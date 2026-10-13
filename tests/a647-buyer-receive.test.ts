import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuyerProtocolRecovery, ProtocolOperationUnknown, type ProtocolExchange } from "../src/buyer-core/protocol-recovery.js";
import { BuyerReplyRejected } from "../src/buyer-core/receive-gate.js";
import { buildCounterEnvelope, buildRfqEnvelope } from "../src/buyer-core/a2a-knp.js";
import { A2ANegotiator } from "../src/buyer-core/a2a-negotiator.js";
import { A2AQuoteFetcher } from "../src/buyer-core/a2a-quote-fetcher.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import type { TermSet } from "../src/negotiation/domain/common.js";
import type { A2ATask } from "../src/a2a/client/types.js";

const NOW = "2026-10-13T00:00:00.000Z";
const FUTURE = "2026-10-13T00:00:01.000Z";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const context = { taskId: "task-a647", createdAt: NOW, intentBindingDigest: contentDigest("real persisted intent") };
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a647-")); dirs.push(dir); return dir; }
function task(envelope: NegotiationEnvelope, working = false): A2ATask {
  return { id: "remote-a647", contextId: "context-a647", status: { state: working ? "working" : "completed",
    message: { role: "agent", messageId: envelope.message_id, parts: [{ kind: "data", data: { knp_envelope: envelope } }] } } };
}
function terms(minor = 100): TermSet {
  return { items: [{ sku: "SKU", quantity: { value: 2, unit: "kg" }, unit_price: { currency: "CNY", amount_minor: minor } }], valid_until: FUTURE };
}
function offer(wire: NegotiationEnvelope, proposed = terms()): NegotiationEnvelope {
  return finalizeEnvelope({ capability: wire.capability, protocol_version: "1.0", negotiation_id: wire.negotiation_id,
    exchange_id: "ex-merchant", message_id: "msg-merchant", in_reply_to: wire.message_id, actor: "merchant",
    action: "offer", created_at: NOW, payload: { type: "offer", offer_id: "off-merchant", terms: proposed } });
}
function counterReply(wire: NegotiationEnvelope, accept = false): NegotiationEnvelope {
  const payload = wire.payload;
  if (payload.type !== "counter_offer") throw Error("counter fixture expected");
  return finalizeEnvelope({ capability: wire.capability, protocol_version: "1.0", negotiation_id: wire.negotiation_id,
    exchange_id: "ex-merchant", message_id: "msg-counter-reply", in_reply_to: wire.message_id, actor: "merchant",
    action: accept ? "accept_nonbinding" : "counter_offer", created_at: NOW,
    payload: accept ? { type: "accept_nonbinding", offer_id: payload.offer_id, terms_digest: contentDigest(payload.proposed_terms) }
      : { type: "counter_offer", offer_id: "off-merchant-counter", responding_to_offer_id: payload.offer_id, proposed_terms: terms() } });
}
function mutate(wire: NegotiationEnvelope, change: (e: NegotiationEnvelope) => void) {
  const e = structuredClone(wire); change(e); return finalizeEnvelope(e);
}
function fixture(stage: "rfq" | "counter" = "rfq", now: () => string = () => NOW) {
  const dir = temp(), recovery = new BuyerProtocolRecovery(dir, "buyer-a647", now);
  let sends = 0, gets = 0;
  const wires: NegotiationEnvelope[] = [];
  let respond = stage === "rfq" ? offer : (wire: NegotiationEnvelope) => counterReply(wire);
  let working = false;
  const input: ProtocolExchange = { context, stage, round: stage === "rfq" ? 0 : 1,
    merchantId: "merchant-a647", endpoint: "http://127.0.0.1:1/rpc", binding: { actual: "request" },
    build: id => stage === "rfq" ? buildRfqEnvelope({ negotiationId: id, sku: "SKU", quantity: { value: 2, unit: "kg" }, now: () => NOW })
      : buildCounterEnvelope({ negotiationId: id, sku: "SKU", quantity: 2, quantityUnit: "kg", counterPriceMinor: 0,
        respondingToOfferId: "off-prior", inReplyTo: "msg-prior", now: () => NOW }),
    send: async wire => { sends++; wires.push(wire); return task(working ? wire : respond(wire), working); },
    get: async () => { gets++; return task(respond(wires[0]!)); }, timeoutMs: 0, pollIntervalMs: 1 };
  return { dir, recovery, input, wires, counts: () => ({ sends, gets }), set: (fn: typeof respond) => { respond = fn; }, working: () => { working = true; } };
}
function persistHistoricalComplete(f: ReturnType<typeof fixture>, reply: NegotiationEnvelope) {
  const sent = f.recovery.ledger.events(f.wires[0]!.negotiation_id).find(e => e.event_kind === "message_sent")!;
  if (sent.outcome.kind !== "ok") throw Error("successful send fixture required");
  const op = sent.outcome.result!.buyer_operation as Record<string, unknown>;
  return f.recovery.ledger.append({ event_kind: "message_received", negotiation_id: reply.negotiation_id,
    message_id: reply.message_id, exchange_id: reply.exchange_id, in_reply_to: reply.in_reply_to,
    identity: { sender_identity: "merchant-a647", counterparty_identity: "buyer-a647", actor: "merchant" },
    capability: { capability: reply.capability, protocol_version: reply.protocol_version }, wire_digest: reply.digest,
    wire_payload: reply as unknown as Record<string, unknown>, occurred_at: reply.created_at,
    outcome: { kind: "ok", result: { buyer_operation: { ...op, kind: "complete" } } },
    remote_task_id: "remote-a647", remote_context_id: "context-a647" });
}
const invalidCases: Array<[string, (e: NegotiationEnvelope) => void, string]> = [
  ["sku", e => { if (e.payload.type === "offer") e.payload.terms.items![0]!.sku = "OTHER"; }, "sku_mismatch"],
  ["quantity", e => { if (e.payload.type === "offer") e.payload.terms.items![0]!.quantity.value = 3; }, "quantity_mismatch"],
  ["unit", e => { if (e.payload.type === "offer") e.payload.terms.items![0]!.quantity.unit = "piece"; }, "unit_unmapped"],
  ["exact expiry", e => { if (e.payload.type === "offer") e.payload.terms.valid_until = NOW; }, "offer_expired"],
  ["past expiry", e => { if (e.payload.type === "offer") e.payload.terms.valid_until = "2026-10-12T23:59:59Z"; }, "offer_expired"],
  ["invalid expiry", e => { if (e.payload.type === "offer") e.payload.terms.valid_until = "not-a-time"; }, "wire_invalid"],
  ["unsafe price", e => { if (e.payload.type === "offer") e.payload.terms.items![0]!.unit_price!.amount_minor = Number.MAX_SAFE_INTEGER + 1; }, "price_invalid"],
  ["two items", e => { if (e.payload.type === "offer") e.payload.terms.items!.push(structuredClone(e.payload.terms.items![0]!)); }, "unsupported_offer_shape"],
  ["unknown root", e => { Object.assign(e, { transport_signature: "unexpected" }); }, "wire_invalid"],
];

