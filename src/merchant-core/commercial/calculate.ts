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
 * 统一商业计算（v0.2 §9.2 / FR14）。
 *
 * 组合两个既有确定性引擎，不实现第三套算法：
 *  - 单价选择：与 `src/merchant/quote-calculator.ts` 相同的公开促销优先级
 *    （priority 降序、价格低→高、promotion_id 字典序）与私有 floor 判断；
 *  - 行/运费/税/总额：交给 `calculatePricing()`（HALF_UP_LINE、BigInt）。
 *
 * 失败语义：
 *  - 输入越界/币种/税基非法 → 抛 RfqError("pricing_invalid")，整单拒绝；
 *  - 促销候选非法或价格低于私有 floor → `approval_required`，不返回价格。
 */

import { RfqError, type PricingResult } from "../rfq/types.js";
import {
  MAX_QUOTE_AMOUNT_MINOR,
  MAX_QUANTITY,
  calculatePricing,
} from "../rfq/pricing.js";
import {
  COMMERCIAL_CALCULATION_VERSION,
  type CommercialPromotion,
  type CommercialQuoteInput,
  type CommercialQuoteResult,
} from "./types.js";

const MAX_MINOR = BigInt(MAX_QUOTE_AMOUNT_MINOR);

function invalid(message: string): never {
  throw new RfqError("pricing_invalid", message);
}

function requireMinor(value: unknown, name: string, max = MAX_QUOTE_AMOUNT_MINOR): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    invalid(`${name} 必须是 [0, ${max}] 内的安全整数`);
  }
  return value;
}

function requireTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    invalid(`${name} 必须是可解析的 RFC 3339 时间`);
  }
  return value;
}

/**
 * 促销候选校验：与 `calculateWorkbenchQuote` 保持一致——任一候选非法
 * 就整单转审批，而不是悄悄跳过（跳过会让不同入口选出不同价格）。
 */
function validPromotions(input: CommercialQuoteInput): CommercialPromotion[] {
  const seen = new Set<string>();
  const valid: CommercialPromotion[] = [];
  for (const candidate of input.promotions ?? []) {
    if (
      typeof candidate.promotion_id !== "string" ||
      candidate.promotion_id === "" ||
      seen.has(candidate.promotion_id) ||
      !Number.isSafeInteger(candidate.revision) ||
      candidate.revision < 1 ||
      !Number.isSafeInteger(candidate.unit_price_minor) ||
      candidate.unit_price_minor < 0 ||
      candidate.unit_price_minor > MAX_QUOTE_AMOUNT_MINOR ||
      candidate.unit_price_minor > input.base_unit_price_minor ||
      !Number.isSafeInteger(candidate.priority) ||
      !Number.isFinite(Date.parse(candidate.ends_at))
    ) {
      return [];
    }
    seen.add(candidate.promotion_id);
    valid.push(candidate);
  }
  return valid;
}

function earliestTimestamp(candidates: Array<string | undefined>): string | null {
  const valid = candidates.filter(
    (value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)),
  );
  if (valid.length === 0) return null;
  return valid.reduce((earliest, value) =>
    Date.parse(value) < Date.parse(earliest) ? value : earliest,
  );
}

