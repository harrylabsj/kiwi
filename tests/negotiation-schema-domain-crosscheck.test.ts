/**
 * 协议 schema 与领域实现的交叉一致性抽查（基线 §41 #7 完成后的对齐验证）。
 *
 * 对同一批 Envelope 样本同时跑：
 *   - 领域校验：src/negotiation/domain/envelope.ts validateEnvelope（fail-closed）；
 *   - schema 校验：src/contracts/negotiation-schema.ts validateEnvelopeAgainstSchema。
 * 断言二者判定一致。已知且有意的不对称单独列出（见「记录在案的分歧」），
 * 若将来一方收紧导致分歧消失，会在这里显式暴露。
 *
 * 记录在案的分歧（当前有意保持）：
 *   1. 条件嵌套深度 ≤ 2：仅领域强制（§13.3），schema 用 description 注明（JSON Schema 不表达深度）。
 *   2. identifier 含控制字符：仅领域拒绝（validateIdentifier），schema 只拦首尾空白。
 *
 * 已对齐项：Envelope.digest 在 schema 与领域 validateEnvelope 中均为必填且校验 sha256 格式；
 * digest 的内容一致性由 verifyEnvelopeDigest 单独校验（本测试只比对格式判定）。
 */
import { describe, expect, it } from "vitest";
import { validateEnvelope } from "../src/negotiation/domain/envelope.js";
import { validateAcceptedNonbindingAgreement } from "../src/negotiation/domain/objects.js";
import {
  validateEnvelopeAgainstSchema,
  validateNegotiationObject,
} from "../src/contracts/negotiation-schema.js";
import {
  CAPABILITY,
  EXCHANGE_ID,
  MESSAGE_ID,
  NEGOTIATION_ID,
  TIMESTAMP,
  validAcceptNonbinding,
  validAgreement,
  validClarification,
  validConditionalOffer,
  validCounterOffer,
  validDecline,
  validInquiry,
  validOffer,
  validRfq,
  validWithdraw,
} from "./negotiation-helpers.js";

type Sample = [name: string, envelope: unknown];