describe("A647 real exchange and persisted complete admission", () => {
  it.each(invalidCases)("fresh %s refuses before commercial ledger/commit, replay only polls", async (_name, change, reason) => {
    const f = fixture(); f.set(w => mutate(offer(w), change));
    await expect(f.recovery.exchange(f.input)).rejects.toMatchObject({ reason, detail: { reconciliation_required: true, remote_execution_status: "not_inferred" } });
    const before = f.recovery.ledger.events(f.wires[0]!.negotiation_id);
    expect(before.some(e => e.event_kind === "message_received")).toBe(false);
    expect(before.some(e => e.remote_task_id === "remote-a647")).toBe(true);
    await expect(new BuyerProtocolRecovery(f.dir, "buyer-a647", () => NOW).exchange(f.input)).rejects.toMatchObject({ reason });
    expect(f.counts()).toEqual({ sends: 1, gets: 1 });
    expect(f.recovery.ledger.events(f.wires[0]!.negotiation_id)).toEqual(before);
  });
  it.each(invalidCases)("historic complete %s remains untouched and is refused on both exchange/recover", async (_name, change, reason) => {
    const f = fixture(); f.working(); await expect(f.recovery.exchange(f.input)).rejects.toBeInstanceOf(ProtocolOperationUnknown);
    persistHistoricalComplete(f, mutate(offer(f.wires[0]!), change));
    const before = f.recovery.ledger.events(f.wires[0]!.negotiation_id);
    const reopened = new BuyerProtocolRecovery(f.dir, "buyer-a647", () => NOW);
    await expect(reopened.exchange(f.input)).rejects.toMatchObject({ reason });
    await expect(reopened.recover(context, async () => { throw Error("no new poll for a complete"); }, 0, 1)).rejects.toMatchObject({ reason });
    expect(reopened.ledger.events(f.wires[0]!.negotiation_id)).toEqual(before);
    expect(f.counts()).toEqual({ sends: 1, gets: 0 });
  });
  it.each([0, 100])("valid price %i is admitted, original wire IDs/time and complete are reused", async minor => {
    const f = fixture(); f.set(w => offer(w, terms(minor))); const first = await f.recovery.exchange(f.input);
    const second = await new BuyerProtocolRecovery(f.dir, "buyer-a647", () => NOW).exchange(f.input);
    expect(second).toEqual(first); expect(f.counts()).toEqual({ sends: 1, gets: 0 });
    expect(f.recovery.ledger.events(first.wire.negotiation_id).filter(e => e.event_kind === "message_received")).toHaveLength(1);
  });
  it("optional expiry stays optional; fractional requested quantity is legal when its total is representable", async () => {
    const f = fixture(); const build = f.input.build; f.input.build = id => mutate(build(id), e => { if (e.payload.type === "rfq") e.payload.items[0]!.quantity.value = 0.5; });
    f.set(w => { const t = terms(); t.items![0]!.quantity.value = 0.5; delete t.valid_until; return offer(w, t); });
    await expect(f.recovery.exchange(f.input)).resolves.toBeDefined();
  });
  it("invalid now never bypasses expiry or commits a reply", async () => {
    const f = fixture("rfq", () => "not-a-clock"); await expect(f.recovery.exchange(f.input)).rejects.toMatchObject({ reason: "clock_invalid" });
    expect(f.recovery.ledger.events(f.wires[0]!.negotiation_id).filter(e => e.event_kind === "message_received")).toHaveLength(0);
  });
  it("persisted valid complete expires at reopen rather than renewing its terms", async () => {
    const f = fixture(); const done = await f.recovery.exchange(f.input); const before = f.recovery.ledger.events(done.wire.negotiation_id);
    await expect(new BuyerProtocolRecovery(f.dir, "buyer-a647", () => FUTURE).exchange(f.input)).rejects.toMatchObject({ reason: "offer_expired" });
    expect(f.recovery.ledger.events(done.wire.negotiation_id)).toEqual(before); expect(f.counts()).toEqual({ sends: 1, gets: 0 });
  });
  it("empty-conditions conditional_offer replying to an RFQ is refused (RFQ is not an active offer)", async () => {
    // A659：空 conditions 形状本身被兼容（§13 ≡ base_terms），但 conditional
    // 必须响应 buyer 已外发 counter 的 offer_id——引用 RFQ 仍 proposal_ref_mismatch。
    const f = fixture(); f.set(w => finalizeEnvelope({ ...offer(w), action: "conditional_offer",
      payload: { type: "conditional_offer", offer_id: "off-cond", base_terms: terms(), conditions: [] } }));
    await expect(f.recovery.exchange(f.input)).rejects.toMatchObject({ reason: "proposal_ref_mismatch" });
    expect(f.recovery.ledger.events(f.wires[0]!.negotiation_id).filter(e => e.event_kind === "message_received")).toHaveLength(0);
  });
  it("empty-conditions conditional_offer binding the actual counter offer_id adopts base_terms through the full terms gate", async () => {
    // A659 经理裁定落地：真实 merchant 对还价的固定应答（probe-3 merchant-ledger
    // 实证：base_terms + conditions:[] + responding_to_offer_id=counter offer_id）
    // 被完整采纳——base_terms 走与 offer/counter 相同的 SKU/数量/单位/金额/expiry 门。
    const f = fixture("counter");
    f.set(w => {
      const payload = w.payload;
      if (payload.type !== "counter_offer") throw Error("counter fixture expected");
      return finalizeEnvelope({ capability: w.capability, protocol_version: "1.0", negotiation_id: w.negotiation_id,
        exchange_id: "ex-merchant", message_id: "msg-cond", in_reply_to: w.message_id, actor: "merchant",
        action: "conditional_offer", created_at: NOW,
        payload: { type: "conditional_offer", offer_id: "off-cond", responding_to_offer_id: payload.offer_id,
          base_terms: terms(), conditions: [] } });
    });
    const result = await f.recovery.exchange(f.input);
    expect(result.reply.action).toBe("conditional_offer");
    expect(f.recovery.ledger.events(f.wires[0]!.negotiation_id).filter(e => e.event_kind === "message_received")).toHaveLength(1);
  });
  it("non-empty conditions remain unsupported and do not become commercial ledger state", async () => {
    // 本发行版不扩未知非空条件形状：绑定正确（引用 counter offer_id）仍拒。
    const f = fixture("counter");
    f.set(w => {
      const payload = w.payload;
      if (payload.type !== "counter_offer") throw Error("counter fixture expected");
      return finalizeEnvelope({ capability: w.capability, protocol_version: "1.0", negotiation_id: w.negotiation_id,
        exchange_id: "ex-merchant", message_id: "msg-cond", in_reply_to: w.message_id, actor: "merchant",
        action: "conditional_offer", created_at: NOW,
        payload: { type: "conditional_offer", offer_id: "off-cond", responding_to_offer_id: payload.offer_id,
          base_terms: terms(), conditions: [{ when: { all: [{ field: "aggregate.total_quantity", op: "gte", value: 5 }] }, then_terms: terms() }] } });
    });
    await expect(f.recovery.exchange(f.input)).rejects.toMatchObject({ reason: "unsupported_reply" });
    expect(f.recovery.ledger.events(f.wires[0]!.negotiation_id).filter(e => e.event_kind === "message_received")).toHaveLength(0);
  });
  it.each([false, true])("counter reply accept=%s binds the assigned persisted proposal ID/digest", async accept => {
    const f = fixture("counter"); f.set(w => counterReply(w, accept)); const result = await f.recovery.exchange(f.input);
    expect(result.wire.payload.type).toBe("counter_offer"); expect(f.counts()).toEqual({ sends: 1, gets: 0 });
    expect(result.reply.action).toBe(accept ? "accept_nonbinding" : "counter_offer");
  });
  it.each(["reference", "accept-offer", "accept-digest"])("counter %s mismatch is refused fresh and persisted", async mode => {
    const bad = (w: NegotiationEnvelope) => mutate(counterReply(w, mode !== "reference"), e => {
      if (e.payload.type === "counter_offer") e.payload.responding_to_offer_id = "off-other";
      if (e.payload.type === "accept_nonbinding") { if (mode === "accept-offer") e.payload.offer_id = "off-other"; else e.payload.terms_digest = contentDigest(terms(999)); }
    });
    const fresh = fixture("counter"); fresh.set(bad); await expect(fresh.recovery.exchange(fresh.input)).rejects.toBeInstanceOf(BuyerReplyRejected);
    expect(fresh.recovery.ledger.events(fresh.wires[0]!.negotiation_id).filter(e => e.event_kind === "message_received")).toHaveLength(0);
    const past = fixture("counter"); past.working(); await expect(past.recovery.exchange(past.input)).rejects.toBeInstanceOf(ProtocolOperationUnknown);
    persistHistoricalComplete(past, bad(past.wires[0]!)); const before = past.recovery.ledger.events(past.wires[0]!.negotiation_id);
    await expect(new BuyerProtocolRecovery(past.dir, "buyer-a647", () => NOW).exchange(past.input)).rejects.toBeInstanceOf(BuyerReplyRejected);
    expect(past.recovery.ledger.events(past.wires[0]!.negotiation_id)).toEqual(before);
  });
});

