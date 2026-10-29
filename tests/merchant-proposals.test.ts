/**
 * 方案集合、选择记录与批准绑定（v0.2 §9 / FR12–FR15、FR17、AC04/AC05）。
 */
import { describe, expect, it } from "vitest";

import {
  createApprovalBinding,
  createSelection,
  markSetStale,
  prepareProposalSet,
  publicSetProjection,
  verifyApprovalBinding,
  withdrawSet,
} from "../src/merchant-core/proposal/engine.js";
import type {
  PrepareProposalSetInput,
  ProposalOptionInput,
} from "../src/merchant-core/proposal/types.js";

const NOW = "2026-10-29T10:00:00.000Z";

function option(overrides: Partial<ProposalOptionInput> = {}): ProposalOptionInput {
  return {
    sku: "SKU-A",
    unit: "piece",
    quantity: 500,
    base_unit_price_minor: 10_000,
    line_tax: { basis: "EXCLUSIVE", rate_bps: 0 },
    shipping_tax: { basis: "EXCLUSIVE", rate_bps: 0 },
    adaptation: [{ constraint: "size", result: "MET", evidence_ref: "fact:size" }],
    ...overrides,
  };
}

function proposal(overrides: Partial<PrepareProposalSetInput> = {}): PrepareProposalSetInput {
  return {
    merchant_id: "merchant-1",
    opportunity_id: "opp-1",
    requirement_revision: 2,
    facts_digest: "facts:v1",
    policy_version: "policy:v1",
    now: NOW,
    options: [option()],
    ...overrides,
  };
}

