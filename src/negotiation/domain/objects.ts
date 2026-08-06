/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * KNP/1.0 九类核心 Negotiation Objects（子规范 §9–§17，基线 §11）。
 *
 * 九类：Inquiry / RFQ / Offer / CounterOffer / ConditionalOffer /
 * Clarification / Withdraw / Decline / AcceptedNonbindingAgreement。
 * 另含协议动作对应的 payload：AcceptNonbinding（§15）、
 * clarification_response（§8.2/§14）、Cancel（§17.4）。
 *
 * 每个 payload 都以 `type` 为判别字段，与 envelope.action 一一对应。
 * 校验 fail-closed（基线 §4.6）：结构、枚举、金额整数性、Agreement 副作用
 * flag、Condition 字段 allowlist、Withdraw/Decline scope 语义等。
 */

import {
  NegotiationValidationError,
  requireArray,
  requireDigest,
  requireEnum,
  requireIsoTimestamp,
  requireNonEmptyString,
  requireObject,
  requireType,
  schemaError,
  validateLineItem,
  validateTermSet,
} from "./common.js";
import type { LineItem, TermSet } from "./common.js";
import { validateIdentifier } from "./identifiers.js";
import type { TargetRef } from "./identifiers.js";

export type NegotiationActor = "buyer" | "merchant";

/** KNP/1.0 动作词表（子规范 §8.2）。 */
export const KNP_ACTIONS = [
  "inquiry",
  "rfq",
  "offer",
  "counter_offer",
  "conditional_offer",
  "clarification",
  "clarification_response",
  "accept_nonbinding",
  "withdraw",
  "decline",
  "cancel",
] as const;
export type NegotiationAction = (typeof KNP_ACTIONS)[number];

export const SCOPE_VALUES = ["offer", "negotiation"] as const;
export type TargetScope = (typeof SCOPE_VALUES)[number];

// ---------------------------------------------------------------------------
// Inquiry（§9）
// ---------------------------------------------------------------------------

export interface InquiryQuestion {
  code: string;
}

export interface Inquiry {
  type: "inquiry";
  subject?: Record<string, unknown>;
  questions?: InquiryQuestion[];
}

export function validateInquiry(value: unknown, path = "/payload"): Inquiry {
  const obj = requireObject(value, path);
  requireType(obj, "inquiry", path);
  const inquiry: Inquiry = { type: "inquiry" };
  if (obj.subject !== undefined) {
    inquiry.subject = requireObject(obj.subject, `${path}/subject`);
  }
  if (obj.questions !== undefined) {
    inquiry.questions = requireArray(obj.questions, `${path}/questions`).map((q, i) => {
      const qobj = requireObject(q, `${path}/questions/${i}`);
      return { code: requireNonEmptyString(qobj.code, `${path}/questions/${i}/code`) };
    });
  }
  return inquiry;
}

// ---------------------------------------------------------------------------
// RFQ（§10）
// ---------------------------------------------------------------------------

export interface Rfq {
  type: "rfq";
  /** RFQ MUST 至少含一个 item（§10）。 */
  items: LineItem[];
  requested_terms?: Record<string, unknown>;
}

export function validateRfq(value: unknown, path = "/payload"): Rfq {
  const obj = requireObject(value, path);
  requireType(obj, "rfq", path);
  const items = requireArray(obj.items, `${path}/items`);
  if (items.length === 0) {
    throw schemaError(`${path}/items`, "rfq must contain at least one item");
  }
  const rfq: Rfq = {
    type: "rfq",
    items: items.map((item, i) => validateLineItem(item, `${path}/items/${i}`)),
  };
  if (obj.requested_terms !== undefined) {
    const requested = requireObject(obj.requested_terms, `${path}/requested_terms`);
    if (requested.delivery_before !== undefined) {
      requireIsoTimestamp(requested.delivery_before, `${path}/requested_terms/delivery_before`);
    }
    rfq.requested_terms = requested;
  }
  return rfq;
}