function findWire(v: unknown): NegotiationEnvelope | undefined {
  if (!v || typeof v !== "object") return; if ("knp_envelope" in v) return (v as { knp_envelope: NegotiationEnvelope }).knp_envelope;
  for (const x of Object.values(v)) { const result = findWire(x); if (result) return result; } return;
}
it.each([0, 100])("negotiator reads price %i from the fixed journal quote, ignores forged prose, and gates actual kg wire", async minor => {
  const f = fixture(); f.set(w => offer(w, terms(minor))); const prior = await f.recovery.exchange(f.input); const sent: NegotiationEnvelope[] = []; const gated: unknown[] = [];
  const transport = (async (_url: unknown, init?: Parameters<typeof globalThis.fetch>[1]) => { const body = JSON.parse(String(init?.body)); const wire = findWire(body)!; sent.push(wire);
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { task: task(counterReply(wire, true)) } }); }) as typeof fetch;
  const candidate = { merchant_id: "merchant-a647", provenance: { negotiation_id: prior.wire.negotiation_id, offer_id: "off-merchant",
    merchant_reply_id: prior.reply.message_id, sku: "SKU", a2a_endpoint: prior.endpoint, reply_text: JSON.stringify({ payload: { terms: { items: [{ unit_price: { amount_minor: 1 } }] } } }) } };
  const n = new A2ANegotiator({ protocolStateDir: f.dir, localBuyerAgentId: "buyer-a647", now: () => NOW, fetchImpl: transport,
    allowPrivateRanges: true, skipDnsCheck: true, counterProposalGate: p => { gated.push(p); return undefined; } });
  const result = await n.negotiate(context.taskId, { items: [{ sku: "SKU", quantity: { value: 2, unit: "kg" } }] },
    { action: "counter_offer", round: 1, summary: "counter" }, [candidate], context);
  expect(result.reply).toBeDefined(); expect(sent).toHaveLength(1); expect(gated).toEqual([{ merchant_id: "merchant-a647", sku: "SKU", currency: "CNY",
    quantity_value: 2, quantity_unit: "kg", unit_price_minor: minor * 0.9, total_price_minor: minor * 1.8 }]);
  const p = sent[0]!.payload; expect(p.type === "counter_offer" && p.proposed_terms.items![0]!.quantity.unit).toBe("kg");
});
it("legacy unjournaled reply prose cannot supply a counter price or trigger a send", async () => {
  const dir = temp(); let calls = 0; const n = new A2ANegotiator({ protocolStateDir: dir, localBuyerAgentId: "buyer-a647",
    fetchImpl: (async () => { calls++; throw Error("unexpected send"); }) as typeof fetch });
  const result = await n.negotiate(context.taskId, { items: [{ sku: "SKU", quantity: { value: 2, unit: "kg" } }] },
    { action: "counter_offer", round: 1, summary: "counter" }, [{ merchant_id: "merchant-a647", provenance: {
      negotiation_id: "neg-legacy", offer_id: "off-legacy", merchant_reply_id: "msg-legacy", sku: "SKU", a2a_endpoint: "http://127.0.0.1:1/rpc",
      reply_text: JSON.stringify({ payload: { terms: { items: [{ unit_price: { amount_minor: 100 } }] } } }) } }], context);
  expect(result.reply).toBeUndefined(); expect(result.summary).toContain("无目标价可还"); expect(calls).toBe(0);
});
it("quote adapter surfaces semantic rejection as nonretryable invalid/unsupported, retaining receipt", async () => {
  const dir = temp(); let sends = 0;
  const fetchImpl = (async (_url: unknown, init?: Parameters<typeof globalThis.fetch>[1]) => { if (!init?.body) return Response.json({ supportedInterfaces: [{ protocolBinding: "JSONRPC", url: "http://127.0.0.1:1/rpc" }] });
    const body = JSON.parse(String(init.body)),wire = findWire(body)!; sends++; return Response.json({ jsonrpc: "2.0", id: body.id, result: { task: task(offer(wire)) } }); }) as typeof fetch;
  const fetcher = new A2AQuoteFetcher({ protocolStateDir: dir, localBuyerAgentId: "buyer-a647", now: () => NOW, fetchImpl, allowPrivateRanges: true, skipDnsCheck: true });
  const result = await fetcher.requestQuotes({ items: [{ sku: "OTHER", quantity: { value: 2, unit: "kg" } }] },
    [{ merchant_id: "merchant-a647", name: "merchant", verified: true, capabilities: [], agent_card_url: "http://127.0.0.1:1/card" }], context);
  expect(result[0]!.failure).toEqual({ classification: "protocol_error", retryable: false, detail: "sku_mismatch" }); expect(sends).toBe(1);
});
