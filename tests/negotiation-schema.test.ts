/**
 * KNP/1.0 冻结 schema 测试（基线 §41 #7 九类核心对象）。
 *
 * 正例：子规范 §9–§17 的合法 payload 包进合法 Envelope（复用 negotiation-helpers
 * 的 domain-valid fixture），以及 AcceptedNonbindingAgreement artifact 直接校验。
 * 反例：缺字段 / 空 items / 非法 op / 不支持 field / condition 节点歧义 /
 * 数组 value 用于非 in / agreement 副作用标志 true / action-payload 不匹配 /
 * digest 格式错 / withdraw scope=negotiation 携带 target_offer_id 等。
 */
import { describe, expect, it } from "vitest";
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

type Payload = object;

/** 构造一个 KNP/1.0 Envelope（digest 可选，schema 不强制）。 */
function env(
  action: string,
  payload: Payload,
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
    ...overrides,
  };
}

describe("KNP/1.0 schema 正例（§9–§17 对象）", () => {
  const cases: Array<[string, Payload]> = [
    ["inquiry", validInquiry()],
    ["rfq", validRfq()],
    ["offer", validOffer()],
    ["counter_offer", validCounterOffer()],
    ["conditional_offer", validConditionalOffer()],
    ["clarification", validClarification()],
    ["clarification_response", { type: "clarification_response", answers: [] }],
    ["accept_nonbinding", validAcceptNonbinding()],
    ["withdraw", validWithdraw()],
    ["decline", validDecline()],
    ["cancel", { type: "cancel" }],
  ];

  for (const [action, payload] of cases) {
    it(`accepts a valid ${action} envelope`, () => {
      const envelope = env(action, payload);
      expect(validateEnvelopeAgainstSchema(envelope)).toEqual([]);
    });
  }

  it("accepts the §8 envelope example with digest", () => {
    const envelope = env("counter_offer", validCounterOffer(), {
      in_reply_to: "msg_00H5V8KXZqJ7Qp3mN2B6A",
      public_message: "If we order 200 units, we propose CNY 835.00 per unit.",
      digest: `sha256:${"a".repeat(64)}`,
    });
    expect(validateEnvelopeAgainstSchema(envelope)).toEqual([]);
  });

  it("freezes AcceptedNonbindingAgreement as a standalone artifact (§16)", () => {
    expect(validateNegotiationObject("accepted_nonbinding_agreement", validAgreement())).toEqual(
      [],
    );
  });

  it("accepts a conditional_offer with empty conditions (equiv. base_terms)", () => {
    const offer = { ...validConditionalOffer(), conditions: [] };
    expect(validateEnvelopeAgainstSchema(env("conditional_offer", offer))).toEqual([]);
  });
});

