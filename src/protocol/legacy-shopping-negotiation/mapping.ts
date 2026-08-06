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
 * LegacyNegotiationAdapter 双向字段映射（基线 §35 / 子规范 §32）。
 *
 * 核心约定：
 *
 * 1. conversation_id ↔ negotiation_id —— 直接映射（双方都是 opaque string）。
 * 2. legacy message id（int）↔ KNP message_id（string）：
 *      `msg_legacy_<int>` 可逆编码。KNP 侧出现非该形态的 message_id /
 *      in_reply_to / target_message_id 时，KNP→legacy 无法恢复 int 语义 →
 *      fail-closed（identity 语义，§35 不得静默丢弃）。
 * 3. legacy 消息承载的 offer ↔ KNP offer_id：
 *      legacy 消息路径（已分配消息 id）：`off_legacy_<message_id>`；
 *      legacy decision 路径（尚未分配消息 id）：内容寻址 `off_<sha256>`，
 *      同一决策重试生成同一 offer_id（幂等，§6.4）。
 * 4. 受保护语义（conditions / expiry / identity / agreement）在 KNP→legacy
 *      方向无法表达即 fail-closed / requires-human，绝不静默丢弃字段。
 *
 * legacy-only 字段（stock / delivery eta / fee / after_sales refs / open_issues）
 * 在 legacy→KNP 方向用 KNP 允许的 terms 域内 legacy-extension 字段保真，
 * 并记录 extension note —— 既不丢失，也明确标注不是 KNP/1.0 定义的字段。
 */

import { canonicalize, sha256Hex } from "../../negotiation/jcs.js";
import type { TermSet } from "../../negotiation/domain/common.js";
import { requireIsoTimestamp } from "../../negotiation/domain/common.js";
import type { NegotiationAction } from "../../negotiation/domain/objects.js";
import type { DecisionAction, Proposal, StockState } from "../../negotiation/types.js";
import { fromMinorUnits, toMinorUnits } from "./money.js";
import type { TranslationNote } from "./types.js";

// ---------------------------------------------------------------------------
// Action 映射
// ---------------------------------------------------------------------------

/** legacy action → KNP action。`requires_human` = legacy 无 KNP 等价物（§35 unsupported → human）。 */
export const LEGACY_TO_KNP_ACTION: Record<
  DecisionAction,
  NegotiationAction | "requires_human"
> = {
  ask: "inquiry",
  propose: "offer",
  counter: "counter_offer",
  accept_nonbinding: "accept_nonbinding",
  decline: "decline",
  escalate: "requires_human",
};

/** KNP action → legacy action。`fail_closed` = 受保护语义无法表达；`requires_human` = unsupported。 */
export const KNP_TO_LEGACY_ACTION: Record<
  NegotiationAction,
  DecisionAction | "fail_closed" | "requires_human"
> = {
  inquiry: "ask",
  rfq: "requires_human", // legacy 无 RFQ；结构化 items 无法塞进 legacy ask
  offer: "propose",
  counter_offer: "counter",
  conditional_offer: "fail_closed", // conditions 受保护（§35）：legacy 无法表达
  clarification: "ask",
  clarification_response: "requires_human", // legacy 无结构化澄清应答
  accept_nonbinding: "accept_nonbinding",
  withdraw: "requires_human", // legacy 无 withdraw
  decline: "decline",
  cancel: "requires_human", // legacy 无 cancel
};

// ---------------------------------------------------------------------------
// Identifier 编码（§35 identity / §6）
// ---------------------------------------------------------------------------

const LEGACY_MSG_ID_PATTERN = /^msg_legacy_(\d{1,10})$/;
const LEGACY_OFFER_ID_PATTERN = /^off_legacy_(\d{1,10})$/;

/** legacy 消息 id（int）→ KNP message_id（可逆）。 */
export function legacyMessageIdToKnp(messageId: number): string {
  return `msg_legacy_${messageId}`;
}

/** KNP message_id → legacy 消息 id（int）；非 `msg_legacy_<int>` 形态返回 null。 */
export function knpMessageIdToLegacy(messageId: string): number | null {
  const match = LEGACY_MSG_ID_PATTERN.exec(messageId);
  return match === null ? null : Number(match[1]);
}

/** legacy 消息承载的 offer → KNP offer_id（可逆，消息路径）。 */
export function offerIdOfLegacyMessage(messageId: number): string {
  return `off_legacy_${messageId}`;
}

/** KNP offer_id → legacy 消息 id；非 `off_legacy_<int>` 形态返回 null。 */
export function legacyOfferIdFromKnp(offerId: string): number | null {
  const match = LEGACY_OFFER_ID_PATTERN.exec(offerId);
  return match === null ? null : Number(match[1]);
}

