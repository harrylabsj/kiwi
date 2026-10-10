import process from "node:process";
import fs from "node:fs";
const o = JSON.parse(process.argv[2]);
const m = await import(o.bundle);
const ledger = new m.LedgerStore({
  dir: o.dir,
  lockTimeoutMs: 2000,
  now: () => "2026-10-08T00:00:00Z",
});
const handler = m.createMerchantHandler({
  ledger,
  now: () => "2026-10-08T00:00:00Z",
  sender: "merchant-local",
  counterparty: "placeholder",
  allowDemoPriceFallback: true,
});
fs.writeFileSync(o.ready, "ready");
const end = Date.now() + 5000;
while (!fs.existsSync(o.go)) {
  if (Date.now() > end) throw Error("CHILD_BARRIER_TIMEOUT");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
const envelope = m.finalizeEnvelope({
  capability: "com.harrylabsj.kiwi.shopping.negotiation",
  protocol_version: "1.0",
  negotiation_id: "neg_cross_process",
  exchange_id: "ex_" + o.peer,
  message_id: "msg_" + o.peer,
  actor: "buyer",
  action: "rfq",
  created_at: "2026-10-08T00:00:00Z",
  payload: { type: "rfq", items: [{ sku: "SKU-001", quantity: { value: 1, unit: "piece" } }] },
});
const result = await handler.handle({
  envelope,
  message: { role: "user", messageId: envelope.message_id, parts: [] },
  taskId: "task_" + o.peer,
  senderIdentity: o.peer,
});
fs.writeFileSync(
  o.result,
  JSON.stringify({ peer: o.peer, kind: result.kind, reason: result.reasonCode }),
);
