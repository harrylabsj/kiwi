import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startTestA2aStack, type CapturedInbound } from "./helpers.js";
import { buildBuyerService } from "../src/buyer-core/build-service.js";
import { buildKiwiTools } from "../src/mcp/tools.js";
import { DEFAULT_DELEGATION_POLICY } from "../src/mcp/cli.js";
import type { TaskApprovalStore } from "../src/buyer-core/store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("A2A direct offer survives restart and reaches merchant accept", () => {
  it("persists offer/terms provenance and sends accept_nonbinding after reopen", async () => {
    const capture: CapturedInbound[] = [];
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "Test Product", stock: 12, unit: "台", source_evidence: { system: "owned-test-fixture" } }),
      },
      capture,
    });
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-restart-")); dirs.push(dir);
    const dbPath = path.join(dir, "buyer.sqlite");
    const protocolStateDir = path.join(dir, "knp");
    const policy = { ...DEFAULT_DELEGATION_POLICY, principal: "company:restart", actions: { ...DEFAULT_DELEGATION_POLICY.actions, accept_nonbinding: { mode: "auto" as const } } };
    try {
      const first = buildBuyerService({
        dbPath, protocolStateDir, principal: "company:restart", buyerAgentId: "buyer:restart",
        sessionId: "session:restart", sessionOwner: "owner-restart", policy,
        catalogUrl: stack.catalogUrl, a2aAllowPrivateRanges: true, a2aSkipDnsCheck: true, a2aTimeoutMs: 8000,
      });
      const tools = buildKiwiTools(first);
      const call = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.handle(args);
      const text = (r: { content?: Array<{ text?: string }> }) => r.content?.[0]?.text ?? "";
      const search = JSON.parse(text(await call("kiwi_search", { query: "Test Product" }))) as { merchants: Array<{ merchant_id: string }> };
      const rq = await call("kiwi_request_quotes", {
        intent: { intent_id: "a2a-direct-restart", intent_type: "purchase", items: [{ query: "Test Product", quantity: { value: 2, unit: "台" } }], constraints: { currency: "CNY" } },
        merchant_ids: [search.merchants[0]!.merchant_id],
      });
      expect(rq.isError).toBeUndefined();
      const taskId = (JSON.parse(text(rq)) as { task_id: string }).task_id;
      const clarified = await first.negotiate({ task_id: taskId, action: "clarification", summary: "【测试】请确认为非约束测试询价" });
      expect(clarified.step.action).toBe("clarification");
      expect(typeof clarified.step.reply).toBe("string");
      const before = JSON.parse(text(await call("kiwi_get_task", { task_id: taskId }))) as { task: { candidates: Array<{ candidate_id: string; provenance?: { latest_offer_type?: string; latest_terms_digest?: string; latest_agreed_terms?: Record<string, unknown> } }> } };
      const candidate = before.task.candidates[0]!;
      expect(candidate.provenance?.latest_offer_type).toBe("offer");
      expect(candidate.provenance?.latest_terms_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(candidate.provenance?.latest_agreed_terms).toBeDefined();
      (first as unknown as { store: TaskApprovalStore }).store.close();

      const reopened = buildBuyerService({
        dbPath, protocolStateDir, principal: "company:restart", buyerAgentId: "buyer:restart",
        sessionId: "session:restart", sessionOwner: "owner-restart", policy,
        catalogUrl: stack.catalogUrl, a2aAllowPrivateRanges: true, a2aSkipDnsCheck: true, a2aTimeoutMs: 8000,
      });
      const accepted = await reopened.acceptAgreement({ task_id: taskId, candidate_id: candidate.candidate_id });
      expect(accepted.agreement.merchant_agreement).toBeDefined();
      expect(capture.some((c) => c.action === "accept_nonbinding")).toBe(true);
      (reopened as unknown as { store: TaskApprovalStore }).store.close();
    } finally {
      await stack.stop();
    }
  }, 30_000);
});
