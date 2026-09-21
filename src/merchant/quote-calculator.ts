/** Shared exact quote selection for Workbench preview and deterministic A2A quoting. */

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
  const validPromotions: QuotePromotionCandidate[] = [];
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
      BigInt(money.amount_minor) > BigInt(base.amount_minor) ||
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
    validPromotions.push({ ...candidate, unit_price: money });
  }
  validPromotions.sort(
    (left, right) =>
      right.priority - left.priority ||
      compareMinor(left.unit_price.amount_minor, right.unit_price.amount_minor) ||
      left.promotion_id.localeCompare(right.promotion_id),
  );
  const selected = validPromotions[0];
  const price = selected?.unit_price ?? base;
  if (floor !== undefined && BigInt(price.amount_minor) < BigInt(floor)) {
    return {
      status: "approval_required",
      reason: "below_private_floor",
      calculator_version: "kiwi-quote/1",
    };
  }
  return {
    status: "quoted",
    unit_price: price,
    source:
      selected === undefined
        ? { kind: "base" }
        : {
            kind: "promotion",
            promotion_id: selected.promotion_id,
            revision: selected.revision,
          },
    valid_until_cap: selected?.ends_at ?? null,
    calculator_version: "kiwi-quote/1",
  };
}

function compareMinor(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
