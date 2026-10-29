/** Shared exact quote selection for Workbench preview and deterministic A2A quoting. */

import { calculateCommercialQuote } from "../merchant-core/commercial/calculate.js";
import { parseExactMoney, type ExactMoney } from "./application/money.js";

export interface QuotePromotionCandidate {
  promotion_id: string;
  revision: number;
  unit_price: ExactMoney;
  ends_at: string;
  priority: number;
}

export type WorkbenchQuoteResult =
  | {
      status: "quoted";
      unit_price: ExactMoney;
      source: { kind: "base" } | { kind: "promotion"; promotion_id: string; revision: number };
      valid_until_cap: string | null;
      calculator_version: "kiwi-quote/1";
    }
  | {
      status: "approval_required";
      reason: "below_private_floor" | "invalid_promotion";
      calculator_version: "kiwi-quote/1";
    };

/**
 * 工作台/A2A 共用的公开单价选择。
 *
 * 单价选择、promotion 优先级与私有 floor 判断统一委托给
 * `calculateCommercialQuote`（v0.2 §9.2）；本函数只保留历史返回形状，
 * 避免两套排序/边界逻辑漂移。
 */
export function calculateWorkbenchQuote(input: {
  base: ExactMoney;
  quantity: number;
  promotions?: readonly QuotePromotionCandidate[];
  privateFloorMinor?: string;
}): WorkbenchQuoteResult {
  const base = parseExactMoney(input.base, { requireOperatingSupport: true });
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new Error("quote quantity must be a positive integer");
  }
  const floor = input.privateFloorMinor;
  if (floor !== undefined && !/^(0|[1-9][0-9]*)$/u.test(floor)) {
    throw new Error("private floor must be an exact minor-unit string");
  }

  const promotions: Array<{
    promotion_id: string;
    revision: number;
    unit_price_minor: number;
    ends_at: string;
    priority: number;
  }> = [];
  for (const candidate of input.promotions ?? []) {
    let money: ExactMoney;
    try {
      money = parseExactMoney(candidate.unit_price, { requireOperatingSupport: true });
    } catch {
      return {
        status: "approval_required",
        reason: "invalid_promotion",
        calculator_version: "kiwi-quote/1",
      };
    }
    if (
      money.currency !== base.currency ||
      !Number.isSafeInteger(candidate.revision) ||
      candidate.revision < 1 ||
      !Number.isSafeInteger(candidate.priority) ||
      !Number.isFinite(Date.parse(candidate.ends_at))
    ) {
      return {
        status: "approval_required",
        reason: "invalid_promotion",
        calculator_version: "kiwi-quote/1",
      };
    }
    promotions.push({
      promotion_id: candidate.promotion_id,
      revision: candidate.revision,
      unit_price_minor: Number(money.amount_minor),
      ends_at: candidate.ends_at,
      priority: candidate.priority,
    });
  }

  const result = calculateCommercialQuote({
    currency: "CNY",
    quantity: input.quantity,
    base_unit_price_minor: Number(base.amount_minor),
    promotions,
    ...(floor !== undefined ? { private_floor_minor: Number(floor) } : {}),
    line_tax: { basis: "EXCLUSIVE", rate_bps: 0 },
    shipping_tax: { basis: "EXCLUSIVE", rate_bps: 0 },
    now: new Date().toISOString(),
  });

  if (result.status === "approval_required") {
    return {
      status: "approval_required",
      reason: result.reason,
      calculator_version: "kiwi-quote/1",
    };
  }
  return {
    status: "quoted",
    unit_price: {
      currency: base.currency,
      amount_minor: String(result.unit_price_minor),
      currency_table_version: base.currency_table_version,
    },
    source: result.source,
    valid_until_cap: result.valid_until,
    calculator_version: "kiwi-quote/1",
  };
}