// ---------------------------------------------------------------------------
// Offer（§11）
// ---------------------------------------------------------------------------

export interface Offer {
  type: "offer";
  offer_id: string;
  terms: TermSet;
}

export function validateOffer(value: unknown, path = "/payload"): Offer {
  const obj = requireObject(value, path);
  requireType(obj, "offer", path);
  return {
    type: "offer",
    offer_id: validateIdentifier(obj.offer_id, `${path}/offer_id`),
    terms: validateTermSet(obj.terms, `${path}/terms`, { requireUnitPrice: true }),
  };
}

// ---------------------------------------------------------------------------
// CounterOffer（§12）
// ---------------------------------------------------------------------------

export interface CounterOffer {
  type: "counter_offer";
  offer_id: string;
  /** MUST 引用前一个 offer-like 对象（§6.4/§12）。 */
  responding_to_offer_id: string;
  proposed_terms: TermSet;
}

export function validateCounterOffer(value: unknown, path = "/payload"): CounterOffer {
  const obj = requireObject(value, path);
  requireType(obj, "counter_offer", path);
  return {
    type: "counter_offer",
    offer_id: validateIdentifier(obj.offer_id, `${path}/offer_id`),
    responding_to_offer_id: validateIdentifier(
      obj.responding_to_offer_id,
      `${path}/responding_to_offer_id`,
    ),
    proposed_terms: validateTermSet(obj.proposed_terms, `${path}/proposed_terms`, {
      requireUnitPrice: true,
    }),
  };
}

// ---------------------------------------------------------------------------
// ConditionalOffer（§13）
// ---------------------------------------------------------------------------

export const CONDITION_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "in"] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** §13.5 协议治理的 field 词表。 */
export const CONDITION_FIELDS = [
  "aggregate.total_quantity",
  "fulfillment.batch_count",
  "service.warranty_months",
  "commercial.commitment_days",
] as const;

export interface ConditionLeaf {
  field: string;
  op: ConditionOperator;
  value: number | string | (number | string)[];
}

export interface ConditionAll {
  all: ConditionNode[];
}

export interface ConditionAny {
  any: ConditionNode[];
}

export type ConditionNode = ConditionAll | ConditionAny | ConditionLeaf;

export interface ConditionRule {
  when: ConditionNode;
  then_terms: TermSet;
}

export interface ConditionalOffer {
  type: "conditional_offer";
  offer_id: string;
  responding_to_offer_id?: string;
  /** §13.1 示例允许空 base_terms；§12.2 要求可独立求值。 */
  base_terms: TermSet;
  conditions: ConditionRule[];
}

function validateConditionValue(
  value: unknown,
  path: string,
  op: ConditionOperator,
): number | string | (number | string)[] {
  if (Array.isArray(value)) {
    if (op !== "in") {
      throw schemaError(path, `${path} array value is only valid for op=in`);
    }
    if (value.length === 0) {
      throw schemaError(path, `${path} must be a non-empty array for op=in`);
    }
    value.forEach((v, i) => {
      if (typeof v !== "number" && typeof v !== "string") {
        throw schemaError(`${path}/${i}`, `${path} elements must be number or string`);
      }
      if (typeof v === "number" && !Number.isFinite(v)) {
        throw schemaError(`${path}/${i}`, `${path} elements must be finite numbers`);
      }
    });
    return value as (number | string)[];
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw schemaError(path, `${path} must be a finite number`);
    }
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  throw schemaError(path, `${path} must be a number, string, or array`);
}

function validateConditionLeaf(obj: Record<string, unknown>, path: string): ConditionLeaf {
  const field = requireNonEmptyString(obj.field, `${path}/field`);
  if (!(CONDITION_FIELDS as readonly string[]).includes(field)) {
    throw new NegotiationValidationError(
      "field_unsupported",
      `unsupported condition field: ${field}`,
      `${path}/field`,
    );
  }
  const op = requireEnum(obj.op, CONDITION_OPERATORS, `${path}/op`);
  return {
    field,
    op,
    value: validateConditionValue(obj.value, `${path}/value`, op),
  };
}

