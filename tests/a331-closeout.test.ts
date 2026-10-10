import { mkdirSync } from "node:fs";
/**
 * A331 收口自有控制。模式复刻 buyer-authorization-limits.test.ts（已验证通过）。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildBuyerService } from "../src/buyer-core/build-service.js";
import { DeterministicNegotiationRunner } from "../src/operator/runner.js";
import type { CommerceClient } from "../src/commerce/types.js";
import type { TaskApprovalStore } from "../src/buyer-core/store.js";
import type { KiwiBuyerService } from "../src/buyer-core/service.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { existsSync } from "node:fs";

const POLICY_LIMITS = {
  max_unit_price: { currency: "CNY", amount_minor: 100_000 },
  max_total_price: { currency: "CNY", amount_minor: 1_000_000 },
  max_quantity: { value: 10, unit: "个" },
  allowed_currencies: ["CNY"],
};

function makeSvc(acceptMode: "auto" | "ask" = "auto") {
  return buildBuyerService({
    dbPath: ":memory:",
    principal: "c:a331",
    buyerAgentId: "b:a331",
    sessionId: "a331",
    policy: {
      policy_id: "dp-a331", version: "1.0", principal: "c:a331", expires_at: "2099-12-31T23:59:59Z",
      actions: { discover: { mode: "auto" }, inquiry_rfq: { mode: "auto" }, compare_offers: { mode: "auto" }, counter_offer: { mode: "auto" }, accept_nonbinding: { mode: acceptMode }, handoff: { mode: "ask" }, payment: { mode: "never" } },
      limits: POLICY_LIMITS,
    } as never,
  } as never);
}

function storeOf(svc: KiwiBuyerService): TaskApprovalStore {
  return (svc as unknown as { store: TaskApprovalStore }).store;
}

async function seedTask(svc: KiwiBuyerService, key: string): Promise<string> {
  const { task } = await svc.requestQuotes({
    intent: { intent_id: "int-a331", intent_type: "purchase", items: [{ query: "扩展坞", quantity: { value: 2, unit: "个" } }] },
    merchant_ids: ["m1"],
    idempotency_key: key,
  });
  return (task as { task_id: string }).task_id;
}

function addCand(svc: KiwiBuyerService, taskId: string, candId: string, terms: Record<string, unknown>, status = "succeeded") {
  storeOf(svc).addCandidate(taskId, {
    candidate_id: candId, merchant_id: "m1", status,
    provenance: { reply_text: "price 999.00 CNY" },
    terms, retryable: false,
  });
}

function terms(unitPriceMinor: number, qty: number, currency = "CNY") {
  return { currency, items: [{ sku: "dock-1", quantity_value: qty, quantity_unit: "个", unit_price_minor: unitPriceMinor }], total_price_minor: unitPriceMinor * qty };
}

describe("A331 P1-2 auto fresh 候选强核", () => {
  it("界内 → agreement granted（正控）", async () => {
    const svc = makeSvc("auto");
    const taskId = await seedTask(svc, "k-pos");
    addCand(svc, taskId, "cand", terms(99_900, 2));
    const done = await svc.acceptAgreement({ task_id: taskId, candidate_id: "cand" });
    expect(done.authorization.effective_decision).toBe("granted");
    expect((done.agreement as { agreement_id: string }).agreement_id).toMatch(/^agreement-/);
  });

  it("候选状态推进（非 succeeded）→ authorization_denied", async () => {
    const svc = makeSvc("auto");
    const taskId = await seedTask(svc, "k-state");
    addCand(svc, taskId, "cand", terms(99_900, 2), "selected");
    await expect(svc.acceptAgreement({ task_id: taskId, candidate_id: "cand" })).rejects.toMatchObject({ code: "authorization_denied" });
  });

  it("ASK + approval → accept 成功（正控回归）", async () => {
    const svc = makeSvc("ask");
    const taskId = await seedTask(svc, "k-ask");
    addCand(svc, taskId, "cand", terms(99_900, 2));
    const digest = contentDigest(storeOf(svc).listCandidates(taskId).find((c) => c.candidate_id === "cand") as never);
    const { approval_id } = svc.requestApproval({ task_id: taskId, action: "accept_nonbinding", candidate_digest: digest });
    svc.approve({ approval_id });
    const done = await svc.acceptAgreement({ task_id: taskId, candidate_id: "cand", approval_id });
    expect(done.authorization.effective_decision).toBe("granted");
  });

  it("ASK + 候选事后篡改 → approval_denied（fresh 核在 approval 分支也生效）", async () => {
    const svc = makeSvc("ask");
    const taskId = await seedTask(svc, "k-ask-dig");
    addCand(svc, taskId, "cand", terms(99_900, 2));
    const digest = contentDigest(storeOf(svc).listCandidates(taskId).find((c) => c.candidate_id === "cand") as never);
    const { approval_id } = svc.requestApproval({ task_id: taskId, action: "accept_nonbinding", candidate_digest: digest });
    svc.approve({ approval_id });
    // 篡改候选 terms（模拟内容推进）——fresh digest 与审批绑定不一致
    const db = (svc as unknown as { store: { db: DatabaseSync } }).store.db;
    db.prepare("UPDATE mcp_candidates SET provenance_json = ? WHERE candidate_id = ?").run(
      JSON.stringify({ reply_text: "tampered", _quote_terms: terms(50_000, 2) }),
      "cand",
    );
    await expect(
      svc.acceptAgreement({ task_id: taskId, candidate_id: "cand", approval_id }),
    ).rejects.toMatchObject({ code: "authorization_denied" });
  });
});

// ── P1-4：围栏持久语义 ─────────────────────────────────────────

const BINDING = { conversation_id: "conv-a331", message_id: 7, idempotency_key: "idem-7" };

function makeRunner(opts: { fenceDir: string; failClaimNever?: boolean }) {
  let failClaimCalls = 0;
  let releaseFailClaim: (() => void) | undefined;
  const client = {
    async listPendingMessages() {
      return [{ conversation_id: BINDING.conversation_id, message_id: BINDING.message_id }];
    },
    async claimMessage() { return { claimed: true }; },
    async getNegotiationSnapshot() {
      return { role: "buyer" as const, conversation: { id: BINDING.conversation_id, status: "open" }, messages: [] };
    },
    async submitNegotiationDecision() {
      throw new Error("gateway unreachable after write");
    },
    async failClaim(_input: { error: string }) {
      failClaimCalls += 1;
      if (opts.failClaimNever) await new Promise<void>((r) => { releaseFailClaim = r; });
    },
    async completeClaim() {},
    async abandonClaim() {},
  } as unknown as CommerceClient;
  const runner = new DeterministicNegotiationRunner(
    {
      agent_id: "buyer-agent:a331", role: "buyer",
      buyer_policy: { max_total_price_private: Number.POSITIVE_INFINITY, acceptable_eta_latest: "9999-12-31T23:59:59Z", required_after_sales_terms: [] },
    } as never,
    client,
    { unknownFenceDir: opts.fenceDir },
  );
  return {
    runner,
    fenceFile: path.join(opts.fenceDir, "submit-unknown.jsonl"),
    counts: () => ({ fail: failClaimCalls }),
    releaseFailClaim: () => releaseFailClaim?.(),
  };
}

describe("A331 P1-4：围栏持久语义收口", () => {
  it("围栏记录先于 failClaim（failClaim 永不返回时围栏已落盘）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a331-order-"));
    const h = makeRunner({ fenceDir: path.join(dir, "fence"), failClaimNever: true });
    const p = h.runner.submit({ binding: BINDING, decision: { action: "accept_nonbinding" } as never }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(h.fenceFile)).toBe(true);
    const entry = JSON.parse(readFileSync(h.fenceFile, "utf-8").trim());
    expect(entry.conversation_id).toBe("conv-a331");
    expect(h.counts().fail).toBe(1);
    h.releaseFailClaim();
    await p.catch(() => undefined);
  });

  it("坏行 fence 文件 → 构造 fail-closed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a331-corrupt-"));
    const fenceDir = path.join(dir, "submit-unknown");
    mkdirSync(fenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(fenceDir, "submit-unknown.jsonl"), "broken json line\n", { mode: 0o600 });
    expect(() =>
      new DeterministicNegotiationRunner(
        { agent_id: "x", role: "buyer" } as never,
        {} as unknown as CommerceClient,
        { unknownFenceDir: fenceDir },
      ),
    ).toThrow(/fail-closed/);
  });

  it("围栏条目重启加载 → prepare 跳过（既有正控保持）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a331-load-"));
    const h = makeRunner({ fenceDir: path.join(dir, "fence") });
    await h.runner.submit({ binding: BINDING, decision: { action: "accept_nonbinding" } as never }).catch(() => undefined);
    const r2 = new DeterministicNegotiationRunner(
      { agent_id: "buyer-agent:a331", role: "buyer" } as never,
      {
        async listPendingMessages() { return [{ conversation_id: BINDING.conversation_id, message_id: BINDING.message_id }]; },
        async getNegotiationSnapshot() { throw new Error("must not reach"); },
      } as unknown as CommerceClient,
      { unknownFenceDir: path.join(dir, "fence") },
    );
    const prepared = await r2.prepare();
    expect(prepared).toBeUndefined();
  });
});
