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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { CommerceError } from "../src/commerce/data-source.js";

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
  const dir = trackedMkdtemp("kiwi-exec-");
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

  it("中间态恢复：consumed 已落、delivered 缺失 → 补落 delivered + 幂等记录（评审项 M1）", async () => {
    const c = candidate();
    const e = env(c);
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    // 模拟崩溃中间态：consumed 落链但 delivered 缺失（两次 append 之间崩溃）
    e.ledger.appendCandidateEvent({
      kind: "handoff_candidate_consumed",
      candidate: c,
      identity: IDENTITY,
      capability: CAPABILITY,
      handoff_id: "hnd_mid",
      occurred_at: NOW,
    });

    const result = await executeHandoff({ ...e, candidate: c });
    expect(result).toMatchObject({ kind: "already_delivered", handoff_id: "hnd_mid" });
    // delivered 已补落（审计完整：deliveryState 可投影，TUI 列表不再显示 "?"）
    const delivered = e.ledger.events(c.negotiation_id).filter((ev) => ev.event_kind === "handoff_delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.handoff_id).toBe("hnd_mid");
    // 幂等记录已补：重试命中幂等表而非再次触发恢复
    expect(e.idempotency.lookup(c.handoff_candidate_id, c.candidate_digest)).toEqual({ handoff_id: "hnd_mid" });
    // 恢复只发生一次：再次执行不重复补落
    const again = await executeHandoff({ ...e, candidate: c });
    expect(again).toMatchObject({ kind: "already_delivered", handoff_id: "hnd_mid" });
    expect(e.ledger.events(c.negotiation_id).filter((ev) => ev.event_kind === "handoff_delivered")).toHaveLength(1);
  });

  it("瞬时探测失败 → probe_failed（候选保持 READY，重试可成功；评审项 M2）", async () => {
    const c = candidate();
    const e = env(c);
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });

    const failing = async (): Promise<never> => {
      throw new CommerceError("request_failed", "destination probe timed out after 15000ms");
    };
    const first = await executeHandoff({ ...e, candidate: c, urlSafety: failing });
    expect(first).toMatchObject({ kind: "probe_failed" });
    // 候选保持 READY：未落 stale/expired/consumed（修复前一次超时即永久废掉候选）
    const events = e.ledger.events(c.negotiation_id);
    expect(events.some((ev) => ev.event_kind === "handoff_candidate_stale")).toBe(false);
    expect(events.some((ev) => ev.event_kind === "handoff_candidate_consumed")).toBe(false);

    // 探测恢复后重试成功（同一候选，无需重新生成）
    const second = await executeHandoff({
      ...e,
      candidate: c,
      urlSafety: async () => ({ finalUrl: "https://acme.example/checkout/abc", redirects: [] }),
    });
    expect(second.kind).toBe("delivered");
  });

  it("安全拒绝（invalid_input）仍置 STALE：目的地内容不可用是终态", async () => {
    const c = candidate();
    const e = env(c);
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_ready", candidate: c, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });

    const unsafe = async (): Promise<never> => {
      throw new CommerceError("invalid_input", "unsafe destination scheme \"file:\"");
    };
    const first = await executeHandoff({ ...e, candidate: c, urlSafety: unsafe });
    expect(first.kind).toBe("stale");
    const events = e.ledger.events(c.negotiation_id);
    expect(events.some((ev) => ev.event_kind === "handoff_candidate_stale")).toBe(true);
  });

  it("双候选同 (agreement, destination)：第二个候选执行 → already_delivered（H3 防二次交付）", async () => {
    // 候选 A、B：同协议同目的地、不同候选 id（模拟 LLM 重试生成的第二候选——
    // 创建期 priorDelivery 检查拦不住双候选双批准，执行期链上事实兜底）。
    const cA = candidate();
    const cB = candidate();
    expect(cB.handoff_candidate_id).not.toBe(cA.handoff_candidate_id);
    expect(cB.candidate_digest).not.toBe(cA.candidate_digest);
    const e = env(cA);
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: cA, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: cB, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });

    const first = await executeHandoff({ ...e, candidate: cA });
    expect(first.kind).toBe("delivered");
    const second = await executeHandoff({ ...e, candidate: cB });
    expect(second).toMatchObject({ kind: "already_delivered" });
    // 链上只有一次 delivered（B 不触发 approval/ready——0.5 步在生命周期门前）
    const events = e.ledger.events(cA.negotiation_id);
    const delivered = events.filter((ev) => ev.event_kind === "handoff_delivered");
    expect(delivered).toHaveLength(1);
    expect(events.filter((ev) => ev.event_kind === "handoff_candidate_ready")).toHaveLength(1);
  });

  it("不同目的地不误伤：同协议不同 destination_ref 仍可交付", async () => {
    const cA = candidate();
    const cB = candidate({ destination: { type: "external_checkout_url", ref: "https://acme.example/checkout/other" } });
    const e = env(cA);
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: cA, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });
    e.ledger.appendCandidateEvent({ kind: "handoff_candidate_created", candidate: cB, identity: IDENTITY, capability: CAPABILITY, occurred_at: NOW });

    const first = await executeHandoff({ ...e, candidate: cA });
    expect(first.kind).toBe("delivered");
    const second = await executeHandoff({ ...e, candidate: cB });
    expect(second.kind).toBe("delivered");
    const delivered = e.ledger.events(cA.negotiation_id).filter((ev) => ev.event_kind === "handoff_delivered");
    expect(delivered).toHaveLength(2);
  });
});

/** 评审项 L6：mkdtemp 目录跟踪清理（此前每次运行在 /tmp 残留）。 */
const tmpDirs: string[] = [];
function trackedMkdtemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
