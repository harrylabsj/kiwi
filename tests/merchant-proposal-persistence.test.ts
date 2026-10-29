/**
 * 方案集合持久化：保存/加载、选择、批准复验、STALE/撤回与幂等（v0.2 §9/§10）。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { ProposalRepository } from "../src/merchant-core/proposal/repository.js";
import { ProposalService } from "../src/merchant-core/proposal/service.js";
import type { PrepareProposalSetInput, ProposalOptionInput } from "../src/merchant-core/proposal/types.js";

const NOW = "2026-10-29T10:00:00.000Z";
let db: DatabaseSync;
let service: ProposalService;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  migrateMerchantOpsSchema(db);
  service = new ProposalService({
    repository: new ProposalRepository({ db, now: () => NOW }),
    now: () => NOW,
  });
});
afterEach(() => db.close());

function option(overrides: Partial<ProposalOptionInput> = {}): ProposalOptionInput {
  return {
    sku: "SKU-A",
    unit: "piece",
    quantity: 10,
    base_unit_price_minor: 10_000,
    line_tax: { basis: "EXCLUSIVE", rate_bps: 0 },
    shipping_tax: { basis: "EXCLUSIVE", rate_bps: 0 },
    adaptation: [{ constraint: "size", result: "MET" }],
    ...overrides,
  };
}

function proposal(overrides: Partial<PrepareProposalSetInput> = {}): PrepareProposalSetInput {
  return {
    merchant_id: "merchant-1",
    opportunity_id: "opp-1",
    requirement_revision: 1,
    facts_digest: "facts:v1",
    policy_version: "policy:v1",
    options: [option()],
    now: NOW,
    ...overrides,
  };
}

describe("ProposalService 持久化", () => {
  it("保存并读回集合与选项（含计价快照）", () => {
    const set = service.prepare(proposal());
    const loaded = service.get("merchant-1", set.set_id);
    expect(loaded).toMatchObject({
      set_id: set.set_id,
      status: "READY",
      requirement_revision: 1,
    });
    expect(loaded?.options[0]).toMatchObject({
      sku: "SKU-A",
      quantity: 10,
      unit_price_minor: 10_000,
      eligibility: "SELECTABLE",
    });
    expect(loaded?.options[0]?.pricing?.totals.gross_minor).toBe(100_000);
    expect(service.listForOpportunity("merchant-1", "opp-1")).toHaveLength(1);
    expect(service.get("merchant-2", set.set_id)).toBeUndefined();
  });

  it("选择与批准写入后可按摘要复验；策略变化使复验失败", () => {
    const set = service.prepare(proposal());
    const optionId = set.options[0]!.option_id;
    const selection = service.select({
      merchant_id: "merchant-1",
      set_id: set.set_id,
      option_id: optionId,
      selected_by: "operator-1",
      requirement_revision: 1,
      publish_reference: { kind: "rfq_quote", quote_id: "quote-1", revision: 1 },
      now: NOW,
    });
    expect(selection.option_id).toBe(optionId);

    const approval = service.approve({
      merchant_id: "merchant-1",
      set_id: set.set_id,
      option_id: optionId,
      policy_version: "policy:v1",
      expires_at: "2026-10-29T10:10:00.000Z",
      now: NOW,
    });
    expect(() =>
      service.verifyApproval({
        merchant_id: "merchant-1",
        approval_id: approval.approval_id,
        option_id: optionId,
        policy_version: "policy:v1",
        now: NOW,
      }),
    ).not.toThrow();
    expect(() =>
      service.verifyApproval({
        merchant_id: "merchant-1",
        approval_id: approval.approval_id,
        option_id: optionId,
        policy_version: "policy:v2",
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "approval_mismatch" }));
  });

  it("STALE/撤回带 revision CAS；旧 revision 拒绝", () => {
    const set = service.prepare(proposal());
    const stale = service.markStale({
      merchant_id: "merchant-1",
      set_id: set.set_id,
      expected_revision: set.revision,
      reason: "price changed",
      now: NOW,
    });
    expect(stale.status).toBe("STALE");
    expect(stale.revision).toBe(2);
    expect(() =>
      service.markStale({
        merchant_id: "merchant-1",
        set_id: set.set_id,
        expected_revision: 1,
        reason: "again",
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "validation" }));

    const withdrawn = service.withdraw({
      merchant_id: "merchant-1",
      set_id: set.set_id,
      expected_revision: stale.revision,
      now: NOW,
    });
    expect(withdrawn.status).toBe("WITHDRAWN");
  });

  it("幂等键：同内容重放返回同一集合，异内容冲突", () => {
    const input = proposal();
    const first = service.prepare(input, { idempotency_key: "proposal-1" });
    const replay = service.prepare(input, { idempotency_key: "proposal-1" });
    expect(replay.set_id).toBe(first.set_id);
    expect(service.listForOpportunity("merchant-1", "opp-1")).toHaveLength(1);
    expect(() =>
      service.prepare(proposal({ requirement_revision: 2 }), { idempotency_key: "proposal-1" }),
    ).toThrowError(expect.objectContaining({ code: "validation" }));
  });
});
