import { describe, expect, it } from "vitest";

import { WORKBENCH_CURRENCY_TABLE_VERSION } from "../src/merchant/application/money.js";
import type { ExactMoney } from "../src/merchant/application/money.js";
import { calculateWorkbenchQuote } from "../src/merchant/quote-calculator.js";

const money = (amount_minor: string): ExactMoney => ({
  currency: "CNY",
  amount_minor,
  currency_table_version: WORKBENCH_CURRENCY_TABLE_VERSION,
});

describe("shared Workbench quote calculator", () => {
  it("selects highest priority then lowest exact price deterministically", () => {
    expect(
      calculateWorkbenchQuote({
        base: money("10000"),
        quantity: 10,
        promotions: [
          {
            promotion_id: "low-priority",
            revision: 1,
            unit_price: money("8000"),
            ends_at: "2026-09-22T00:00:00Z",
            priority: 1,
          },
          {
            promotion_id: "priority-b",
            revision: 2,
            unit_price: money("9000"),
            ends_at: "2026-09-22T00:00:00Z",
            priority: 10,
          },
          {
            promotion_id: "priority-a",
            revision: 3,
            unit_price: money("9000"),
            ends_at: "2026-09-22T00:00:00Z",
            priority: 10,
          },
        ],
      }),
    ).toMatchObject({
      status: "quoted",
      unit_price: { amount_minor: "9000" },
      source: { promotion_id: "priority-a", revision: 3 },
    });
  });

  it("returns redacted approval_required instead of exposing a private floor", () => {
    const result = calculateWorkbenchQuote({
      base: money("10000"),
      quantity: 1,
      privateFloorMinor: "9000",
      promotions: [
        {
          promotion_id: "too-low",
          revision: 1,
          unit_price: money("8000"),
          ends_at: "2026-09-22T00:00:00Z",
          priority: 1,
        },
      ],
    });
    expect(result).toEqual({
      status: "approval_required",
      reason: "below_private_floor",
      calculator_version: "kiwi-quote/1",
    });
    expect(JSON.stringify(result)).not.toContain("9000");
  });

  it("rejects cross-currency or price-increasing promotions", () => {
    expect(
      calculateWorkbenchQuote({
        base: money("10000"),
        quantity: 1,
        promotions: [
          {
            promotion_id: "invalid",
            revision: 1,
            unit_price: money("10001"),
            ends_at: "2026-09-22T00:00:00Z",
            priority: 1,
          },
        ],
      }),
    ).toMatchObject({ status: "approval_required", reason: "invalid_promotion" });
  });
});
