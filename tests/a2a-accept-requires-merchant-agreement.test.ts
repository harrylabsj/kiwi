import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KiwiBuyerService } from "../src/buyer-core/service.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";

import { contentDigest } from "../src/negotiation/jcs.js";
import { A2ANegotiator } from "../src/buyer-core/a2a-negotiator.js";
import { buildKiwiTools } from "../src/mcp/tools.js";

const terms = { items: [{ sku: "s", quantity: { value: 2, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 81000 } }] };
const version = "01890aa1-0000-7000-8000-123456789abc";
const collectionTerms = {
  ...terms,
  handoff_destination: `https://merchant.example/collect/alipay/neg-a2a/offer-a2a/${version}`,
  kiwi_alipay_collection: { version, total_minor: 163000, currency: "CNY", recipient_summary: "张***", expires_at: "2099-01-01T00:00:00Z" },
};
const merchantProvenance = {
  a2a_endpoint: "https://merchant.example/a2a", negotiation_id: "neg-a2a", offer_id: "offer-a2a",
  merchant_reply_id: "msg-a2a", latest_offer_type: "offer",
};

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const POLICY = {
  policy_id: "a2a-accept-policy", version: "1.0", principal: "company:a2a",
  expires_at: "2099-12-31T23:59:59Z",
  actions: { accept_nonbinding: { mode: "auto" }, payment: { mode: "never" } }, limits: {},
};

describe("A2A accept requires a real merchant agreement", () => {
  it("rejects a merchant agreement that claims binding/order/payment effects", async () => {
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
        ...merchantProvenance, latest_agreed_terms: terms, latest_terms_digest: contentDigest(terms),
      },
    });
    let merchantCalls = 0;
    const service = new KiwiBuyerService({
      store, principal: "company:a2a", buyerAgentId: "buyer:a2a", sessionId: "session:a2a", sessionOwner: "owner-a2a",
      delegationPolicy: POLICY,
      negotiator: {
        negotiate: async (_task, _intent, current) => current,
        acceptNonbinding: async () => {
          merchantCalls += 1;
          return { agreement: {
            type: "accepted_nonbinding_agreement",
            agreement_id: "merchant-agr-1",
            negotiation_id: "neg-a2a",
            accepted_offer_id: "offer-a2a",
            agreed_terms: terms,
            terms_digest: contentDigest(terms),
            accepted_by: ["buyer", "merchant"],
            created_at: "2026-11-05T00:00:00Z",
            binding_effect: "binding",
            creates_order: true,
            reserves_inventory: true,
            authorizes_payment: true,
          } };
        },
      },
    });
    await expect(service.acceptAgreement({ task_id: "task-a2a-offer", candidate_id: "cand-a2a-offer" }))
      .rejects.toMatchObject({ code: "internal_error", detail: { reconciliation_required: true } });
    expect(merchantCalls).toBe(1);
    expect(store.hasAgreementForTask("task-a2a-offer")).toBe(false);
    store.close();
  });
});


it.each([
  { latestTerms: collectionTerms, digest: contentDigest(collectionTerms), message: "含费总额校验" },
  { latestTerms: undefined, digest: contentDigest(collectionTerms), message: "请重新获取报价" },
  { latestTerms: terms, digest: contentDigest(collectionTerms), message: "请重新获取报价" },
])("MCP rejects collection or unverifiable terms before sending or consuming approval: $message", async ({ latestTerms, digest, message }) => {
  const store = new TaskApprovalStore({ dbPath: ":memory:" });
  try {
    const task_id = "task-mcp-collection";
    const candidate_id = "cand-mcp-collection";
    const acceptNonbinding = vi.fn(async () => ({ agreement: {} }));
    const service = new KiwiBuyerService({
      store, principal: "company:a2a", buyerAgentId: "buyer:a2a", sessionId: "session:a2a", sessionOwner: "owner-a2a",
      delegationPolicy: { ...POLICY, actions: { ...POLICY.actions, accept_nonbinding: { mode: "ask" } } },
      negotiator: { negotiate: async (_task, _intent, current) => current, acceptNonbinding },
    });
    store.createTask({
      task_id, task_kind: "request_quotes", status: "succeeded", idempotency_key: "idem-collection",
      created_at: "2026-11-05T00:00:00Z", updated_at: "2026-11-05T00:00:00Z", expires_at: "2099-01-01T00:00:00Z", resumable: true, owner_hash: "owner-a2a",
      payload: JSON.stringify({ intent: { constraints: { budget: { currency: "CNY", amount_minor: 162000 } } } }),
    });
    store.addCandidate(task_id, {
      candidate_id, merchant_id: "merchant-a2a", status: "succeeded", retryable: false,
      provenance: { ...merchantProvenance, latest_agreed_terms: latestTerms, latest_terms_digest: digest },
    });
    const { approval_id } = service.requestApproval({ task_id, action: "accept_nonbinding", candidate_digest: digest });
    service.approve({ approval_id });
    const tool = buildKiwiTools(service).find((tool) => tool.name === "kiwi_accept_agreement")!;
    const result = await tool.handle({ task_id, candidate_id, approval_id });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(message) });
    expect(acceptNonbinding).not.toHaveBeenCalled();
    expect(store.getApproval(approval_id)?.status).toBe("approved");
    expect(store.hasAgreementForTask(task_id)).toBe(false);
    expect(store.getTask(task_id)?.status).toBe("succeeded");
  } finally { store.close(); }
});

it("a directly used A2A driver refuses the same collection before HTTP", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const negotiator = new A2ANegotiator({ fetchImpl });
  await expect(negotiator.acceptNonbinding({ taskId: "task-direct", candidate: { provenance: {
    ...merchantProvenance, latest_agreed_terms: collectionTerms, latest_terms_digest: contentDigest(collectionTerms),
  } } })).rejects.toMatchObject({ code: "invalid_params", detail: { reason_code: "ALIPAY_PRIVATE_DISPLAY_REQUIRED" } });
  expect(fetchImpl).not.toHaveBeenCalled();
});
