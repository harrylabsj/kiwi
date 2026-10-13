import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMerchantHandler, type MerchantProductSource } from "../src/a2a/server/merchant-handler.js";
import { createFileProductSource, type CloudProductTable } from "../src/cloud/product-source.js";
import { finalizeEnvelope, validateWireEnvelope } from "../src/negotiation/domain/envelope.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { evaluateConditionalOffer } from "../src/negotiation/condition/evaluator.js";
import type { NegotiationHandlerResult } from "../src/a2a/server/types.js";

const NOW = "2026-10-13T00:00:00.000Z";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
type Facts = Awaited<ReturnType<MerchantProductSource["getProduct"]>>;
const base = (): Facts => ({ price: 100, currency: "CNY", unit: "box", stock: 20, valid_until: "2026-10-14T00:00:00.000Z", handoff_destination: "https://example.com/item/1", source_evidence: { system: "owned-fixture", source_version: "revision-1" } });
function setup(facts = base(), source?: MerchantProductSource, promotionPrice?: Parameters<typeof createMerchantHandler>[0]["promotionPrice"]) {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-source-facts-")); dirs.push(dir);
  let current = facts;
  let time = NOW;
  let reads = 0;
  const ledger = new LedgerStore({ dir, now: () => time });
  const options = { ...(promotionPrice !== undefined ? { promotionPrice } : {}), ledger, now: () => time, sender: "merchant:merchant-001", counterparty: "buyer:*", productSource: source ?? { getProduct: async () => { reads++; return current; } } };
  let handler = createMerchantHandler(options);
  let seq = 0;
  const send = async (action: string, payload: Record<string, unknown>, in_reply_to = "msg_previous") => {
    const envelope = finalizeEnvelope({ capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0", negotiation_id: "neg_owned", exchange_id: `ex_${++seq}`, message_id: `msg_${seq}`, actor: "buyer", action: action as never, created_at: time, payload: payload as never, in_reply_to });
    return handler.handle({ envelope: envelope as never, message: { role: "user", parts: [], messageId: envelope.message_id }, taskId: "task-owned", senderIdentity: "buyer:buyer-001" });
  };
  const quote = async () => send("rfq", { type: "rfq", items: [{ sku: "SKU", quantity: { value: 5, unit: "box" } }] });
  const accept = async (result: NegotiationHandlerResult) => {
    const envelope = outgoing(result);
    const payload = envelope.payload as { offer_id: string; terms?: Record<string, unknown>; base_terms?: Record<string, unknown>; conditions?: unknown[] };
    const terms = payload.terms ?? evaluateConditionalOffer(payload as never, { "aggregate.total_quantity": 5 });
    return send("accept_nonbinding", { type: "accept_nonbinding", offer_id: payload.offer_id, terms_digest: contentDigest(terms as never) }, envelope.message_id);
  };
  return { quote, accept, send, ledger, options, set: (value: Facts) => { current = value; }, time: (value: string) => { time = value; }, restart: () => { handler = createMerchantHandler({ ...options, ledger: new LedgerStore({ dir, now: () => time }) }); }, reads: () => reads };
}
function outgoing(result: NegotiationHandlerResult) {
  expect(result.kind).toBe("accepted");
  if (result.kind !== "accepted") throw new Error("Expected response");
  const env = (result.message?.parts[0] as unknown as { data: { knp_envelope: ReturnType<typeof finalizeEnvelope> } }).data.knp_envelope;
  return env;
}
function noAgreement(f: ReturnType<typeof setup>, result: NegotiationHandlerResult) {
  expect(result.kind).toBe("declined");
  expect(f.ledger.events("neg_owned").some(e => e.state_transition?.to_phase === "AGREEMENT_REACHED")).toBe(false);
  expect(f.ledger.verifyChain("neg_owned").valid).toBe(true);
}

describe("actual handler source facts and accept preconditions", () => {
  it("uses requested SKU/quantity and exact source unit, real metadata stays in internal hashed ledger", async () => {
    const f = setup(); const q = await f.quote(); const env = outgoing(q);
    expect(validateWireEnvelope(env)).toMatchObject({ action: "offer", digest: env.digest });
    expect((env.payload as { terms: { items: unknown[] } }).terms.items).toEqual([{ sku: "SKU", quantity: { value: 5, unit: "box" }, unit_price: { currency: "CNY", amount_minor: 10000 } }]);
    const e = f.ledger.events("neg_owned").find(e => e.event_kind === "message_sent");
    expect(e?.outcome.kind === "ok" && e.outcome.result?.merchant_quote_source).toMatchObject({ snapshot: { sku: "SKU", quantity: 5, source_evidence: { source_version: "revision-1" } } });
    const a = await f.accept(q); expect(a.kind).toBe("accepted"); expect(a.kind === "accepted" && a.artifactParts?.[0]).toMatchObject({ data: { agreement: { creates_order: false, reserves_inventory: false, authorizes_payment: false } } });
    expect(f.reads()).toBe(2);
  });
  it.each([undefined, "piece"])("refuses source/request unit mismatch without synonyms (%s)", async unit => {
    const f = setup({ ...base(), unit }); const result = await f.quote(); expect(result.kind === "declined" && result.reasonCode).toBe("field_unsupported");
  });
  it.each([{}, { sku: "SKU" }, { sku: "SKU", quantity: { value: 5 } }])("does not fabricate required request fields %j", async item => {
    const f = setup(); const r = await f.send("rfq", { type: "rfq", items: [item] }); expect(r.kind === "declined" && r.reasonCode).toBe("schema_invalid");
  });
  it("unknown stock produces confirmation-only proposal without handoff and cannot accept", async () => {
    const f = setup({ ...base(), stock: undefined }); const q = await f.quote(); const env = outgoing(q);
    expect(env.public_message).toContain("needs_confirmation"); expect((env.payload as { terms: unknown }).terms).not.toHaveProperty("handoff_destination"); noAgreement(f, await f.accept(q));
  });
  it.each([NaN, Infinity, -1, 1.5, "10"])("rejects invalid stock runtime values %s", async stock => {
    const f = setup({ ...base(), stock: stock as number }); expect((await f.quote()).kind).toBe("declined");
  });
  it.each(["unit", "currency", "price", "handoff_destination", "valid_until", "source_evidence", "stock"] as const)("rechecks changed %s before phase/agreement", async field => {
    const f = setup(); const q = await f.quote(); const changed = base();
    if (field === "unit") changed.unit = "piece";
    if (field === "currency") changed.currency = "USD";
    if (field === "price") changed.price = 101;
    if (field === "handoff_destination") changed.handoff_destination = "https://example.com/item/2";
    if (field === "valid_until") changed.valid_until = "2026-10-15T00:00:00.000Z";
    if (field === "source_evidence") changed.source_evidence = { system: "owned-fixture", source_version: "revision-2" };
    if (field === "stock") changed.stock = undefined;
    f.set(changed); noAgreement(f, await f.accept(q));
  });
  it("allows still-sufficient inventory fluctuation, rejects insufficient and unknown source", async () => {
    const f = setup(); const q = await f.quote(); f.set({ ...base(), stock: 6 }); expect((await f.accept(q)).kind).toBe("accepted");
    const low = setup(); const lq = await low.quote(); low.set({ ...base(), stock: 4 }); noAgreement(low, await low.accept(lq));
    const unknown = setup(); const uq = await unknown.quote(); unknown.set({ ...base(), source_evidence: undefined }); noAgreement(unknown, await unknown.accept(uq));
  });
  it("expiry is exclusive at the exact deadline and source caps terms", async () => {
    const f = setup({ ...base(), valid_until: "2026-10-13T00:00:10.000Z" }); const q = await f.quote(); expect((outgoing(q).payload as { terms: { valid_until: string } }).terms.valid_until).toBe("2026-10-13T00:00:10.000Z");
    f.time("2026-10-13T00:00:10.000Z"); noAgreement(f, await f.accept(q));
    const expired = setup({ ...base(), valid_until: NOW }); expect((await expired.quote()).kind).toBe("declined");
  });
  it("restart restores original snapshot, not current facts or a replacement grant", async () => {
    const f = setup(); const q = await f.quote(); f.set({ ...base(), handoff_destination: "https://example.com/changed" }); f.restart(); noAgreement(f, await f.accept(q));
    const same = setup(); const sq = await same.quote(); same.restart(); expect((await same.accept(sq)).kind).toBe("accepted");
  });
  it("revalidates current promotion revision before accepting the saved promoted terms", async () => {
    let revision = 1;
    const f = setup(base(), undefined, () => ({ promotionId: "owned-prm", revision, currency: "CNY", amountMinor: "8000", endsAt: "2026-10-13T01:00:00Z" }));
    const q = await f.quote(); revision = 2; noAgreement(f, await f.accept(q));
    const stable = setup(base(), undefined, () => ({ promotionId: "owned-prm", revision: 1, currency: "CNY", amountMinor: "8000", endsAt: "2026-10-13T01:00:00Z" }));
    const sq = await stable.quote(); expect((await stable.accept(sq)).kind).toBe("accepted");
  });
  it.each([85.005, -1, NaN])("rejects lossy or invalid source price %s", async price => {
    const f = setup({ ...base(), price }); expect((await f.quote()).kind).toBe("declined");
  });
  it("rejects mismatched source SKU and scopes legacy evidence to the original source", async () => {
    const f = setup({ ...base(), sku: "OTHER" }); expect((await f.quote()).kind).toBe("declined");
    const missing = setup({ ...base(), source_evidence: undefined }); const q = await missing.quote(); expect(outgoing(q).public_message).toContain("needs_confirmation"); expect((outgoing(q).payload as { terms: unknown }).terms).not.toHaveProperty("handoff_destination"); noAgreement(missing, await missing.accept(q));
  });
  it("legacy ledger offers without original snapshot cannot be accepted after restart", async () => {
    const old = setup(); const q = await old.quote(); const env = outgoing(q);
    const dir = mkdtempSync(join(tmpdir(), "kiwi-legacy-no-snapshot-")); dirs.push(dir);
    const legacy = new LedgerStore({ dir, now: () => NOW });
    legacy.ensureCounterpartyBinding({ negotiationId: "neg_owned", localIdentity: "merchant:merchant-001", senderIdentity: "buyer:buyer-001", actor: "buyer" });
    await legacy.append({ event_kind: "message_sent", negotiation_id: "neg_owned", message_id: env.message_id, identity: { sender_identity: "merchant:merchant-001", counterparty_identity: "buyer:buyer-001", actor: "merchant" }, capability: { capability: env.capability, protocol_version: "1.0" }, wire_digest: env.digest, wire_payload: env as unknown as Record<string, unknown>, outcome: { kind: "ok" }, occurred_at: NOW });
    const handler = createMerchantHandler({ ...old.options, ledger: legacy });
    const payload = env.payload as { offer_id: string; terms: unknown };
    const accept = finalizeEnvelope({ ...env, actor: "buyer", action: "accept_nonbinding", message_id: "msg_legacy_accept", in_reply_to: env.message_id, payload: { type: "accept_nonbinding", offer_id: payload.offer_id, terms_digest: contentDigest(payload.terms as never) } as never });
    const r = await handler.handle({ envelope: accept as never, message: { role: "user", parts: [], messageId: accept.message_id }, taskId: "legacy-owned", senderIdentity: "buyer:buyer-001" });
    expect(r).toMatchObject({ kind: "declined", reasonCode: "offer_unknown" });
  });
  it("counter/conditional terms preserve source unit and confirmation-only unknown inventory", async () => {
    const f = setup({ ...base(), stock: undefined });
    const counter = await f.send("offer", { type: "offer", offer_id: "off_buyer", terms: { items: [{ sku: "SKU", quantity: { value: 5, unit: "box" }, unit_price: { currency: "CNY", amount_minor: 8000 } }], valid_until: "2026-10-14T00:00:00Z" } });
    expect((outgoing(counter).payload as { proposed_terms: { items: Array<{ quantity: unknown }> } }).proposed_terms.items[0]?.quantity).toEqual({ value: 5, unit: "box" });
    const q = await f.send("counter_offer", { type: "counter_offer", offer_id: "off_buyer2", responding_to_offer_id: (outgoing(counter).payload as { offer_id: string }).offer_id, proposed_terms: { items: [{ sku: "SKU", quantity: { value: 5, unit: "box" }, unit_price: { currency: "CNY", amount_minor: 8000 } }], valid_until: "2026-10-14T00:00:00Z" } }, outgoing(counter).message_id);
    expect(outgoing(q).public_message).toContain("needs_confirmation"); noAgreement(f, await f.accept(q));
  });
  it("file source admits zero price and detects changed same-mtime bytes, while stock-only update remains valid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-real-file-facts-")); dirs.push(dir); const file = join(dir, "products.json");
    const table: CloudProductTable = { schema_version: "0.1.2", merchant_id: "merchant-001", source: "test_fixture", generated_at: NOW, products: [{ sku: "SKU", title: "Owned fixture", unit: "box", price: 0, currency: "CNY", updated_at: NOW, valid_until: "2026-10-14T00:00:00Z", status: "active", stock: 20 }] };
    writeFileSync(file, JSON.stringify(table)); const source = createFileProductSource({ file, merchantId: "merchant-001", now: () => Date.parse(NOW) }).source;
    const f = setup(base(), source); const q = await f.quote(); expect((outgoing(q).payload as { terms: { items: Array<{ unit_price: unknown }> } }).terms.items[0]?.unit_price).toEqual({ currency: "CNY", amount_minor: 0 });
    const before = statSync(file); table.products[0]!.stock = 6; writeFileSync(file, JSON.stringify(table)); utimesSync(file, before.atime, before.mtime);
    expect((await f.accept(q)).kind).toBe("accepted");
    const changed = setup(base(), source); const cq = await changed.quote(); table.products[0]!.unit = "piece"; writeFileSync(file, JSON.stringify(table)); utimesSync(file, before.atime, before.mtime); noAgreement(changed, await changed.accept(cq));
  });
});