function validateConditionNode(value: unknown, path: string, depth: number): ConditionNode {
  if (depth > 2) {
    throw schemaError(path, "condition nesting must not exceed 2 levels below the root");
  }
  const obj = requireObject(value, path);
  const hasAll = obj.all !== undefined;
  const hasAny = obj.any !== undefined;
  const isLeaf = obj.field !== undefined || obj.op !== undefined || obj.value !== undefined;
  const present = Number(hasAll) + Number(hasAny) + Number(isLeaf);
  if (present !== 1) {
    throw schemaError(path, "condition node must have exactly one of all/any/leaf");
  }
  if (hasAll) {
    const children = requireArray(obj.all, `${path}/all`);
    if (children.length === 0) {
      throw schemaError(`${path}/all`, "all must be a non-empty array");
    }
    return { all: children.map((c, i) => validateConditionNode(c, `${path}/all/${i}`, depth + 1)) };
  }
  if (hasAny) {
    const children = requireArray(obj.any, `${path}/any`);
    if (children.length === 0) {
      throw schemaError(`${path}/any`, "any must be a non-empty array");
    }
    return { any: children.map((c, i) => validateConditionNode(c, `${path}/any/${i}`, depth + 1)) };
  }
  return validateConditionLeaf(obj, path);
}

export function validateConditionalOffer(value: unknown, path = "/payload"): ConditionalOffer {
  const obj = requireObject(value, path);
  requireType(obj, "conditional_offer", path);
  const conditions = (
    obj.conditions === undefined ? [] : requireArray(obj.conditions, `${path}/conditions`)
  ).map((c, i) => {
    const cobj = requireObject(c, `${path}/conditions/${i}`);
    return {
      when: validateConditionNode(cobj.when, `${path}/conditions/${i}/when`, 0),
      then_terms: validateTermSet(cobj.then_terms, `${path}/conditions/${i}/then_terms`),
    };
  });
  return {
    type: "conditional_offer",
    offer_id: validateIdentifier(obj.offer_id, `${path}/offer_id`),
    responding_to_offer_id:
      obj.responding_to_offer_id === undefined
        ? undefined
        : validateIdentifier(obj.responding_to_offer_id, `${path}/responding_to_offer_id`),
    base_terms: validateTermSet(obj.base_terms, `${path}/base_terms`),
    conditions,
  };
}

// ---------------------------------------------------------------------------
// Clarification（§14）
// ---------------------------------------------------------------------------

export interface ClarificationQuestion {
  field: string;
  reason?: string;
}

export interface Clarification {
  type: "clarification";
  questions: ClarificationQuestion[];
}

export function validateClarification(value: unknown, path = "/payload"): Clarification {
  const obj = requireObject(value, path);
  requireType(obj, "clarification", path);
  const questions = requireArray(obj.questions, `${path}/questions`);
  if (questions.length === 0) {
    throw schemaError(`${path}/questions`, "clarification must contain at least one question");
  }
  return {
    type: "clarification",
    questions: questions.map((q, i) => {
      const qobj = requireObject(q, `${path}/questions/${i}`);
      const question: ClarificationQuestion = {
        field: requireNonEmptyString(qobj.field, `${path}/questions/${i}/field`),
      };
      if (qobj.reason !== undefined) {
        question.reason = requireNonEmptyString(qobj.reason, `${path}/questions/${i}/reason`);
      }
      return question;
    }),
  };
}

/**
 * clarification_response：KNP/1.0 未冻结 payload 形状（§8.2/§14）。唯一约束是
 * 携带 `type` 判别；对澄清消息的引用由 envelope `in_reply_to` 承担。
 */
export interface ClarificationResponse {
  type: "clarification_response";
  [key: string]: unknown;
}

export function validateClarificationResponse(
  value: unknown,
  path = "/payload",
): ClarificationResponse {
  const obj = requireObject(value, path);
  requireType(obj, "clarification_response", path);
  return { ...obj, type: "clarification_response" };
}

