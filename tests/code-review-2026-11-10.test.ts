// Code review 2026-11-10 P1-3: default discount counter offers must stay in
// integer minor units, otherwise the delegation gate rejects nearly every
// common price (any current amount not a multiple of 10 minor units).
import { describe, expect, it } from "vitest";

import { targetPriceMinor } from "../src/buyer-core/a2a-negotiator.js";

describe("targetPriceMinor (P1-3)", () => {
  it("keeps integer minor units for prices that are not round deca-minor", () => {
    for (const current of [14907, 8901, 12345, 999, 70, 1234567]) {
      const target = targetPriceMinor({}, current, 0.1);
      expect(Number.isSafeInteger(target)).toBe(true);
      expect(target).toBeGreaterThanOrEqual(0);
      expect(target).toBe(Math.max(0, Math.round(current * 0.9)));
    }
  });

  it("prefers an explicit target_unit_price in minor units", () => {
    expect(
      targetPriceMinor({ constraints: { target_unit_price: { currency: "CNY", amount_minor: 13500 } } }, 14907, 0.1),
    ).toBe(13500);
  });

  it("derives from budget and quantity without floating minor output", () => {
    const target = targetPriceMinor({ constraints: { budget: { amount_minor: 30000 } }, items: [{ quantity: { value: 2, unit: "piece" } }] }, 14907, 0.1);
    expect(target).toBe(15000);
    expect(Number.isSafeInteger(target)).toBe(true);
  });
});
