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
 * 方案集合引擎（v0.2 §9.2–§9.3、§10.2）。
 *
 * 纯函数/无 IO：准备 1–3 个选项、判定可选性、生成选择记录与批准绑定，
 * 并给出公共投影。金额统一走 `calculateCommercialQuote`；私有 floor 只
 * 参与判定，不进入选项或投影。
 */

import { randomUUID } from "node:crypto";

import { contentDigest } from "../../negotiation/jcs.js";
import { calculateCommercialQuote } from "../commercial/calculate.js";
import type { CommercialQuoteResult } from "../commercial/types.js";
import {
  ProposalError,
  type ApprovalBinding,
  type ApprovalBindingInput,
  type ApprovalVerificationInput,
  type PrepareProposalSetInput,
  type ProposalOption,
  type ProposalOptionInput,
  type ProposalSet,
  type SelectionRecord,
  type SelectionRecordInput,
} from "./types.js";

const MAX_OPTIONS = 3;

function requireText(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new ProposalError("validation", `${name} 必须是非空字符串（≤${max}）`);
  }
  return value;
}

function requireTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ProposalError("validation", `${name} 必须是可解析的 RFC 3339 时间`);
  }
  return value;
}

function optionFingerprint(input: ProposalOptionInput, priceMinor: number | undefined): string {
  return JSON.stringify({
    sku: input.sku,
    unit: input.unit,
    quantity: input.quantity,
    price: priceMinor ?? null,
    alternative: input.is_alternative === true,
  });
}

