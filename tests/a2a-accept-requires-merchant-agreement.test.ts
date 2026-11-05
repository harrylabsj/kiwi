import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { KiwiBuyerService } from "../src/buyer-core/service.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const POLICY = {
  policy_id: "a2a-accept-policy", version: "1.0", principal: "company:a2a",
  expires_at: "2099-12-31T23:59:59Z",
  actions: { accept_nonbinding: { mode: "auto" }, payment: { mode: "never" } }, limits: {},
};

describe("A2A accept requires a real merchant agreement", () => {
  it("does not create a local agreement or call the merchant for an offer reply", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-accept-")); dirs.push(dir);
    const store = new TaskApprovalStore({ dbPath: path.join(dir, "buyer.sqlite") });
    store.createTask({
      task_id: "task-a2a-offer", task_kind: "request_quotes", status: "succeeded",
      idempotency_key: "idem-a2a-offer", created_at: "2026-11-05T00:00:00Z",
      updated_at: "2026-11-05T00:00:00Z", resumable: true, owner_hash: "owner-a2a", payload: "{}",
    });
    store.addCandidate("task-a2a-offer", {
      candidate_id: "cand-a2a-offer", merchant_id: "merchant-a2a", status: "succeeded", retryable: false,
      provenance: {
        a2a_endpoint: "https://merchant.example/a2a",
        negotiation_id: "neg-a2a", offer_id: "offer-a2a", merchant_reply_id: "msg-a2a",
        latest_offer_type: "offer", latest_terms_digest: "sha256:" + "a".repeat(64),
      },
    });
    let merchantCalls = 0;
    const service = new KiwiBuyerService({
      store, principal: "company:a2a", buyerAgentId: "buyer:a2a", sessionId: "session:a2a", sessionOwner: "owner-a2a",
      delegationPolicy: POLICY,
      negotiator: {
        negotiate: async (_task, _intent, current) => current,
        acceptNonbinding: async () => { merchantCalls += 1; return { agreement: { fake: true } }; },
      },
    });
    await expect(service.acceptAgreement({ task_id: "task-a2a-offer", candidate_id: "cand-a2a-offer" }))
      .rejects.toMatchObject({ code: "invalid_params" });
    expect(merchantCalls).toBe(0);
    expect(store.hasAgreementForTask("task-a2a-offer")).toBe(false);
    store.close();
  });
});