describe("prepareProposalSet", () => {
  it("1–3 个有差异的选项；B 不替代 A", () => {
    const set = prepareProposalSet(
      proposal({
        options: [
          option({ option_id: "opt-a", sku: "SKU-A" }),
          option({ option_id: "opt-b", sku: "SKU-B", base_unit_price_minor: 11_000 }),
        ],
      }),
    );
    expect(set.status).toBe("READY");
    expect(set.options).toHaveLength(2);
    expect(set.options.map((o) => o.option_id)).toEqual(["opt-a", "opt-b"]);
    expect(set.options.every((o) => o.eligibility === "SELECTABLE")).toBe(true);
  });

  it("超过 3 个选项或没有差异的重复选项被拒绝", () => {
    expect(() =>
      prepareProposalSet(
        proposal({
          options: [
            option({ option_id: "a" }),
            option({ option_id: "b", sku: "SKU-B" }),
            option({ option_id: "c", sku: "SKU-C" }),
            option({ option_id: "d", sku: "SKU-D" }),
          ],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "validation" }));

    expect(() =>
      prepareProposalSet(
        proposal({ options: [option({ option_id: "a" }), option({ option_id: "b" })] }),
      ),
    ).toThrowError(expect.objectContaining({ code: "validation" }));
  });

  it("硬性条件不满足/证据未知 → BLOCKED，不能被更低价格抵消", () => {
    const set = prepareProposalSet(
      proposal({
        options: [
          option({
            option_id: "not-met",
            base_unit_price_minor: 1,
            adaptation: [{ constraint: "load", result: "NOT_MET" }],
          }),
          option({
            option_id: "unknown",
            adaptation: [{ constraint: "load", result: "UNKNOWN" }],
          }),
        ],
      }),
    );
    expect(set.status).toBe("EVALUATED");
    expect(set.options[0]).toMatchObject({
      eligibility: "BLOCKED",
      blocking_reasons: ["hard_constraint_not_met:load"],
    });
    expect(set.options[1]).toMatchObject({
      eligibility: "BLOCKED",
      blocking_reasons: ["evidence_missing:load"],
    });
  });

  it("低于私有 floor → 选项 blocked，且公开投影不泄露 floor", () => {
    const set = prepareProposalSet(
      proposal({
        options: [
          option({ option_id: "floor", private_floor_minor: 10_500 }),
          option({ option_id: "alt", sku: "SKU-ALT", is_alternative: true }),
        ],
      }),
    );
    expect(set.options[0]).toMatchObject({
      eligibility: "BLOCKED",
      blocking_reasons: ["approval_required:below_private_floor"],
    });
    expect(set.options[0]?.unit_price_minor).toBeUndefined();
    expect(set.options[1]?.eligibility).toBe("CHANGE_REQUIRES_CUSTOMER_CONFIRMATION");

    const projection = JSON.stringify(publicSetProjection(set));
    expect(projection).not.toContain("10500");
    expect(projection).not.toContain("private_floor");
    expect(projection).not.toContain("facts:v1");
    expect(projection).not.toContain("policy:v1");
  });

  it("计价输入非法时整单拒绝（不静默跳过选项）", () => {
    expect(() =>
      prepareProposalSet(proposal({ options: [option({ quantity: 0 })] })),
    ).toThrowError(expect.objectContaining({ code: "validation" }));
    expect(() =>
      prepareProposalSet(proposal({ options: [option({ base_unit_price_minor: 1.5 })] })),
    ).toThrowError(expect.objectContaining({ code: "validation" }));
  });
});

describe("选择记录", () => {
  it("只能选定客户已确认范围内的可选选项", () => {
    const set = prepareProposalSet(
      proposal({
        options: [
          option({ option_id: "ok" }),
          option({ option_id: "alt", sku: "SKU-ALT", is_alternative: true }),
          option({ option_id: "blocked", sku: "SKU-C", adaptation: [{ constraint: "x", result: "NOT_MET" }] }),
        ],
      }),
    );
    const selection = createSelection({
      merchant_id: "merchant-1",
      set,
      option_id: "ok",
      selected_by: "operator-1",
      requirement_revision: 2,
      publish_reference: { kind: "rfq_quote", quote_id: "quote-1", revision: 1 },
      now: NOW,
    });
    expect(selection.option_id).toBe("ok");
    expect(selection.set_id).toBe(set.set_id);

    // 超出已确认范围的替代品 → 先取得客户确认；硬约束不满足 → 不可选定。
    expect(() =>
      createSelection({
        merchant_id: "merchant-1",
        set,
        option_id: "alt",
        selected_by: "operator-1",
        requirement_revision: 2,
        publish_reference: { kind: "knp_offer", negotiation_id: "neg-1", action: "offer", terms_digest: "d" },
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "requirement_out_of_scope" }));

    expect(() =>
      createSelection({
        merchant_id: "merchant-1",
        set,
        option_id: "blocked",
        selected_by: "operator-1",
        requirement_revision: 2,
        publish_reference: { kind: "knp_offer", negotiation_id: "neg-1", action: "offer", terms_digest: "d" },
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "not_selectable" }));
  });

  it("需求版本变化或集合失效后不能沿用旧选择", () => {
    const set = prepareProposalSet(proposal());
    expect(() =>
      createSelection({
        merchant_id: "merchant-1",
        set,
        option_id: set.options[0]!.option_id,
        selected_by: "operator-1",
        requirement_revision: 3,
        publish_reference: { kind: "rfq_quote", quote_id: "q", revision: 1 },
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "requirement_out_of_scope" }));

    const stale = markSetStale(set, "price changed", NOW);
    expect(() =>
      createSelection({
        merchant_id: "merchant-1",
        set: stale,
        option_id: stale.options[0]!.option_id,
        selected_by: "operator-1",
        requirement_revision: 2,
        publish_reference: { kind: "rfq_quote", quote_id: "q", revision: 1 },
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "not_selectable" }));
  });

  it("发布引用必须合法（RFQ 修订号 / KNP 动作与摘要）", () => {
    const set = prepareProposalSet(proposal());
    expect(() =>
      createSelection({
        merchant_id: "merchant-1",
        set,
        option_id: set.options[0]!.option_id,
        selected_by: "operator-1",
        requirement_revision: 2,
        publish_reference: { kind: "rfq_quote", quote_id: "q", revision: 0 },
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "validation" }));
  });
});

describe("批准绑定", () => {
  function readySet() {
    return prepareProposalSet(proposal());
  }

  it("批准绑定摘要覆盖方案、选项、需求与策略版本", () => {
    const set = readySet();
    const binding = createApprovalBinding({
      merchant_id: "merchant-1",
      set,
      option_id: set.options[0]!.option_id,
      policy_version: "policy:v1",
      expires_at: "2026-10-29T10:10:00.000Z",
      now: NOW,
    });
    expect(binding.scope).toBe("publish_quote");
    expect(binding.content_digest).toMatch(/^sha256:/);
    expect(() =>
      verifyApprovalBinding({
        binding,
        set,
        option_id: set.options[0]!.option_id,
        policy_version: "policy:v1",
        now: NOW,
      }),
    ).not.toThrow();
  });

  it("策略/内容/有效期变化使批准失效", () => {
    const set = readySet();
    const binding = createApprovalBinding({
      merchant_id: "merchant-1",
      set,
      option_id: set.options[0]!.option_id,
      policy_version: "policy:v1",
      expires_at: "2026-10-29T10:10:00.000Z",
      now: NOW,
    });
    expect(() =>
      verifyApprovalBinding({
        binding,
        set,
        option_id: set.options[0]!.option_id,
        policy_version: "policy:v2",
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "approval_mismatch" }));

    const changed: typeof set = {
      ...set,
      options: set.options.map((o) => ({ ...o, unit_price_minor: (o.unit_price_minor ?? 0) + 1 })),
    };
    expect(() =>
      verifyApprovalBinding({
        binding,
        set: changed,
        option_id: changed.options[0]!.option_id,
        policy_version: "policy:v1",
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "approval_mismatch" }));

    expect(() =>
      verifyApprovalBinding({
        binding,
        set,
        option_id: set.options[0]!.option_id,
        policy_version: "policy:v1",
        now: "2026-10-29T10:10:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "approval_expired" }));
  });

  it("只有 READY 集合中的可选选项可以申请批准；STALE 后复验失败", () => {
    const blocked = prepareProposalSet(
      proposal({ options: [option({ adaptation: [{ constraint: "x", result: "NOT_MET" }] })] }),
    );
    expect(() =>
      createApprovalBinding({
        merchant_id: "merchant-1",
        set: blocked,
        option_id: blocked.options[0]!.option_id,
        policy_version: "policy:v1",
        expires_at: "2026-10-29T10:10:00.000Z",
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "not_selectable" }));

    const set = readySet();
    const binding = createApprovalBinding({
      merchant_id: "merchant-1",
      set,
      option_id: set.options[0]!.option_id,
      policy_version: "policy:v1",
      expires_at: "2026-10-29T10:10:00.000Z",
      now: NOW,
    });
    const stale = markSetStale(set, "facts changed", NOW);
    expect(() =>
      verifyApprovalBinding({
        binding,
        set: stale,
        option_id: stale.options[0]!.option_id,
        policy_version: "policy:v1",
        now: NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: "approval_mismatch" }));
  });

  it("撤回后集合不可用", () => {
    const withdrawn = withdrawSet(prepareProposalSet(proposal()), NOW);
    expect(withdrawn.status).toBe("WITHDRAWN");
    expect(withdrawn.revision).toBe(2);
  });
});
