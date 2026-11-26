/** Copyright 2026 harrylabsj; SPDX-License-Identifier: Apache-2.0 */
import type { A2ATask } from "../a2a/client/types.js";
import type { ProductAnswer } from "../a2a/server/buyer-product-qa.js";
import { PUBLIC_PRODUCT_FIELDS } from "../commerce/data-source.js";
import type { NegotiationEnvelope } from "../negotiation/domain/envelope.js";

export interface MerchantReplyExtensions {
  product_answers?: ProductAnswer[];
  next_step?: { kind: "new_rfq"; sku: string; quantity: { value: number; unit: string }; requires_buyer_confirmation: true };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= max && !/\p{Cc}/u.test(value);
const isField = (value: unknown): value is (typeof PUBLIC_PRODUCT_FIELDS)[number] => PUBLIC_PRODUCT_FIELDS.some((field) => field === value);

function productAnswer(value: unknown, questionCount: number): ProductAnswer | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  const { index, topic, status, answer } = item;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= questionCount ||
      (!isField(topic) && topic !== "stock" && topic !== "delivery") || !bounded(answer, 640) ||
      (status !== "answered" && status !== "needs_input" && status !== "needs_merchant" && status !== "unavailable")) return undefined;
  const evidence = record(item.evidence);
  const followup = record(item.followup);
  const projected: ProductAnswer = { index, topic, status, answer };
  if (status === "answered") {
    if (evidence === undefined || !bounded(evidence.sku, 128) || !bounded(evidence.revision, 160) || !isField(evidence.field)) return undefined;
    projected.evidence = { sku: evidence.sku, revision: evidence.revision, field: evidence.field };
  }
  if (status === "needs_merchant" && followup !== undefined && typeof followup.case_ref === "string" && /^qa_[a-f0-9]{32}$/u.test(followup.case_ref) &&
      (followup.status === "pending" || followup.status === "in_progress" || followup.status === "answered" || followup.status === "closed_without_answer")) {
    projected.followup = { case_ref: followup.case_ref, status: followup.status };
  }
  return projected;
}

function project(value: Record<string, unknown>, wire: NegotiationEnvelope, reply: NegotiationEnvelope): MerchantReplyExtensions | undefined {
  if (wire.payload.type === "clarification" && reply.payload.type === "clarification_response" &&
      Array.isArray(value.product_answers) && value.product_answers.length > 0 && value.product_answers.length <= 16) {
    const answers = value.product_answers.map((entry) => productAnswer(entry, wire.payload.type === "clarification" ? wire.payload.questions.length : 0));
    if (answers.every((answer) => answer !== undefined)) return { product_answers: answers };
  }
  if (wire.payload.type === "counter_offer" && (reply.payload.type === "counter_offer" || reply.payload.type === "conditional_offer")) {
    const step = record(value.next_step);
    const quantity = record(step?.quantity);
    const items = wire.payload.proposed_terms.items;
    const original = items?.length === 1 ? items[0] : undefined;
    if (original !== undefined && step?.kind === "new_rfq" && step.requires_buyer_confirmation === true && step.sku === original.sku &&
        quantity?.unit === original.quantity.unit && typeof quantity.value === "number" && Number.isSafeInteger(quantity.value) &&
        quantity.value > 0 && quantity.value !== original.quantity.value) {
      return { next_step: { kind: "new_rfq", sku: original.sku, quantity: { value: quantity.value, unit: original.quantity.unit }, requires_buyer_confirmation: true } };
    }
  }
  return undefined;
}

/** 仅投影已验证 KNP 回复所在任务附带的受控建议；这些字段不属于报价条款。 */
export function readMerchantReplyExtensions(wire: NegotiationEnvelope, reply: NegotiationEnvelope, task: A2ATask): MerchantReplyExtensions | undefined {
  const kind = wire.action === "clarification" ? "kiwi_product_answers" : wire.action === "counter_offer" ? "kiwi_negotiation_next_step" : undefined;
  if (kind === undefined) return undefined;
  const parts = task.artifacts?.flatMap((artifact) => artifact.parts).filter((part) => part.kind === "data" && part.data.type === kind) ?? [];
  const part = parts[0];
  if (parts.length !== 1 || part?.kind !== "data" || part.data.version !== 1) return undefined;
  return project(kind === "kiwi_product_answers" ? { product_answers: part.data.answers } : { next_step: part.data }, wire, reply);
}

export function restoreMerchantReplyExtensions(value: unknown, wire: NegotiationEnvelope, reply: NegotiationEnvelope): MerchantReplyExtensions | undefined {
  const stored = record(value);
  return stored === undefined ? undefined : project(stored, wire, reply);
}
