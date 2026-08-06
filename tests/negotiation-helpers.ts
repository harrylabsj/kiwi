/**
 * KNP/1.0 测试 fixture：镜像子规范 §7–§17 的 JSON 示例。
 *
 * 子规范示例中的 `...` 占位符替换为具体值；`terms_digest`/`digest` 用 WP1 的
 * contentDigest 计算真实 `sha256:` 摘要（schema 校验要求严格 digest 格式）。
 */

import { contentDigest } from "../src/negotiation/jcs.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import type {
  AcceptNonbinding,
  AcceptedNonbindingAgreement,
  Clarification,
  ConditionalOffer,
  CounterOffer,
  Decline,
  Inquiry,
  Offer,
  Rfq,
  Withdraw,
} from "../src/negotiation/domain/objects.js";

export const CAPABILITY = "example.kiwi.shopping.negotiation";
export const NEGOTIATION_ID = "neg_01H5V8KXZqJ7Qp3mN2B6A";
export const EXCHANGE_ID = "ex_01H5V8KXZqJ7Qp3mN2B6A";
export const MESSAGE_ID = "msg_01H5V8KXZqJ7Qp3mN2B6A";
export const IN_REPLY_TO = "msg_00H5V8KXZqJ7Qp3mN2B6A";
export const OFFER_ID_1 = "off_01H5V8KXZqJ7Qp3mN2B6A";
export const OFFER_ID_2 = "off_02H5V8KXZqJ7Qp3mN2B6A";
export const OFFER_ID_3 = "off_03H5V8KXZqJ7Qp3mN2B6A";
export const AGREEMENT_ID = "agr_01H5V8KXZqJ7Qp3mN2B6A";
export const SKU = "SKU-001";
export const TIMESTAMP = "2026-08-05T12:00:00Z";
export const DELIVERY_BEFORE = "2026-08-20T18:00:00Z";

export const QUANTITY = { value: 200, unit: "piece" };
export const MONEY_85000 = { currency: "CNY", amount_minor: 85000 };
export const MONEY_83500 = { currency: "CNY", amount_minor: 83500 };

// §9 Inquiry 示例
export function validInquiry(): Inquiry {
  return {
    type: "inquiry",
    subject: { sku: SKU },
    questions: [{ code: "delivery.estimated_date" }],
  };
}

// §10 RFQ 示例
export function validRfq(): Rfq {
  return {
    type: "rfq",
    items: [{ sku: SKU, quantity: QUANTITY }],
    requested_terms: { delivery_before: DELIVERY_BEFORE },
  };
}

// §11 Offer 示例
export function validOffer(): Offer {
  return {
    type: "offer",
    offer_id: OFFER_ID_1,
    terms: {
      items: [{ sku: SKU, quantity: QUANTITY, unit_price: MONEY_85000 }],
      fulfillment_terms: { delivery_before: DELIVERY_BEFORE },
      valid_until: "2026-08-06T12:00:00Z",
    },
  };
}

// §12 CounterOffer 示例
export function validCounterOffer(): CounterOffer {
  return {
    type: "counter_offer",
    offer_id: OFFER_ID_2,
    responding_to_offer_id: OFFER_ID_1,
    proposed_terms: {
      items: [{ sku: SKU, quantity: QUANTITY, unit_price: MONEY_83500 }],
    },
  };
}

// §13.1 ConditionalOffer 示例（base_terms 允许为空，见 §12.2）
export function validConditionalOffer(): ConditionalOffer {
  return {
    type: "conditional_offer",
    offer_id: OFFER_ID_3,
    responding_to_offer_id: OFFER_ID_2,
    base_terms: {},
    conditions: [
      {
        when: { all: [{ field: "aggregate.total_quantity", op: "gte", value: 500 }] },
        then_terms: { items: [] },
      },
    ],
  };
}

// §14 Clarification 示例
export function validClarification(): Clarification {
  return {
    type: "clarification",
    questions: [{ field: "fulfillment.delivery_before", reason: "missing" }],
  };
}

// §15 AcceptNonbinding 示例（terms_digest 用真实 digest）
export function validAcceptNonbinding(): AcceptNonbinding {
  return {
    type: "accept_nonbinding",
    offer_id: OFFER_ID_3,
    terms_digest: contentDigest(validOffer().terms),
  };
}

// §17.2 Withdraw 示例
export function validWithdraw(): Withdraw {
  return {
    type: "withdraw",
    target_message_id: MESSAGE_ID,
    target_offer_id: OFFER_ID_3,
    scope: "offer",
    reason_code: "commercial_terms_changed",
  };
}

// §17.3 Decline 示例
export function validDecline(): Decline {
  return {
    type: "decline",
    target_message_id: MESSAGE_ID,
    target_offer_id: OFFER_ID_3,
    scope: "offer",
    reason_code: "terms_unacceptable",
  };
}

// §16 AcceptedNonbindingAgreement 示例
export function validAgreement(): AcceptedNonbindingAgreement {
  return {
    type: "accepted_nonbinding_agreement",
    agreement_id: AGREEMENT_ID,
    negotiation_id: NEGOTIATION_ID,
    accepted_offer_id: OFFER_ID_3,
    agreed_terms: {},
    terms_digest: contentDigest({}),
    accepted_by: ["buyer", "merchant"],
    created_at: "2026-08-05T12:30:00Z",
    binding_effect: "nonbinding",
    creates_order: false,
    reserves_inventory: false,
    authorizes_payment: false,
  };
}

// §8 Envelope 示例（digest 由 finalizeEnvelope 计算）
export function validEnvelopeFields(): Omit<NegotiationEnvelope, "digest"> {
  return {
    capability: CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: NEGOTIATION_ID,
    exchange_id: EXCHANGE_ID,
    message_id: MESSAGE_ID,
    in_reply_to: IN_REPLY_TO,
    actor: "buyer",
    action: "counter_offer",
    created_at: TIMESTAMP,
    payload: validCounterOffer(),
    public_message: "If we order 200 units, we propose CNY 835.00 per unit.",
  };
}
