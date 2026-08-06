import { finalizeEnvelope } from "../dist/negotiation/domain/envelope.js";

// KNP inquiry envelope，与 shopping-cli tests/test_a2a_hosted_server.py 的
// inquiry 语义一致（交付时间询问）。digest 由本实现（kiwi dist）计算。
const envelope = finalizeEnvelope({
  capability: "com.harrylabsj.kiwi.shopping.negotiation",
  protocol_version: "1.0",
  negotiation_id: "neg_interop_01H5V8KXZqJ7Qp3mN2B6A",
  exchange_id: "ex_interop_01H5V8KXZqJ7Qp3mN2B6A",
  message_id: "msg_interop_01H5V8KXZqJ7Qp3mN2B6A",
  in_reply_to: "msg_legacy_1",
  actor: "buyer",
  action: "inquiry",
  created_at: "2026-08-06T12:00:00Z",
  payload: {
    type: "inquiry",
    subject: { sku: "SKU-001" },
    questions: [{ code: "delivery.estimated_date" }],
  },
  public_message: "请问这款商品的预计交付时间？",
});

const body = {
  jsonrpc: "2.0",
  id: "interop-req-001",
  method: "message/send",
  params: {
    message: {
      role: "agent",
      messageId: envelope.message_id,
      parts: [{ kind: "data", data: { knp_envelope: envelope } }],
    },
    contextId: "ctx_interop_01H5V8KXZqJ7Qp3mN2B6A",
  },
};
console.log(JSON.stringify(body, null, 2));
