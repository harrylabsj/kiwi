import fs from "node:fs";
import path from "node:path";
import process from "node:process";
const o = JSON.parse(process.argv[2]);
const { A2AQuoteFetcher, IdempotencyStore, finalizeEnvelope } = await import(o.bundle);
const wait = () => {
  const until = Date.now() + 7000;
  while (!fs.existsSync(path.join(o.dir, "go"))) {
    if (Date.now() > until) throw new Error("own race barrier timeout");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};
const ready = (stage) => {
  fs.writeFileSync(path.join(o.dir, o.actor + ".ready"), stage);
  wait();
};
const mark = IdempotencyStore.prototype.markInFlight;
IdempotencyStore.prototype.markInFlight = function (input) {
  ready("before-real-wx-claim");
  return mark.call(this, input);
};
const find = (value) => {
  if (!value || typeof value !== "object") return;
  if (value.knp_envelope) return value.knp_envelope;
  for (const v of Object.values(value)) {
    const found = find(v);
    if (found) return found;
  }
};
const fetchImpl = async (_url, init) => {
  if (!init?.body)
    return new globalThis.Response(
      JSON.stringify({
        supportedInterfaces: [{ protocolBinding: "JSONRPC", url: "http://127.0.0.1:1/rpc" }],
      }),
    );
  const b = JSON.parse(String(init.body)),
    wire = find(b);
  if (!wire) throw new Error("this control expects immediate complete response");
  if (!fs.existsSync(path.join(o.dir, o.actor + ".ready"))) ready("before-wire-without-claim");
  fs.appendFileSync(
    path.join(o.dir, "effects"),
    JSON.stringify({ actor: o.actor, message_id: wire.message_id }) + "\n",
  );
  const reply = finalizeEnvelope({
    ...wire,
    message_id: "reply-" + wire.message_id,
    actor: "merchant",
    action: "offer",
    in_reply_to: wire.message_id,
    payload: {
      type: "offer",
      offer_id: "off",
      terms: {
        currency: "CNY",
        items: [
          {
            sku: "SKU",
            quantity: { value: 1, unit: "piece" },
            unit_price: { currency: "CNY", amount_minor: 100 },
          },
        ],
      },
    },
  });
  const task = {
    id: "remote",
    contextId: "context",
    status: {
      state: "completed",
      message: {
        role: "agent",
        messageId: reply.message_id,
        parts: [{ kind: "data", data: { knp_envelope: reply } }],
      },
    },
  };
  return new globalThis.Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { task } }));
};
const q = new A2AQuoteFetcher({
  protocolStateDir: path.join(o.dir, "state"),
  localBuyerAgentId: "buyer-fixed",
  fetchImpl,
  allowPrivateRanges: true,
  skipDnsCheck: true,
  timeoutMs: 100,
  pollIntervalMs: 1,
});
const result = await q.requestQuotes(o.intent, [o.merchant], o.context);
fs.writeFileSync(path.join(o.dir, o.actor + ".result"), JSON.stringify(result));