/** 内容寻址 id：同一 legacy 决策/terms 产生同一 KNP id（重试幂等，§6.3/§6.4）。 */
export function deterministicId(prefix: "ex" | "msg" | "off", seed: string): string {
  return `${prefix}_${sha256Hex(seed).slice(0, 16)}`;
}

/**
 * decision 路径的内容种子：不依赖未来才分配的消息 id。
 * 包含完整商业内容（含 public_message），因此 §6.3 的「不同内容不得复用同一
 * message_id」成立；同一决策重试产生同一 message_id（§6.3/§20 idempotency）。
 * 注：created_at 不参与种子 —— 若调用方用适配器时钟缺省填充，重试必须复用
 * 同一 ctx.created_at，否则 digest 变化会触发 idempotency_conflict。
 */
export function decisionContentSeed(
  conversationId: string,
  action: NegotiationAction,
  inReplyToMessageId: number,
  terms: TermSet | undefined,
  publicMessage: string,
): string {
  return canonicalize({
    conversation_id: conversationId,
    action,
    in_reply_to_message_id: inReplyToMessageId,
    terms,
    public_message: publicMessage,
  });
}

// ---------------------------------------------------------------------------
// Proposal ↔ TermSet（§7.4 / decision.schema.json #/$defs/proposal）
// ---------------------------------------------------------------------------

export type MoneyLike = { currency: string; amount_minor: number };

const STOCK_STATUSES = ["available", "low", "out_of_stock", "unknown"] as const;

/** legacy stock 块形状校验：防外来 KNP 注入伪造库存事实。 */
export function isLegacyStockState(value: unknown): value is StockState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.status === "string" &&
    (STOCK_STATUSES as readonly string[]).includes(s.status) &&
    typeof s.quantity === "number" &&
    Number.isInteger(s.quantity) &&
    s.quantity >= 0 &&
    typeof s.observed_at === "string" &&
    s.reserved === false
  );
}

function isRfc3339(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    requireIsoTimestamp(value, "/");
    return true;
  } catch {
    return false;
  }
}

function isMoneyLike(value: unknown): value is MoneyLike {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.currency === "string" &&
    typeof m.amount_minor === "number" &&
    Number.isInteger(m.amount_minor) &&
    m.amount_minor >= 0
  );
}

export interface TermConversion<T> {
  ok: true;
  value: T;
  notes: TranslationNote[];
}

export interface TermConversionError {
  ok: false;
  reason: string;
}

export type TermConversionResult<T> = TermConversion<T> | TermConversionError;

/**
 * legacy Proposal → KNP TermSet（§7.4）。
 *
 * 无损路径：sku/quantity/unit_price/currency → items[0]；
 * valid_until → terms.valid_until（expiry 语义保真）。
 * legacy-extension（记录 note，不属于 KNP/1.0 定义字段）：
 *   stock → fulfillment_terms.legacy_stock
 *   delivery.eta_start/eta_end/fee → fulfillment_terms.eta_start/eta_end/delivery_fee
 *   after_sales_policy_refs → service_terms.after_sales_policy_refs
 * 默认填充（记录 note）：quantity.unit 缺省 "piece"。
 * 有损拒绝：金额小数位超出最小单位（§7.1 float 金额禁止）。
 */
export function proposalToTerms(
  proposal: Proposal,
  currencyExponentOf: (currency: string) => number,
): TermConversionResult<TermSet> {
  const notes: TranslationNote[] = [];
  const exponent = currencyExponentOf(proposal.currency);

  const unitPrice = toMinorUnitsLossy(proposal.unit_price, exponent);
  if (!unitPrice.ok) {
    return {
      ok: false,
      reason: `unit_price ${proposal.unit_price} ${proposal.currency} is not representable in minor units (exponent ${exponent}): ${unitPrice.reason}`,
    };
  }
  const fee = toMinorUnitsLossy(proposal.delivery.fee, exponent);
  if (!fee.ok) {
    return {
      ok: false,
      reason: `delivery.fee ${proposal.delivery.fee} ${proposal.currency} is not representable in minor units (exponent ${exponent}): ${fee.reason}`,
    };
  }

  notes.push({
    kind: "default",
    path: "proposal.quantity.unit",
    detail: 'legacy quantity is unit-less; defaulted to "piece"',
  });
  notes.push({
    kind: "extension",
    path: "proposal.stock",
    detail: "stock preserved as terms.fulfillment_terms.legacy_stock (legacy-extension field, not defined by KNP/1.0)",
  });
  notes.push({
    kind: "extension",
    path: "proposal.delivery",
    detail: "eta_start/eta_end/delivery_fee preserved as terms.fulfillment_terms legacy-extension fields",
  });
  notes.push({
    kind: "extension",
    path: "proposal.after_sales_policy_refs",
    detail: "after_sales_policy_refs preserved as terms.service_terms.after_sales_policy_refs (legacy-extension field)",
  });

  const terms: TermSet = {
    items: [
      {
        sku: proposal.sku,
        quantity: { value: proposal.quantity, unit: "piece" },
        unit_price: { currency: proposal.currency, amount_minor: unitPrice.amount_minor },
      },
    ],
    fulfillment_terms: {
      eta_start: proposal.delivery.eta_start,
      eta_end: proposal.delivery.eta_end,
      delivery_fee: { currency: proposal.currency, amount_minor: fee.amount_minor },
      legacy_stock: proposal.stock,
    },
    service_terms: { after_sales_policy_refs: proposal.after_sales_policy_refs },
    valid_until: proposal.valid_until,
  };
  return { ok: true, value: terms, notes };
}