// ---------------------------------------------------------------------------
// AcceptNonbinding（§15）
// ---------------------------------------------------------------------------

export interface AcceptNonbinding {
  type: "accept_nonbinding";
  offer_id: string;
  terms_digest: string;
}

export function validateAcceptNonbinding(value: unknown, path = "/payload"): AcceptNonbinding {
  const obj = requireObject(value, path);
  requireType(obj, "accept_nonbinding", path);
  return {
    type: "accept_nonbinding",
    offer_id: validateIdentifier(obj.offer_id, `${path}/offer_id`),
    terms_digest: requireDigest(obj.terms_digest, `${path}/terms_digest`),
  };
}

// ---------------------------------------------------------------------------
// Withdraw（§17.2）
// ---------------------------------------------------------------------------

export interface Withdraw extends TargetRef {
  type: "withdraw";
  scope: TargetScope;
  reason_code?: string;
}

export function validateWithdraw(value: unknown, path = "/payload"): Withdraw {
  const obj = requireObject(value, path);
  requireType(obj, "withdraw", path);
  const scope = requireEnum(obj.scope, SCOPE_VALUES, `${path}/scope`);
  const withdraw: Withdraw = {
    type: "withdraw",
    scope,
    target_message_id: validateIdentifier(obj.target_message_id, `${path}/target_message_id`),
  };
  if (obj.target_offer_id !== undefined) {
    if (scope === "negotiation") {
      // §9.7：negotiation 级用 envelope negotiation_id，不得伪造 object id。
      throw new NegotiationValidationError(
        "state_conflict",
        `${path}/target_offer_id must be absent for scope=negotiation (envelope negotiation_id is authoritative)`,
        `${path}/target_offer_id`,
      );
    }
    withdraw.target_offer_id = validateIdentifier(obj.target_offer_id, `${path}/target_offer_id`);
  }
  if (obj.reason_code !== undefined) {
    withdraw.reason_code = requireNonEmptyString(obj.reason_code, `${path}/reason_code`);
  }
  return withdraw;
}

// ---------------------------------------------------------------------------
// Decline（§17.3）
// ---------------------------------------------------------------------------

export interface Decline extends TargetRef {
  type: "decline";
  scope: TargetScope;
  reason_code?: string;
}

export function validateDecline(value: unknown, path = "/payload"): Decline {
  const obj = requireObject(value, path);
  requireType(obj, "decline", path);
  const scope = requireEnum(obj.scope, SCOPE_VALUES, `${path}/scope`);
  const decline: Decline = {
    type: "decline",
    scope,
    target_message_id: validateIdentifier(obj.target_message_id, `${path}/target_message_id`),
  };
  if (obj.target_offer_id !== undefined) {
    if (scope === "negotiation") {
      // §9.7 / §17.3：negotiation 级 decline 以 envelope negotiation_id 为准。
      throw new NegotiationValidationError(
        "state_conflict",
        `${path}/target_offer_id must be absent for scope=negotiation (envelope negotiation_id is authoritative)`,
        `${path}/target_offer_id`,
      );
    }
    decline.target_offer_id = validateIdentifier(obj.target_offer_id, `${path}/target_offer_id`);
  }
  if (obj.reason_code !== undefined) {
    decline.reason_code = requireNonEmptyString(obj.reason_code, `${path}/reason_code`);
  }
  return decline;
}

// ---------------------------------------------------------------------------
// Cancel（§17.4）
// ---------------------------------------------------------------------------

export interface Cancel {
  type: "cancel";
}

export function validateCancel(value: unknown, path = "/payload"): Cancel {
  const obj = requireObject(value, path);
  requireType(obj, "cancel", path);
  return { type: "cancel" };
}

// ---------------------------------------------------------------------------
// AcceptedNonbindingAgreement（§16）
// ---------------------------------------------------------------------------