/** 构造 Envelope。digest 用合法格式（schema 与 validateEnvelope 都只校验格式，不校验内容）。 */
function env(
  action: string,
  payload: object,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    capability: CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: NEGOTIATION_ID,
    exchange_id: EXCHANGE_ID,
    message_id: MESSAGE_ID,
    actor: "buyer",
    action,
    created_at: TIMESTAMP,
    payload,
    digest: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

function domainValid(envelope: unknown): boolean {
  try {
    validateEnvelope(envelope);
    return true;
  } catch {
    return false;
  }
}

function schemaValid(envelope: unknown): boolean {
  return validateEnvelopeAgainstSchema(envelope).length === 0;
}

function domainValidAgreement(value: unknown): boolean {
  try {
    validateAcceptedNonbindingAgreement(value);
    return true;
  } catch {
    return false;
  }
}

function schemaValidAgreement(value: unknown): boolean {
  return validateNegotiationObject("accepted_nonbinding_agreement", value).length === 0;
}

describe("交叉一致性：领域 ↔ schema（应一致）", () => {
  // 合法样本：协议 §9–§17 对象（复用 domain-valid fixture）。
  const validSamples: Sample[] = [
    ["inquiry", env("inquiry", validInquiry())],
    ["rfq", env("rfq", validRfq())],
    ["offer（含 unit_price）", env("offer", validOffer())],
    ["counter_offer（含 unit_price）", env("counter_offer", validCounterOffer())],
    ["conditional_offer", env("conditional_offer", validConditionalOffer())],
    ["clarification", env("clarification", validClarification())],
    ["clarification_response（带 in_reply_to）", env("clarification_response", { type: "clarification_response" }, { in_reply_to: "msg_00H5V8KXZqJ7Qp3mN2B6A" })],
    ["accept_nonbinding", env("accept_nonbinding", validAcceptNonbinding())],
    ["withdraw", env("withdraw", validWithdraw())],
    ["decline", env("decline", validDecline())],
    ["cancel", env("cancel", { type: "cancel" })],
  ];

  for (const [name, envelope] of validSamples) {
    it(`accepts ${name} in both`, () => {
      expect(domainValid(envelope), "domain").toBe(true);
      expect(schemaValid(envelope), "schema").toBe(true);
    });
  }

  // 非法样本：结构/枚举/语义违规，两端都应拒绝。
  const invalidSamples: Sample[] = [
    ["rfq 空 items", env("rfq", { type: "rfq", items: [] })],
    ["offer 缺 offer_id", env("offer", { type: "offer", terms: {} })],
    [
      "offer item 缺 unit_price",
      env("offer", {
        type: "offer",
        offer_id: "off_1",
        terms: { items: [{ sku: "SKU-001", quantity: { value: 1, unit: "u" } }] },
      }),
    ],
    [
      "counter_offer 缺 responding_to_offer_id",
      env("counter_offer", { type: "counter_offer", offer_id: "off_2", proposed_terms: {} }),
    ],
    [
      "counter_offer item 缺 unit_price",
      env("counter_offer", {
        type: "counter_offer",
        offer_id: "off_2",
        responding_to_offer_id: "off_1",
        proposed_terms: { items: [{ sku: "SKU-001", quantity: { value: 1, unit: "u" } }] },
      }),
    ],
    [
      "conditional_offer 非法 op",
      env("conditional_offer", {
        ...validConditionalOffer(),
        conditions: [{ when: { field: "aggregate.total_quantity", op: "contains", value: 1 }, then_terms: {} }],
      }),
    ],
    [
      "conditional_offer 不支持 field",
      env("conditional_offer", {
        ...validConditionalOffer(),
        conditions: [{ when: { field: "unknown.field", op: "eq", value: 1 }, then_terms: {} }],
      }),
    ],
    [
      "conditional_offer all+叶并存",
      env("conditional_offer", {
        ...validConditionalOffer(),
        conditions: [{ when: { all: [], field: "x" }, then_terms: {} }],
      }),
    ],
    [
      "conditional_offer 非 in 用数组 value",
      env("conditional_offer", {
        ...validConditionalOffer(),
        conditions: [{ when: { field: "aggregate.total_quantity", op: "eq", value: [1] }, then_terms: {} }],
      }),
    ],
    ["clarification 空 questions", env("clarification", { type: "clarification", questions: [] })],
    [
      "accept_nonbinding 畸形 digest",
      env("accept_nonbinding", { type: "accept_nonbinding", offer_id: "off_3", terms_digest: "md5:x" }),
    ],
    [
      "withdraw scope=negotiation 带 target_offer_id",
      env("withdraw", { type: "withdraw", scope: "negotiation", target_message_id: "msg_3", target_offer_id: "off_3" }),
    ],
    ["withdraw 非法 scope", env("withdraw", { type: "withdraw", scope: "all", target_message_id: "msg_3" })],
    [
      "decline scope=negotiation 带 target_offer_id",
      env("decline", { type: "decline", scope: "negotiation", target_message_id: "msg_3", target_offer_id: "off_3" }),
    ],
    [
      "action/payload 不匹配",
      env("offer", validRfq()),
    ],
    ["非法 actor", env("rfq", validRfq(), { actor: "system" })],
    ["非 RFC3339 created_at", env("rfq", validRfq(), { created_at: "2026-08-05" })],
    ["缺 payload", (() => { const { payload: _drop, ...rest } = env("rfq", validRfq()); return rest; })()],
    ["缺 digest", (() => { const { digest: _drop, ...rest } = env("rfq", validRfq()); return rest; })()],
    ["畸形 digest", env("rfq", validRfq(), { digest: "not-a-digest" })],
  ];

  for (const [name, envelope] of invalidSamples) {
    it(`rejects ${name} in both`, () => {
      expect(domainValid(envelope), "domain").toBe(false);
      expect(schemaValid(envelope), "schema").toBe(false);
    });
  }
});

describe("交叉一致性：AcceptedNonbindingAgreement artifact（§16）", () => {
  it("accepts the valid agreement in both", () => {
    const value = validAgreement();
    expect(domainValidAgreement(value)).toBe(true);
    expect(schemaValidAgreement(value)).toBe(true);
  });

  const rejections: Array<[string, object]> = [
    ["creates_order=true", { ...validAgreement(), creates_order: true }],
    ["reserves_inventory=true", { ...validAgreement(), reserves_inventory: true }],
    ["authorizes_payment=true", { ...validAgreement(), authorizes_payment: true }],
    ["accepted_by 空", { ...validAgreement(), accepted_by: [] }],
    ["binding_effect 非 nonbinding", { ...validAgreement(), binding_effect: "binding" }],
  ];
  for (const [name, value] of rejections) {
    it(`rejects agreement ${name} in both`, () => {
      expect(domainValidAgreement(value), "domain").toBe(false);
      expect(schemaValidAgreement(value), "schema").toBe(false);
    });
  }
});

describe("记录在案的分歧（有意保留，双方判定不同）", () => {
  it("条件嵌套深度>2：领域拒绝，schema 放行（§13.3 深度仅实现校验）", () => {
    const envelope = env("conditional_offer", {
      ...validConditionalOffer(),
      conditions: [
        {
          when: { all: [{ any: [{ all: [{ field: "aggregate.total_quantity", op: "gte", value: 1 }] }] }] },
          then_terms: {},
        },
      ],
    });
    expect(domainValid(envelope)).toBe(false);
    expect(schemaValid(envelope)).toBe(true);
  });

  it("identifier 含控制字符：领域拒绝，schema 放行（validateIdentifier 附加约束）", () => {
    const envelope = env("rfq", validRfq(), { message_id: "msg bad" });
    expect(domainValid(envelope)).toBe(false);
    expect(schemaValid(envelope)).toBe(true);
  });

});
