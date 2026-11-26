/** Copyright 2026 harrylabsj; SPDX-License-Identifier: Apache-2.0 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { expect, it } from "vitest";
import { A2AClient } from "../src/a2a/client/client.js";
import { A2AServer } from "../src/a2a/server/server.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { JSONRPC_CODES } from "../src/a2a/server/errors.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/store.js";
import { LedgerStore } from "../src/negotiation/ledger/store.js";
import { OpenInquirySessionSigner, resolveOpenInquirySessionKey } from "../src/a2a/open-inquiry-session.js";
import { A2AQuoteFetcher } from "../src/buyer-core/a2a-quote-fetcher.js";
import { KiwiBuyerService } from "../src/buyer-core/service.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import { McpServer } from "../src/mcp/server.js";
import { buildKiwiTools } from "../src/mcp/tools.js";
import { HttpMessageSignatureVerifier } from "../src/trust/identity/auth-verifier.js";
import { InMemoryNonceStore } from "../src/trust/identity/nonce.js";
const principal = "principal:receipt-test";
const buyer = "buyer:receipt-test";
const policy = {
  policy_id: "policy-receipt-test", version: "1.0", principal,
  expires_at: "2099-12-31T23:59:59Z",
  actions: {
    discover: { mode: "auto" }, inquiry_rfq: { mode: "auto" }, compare_offers: { mode: "auto" },
    counter_offer: { mode: "auto" }, accept_nonbinding: { mode: "ask" }, handoff: { mode: "never" }, payment: { mode: "never" },
  },
  limits: { max_rounds: 2 },
};
const request = {
  idempotency_key: "original-rfq",
  merchant_ids: ["merchant-001"],
  intent: { intent_id: "intent-receipt", intent_type: "purchase", items: [{ query: "cup", sku: "sku-001", quantity: { value: 100, unit: "piece" } }] },
};

async function fixture(options: { stock?: number; dropBefore?: boolean; stripProof?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-rfq-receipt-"));
  const capture: NegotiationEnvelope[] = [];
  const signer = new OpenInquirySessionSigner();
  const merchantDir = path.join(dir, "merchant");
  let http: Server | undefined;
  let port = 0;
  const stopMerchant = async () => {
    if (!http) return;
    const active = http;
    http = undefined;
    await new Promise<void>((resolve, reject) => {
      active.close((error) => error ? reject(error) : resolve());
      active.closeAllConnections();
    });
  };
  const bootMerchant = async () => {
    const ledger = new LedgerStore({ dir: merchantDir });
    const handler = createMerchantHandler({ ledger, sender: "merchant:local", counterparty: "buyer:*",
      now: () => new Date().toISOString(),
      productSource: { getProduct: async () => ({ sku: "sku-001", price: 189, currency: "CNY", unit: "piece", stock: options.stock ?? 120 }) },
    });
    const server = new A2AServer({ ledger, idempotency: new IdempotencyStore({ dir: merchantDir }),
      card: () => ({ name: "Local merchant", description: "RFQ fixture", providerOrganization: "test", version: "1", baseUrl: `http://127.0.0.1:${port}` }),
      handler: { name: handler.name, handle(ctx) {
        capture.push(ctx.envelope);
        return handler.handle(ctx);
      } },
      authVerifier: new HttpMessageSignatureVerifier({ resolver: resolveOpenInquirySessionKey,
        scheme: "http", expectedAuthority: "127.0.0.1", nonceStore: new InMemoryNonceStore() }),
    });
    const active = server.createServer();
    http = active;
    await new Promise<void>((resolve, reject) => {
      active.once("error", reject);
      active.listen(port, "127.0.0.1", resolve);
    });
    port = (active.address() as { port: number }).port;
  };
  await bootMerchant();
  const url = `http://127.0.0.1:${port}`;
  const merchant = { merchant_id: "merchant-001", name: "Local merchant", verified: true,
    capabilities: [], agent_card_url: `${url}/.well-known/agent-card.json`, matching_skus: ["sku-001"] };
  const stores: TaskApprovalStore[] = [];
  const methods: string[] = [];
  const open = async (sessionId = "original-session") => {
    const store = new TaskApprovalStore({ dbPath: path.join(dir, "buyer.sqlite") });
    stores.push(store);
    const service = new KiwiBuyerService({ store, principal, buyerAgentId: buyer, sessionId, sessionOwner: `test-owner:${sessionId}`, delegationPolicy: policy,
      merchantIndex: { search: async () => [merchant], resolveById: async () => merchant },
      quoteFetcher: new A2AQuoteFetcher({ localBuyerAgentId: buyer, protocolStateDir: path.join(dir, "buyer-knp"),
        signer, allowPrivateRanges: true, skipDnsCheck: true, timeoutMs: 1_000,
        fetchImpl: async (url, init) => {
          const method = init?.body ? String(JSON.parse(String(init.body)).method) : undefined;
          if (method !== undefined) methods.push(method);
          if (method === "SendMessage" && options.dropBefore) throw new Error("synthetic pre-delivery loss");
          // Do not reuse a client socket across the simulated merchant restart.
          const headers = new Headers(init?.headers);
          headers.set("connection", "close");
          const res = await fetch(url, { ...init, headers });
          // Lose the response only after the real merchant has processed the signed RFQ.
          if (method === "SendMessage" && res.ok) {
            await res.arrayBuffer();
            throw new Error("synthetic response loss after processing");
          }
          if (method === "GetTask" && options.stripProof) {
            const body = await res.json() as { result?: { task?: { metadata?: unknown } } };
            delete body.result?.task?.metadata;
            return Response.json(body);
          }
          return res;
        },
      }),
    });
    const server = new McpServer({ tools: buildKiwiTools(service), serverInfo: { name: "receipt-test", version: "1" } });
    await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }));
    await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    return async (name: string, args: Record<string, unknown>) => {
      const reply = await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }));
      const result = reply?.result as { content: Array<{ text: string }>; isError?: boolean };
      return { payload: result.isError ? undefined : JSON.parse(result.content[0]!.text), isError: result.isError };
    };
  };
  return {
    open, capture, methods,
    client: (key: OpenInquirySessionSigner = signer) => new A2AClient({ url, signer: key, allowPrivateRanges: true, skipDnsCheck: true, timeoutMs: 1_000 }),
    async restartMerchant() { await stopMerchant(); await bootMerchant(); },
    async stop() {
      for (const store of stores) store.close();
      await stopMerchant();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

it("kiwi_get_task recovers the original signed RFQ after its response was lost, without a second send", async () => {
  const f = await fixture();
  try {
    const call = await f.open();
    const { payload: first } = await call("kiwi_request_quotes", request);
    expect(first.task.status).toBe("in_progress");
    expect(first.task.candidates[0]).toMatchObject({ status: "failed", retryable: false });
    expect(f.capture).toHaveLength(1);

    const otherSession = await f.open("another-session");
    expect((await otherSession("kiwi_get_task", { task_id: first.task_id })).isError).toBe(true);
    expect(f.methods).toEqual(["SendMessage"]);

    await f.restartMerchant(); // Reconstruct the merchant with an empty in-memory task registry.
    const reopened = await f.open();
    const { payload: refreshed } = await reopened("kiwi_get_task", { task_id: first.task_id });
    expect(refreshed.task).toMatchObject({ task_id: first.task_id, status: "succeeded", candidates: [{
      candidate_id: first.task.candidates[0].candidate_id, status: "succeeded",
      provenance: { negotiation_id: f.capture[0]!.negotiation_id, sku: "sku-001" },
    }] });
    expect(f.methods).toEqual(["SendMessage", "GetTask"]);
    expect(f.capture).toHaveLength(1);
    expect((await reopened("kiwi_get_task", { task_id: first.task_id })).payload.task.status).toBe("succeeded");
    expect(f.methods).toEqual(["SendMessage", "GetTask"]);
  } finally {
    await f.stop();
  }
});

it.each([
  { name: "the request never arrived", dropBefore: true },
  { name: "the GetTask response has no original request proof", stripProof: true },
])("keeps an RFQ unknown without resending when $name", async (options) => {
  const f = await fixture(options);
  try {
    const call = await f.open();
    const { payload: first } = await call("kiwi_request_quotes", request);
    const { payload: refreshed } = await call("kiwi_get_task", { task_id: first.task_id });
    expect(refreshed.task).toEqual(first.task);
    const { payload: replay } = await call("kiwi_request_quotes", request);
    expect(replay).toMatchObject({ created: false, task: first.task });
    expect(f.capture).toHaveLength(options.dropBefore ? 0 : 1);
    expect(f.methods).toEqual(["SendMessage", "GetTask", "GetTask"]);
  } finally {
    await f.stop();
  }
});

it("recovers a confirmed merchant refusal as a terminal rejection, not an unknown outcome", async () => {
  const f = await fixture({ stock: 1 });
  try {
    const call = await f.open();
    const { payload: first } = await call("kiwi_request_quotes", request);
    expect(first.task.status).toBe("in_progress");
    const { payload: refreshed } = await call("kiwi_get_task", { task_id: first.task_id });
    expect(refreshed.task).toMatchObject({ status: "failed", resumable: false, candidates: [{
      candidate_id: first.task.candidates[0].candidate_id, status: "failed",
      failure: { classification: "rejected", retryable: false },
    }] });
    expect((await call("kiwi_get_task", { task_id: first.task_id })).payload.task).toEqual(refreshed.task);
    expect(f.methods).toEqual(["SendMessage", "GetTask"]);
    expect(f.capture).toHaveLength(1);
  } finally {
    await f.stop();
  }
});

it("the merchant only returns the result to the original signer with the exact RFQ reference", async () => {
  const f = await fixture();
  try {
    const call = await f.open();
    await call("kiwi_request_quotes", request);
    const { message_id, negotiation_id, digest: wire_digest } = f.capture[0]!;
    const ref = { message_id, negotiation_id, wire_digest };
    const notFound = { jsonrpcCode: JSONRPC_CODES.TASK_NOT_FOUND };
    await expect(f.client(new OpenInquirySessionSigner()).getRfqReceipt(ref)).rejects.toMatchObject(notFound);
    await expect(f.client().getRfqReceipt({ ...ref, wire_digest: `sha256:${"0".repeat(64)}` })).rejects.toMatchObject(notFound);
    await expect(f.client().getRfqReceipt({ ...ref, negotiation_id: "neg-other" })).rejects.toMatchObject(notFound);
    await expect(f.client().getRfqReceipt(ref)).resolves.toHaveProperty("status.message");
    expect(f.capture).toHaveLength(1);
  } finally {
    await f.stop();
  }
});