describe("KNP/1.0 schema 反例", () => {
  it("rejects action/payload type mismatch", () => {
    const envelope = env("offer", validRfq());
    const errors = validateEnvelopeAgainstSchema(envelope);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toMatch(/payload|const/);
  });

  it("rejects a payload that matches no object", () => {
    const envelope = env("offer", { type: "unknown", foo: 1 });
    expect(validateEnvelopeAgainstSchema(envelope).length).toBeGreaterThan(0);
  });

  it("rejects rfq with empty items (§10)", () => {
    const envelope = env("rfq", { type: "rfq", items: [] });
    expect(validateEnvelopeAgainstSchema(envelope).join("\n")).toMatch(/items/);
  });

  it("rejects offer without offer_id (§11)", () => {
    const envelope = env("offer", { type: "offer", terms: {} });
    expect(validateEnvelopeAgainstSchema(envelope).join("\n")).toMatch(/offer_id/);
  });

  it("rejects counter_offer without responding_to_offer_id (§12)", () => {
    const envelope = env("counter_offer", {
      type: "counter_offer",
      offer_id: "off_02",
      proposed_terms: {},
    });
    expect(validateEnvelopeAgainstSchema(envelope).join("\n")).toMatch(/responding_to_offer_id/);
  });

  it("rejects conditional_offer with unsupported condition field (§13.5)", () => {
    const offer = {
      ...validConditionalOffer(),
      conditions: [{ when: { field: "unknown.field", op: "eq", value: 1 }, then_terms: {} }],
    };
    expect(validateEnvelopeAgainstSchema(env("conditional_offer", offer)).join("\n")).toMatch(
      /field/,
    );
  });

  it("rejects conditional_offer with invalid operator (§13.4)", () => {
    const offer = {
      ...validConditionalOffer(),
      conditions: [{ when: { field: "aggregate.total_quantity", op: "contains", value: 1 }, then_terms: {} }],
    };
    expect(validateEnvelopeAgainstSchema(env("conditional_offer", offer)).length).toBeGreaterThan(0);
  });

  it("rejects a condition node with both all and a leaf (§13.3)", () => {
    const offer = {
      ...validConditionalOffer(),
      conditions: [
        {
          when: { all: [{ field: "aggregate.total_quantity", op: "gte", value: 500 }], field: "x" },
          then_terms: {},
        },
      ],
    };
    expect(validateEnvelopeAgainstSchema(env("conditional_offer", offer)).length).toBeGreaterThan(0);
  });

  it("rejects an array value for a non-in operator (§13.4)", () => {
    const offer = {
      ...validConditionalOffer(),
      conditions: [
        { when: { field: "aggregate.total_quantity", op: "eq", value: [1, 2] }, then_terms: {} },
      ],
    };
    expect(validateEnvelopeAgainstSchema(env("conditional_offer", offer)).length).toBeGreaterThan(0);
  });

  it("rejects clarification with empty questions (§14)", () => {
    const envelope = env("clarification", { type: "clarification", questions: [] });
    expect(validateEnvelopeAgainstSchema(envelope).join("\n")).toMatch(/questions/);
  });

  it("rejects accept_nonbinding with malformed terms_digest (§15)", () => {
    const envelope = env("accept_nonbinding", {
      type: "accept_nonbinding",
      offer_id: "off_03",
      terms_digest: "md5:abc",
    });
    expect(validateEnvelopeAgainstSchema(envelope).join("\n")).toMatch(/digest/);
  });

  it("rejects withdraw scope=negotiation carrying target_offer_id (§17.2)", () => {
    const envelope = env("withdraw", {
      type: "withdraw",
      scope: "negotiation",
      target_message_id: "msg_03",
      target_offer_id: "off_03",
    });
    expect(validateEnvelopeAgainstSchema(envelope).length).toBeGreaterThan(0);
  });

  it("rejects withdraw with invalid scope", () => {
    const envelope = env("withdraw", {
      type: "withdraw",
      scope: "everything",
      target_message_id: "msg_03",
    });
    expect(validateEnvelopeAgainstSchema(envelope).length).toBeGreaterThan(0);
  });

  it("rejects agreement with creates_order=true (§16)", () => {
    const agreement = { ...validAgreement(), creates_order: true };
    const errors = validateNegotiationObject("accepted_nonbinding_agreement", agreement);
    expect(errors.join("\n")).toMatch(/creates_order/);
  });

  it("rejects agreement with empty accepted_by (§16)", () => {
    const agreement = { ...validAgreement(), accepted_by: [] };
    expect(
      validateNegotiationObject("accepted_nonbinding_agreement", agreement).join("\n"),
    ).toMatch(/accepted_by/);
  });

  it("rejects envelope with non-RFC3339 created_at (§7.3)", () => {
    const envelope = env("rfq", validRfq(), { created_at: "2026-08-05" });
    expect(validateEnvelopeAgainstSchema(envelope).length).toBeGreaterThan(0);
  });

  it("rejects envelope with an invalid actor", () => {
    const envelope = env("rfq", validRfq(), { actor: "system" });
    expect(validateEnvelopeAgainstSchema(envelope).length).toBeGreaterThan(0);
  });

  it("rejects envelope missing the payload", () => {
    const { payload: _drop, ...withoutPayload } = env("rfq", validRfq());
    expect(validateEnvelopeAgainstSchema(withoutPayload).join("\n")).toMatch(/payload/);
  });
});
