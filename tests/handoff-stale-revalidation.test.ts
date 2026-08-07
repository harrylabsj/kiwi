/**
 * executeHandoff 测试（KTH rev0.3 §6/§10；完成定义 #9-16、#18-19）。
 *
 * 覆盖：
 * - 生命周期门：PROPOSED 走 approval（拒绝 → rejected 事件 + 结果）；
 * - pre-execution revalidation（§10）：agreement 消失 / 身份变化 /
 *   terms_digest 不匹配 / expiry → stale / expired（不执行，不产生
 *   handoff 对象）；
 * - 目的地 URL 安全失败 → stale；
 * - 幂等：同候选重试 → already_delivered（不重复交付）；
 * - 成功路径：consumed + delivered 落链、三 false 不变量、handoff_digest
 *   自洽、无订单/支付/库存事件（完成定义 #12-14）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HandoffEventStore,
  HandoffIdempotencyStore,
  createHandoffCandidate,
  executeHandoff,
  foldCandidateLifecycle,
  type AgreementReadResult,
  type HandoffCandidate,
} from "../src/handoff/index.js";
import { contentDigest } from "../src/negotiation/jcs.js";

const IDENTITY = { sender_identity: "principal:buyer-1", counterparty_identity: "merchant:acme", actor: "buyer" as const };
const CAPABILITY = { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" };
const AGREED_TERMS = { items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" } }] };
const NOW = "2026-08-07T09:00:00Z";

function candidate(overrides: Record<string, unknown> = {}): HandoffCandidate {
  return createHandoffCandidate({
    agreement_id: "agr_01JABC",
    negotiation_id: "neg_01JABC",
    agreed_terms: AGREED_TERMS,
    destination: { type: "external_checkout_url", ref: "https://acme.example/checkout/abc" },
    display_summary: { merchant: "Acme", summary: "200 units" },
    policy_version: "handoff-policy/1",
    expires_at: "2026-08-08T12:00:00Z",
    ...overrides,
  });
}

function agreementReader(overrides: Partial<AgreementReadResult> = {}): (id: string) => Promise<AgreementReadResult | undefined> {
  return async (id: string) => {
    if (id !== "agr_01JABC") return undefined;
    return {
      agreement_id: "agr_01JABC",
      negotiation_id: "neg_01JABC",
      agreed_terms: AGREED_TERMS,
      ...overrides,
    };
  };
}

function approval(approved = true) {
  return async () => ({ approved, evidence: { actor: "operator" } as Record<string, unknown> });
}

function env(c: HandoffCandidate, reader = agreementReader()) {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-exec-"));
  return {
    ledger: new HandoffEventStore({ dir }),
    idempotency: new HandoffIdempotencyStore({ dir }),
    identity: IDENTITY,
    capability: CAPABILITY,
    now: () => NOW,
    approval: approval(true),
    agreementReader: reader,
  };
}

describe("executeHandoff", () => {
  it("成功路径：approval → ready → consumed + delivered 落链（三 false 不变量）", async () => {
    const c = candidate();
    const e = env(c);
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });

    const result = await executeHandoff({ ...e, candidate: c });
    expect(result.kind).toBe("delivered");
    if (result.kind !== "delivered") return;
    expect(result.handoff.handoff_id).toMatch(/^hnd_/);
    expect(result.handoff.source_candidate_id).toBe(c.handoff_candidate_id);
    expect(result.handoff.creates_order).toBe(false);
    expect(result.handoff.authorizes_payment).toBe(false);
    expect(result.handoff.reserves_inventory).toBe(false);
    expect(result.handoff.terms_digest).toBe(contentDigest(AGREED_TERMS));
    // handoff_digest 自洽
    const { handoff_digest: _d, ...rest } = result.handoff;
    expect(contentDigest(rest)).toBe(result.handoff.handoff_digest);

    const events = e.ledger.events(c.negotiation_id);
    const kinds = events.map((ev) => ev.event_kind);
    expect(kinds).toContain("handoff_candidate_created");
    expect(kinds).toContain("handoff_candidate_ready");
    expect(kinds).toContain("handoff_candidate_consumed");
    expect(kinds).toContain("handoff_delivered");
    // 完成定义 #12-14：无订单/支付/库存事件
    expect(kinds.some((k) => k.includes("order") || k.includes("payment") || k.includes("inventory"))).toBe(false);
    // 生命周期投影 → CONSUMED
    expect(foldCandidateLifecycle(e.ledger.eventsForCandidate(c.negotiation_id, c.handoff_candidate_id))).toBe("CONSUMED");
  });

  it("approval 拒绝 → rejected 事件 + 结果，不执行", async () => {
    const c = candidate();
    const e = env(c);
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    e.approval = async () => ({ approved: false, reason: "policy denies", evidence: {} });

    const result = await executeHandoff({ ...e, candidate: c });
    expect(result).toMatchObject({ kind: "rejected", reason: "policy denies" });
    const kinds = e.ledger.events(c.negotiation_id).map((ev) => ev.event_kind);
    expect(kinds).toContain("handoff_candidate_rejected");
    expect(kinds).not.toContain("handoff_delivered");
  });

  it("agreement 消失 → stale（不执行）", async () => {
    const c = candidate();
    const e = env(c, async () => undefined);
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });

    const result = await executeHandoff({ ...e, candidate: c });
    expect(result).toMatchObject({ kind: "stale", reason: /agreement no longer exists/ });
    expect(e.ledger.events(c.negotiation_id).map((ev) => ev.event_kind)).toContain("handoff_candidate_stale");
    expect(e.ledger.events(c.negotiation_id).map((ev) => ev.event_kind)).not.toContain("handoff_delivered");
  });

  it("terms_digest 不匹配 → stale（#16：stale Agreement 使候选失效）", async () => {
    const c = candidate();
    const e = env(c, agreementReader({ agreed_terms: { items: [{ sku: "SKU-001", quantity: { value: 999, unit: "piece" } }] } }));
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });

    const result = await executeHandoff({ ...e, candidate: c });
    expect(result).toMatchObject({ kind: "stale", reason: /terms_digest mismatch/ });
  });

  it("expiry → expired（不执行）", async () => {
    const c = candidate({ expires_at: "2026-08-06T00:00:00Z" }); // 已过期
    const e = env(c);
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });

    const result = await executeHandoff({ ...e, candidate: c });
    expect(result).toMatchObject({ kind: "expired" });
  });

  it("目的地 URL 不安全 → stale（#15 防护生效）", async () => {
    const c = candidate();
    const e = env(c);
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });

    const result = await executeHandoff({
      ...e,
      candidate: c,
      urlSafety: async () => {
        throw new Error("unsafe scheme");
      },
    });
    expect(result).toMatchObject({ kind: "stale", reason: /destination invalid/ });
    expect(e.idempotency.lookup(c.handoff_candidate_id, c.candidate_digest)).toBeUndefined();
  });

  it("幂等：同候选重试 → already_delivered（不重复交付，完成标准 11）", async () => {
    const c = candidate();
    const e = env(c);
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });

    const first = await executeHandoff({ ...e, candidate: c });
    expect(first.kind).toBe("delivered");
    const second = await executeHandoff({ ...e, candidate: c });
    expect(second).toMatchObject({ kind: "already_delivered" });
    // 只有一次 delivered 事件
    const delivered = e.ledger.events(c.negotiation_id).filter((ev) => ev.event_kind === "handoff_delivered");
    expect(delivered).toHaveLength(1);
  });
});