/** 确定性统一计算；同输入必须得到同输出（含排序与有效期）。 */
export function calculateCommercialQuote(input: CommercialQuoteInput): CommercialQuoteResult {
  if (input?.currency !== "CNY") invalid("首版仅支持 CNY");
  if (
    typeof input.quantity !== "number" ||
    !Number.isSafeInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > MAX_QUANTITY
  ) {
    invalid(`quantity 必须是 [1, ${MAX_QUANTITY}] 内的安全整数`);
  }
  const baseMinor = requireMinor(input.base_unit_price_minor, "base_unit_price_minor");
  const discountMinor = requireMinor(input.line_discount_minor ?? 0, "line_discount_minor");
  const shippingMinor = requireMinor(input.shipping_amount_minor ?? 0, "shipping_amount_minor");
  const now = requireTimestamp(input.now, "now");
  if (input.quote_ttl_seconds !== undefined) {
    if (
      !Number.isSafeInteger(input.quote_ttl_seconds) ||
      input.quote_ttl_seconds <= 0 ||
      input.quote_ttl_seconds > 366 * 24 * 3600
    ) {
      invalid("quote_ttl_seconds 必须是 (0, 366d] 内的安全整数");
    }
  }
  if (input.valid_until_cap !== undefined) requireTimestamp(input.valid_until_cap, "valid_until_cap");
  const lineTax = input.line_tax;
  if (
    (lineTax?.basis !== "EXCLUSIVE" && lineTax?.basis !== "INCLUSIVE") ||
    !Number.isSafeInteger(lineTax?.rate_bps) ||
    lineTax.rate_bps < 0 ||
    lineTax.rate_bps > 10_000
  ) {
    invalid("line_tax 必须是合法税基与 [0,10000] bps");
  }
  const shippingTax = input.shipping_tax;
  if (
    (shippingTax?.basis !== "EXCLUSIVE" && shippingTax?.basis !== "INCLUSIVE") ||
    !Number.isSafeInteger(shippingTax?.rate_bps) ||
    shippingTax.rate_bps < 0 ||
    shippingTax.rate_bps > 10_000
  ) {
    invalid("shipping_tax 必须是合法税基与 [0,10000] bps");
  }

  const promotions = validPromotions(input);
  if ((input.promotions?.length ?? 0) > 0 && promotions.length !== input.promotions!.length) {
    return {
      status: "approval_required",
      calculation_version: COMMERCIAL_CALCULATION_VERSION,
      reason: "invalid_promotion",
    };
  }
  promotions.sort(
    (left, right) =>
      right.priority - left.priority ||
      left.unit_price_minor - right.unit_price_minor ||
      left.promotion_id.localeCompare(right.promotion_id),
  );
  const selected = promotions[0];
  const unitPriceMinor = selected?.unit_price_minor ?? baseMinor;

  const floor = input.private_floor_minor;
  if (floor !== undefined) {
    if (!Number.isSafeInteger(floor) || floor < 0 || floor > MAX_QUOTE_AMOUNT_MINOR) {
      invalid("private_floor_minor 必须是合法 minor 整数");
    }
    if (BigInt(unitPriceMinor) < BigInt(floor)) {
      return {
        status: "approval_required",
        calculation_version: COMMERCIAL_CALCULATION_VERSION,
        reason: "below_private_floor",
      };
    }
  }

  const lineBase = BigInt(input.quantity) * BigInt(unitPriceMinor);
  if (lineBase > MAX_MINOR) invalid("quantity × unit_price_minor 超出金额上限");
  if (BigInt(discountMinor) > lineBase) invalid("line_discount_minor 超过行基数");

  let pricing: PricingResult;
  try {
    pricing = calculatePricing({
      schema_version: "0.1.0",
      currency: "CNY",
      rounding: "HALF_UP_LINE",
      lines: [
        {
          line_id: "line-1",
          quantity: input.quantity,
          unit_price_minor: unitPriceMinor,
          discount_minor: discountMinor,
          tax_basis: input.line_tax.basis,
          tax_rate_bps: input.line_tax.rate_bps,
        },
      ],
      shipping: {
        amount_minor: shippingMinor,
        tax_basis: input.shipping_tax.basis,
        tax_rate_bps: input.shipping_tax.rate_bps,
      },
    });
  } catch (err) {
    if (err instanceof RfqError) throw err;
    invalid(err instanceof Error ? err.message : String(err));
  }

  const ttlUntil =
    input.quote_ttl_seconds !== undefined
      ? new Date(Date.parse(now) + input.quote_ttl_seconds * 1_000).toISOString()
      : undefined;
  const validUntil = earliestTimestamp([
    ttlUntil,
    input.valid_until_cap,
    selected?.ends_at,
  ]);

  return {
    status: "quoted",
    calculation_version: COMMERCIAL_CALCULATION_VERSION,
    currency: "CNY",
    quantity: input.quantity,
    unit_price_minor: unitPriceMinor,
    source:
      selected === undefined
        ? { kind: "base" }
        : { kind: "promotion", promotion_id: selected.promotion_id, revision: selected.revision },
    pricing,
    valid_until: validUntil,
  };
}
