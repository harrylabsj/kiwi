// 生成 normative Data Part examples（binding rc1 §8 gate 2）。
// 每个示例是完整 A2A Message（Text Part 可选 + Data Part 必含 knp_envelope），
// envelope 由本实现 finalize（digest 权威）。输出 contracts/interop/
// knp-data-part-examples.json；shopping-cli 与 kiwi 双侧测试都加载并断言
// schema-valid（消息层 + envelope 层）。
import { finalizeEnvelope } from "../dist/negotiation/domain/envelope.js";
import { writeFileSync } from "node:fs";

const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const NEG = "neg_01H5V8KXZqJ7Qp3mN2B6A", EX = "ex_01H5V8KXZqJ7Qp3mN2B6A";
const TS = "2026-08-05T12:00:00Z";
const base = { capability: CAP, protocol_version: "1.0", negotiation_id: NEG, exchange_id: EX, created_at: TS };

function message(fields, text) {
  const envelope = finalizeEnvelope(fields);
  const parts = text === undefined
    ? [{ kind: "data", data: { knp_envelope: envelope } }]
    : [
        { kind: "text", text },
        { kind: "data", data: { knp_envelope: envelope } },
      ];
  return { role: "agent", messageId: envelope.message_id, parts };
}

const examples = [
  {
    label: "counter_offer",
    kind: "message",
    message: message(
      {
        ...base,
        message_id: "msg_01H5V8KXZqJ7Qp3mN2B6A",
        in_reply_to: "msg_00H5V8KXZqJ7Qp3mN2B6A",
        actor: "buyer",
        action: "counter_offer",
        payload: {
          type: "counter_offer",
          offer_id: "off_02H5V8KXZqJ7Qp3mN2B6A",
          responding_to_offer_id: "off_01H5V8KXZqJ7Qp3mN2B6A",
          proposed_terms: {
            items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 83500 } }],
          },
        },
        public_message: "If we order 200 units, we propose CNY 835.00 per unit.",
      },
      "If we order 200 units, we propose CNY 835.00 per unit.",
    ),
  },
  {
    label: "offer",
    kind: "message",
    message: message(
      {
        ...base,
        message_id: "msg_02H5V8KXZqJ7Qp3mN2B6A",
        in_reply_to: "msg_00H5V8KXZqJ7Qp3mN2B6A",
        actor: "merchant",
        action: "offer",
        payload: {
          type: "offer",
          offer_id: "off_01H5V8KXZqJ7Qp3mN2B6A",
          terms: {
            items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 85000 } }],
            fulfillment_terms: { delivery_before: "2026-08-20T18:00:00Z" },
            valid_until: "2026-08-06T12:00:00Z",
          },
        },
        public_message: "We offer CNY 850.00 per unit, delivery before 2026-08-20.",
      },
      "We offer CNY 850.00 per unit, delivery before 2026-08-20.",
    ),
  },
  {
    label: "inquiry",
    kind: "message",
    message: message(
      {
        ...base,
        message_id: "msg_03H5V8KXZqJ7Qp3mN2B6A",
        actor: "buyer",
        action: "inquiry",
        payload: {
          type: "inquiry",
          subject: { sku: "SKU-001" },
          questions: [{ code: "delivery.estimated_date" }],
        },
      },
      "请问这款商品的预计交付时间？",
    ),
  },
  {
    label: "accept_nonbinding",
    kind: "message",
    message: message(
      {
        ...base,
        message_id: "msg_04H5V8KXZqJ7Qp3mN2B6A",
        in_reply_to: "msg_01H5V8KXZqJ7Qp3mN2B6A",
        actor: "buyer",
        action: "accept_nonbinding",
        payload: {
          type: "accept_nonbinding",
          offer_id: "off_01H5V8KXZqJ7Qp3mN2B6A",
          terms_digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        },
      },
    ),
  },
  {
    label: "task_result",
    kind: "task",
    task: {
      taskId: "task_01H5V8KXZqJ7Qp3mN2B6A",
      status: {
        state: "completed",
        message: message(
          {
            ...base,
            message_id: "msg_05H5V8KXZqJ7Qp3mN2B6A",
            in_reply_to: "msg_01H5V8KXZqJ7Qp3mN2B6A",
            actor: "merchant",
            action: "offer",
            payload: {
              type: "offer",
              offer_id: "off_01H5V8KXZqJ7Qp3mN2B6A",
              terms: {
                items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 85000 } }],
                fulfillment_terms: { delivery_before: "2026-08-20T18:00:00Z" },
                valid_until: "2026-08-06T12:00:00Z",
              },
            },
            public_message: "异步任务的 offer 结果。",
          },
        ),
      },
    },
  },
];

writeFileSync(
  new URL("../contracts/interop/knp-data-part-examples.json", import.meta.url),
  JSON.stringify({ schema: "binding-rc1/data-part-examples/v1", generated_by: "kiwi dist", examples }, null, 2) + "\n",
);
console.log("wrote", examples.length, "examples");