function evaluateOption(
  input: ProposalOptionInput,
  optionId: string,
  now: string,
): { option: ProposalOption; quote: CommercialQuoteResult } {
  requireText(input.sku, "options[].sku", 128);
  requireText(input.unit, "options[].unit", 64);
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new ProposalError("validation", "options[].quantity 必须是正整数");
  }
  if (!Array.isArray(input.adaptation)) {
    throw new ProposalError("validation", "options[].adaptation 必须是数组");
  }
  const adaptation = input.adaptation.map((entry, index) => {
    requireText(entry?.constraint, `options[].adaptation[${index}].constraint`, 128);
    if (entry.result !== "MET" && entry.result !== "NOT_MET" && entry.result !== "UNKNOWN") {
      throw new ProposalError("validation", `options[].adaptation[${index}].result 非法`);
    }
    return {
      constraint: entry.constraint,
      result: entry.result,
      ...(entry.evidence_ref !== undefined
        ? { evidence_ref: requireText(entry.evidence_ref, `options[].adaptation[${index}].evidence_ref`, 256) }
        : {}),
    };
  });

  let quote: CommercialQuoteResult;
  try {
    quote = calculateCommercialQuote({
      currency: "CNY",
      quantity: input.quantity,
      base_unit_price_minor: input.base_unit_price_minor,
      ...(input.promotions !== undefined ? { promotions: input.promotions } : {}),
      ...(input.private_floor_minor !== undefined ? { private_floor_minor: input.private_floor_minor } : {}),
      ...(input.line_discount_minor !== undefined ? { line_discount_minor: input.line_discount_minor } : {}),
      ...(input.shipping_amount_minor !== undefined ? { shipping_amount_minor: input.shipping_amount_minor } : {}),
      line_tax: input.line_tax,
      shipping_tax: input.shipping_tax,
      ...(input.valid_until_cap !== undefined ? { valid_until_cap: input.valid_until_cap } : {}),
      ...(input.quote_ttl_seconds !== undefined ? { quote_ttl_seconds: input.quote_ttl_seconds } : {}),
      now,
    });
  } catch (err) {
    throw new ProposalError(
      "validation",
      `选项计价失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const blocking: string[] = [];
  if (quote.status === "approval_required") {
    blocking.push(`approval_required:${quote.reason}`);
  }
  for (const entry of adaptation) {
    if (entry.result === "NOT_MET") blocking.push(`hard_constraint_not_met:${entry.constraint}`);
    if (entry.result === "UNKNOWN") blocking.push(`evidence_missing:${entry.constraint}`);
  }
  let eligibility: ProposalOption["eligibility"] = "SELECTABLE";
  if (blocking.length > 0) eligibility = "BLOCKED";
  else if (input.is_alternative === true) {
    eligibility = "CHANGE_REQUIRES_CUSTOMER_CONFIRMATION";
    blocking.push("outside_confirmed_scope");
  }

  return {
    option: {
      option_id: optionId,
      sku: input.sku,
      unit: input.unit,
      quantity: input.quantity,
      currency: "CNY",
      ...(quote.status === "quoted"
        ? {
            unit_price_minor: quote.unit_price_minor,
            pricing: quote.pricing,
            valid_until: quote.valid_until,
            price_source: quote.source,
          }
        : {}),
      adaptation,
      eligibility,
      blocking_reasons: blocking,
      is_alternative: input.is_alternative === true,
      ...(input.note !== undefined ? { note: requireText(input.note, "options[].note", 1_024) } : {}),
    },
    quote,
  };
}

/** 准备方案集合：1–3 个选项；没有差异的重复选项拒绝。 */
export function prepareProposalSet(input: PrepareProposalSetInput): ProposalSet {
  const merchantId = requireText(input.merchant_id, "merchant_id", 128);
  const opportunityId = requireText(input.opportunity_id, "opportunity_id", 128);
  const factsDigest = requireText(input.facts_digest, "facts_digest", 256);
  const policyVersion = requireText(input.policy_version, "policy_version", 256);
  const now = requireTimestamp(input.now, "now");
  if (!Number.isSafeInteger(input.requirement_revision) || input.requirement_revision < 1) {
    throw new ProposalError("validation", "requirement_revision 必须是正整数");
  }
  if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > MAX_OPTIONS) {
    throw new ProposalError("validation", `方案集合必须包含 1–${MAX_OPTIONS} 个选项`);
  }

  const seenIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const options: ProposalOption[] = [];
  for (const optionInput of input.options) {
    const optionId =
      optionInput.option_id !== undefined
        ? requireText(optionInput.option_id, "options[].option_id", 128)
        : `opt_${randomUUID()}`;
    if (seenIds.has(optionId)) throw new ProposalError("validation", `重复 option_id：${optionId}`);
    seenIds.add(optionId);

    const evaluated = evaluateOption(optionInput, optionId, now);
    const fingerprint = optionFingerprint(
      optionInput,
      evaluated.option.unit_price_minor,
    );
    if (seenFingerprints.has(fingerprint)) {
      throw new ProposalError("validation", "方案选项没有差异；没有差异时只生成一个选项");
    }
    seenFingerprints.add(fingerprint);
    options.push(evaluated.option);
  }

  const status = options.some((option) => option.eligibility === "SELECTABLE")
    ? "READY"
    : "EVALUATED";
  return {
    set_id: `pset_${randomUUID()}`,
    merchant_id: merchantId,
    opportunity_id: opportunityId,
    requirement_revision: input.requirement_revision,
    facts_digest: factsDigest,
    policy_version: policyVersion,
    status,
    options,
    created_at: now,
    updated_at: now,
    revision: 1,
  };
}

/** 公开投影：只含可说明的适配、报价与条件；不含 floor、来源与规则版本。 */
export function publicOptionProjection(option: ProposalOption): Record<string, unknown> {
  return {
    option_id: option.option_id,
    sku: option.sku,
    unit: option.unit,
    quantity: option.quantity,
    currency: option.currency,
    ...(option.unit_price_minor !== undefined ? { unit_price_minor: option.unit_price_minor } : {}),
    ...(option.pricing !== undefined ? { totals: option.pricing.totals } : {}),
    ...(option.valid_until !== undefined ? { valid_until: option.valid_until } : {}),
    adaptation: option.adaptation.map((entry) => ({
      constraint: entry.constraint,
      result: entry.result,
      ...(entry.evidence_ref !== undefined ? { evidence_ref: entry.evidence_ref } : {}),
    })),
    eligibility: option.eligibility,
    ...(option.note !== undefined ? { note: option.note } : {}),
  };
}

/** 选定方案：只能选已确认范围内、且未被硬约束/审批阻塞的选项。 */
export function createSelection(input: SelectionRecordInput): SelectionRecord {
  const { set } = input;
  if (set.status === "STALE" || set.status === "WITHDRAWN") {
    throw new ProposalError("not_selectable", `方案集合状态 ${set.status} 不能选定`);
  }
  const option = set.options.find((candidate) => candidate.option_id === input.option_id);
  if (option === undefined) {
    throw new ProposalError("not_found", `option ${input.option_id} not found`);
  }
  if (input.requirement_revision !== set.requirement_revision) {
    throw new ProposalError("requirement_out_of_scope", "客户需求版本已变化，不能沿用旧方案");
  }
  if (option.eligibility === "CHANGE_REQUIRES_CUSTOMER_CONFIRMATION") {
    throw new ProposalError(
      "requirement_out_of_scope",
      "替代品或数量变化超出客户已确认范围；先取得客户确认",
    );
  }
  if (option.eligibility !== "SELECTABLE") {
    throw new ProposalError(
      "not_selectable",
      `选项不可选定：${option.blocking_reasons.join(",") || "unknown"}`,
    );
  }
  requireText(input.selected_by, "selected_by", 128);
  requireTimestamp(input.now, "now");
  validatePublishReference(input.publish_reference);
  return {
    selection_id: `sel_${randomUUID()}`,
    merchant_id: requireText(input.merchant_id, "merchant_id", 128),
    set_id: set.set_id,
    option_id: option.option_id,
    selected_by: input.selected_by,
    selected_at: input.now,
    requirement_revision: input.requirement_revision,
    publish_reference: input.publish_reference,
  };
}

function validatePublishReference(reference: SelectionRecord["publish_reference"]): void {
  if (reference.kind === "rfq_quote") {
    requireText(reference.quote_id, "publish_reference.quote_id", 128);
    if (!Number.isSafeInteger(reference.revision) || reference.revision < 1) {
      throw new ProposalError("validation", "publish_reference.revision 必须是正整数");
    }
    return;
  }
  if (reference.kind === "knp_offer") {
    requireText(reference.negotiation_id, "publish_reference.negotiation_id", 256);
    requireText(reference.terms_digest, "publish_reference.terms_digest", 256);
    if (reference.action !== "offer" && reference.action !== "counter_offer") {
      throw new ProposalError("validation", "publish_reference.action 非法");
    }
    return;
  }
  throw new ProposalError("validation", "publish_reference.kind 非法");
}

/** 批准绑定：摘要覆盖商家、方案/选项、需求版本、策略版本与动作范围。 */
export function createApprovalBinding(input: ApprovalBindingInput): ApprovalBinding {
  const now = requireTimestamp(input.now, "now");
  const expiresAt = requireTimestamp(input.expires_at, "expires_at");
  if (Date.parse(expiresAt) <= Date.parse(now)) {
    throw new ProposalError("validation", "expires_at 必须晚于 now");
  }
  const option = input.set.options.find((candidate) => candidate.option_id === input.option_id);
  if (option === undefined) throw new ProposalError("not_found", `option ${input.option_id} not found`);
  if (option.eligibility !== "SELECTABLE" || input.set.status !== "READY") {
    throw new ProposalError("not_selectable", "只有 READY 集合中的可选选项可以申请批准");
  }
  const policyVersion = requireText(input.policy_version, "policy_version", 256);
  if (policyVersion !== input.set.policy_version) {
    throw new ProposalError("approval_mismatch", "策略版本与方案集合不一致");
  }
  const contentDigest = approvalDigest(input.set, option.option_id, policyVersion);
  return {
    approval_id: `apr_${randomUUID()}`,
    merchant_id: requireText(input.merchant_id, "merchant_id", 128),
    set_id: input.set.set_id,
    option_id: option.option_id,
    opportunity_id: input.set.opportunity_id,
    requirement_revision: input.set.requirement_revision,
    policy_version: policyVersion,
    content_digest: contentDigest,
    scope: "publish_quote",
    expires_at: expiresAt,
    created_at: now,
  };
}

function approvalDigest(set: ProposalSet, optionId: string, policyVersion: string): string {
  const option = set.options.find((candidate) => candidate.option_id === optionId);
  if (option === undefined) throw new ProposalError("not_found", `option ${optionId} not found`);
  return contentDigest({
    merchant_id: set.merchant_id,
    opportunity_id: set.opportunity_id,
    set_id: set.set_id,
    option_id: optionId,
    requirement_revision: set.requirement_revision,
    policy_version: policyVersion,
    scope: "publish_quote",
    content: publicOptionProjection(option),
  });
}

/** 发布前复验：版本、选项、策略、有效期与摘要必须全部仍然一致。 */
export function verifyApprovalBinding(input: ApprovalVerificationInput): void {
  const { binding, set } = input;
  if (Date.parse(input.now) >= Date.parse(binding.expires_at)) {
    throw new ProposalError("approval_expired", "批准已过期");
  }
  if (
    binding.merchant_id !== set.merchant_id ||
    binding.set_id !== set.set_id ||
    binding.opportunity_id !== set.opportunity_id ||
    binding.option_id !== input.option_id ||
    binding.requirement_revision !== set.requirement_revision ||
    binding.policy_version !== input.policy_version ||
    input.policy_version !== set.policy_version ||
    set.status !== "READY"
  ) {
    throw new ProposalError("approval_mismatch", "批准绑定与当前方案/策略/需求版本不一致");
  }
  const expected = approvalDigest(set, input.option_id, input.policy_version);
  if (expected !== binding.content_digest) {
    throw new ProposalError("approval_mismatch", "批准摘要与当前对外内容不一致");
  }
}

/** 事实/策略/需求变化：旧集合标记 STALE，不静默改价。 */
export function markSetStale(set: ProposalSet, reason: string, now: string): ProposalSet {
  requireText(reason, "reason", 512);
  requireTimestamp(now, "now");
  return {
    ...set,
    status: "STALE",
    stale_reason: reason,
    updated_at: now,
    revision: set.revision + 1,
  };
}

export function withdrawSet(set: ProposalSet, now: string): ProposalSet {
  requireTimestamp(now, "now");
  return { ...set, status: "WITHDRAWN", updated_at: now, revision: set.revision + 1 };
}

/** 方案集合的公共视图：只暴露选项的公共投影。 */
export function publicSetProjection(set: ProposalSet): Record<string, unknown> {
  return {
    set_id: set.set_id,
    opportunity_id: set.opportunity_id,
    requirement_revision: set.requirement_revision,
    status: set.status,
    options: set.options.map(publicOptionProjection),
    ...(set.stale_reason !== undefined ? { stale_reason: set.stale_reason } : {}),
    updated_at: set.updated_at,
    revision: set.revision,
  };
}