export interface AcceptedNonbindingAgreement {
  type: "accepted_nonbinding_agreement";
  agreement_id: string;
  negotiation_id: string;
  accepted_offer_id: string;
  agreed_terms: TermSet;
  terms_digest: string;
  accepted_by: NegotiationActor[];
  created_at: string;
  binding_effect: "nonbinding";
  /** KNP/1.0 不产生订单/库存/支付副作用：三个 flag 必须恒为 false（§16/§33）。 */
  creates_order: false;
  reserves_inventory: false;
  authorizes_payment: false;
}

function requireFalse(value: unknown, path: string): false {
  if (value !== false) {
    throw schemaError(
      path,
      `${path} must be false (KNP/1.0 produces no order/inventory/payment side effect)`,
    );
  }
  return false;
}

export function validateAcceptedNonbindingAgreement(
  value: unknown,
  path = "/payload",
): AcceptedNonbindingAgreement {
  const obj = requireObject(value, path);
  requireType(obj, "accepted_nonbinding_agreement", path);
  const acceptedBy = requireArray(obj.accepted_by, `${path}/accepted_by`);
  if (acceptedBy.length === 0) {
    throw schemaError(`${path}/accepted_by`, "accepted_by must not be empty");
  }
  return {
    type: "accepted_nonbinding_agreement",
    agreement_id: validateIdentifier(obj.agreement_id, `${path}/agreement_id`),
    negotiation_id: validateIdentifier(obj.negotiation_id, `${path}/negotiation_id`),
    accepted_offer_id: validateIdentifier(obj.accepted_offer_id, `${path}/accepted_offer_id`),
    agreed_terms: validateTermSet(obj.agreed_terms, `${path}/agreed_terms`),
    terms_digest: requireDigest(obj.terms_digest, `${path}/terms_digest`),
    accepted_by: acceptedBy.map((a, i) =>
      requireEnum(a, ["buyer", "merchant"] as const, `${path}/accepted_by/${i}`),
    ),
    created_at: requireIsoTimestamp(obj.created_at, `${path}/created_at`),
    binding_effect: requireEnum(
      obj.binding_effect,
      ["nonbinding"] as const,
      `${path}/binding_effect`,
    ),
    creates_order: requireFalse(obj.creates_order, `${path}/creates_order`),
    reserves_inventory: requireFalse(obj.reserves_inventory, `${path}/reserves_inventory`),
    authorizes_payment: requireFalse(obj.authorizes_payment, `${path}/authorizes_payment`),
  };
}

// ---------------------------------------------------------------------------
// Payload 判别分发
// ---------------------------------------------------------------------------

/**
 * envelope.payload 的合法载荷。AcceptedNonbindingAgreement 不在其中：它是
 * 响应/Task artifact（§8.2），不是 envelope action，由
 * validateAcceptedNonbindingAgreement 单独校验。
 */
export type NegotiationPayload =
  | Inquiry
  | Rfq
  | Offer
  | CounterOffer
  | ConditionalOffer
  | Clarification
  | ClarificationResponse
  | AcceptNonbinding
  | Withdraw
  | Decline
  | Cancel;

const PAYLOAD_VALIDATORS: Record<
  NegotiationAction,
  (value: unknown, path: string) => NegotiationPayload
> = {
  inquiry: validateInquiry,
  rfq: validateRfq,
  offer: validateOffer,
  counter_offer: validateCounterOffer,
  conditional_offer: validateConditionalOffer,
  clarification: validateClarification,
  clarification_response: validateClarificationResponse,
  accept_nonbinding: validateAcceptNonbinding,
  withdraw: validateWithdraw,
  decline: validateDecline,
  cancel: validateCancel,
};

/**
 * 按 envelope.action 校验 payload。每个 validator 强制 payload.type 与
 * action 一致，因此 action/payload 类型不匹配会在这里被拒绝（fail-closed）。
 */
export function validatePayloadForAction(
  action: NegotiationAction,
  value: unknown,
  path = "/payload",
): NegotiationPayload {
  const validator = PAYLOAD_VALIDATORS[action];
  if (validator === undefined) {
    throw schemaError(path, `no validator registered for action ${action}`);
  }
  return validator(value, path);
}
