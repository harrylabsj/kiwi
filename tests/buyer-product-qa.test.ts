/** Copyright 2026 harrylabsj; SPDX-License-Identifier: Apache-2.0 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext } from "../src/a2a/server/types.js";
import { BuyerFollowups } from "../src/merchant-core/support/buyer-followups.js";
import { expect, it } from "vitest";
import { readBuyerFollowup } from "../src/buyer-core/a2a-buyer-followups.js";
import { A2AClient } from "../src/a2a/client/client.js";
import { OpenInquirySessionSigner, resolveOpenInquirySessionKey } from "../src/a2a/open-inquiry-session.js";
import { HttpMessageSignatureVerifier } from "../src/trust/identity/auth-verifier.js";
import { InMemoryNonceStore } from "../src/trust/identity/nonce.js";
import { A2ANegotiator } from "../src/buyer-core/a2a-negotiator.js";
import { A2AQuoteFetcher } from "../src/buyer-core/a2a-quote-fetcher.js";
import { KiwiCatalogMerchantIndex } from "../src/buyer-core/merchant-index.js";
import { KiwiBuyerService } from "../src/buyer-core/service.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import { DEFAULT_DELEGATION_POLICY } from "../src/mcp/cli.js";
import { buildKiwiTools } from "../src/mcp/tools.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { NOW, startTestA2aStack, type CapturedInbound } from "./helpers.js";

async function send(client: A2AClient, action: NegotiationEnvelope["action"], payload: Record<string, unknown>, id: string, opts: { text?: string; negotiation?: string } = {}) {
  const envelope = finalizeEnvelope({
    capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0",
    negotiation_id: opts.negotiation ?? "neg_public_facts", exchange_id: id, message_id: id,
    actor: "buyer", action, created_at: NOW, payload: { type: action, ...payload } as never,
  });
  return client.sendMessage({ role: "user", messageId: id, parts: [{ kind: "data", data: { knp_envelope: envelope } }, ...(opts.text === undefined ? [] : [{ kind: "text" as const, text: opts.text }])] });
}

it("answers a specification from the published product in the existing negotiation", async () => {
  const stack = await startTestA2aStack({
    productSource: { getProduct: async () => ({ price: 189, currency: "CNY", unit: "piece", stock: 120 }) },
    buyerProductQa: {
      merchantId: "shop_test",
      read: async () => ({ merchant_id: "shop_test", sku: "CUP-1", revision: "listing-test-2", fields: { capacity: "450 mL" } }),
    },
  });
  try {
    const client = new A2AClient({ url: stack.merchantUrl, allowPrivateRanges: true, skipDnsCheck: true });
    await send(client, "rfq", { items: [{ sku: "CUP-1", quantity: { value: 50, unit: "piece" } }] }, "msg_buy_1");
    const reply = await send(client, "clarification", { questions: [{ field: "capacity", reason: "这款杯子能装多少？" }] }, "msg_buy_2");
    expect(JSON.stringify(reply)).toContain("450 mL");
    expect(JSON.stringify(reply)).toContain("clarification_response");
    expect(reply.artifacts?.flatMap((artifact) => artifact.parts)).toContainEqual({ kind: "data", data: {
      type: "kiwi_product_answers", version: 1, answers: [{ index: 0, topic: "capacity", status: "answered", answer: "容量：450 mL", evidence: { sku: "CUP-1", revision: "listing-test-2", field: "capacity" } }],
    } });
  } finally {
    await stack.stop();
  }
});

const facts = { merchant_id: "shop_test", sku: "CUP-1", revision: "listing-test-2", fields: { features: "双层隔热", capacity: "450 mL" } };
const items = [{ sku: "CUP-1", quantity: { value: 50, unit: "piece" } }];
const productSource = { getProduct: async () => ({ price: 189, currency: "CNY", unit: "piece", stock: 120, source_evidence: { system: "fixture" } }) };
function clientFor(url: string, buyer?: string) {
  return new A2AClient({ url, allowPrivateRanges: true, skipDnsCheck: true, ...(buyer === undefined ? {} : { headers: { "x-fixture-buyer": buyer } }) });
}

it("answers a first inquiry, while withholding private or unverified product data", async () => {
  const stack = await startTestA2aStack({ productSource, buyerProductQa: {
    merchantId: "shop_test", read: async (sku) => sku === "CUP-1" ? facts : { ...facts, sku, merchant_id: "other-shop", fields: { capacity: "stolen fixture value" } },
  } });
  try {
    const client = clientFor(stack.merchantUrl);
    const reply = await send(client, "inquiry", { subject: { sku: "CUP-1" } }, "msg_features", { text: "有什么卖点，能装多少？能刻 Logo 吗？" });
    expect(reply.status.message?.parts.map((part) => part.kind)).toEqual(["text"]); // An inquiry is not a KNP clarification.
    expect(JSON.stringify(reply)).toContain("双层隔热");
    expect(JSON.stringify(reply)).toContain("450 mL");
    expect(JSON.stringify(reply)).toContain("needs_merchant");
    expect(JSON.stringify(reply)).not.toContain("qa_");
    const follow = await send(client, "clarification", { questions: [{ field: "capacity", reason: "容量呢？" }] }, "msg_next_capacity");
    expect(JSON.stringify(follow)).toContain("450 mL");
    const wrong = await send(client, "inquiry", { subject: { sku: "OUTSIDE" } }, "msg_wrong", { text: "How much does it hold?", negotiation: "neg_wrong" });
    expect(JSON.stringify(wrong)).toContain("unavailable");
    expect(JSON.stringify(wrong)).not.toContain("stolen fixture value");
  } finally { await stack.stop(); }
});

it("uses local topic candidates for paraphrases without letting them supply facts or select a SKU", async () => {
  const seen: unknown[] = [];
  let result: unknown = [{ index: 0, topics: ["capacity"] }];
  const stack = await startTestA2aStack({ productSource, buyerProductQa: {
    merchantId: "shop_test", read: async (sku) => sku === "CUP-1" ? facts : undefined,
    classifyLocal: async (questions) => { seen.push(questions); return result; },
  } });
  try {
    const client = clientFor(stack.merchantUrl);
    const ask = (id: string, text: string) => send(client, "inquiry", { subject: { sku: "CUP-1" } }, id, { text });
    const reply = await ask("msg_candidate", "一只灌满能灌进几毫升？");
    expect(seen).toEqual([[{ index: 0, text: "一只灌满能灌进几毫升？" }]]);
    expect(reply.artifacts?.flatMap((artifact) => artifact.parts)).toContainEqual({ kind: "data", data: {
      type: "kiwi_product_answers", version: 1, answers: [{ index: 0, topic: "capacity", status: "answered", answer: "容量：450 mL",
        evidence: { sku: "CUP-1", revision: "listing-test-2", field: "capacity" } }],
    } });
    result = [{ index: 0, topics: ["capacity"], sku: "OTHER", answer: "900 mL" }];
    const invalid = await ask("msg_invalid_candidate", "这一只灌满有几毫升？");
    expect(JSON.stringify(invalid)).not.toMatch(/900 mL|450 mL|kiwi_product_answers/);
    const structured = await send(client, "clarification", { questions: [{ field: "capacity", reason: "请核实" }] }, "msg_structured_candidate");
    expect(JSON.stringify(structured)).toContain("450 mL");
    expect(seen).toHaveLength(2);
  } finally { await stack.stop(); }
});

it("falls back after a local classification timeout and does not create a case from an unconfirmed topic", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-local-classifier-"));
  const queue = new BuyerFollowups(dir, "shop_test", () => NOW);
  let simulateTimeout = false;
  let aborted = false;
  const stack = await startTestA2aStack({
    productSource, buyerFollowups: () => queue,
    authVerifier: { name: "classifier-fixture", verify: () => ({ authenticated: true, identity: "buyer:classifier-test", identityVerified: true }) },
    buyerProductQa: { merchantId: "shop_test", read: async () => facts,
      classifyLocal: async (questions, signal) => simulateTimeout
        ? new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => {
          aborted = true; reject(new Error("fixture aborted"));
        }, { once: true }))
        : [{ index: questions[0]?.index, topics: ["material"] }],
    },
  });
  try {
    const client = clientFor(stack.merchantUrl);
    const missing = await send(client, "inquiry", { subject: { sku: "CUP-1" } }, "msg_inferred_missing", { text: "杯身用的什么料？" });
    expect(JSON.stringify(missing)).toContain("请确认您是否在问材质");
    expect(queue.listOwner()).toEqual([]);
    await send(client, "rfq", { items }, "msg_before_timeout");
    simulateTimeout = true;
    const fallback = await send(client, "clarification", { questions: [
      { field: "capacity", reason: "给出容量" }, { field: "details", reason: "杯身用的什么料？" },
    ] }, "msg_timeout");
    expect(aborted).toBe(true);
    expect(JSON.stringify(fallback)).toContain("clarification_response");
    expect(JSON.stringify(fallback)).toContain("450 mL");
    expect(queue.listOwner()).toEqual([]);
  } finally { await stack.stop(); rmSync(dir, { recursive: true, force: true }); }
});

it("accepts a slow local candidate only when the trusted host supplies a bounded longer budget", async () => {
  const stack = await startTestA2aStack({ productSource, buyerProductQa: {
    merchantId: "shop_test", read: async () => facts, classifyLocalTimeoutMs: 1_500,
    classifyLocal: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return [{ index: 0, topics: ["capacity"] }];
    },
  } });
  try {
    const reply = await send(clientFor(stack.merchantUrl), "inquiry", { subject: { sku: "CUP-1" } }, "msg_local_budget", { text: "一只灌满能灌进几毫升？" });
    expect(JSON.stringify(reply)).toContain("450 mL");
  } finally { await stack.stop(); }
});

it("resolves only a unique exact product title from a natural-language first inquiry", async () => {
  const readSkus: string[] = [];
  const stack = await startTestA2aStack({
    productSource: { ...productSource, findBuyerQaSku: (question) => question.includes("Fixture Cup") && !question.includes("Other Cup") ? "CUP-1" : undefined },
    buyerProductQa: { merchantId: "shop_test", read: async (sku) => { readSkus.push(sku); return facts; } },
  });
  try {
    const client = clientFor(stack.merchantUrl);
    const found = await send(client, "inquiry", {}, "msg_exact_title", { negotiation: "neg_exact_title", text: "Fixture Cup 的容量是多少？" });
    expect(JSON.stringify(found)).toContain("450 mL");
    const ambiguous = await send(client, "inquiry", {}, "msg_ambiguous_title", { negotiation: "neg_ambiguous_title", text: "Fixture Cup 和 Other Cup 的容量是多少？" });
    expect(JSON.stringify(ambiguous)).toContain("needs_input");
    expect(readSkus).toEqual(["CUP-1"]);
  } finally { await stack.stop(); }
});

it("creates one persistent follow-up and returns the owner's confirmed answer only to the original buyer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-buyer-followups-test-"));
  const clock = { value: NOW };
  const open = () => new BuyerFollowups(dir, "shop_test", () => clock.value);
  const stack = await startTestA2aStack({ productSource, now: () => clock.value,
    authVerifier: { name: "fixture-only", verify: (raw: unknown) => {
      const value = (raw as AuthContext).headers?.["x-fixture-buyer"];
      return { authenticated: typeof value === "string", identity: "buyer:" + String(value), identityVerified: true };
    } }, buyerFollowups: open, buyerProductQa: { merchantId: "shop_test", read: async () => facts },
  });
  try {
    const buyer = clientFor(stack.merchantUrl, "original");
    const other = clientFor(stack.merchantUrl, "someone-else");
    const question = { subject: { sku: "CUP-1" }, questions: [{ code: "product.customization" }] };
    const first = await send(buyer, "inquiry", question, "msg_case");
    const again = await send(buyer, "inquiry", question, "msg_case");
    const owner = open(); // fresh repository instance over file-backed SQLite
    const cases = owner.listOwner();
    expect(cases).toHaveLength(1);
    const once = cases[0]!;
    expect(JSON.stringify(first)).toContain(once.case_ref);
    expect(JSON.stringify(again)).toContain(once.case_ref);
    const payload = { subject: { kiwi_buyer_followup: { version: 1, case_ref: once.case_ref, negotiation_id: "neg_public_facts" } } };
    const opts = { negotiation: "neg_poll" };
    const pending = await send(buyer, "inquiry", payload, "msg_poll_1", opts);
    expect(JSON.stringify(pending)).toContain('"status":"pending"');
    owner.changeOwner("fixture-owner", once.case_ref, once.version, { kind: "claim" });
    expect(() => owner.changeOwner("fixture-owner", once.case_ref, once.version, { kind: "answer", answer: "stale answer" })).toThrow("conflict");
    open().changeOwner("fixture-owner", once.case_ref, once.version + 1, { kind: "answer", answer: "支持单色丝印" });
    const read = await send(buyer, "inquiry", payload, "msg_poll_2", opts);
    expect(JSON.stringify(read)).toContain("支持单色丝印");
    expect(await readBuyerFollowup(buyer, { case_ref: once.case_ref, negotiation_id: "neg_public_facts" }, () => clock.value)).toMatchObject({ status: "answered", answer: "支持单色丝印" });
    const denied = await send(other, "inquiry", payload, "msg_other", { negotiation: "neg_other" });
    expect(JSON.stringify(denied)).not.toContain("支持单色丝印");
    expect(JSON.stringify(denied)).not.toContain(once.case_ref);
    clock.value = new Date(Date.parse(NOW) + 8 * 86_400_000).toISOString();
    const replay = await send(buyer, "inquiry", payload, "msg_poll_2", opts);
    expect(JSON.stringify(replay)).not.toContain("支持单色丝印");
    expect(JSON.stringify(replay)).toContain('"status":"expired"');
  } finally { await stack.stop(); rmSync(dir, { recursive: true, force: true }); }
});

it("exposes a signed A2A clarification and the merchant's later answer to the buyer MCP tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-buyer-mcp-test-"));
  const now = () => new Date().toISOString();
  const signer = new OpenInquirySessionSigner();
  const queue = new BuyerFollowups(dir, "shop_test", now);
  const sku = "sku-001";
  const stack = await startTestA2aStack({
    now, productSource: { getProduct: async () => ({ price: 189, currency: "CNY", unit: "piece", stock: 120, source_evidence: { system: "fixture" } }) },
    buyerProductQa: { merchantId: "shop_test", read: async () => ({ ...facts, sku }) }, buyerFollowups: () => queue,
    buyerNegotiationAssist: true, merchantPolicy: { max_auto_discount_percent: 10 },
    authVerifier: new HttpMessageSignatureVerifier({ resolver: resolveOpenInquirySessionKey,
      scheme: "http", expectedAuthority: "127.0.0.1", nonceStore: new InMemoryNonceStore() }),
  });
  const store = new TaskApprovalStore({ dbPath: join(dir, "buyer.sqlite") });
  try {
    const protocol = { localBuyerAgentId: "buyer-agent:fixture", protocolStateDir: join(dir, "protocol"),
      allowPrivateRanges: true, skipDnsCheck: true, signer, timeoutMs: 3000, now };
    const service = new KiwiBuyerService({ store, principal: "fixture", buyerAgentId: protocol.localBuyerAgentId, sessionId: "fixture",
      delegationPolicy: DEFAULT_DELEGATION_POLICY, merchantIndex: new KiwiCatalogMerchantIndex({ baseUrl: stack.catalogUrl }),
      quoteFetcher: new A2AQuoteFetcher(protocol), negotiator: new A2ANegotiator(protocol), now });
    expect(buildKiwiTools(service).some((tool) => tool.name === "kiwi_get_merchant_followup")).toBe(false);
    const tools = buildKiwiTools(service, "legacy13", { merchantFollowups: true });
    async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const tool = tools.find((item) => item.name === name);
      if (tool === undefined) throw new Error("missing test tool");
      const result = await tool.handle(args);
      expect(result.isError, result.content[0]?.text).not.toBe(true);
      return JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;
    }
    const quote = await call("kiwi_request_quotes", { merchant_ids: ["merchant-001"], idempotency_key: "hermes-fixture-rfq",
      intent: { intent_id: "intent-hermes-fixture", intent_type: "procurement", items: [{ query: "Test Product", sku, quantity: { value: 50, unit: "piece" } }] } });
    expect(typeof quote.task_id).toBe("string");
    const clarification = await call("kiwi_negotiate", { task_id: quote.task_id, action: "clarification", summary: "杯子的容量是多少？能印 Logo 吗？" });
    const step = clarification.step as { merchant_extensions?: { candidate_id: string; product_answers?: Array<{ followup?: { case_ref: string } }> } };
    expect(step.merchant_extensions?.product_answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ topic: "capacity", answer: "容量：450 mL", evidence: expect.objectContaining({ sku }) }),
      expect.objectContaining({ topic: "customization", status: "needs_merchant", followup: expect.objectContaining({ status: "pending" }) }),
    ]));
    const ref = step.merchant_extensions?.product_answers?.find((answer) => answer.followup !== undefined)?.followup?.case_ref;
    const query = { task_id: quote.task_id, candidate_id: step.merchant_extensions?.candidate_id, case_ref: ref };
    expect(await call("kiwi_get_merchant_followup", query)).toMatchObject({ status: "pending" });
    expect(await call("kiwi_get_merchant_followup", { ...query, candidate_id: "other-candidate" })).toEqual({ status: "unavailable" });
    queue.changeOwner("fixture-owner", String(ref), 1, { kind: "claim" });
    queue.changeOwner("fixture-owner", String(ref), 2, { kind: "answer", answer: "支持单色丝印" });
    expect(await call("kiwi_get_merchant_followup", query)).toMatchObject({ status: "answered", answer: "支持单色丝印" });
    const counter = await call("kiwi_negotiate", { task_id: quote.task_id, action: "counter_offer", summary: "如果改买100件，交期可以放宽吗？" });
    expect(counter.step).toMatchObject({ merchant_extensions: { candidate_id: query.candidate_id, next_step: {
      kind: "new_rfq", sku, quantity: { value: 100, unit: "piece" }, requires_buyer_confirmation: true,
    } } });
    const counterStep = counter.step as { reply: string };
    expect(JSON.parse(counterStep.reply)).toMatchObject({ payload: { base_terms: { items: [{ sku, quantity: { value: 50, unit: "piece" } }] } } });
  } finally { await stack.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("keeps a quantity suggestion non-binding and reprices only the buyer's explicit new RFQ", async () => {
  const capture: CapturedInbound[] = [];
  let currentPrice = 189;
  let currentStock = 120;
  const stack = await startTestA2aStack({ capture, buyerNegotiationAssist: true, merchantPolicy: { max_auto_discount_percent: 10 },
    productSource: { getProduct: async () => ({ price: currentPrice, stock: currentStock, unit: "piece", currency: "CNY", source_evidence: { system: "fixture" } }) },
  });
  try {
    const client = clientFor(stack.merchantUrl);
    const quote = await send(client, "rfq", { items }, "msg_quote_start");
    const offered = quote.status.message?.parts.find((part) => part.kind === "data")?.data.knp_envelope as { payload?: { offer_id?: string } } | undefined;
    expect(offered?.payload?.offer_id).toBeTruthy();
    const result = await send(client, "counter_offer", { offer_id: "off_buyer", responding_to_offer_id: offered?.payload?.offer_id,
      proposed_terms: { currency: "CNY", items: [{ ...items[0], unit_price: { currency: "CNY", amount_minor: 18_000 } }] },
    }, "msg_tradeoff", { text: "如果改买100件，交期可以放宽吗？" });
    const payload = result.status.message?.parts.find((part) => part.kind === "data")?.data.knp_envelope as { payload?: { base_terms?: { items?: unknown[] } } } | undefined;
    expect(payload?.payload?.base_terms?.items?.[0]).toMatchObject({ quantity: { value: 50, unit: "piece" }, unit_price: { amount_minor: 18_000 } });
    expect(result.artifacts?.flatMap((artifact) => artifact.parts)).toContainEqual({ kind: "data", data: {
      type: "kiwi_negotiation_next_step", version: 1, kind: "new_rfq", sku: "CUP-1", quantity: { value: 100, unit: "piece" }, requires_buyer_confirmation: true,
    } });
    expect(capture.map(({ action }) => action)).toEqual(["rfq", "counter_offer"]);

    // An explicit RFQ in a new negotiation uses current authority, not the earlier cache or counter terms.
    currentPrice = 209;
    const newItems = [{ sku: "CUP-1", quantity: { value: 100, unit: "piece" } }];
    const renewed = await send(client, "rfq", { items: newItems }, "msg_new_quantity", { negotiation: "neg_quantity_confirmed" });
    const wire = renewed.status.message?.parts.find((part) => part.kind === "data")?.data.knp_envelope;
    expect(wire).toMatchObject({ action: "offer", negotiation_id: "neg_quantity_confirmed", payload: {
      terms: { items: [{ ...newItems[0], unit_price: { amount_minor: 20_900, currency: "CNY" } }] },
    } });

    currentStock = 90;
    const unavailable = await send(client, "rfq", { items: newItems }, "msg_new_quantity_insufficient", { negotiation: "neg_quantity_unavailable" });
    expect(unavailable.status.message?.parts).toEqual([{ kind: "data", data: { decline: true, reason_code: "temporarily_unavailable" } }]);
  } finally { await stack.stop(); }
});