/**
 * KNP TermSet → legacy Proposal（decision.schema.json #/$defs/proposal）。
 *
 * legacy proposal 是单 SKU、强制 stock/delivery/valid_until；KNP 缺这些
 * 语义时 fail-closed（expiry 受保护：KNP 无 valid_until 时不得发明一个；
 * 缺 stock / delivery 同理不得发明库存/履约事实）。
 */
export function termsToProposal(
  terms: TermSet,
  currencyExponentOf: (currency: string) => number,
): TermConversionResult<Proposal> {
  const notes: TranslationNote[] = [];
  const items = terms.items ?? [];
  if (items.length !== 1) {
    return {
      ok: false,
      reason: `legacy proposal is single-SKU; KNP terms carry ${items.length} item(s)`,
    };
  }
  const item = items[0]!;
  if (item.unit_price === undefined) {
    return { ok: false, reason: "legacy proposal requires a unit price; KNP item carries none" };
  }
  const exponent = currencyExponentOf(item.unit_price.currency);

  if (item.quantity.unit !== "piece") {
    notes.push({
      kind: "dropped",
      path: "terms.items[0].quantity.unit",
      detail: `unit "${item.quantity.unit}" dropped; legacy quantity is unit-less`,
    });
  }

  const fulfillment = terms.fulfillment_terms ?? {};
  const etaStart = fulfillment.eta_start;
  const etaEnd = fulfillment.eta_end;
  if (!isRfc3339(etaStart) || !isRfc3339(etaEnd)) {
    return {
      ok: false,
      reason: "legacy proposal requires delivery eta_start/eta_end (RFC 3339); KNP terms carry none",
    };
  }
  const fee = fulfillment.delivery_fee;
  if (!isMoneyLike(fee)) {
    return { ok: false, reason: "legacy proposal requires delivery.fee; KNP terms carry no delivery fee" };
  }
  if (fee.currency !== item.unit_price.currency) {
    return {
      ok: false,
      reason: `delivery_fee currency ${fee.currency} differs from item currency ${item.unit_price.currency}; legacy proposal is single-currency`,
    };
  }
  const stock = fulfillment.legacy_stock;
  if (!isLegacyStockState(stock)) {
    return {
      ok: false,
      reason: "legacy proposal requires stock state; KNP terms carry no valid inventory observation",
    };
  }

  const afterSalesRefs = terms.service_terms?.after_sales_policy_refs;
  const afterSales: string[] = Array.isArray(afterSalesRefs) ? afterSalesRefs : [];
  if (!Array.isArray(afterSalesRefs)) {
    notes.push({
      kind: "default",
      path: "proposal.after_sales_policy_refs",
      detail: "KNP terms carry no after-sales refs; defaulted to []",
    });
  }
  if (terms.valid_until === undefined) {
    return {
      ok: false,
      reason: "legacy proposal requires valid_until; KNP offer has no expiry and the adapter must not invent one",
    };
  }

  const proposal: Proposal = {
    sku: item.sku,
    quantity: item.quantity.value,
    unit_price: fromMinorUnitsLossy(item.unit_price.amount_minor, exponent),
    currency: item.unit_price.currency,
    stock,
    delivery: { eta_start: etaStart, eta_end: etaEnd, fee: fromMinorUnitsLossy(fee.amount_minor, exponent) },
    after_sales_policy_refs: afterSales,
    valid_until: terms.valid_until,
  };
  return { ok: true, value: proposal, notes };
}

function toMinorUnitsLossy(
  amount: number,
  exponent: number,
): { ok: true; amount_minor: number } | { ok: false; reason: string } {
  const conv = toMinorUnits(amount, exponent);
  if (!conv.lossless) {
    return {
      ok: false,
      reason: `amount ${amount} exceeds minor-unit precision (10^${exponent})`,
    };
  }
  return { ok: true, amount_minor: conv.amount_minor };
}

function fromMinorUnitsLossy(amountMinor: number, exponent: number): number {
  return fromMinorUnits(amountMinor, exponent);
}
