import { describe, expect, it } from "vitest";

import {
  assertWorkbenchCurrencySupported,
  decimalMajorToMinor,
  divideHalfUp,
  MAX_KNP_MINOR,
  multiplyMinor,
  parseExactMoney,
  rejectLegacyNumberMoney,
  WorkbenchMoneyError,
} from "../src/merchant/application/money.js";

describe("Workbench exact money contract", () => {
  it("converts the required exponent vectors from authoritative decimal text", () => {
    expect(decimalMajorToMinor("CNY", "99.99").amount_minor).toBe("9999");
    expect(decimalMajorToMinor("JPY", "100").amount_minor).toBe("100");
    expect(decimalMajorToMinor("KWD", "1.234").amount_minor).toBe("1234");
    expect(() => decimalMajorToMinor("CNY", "1.001")).toThrowError(WorkbenchMoneyError);
    expect(() => decimalMajorToMinor("JPY", "1.1")).toThrow(/allows 0 fractional digits/);
  });

  it("requires integer strings and enforces the locked KNP safe range", () => {
    expect(parseExactMoney({ currency: "CNY", amount_minor: "0" }).amount_minor).toBe("0");
    expect(
      parseExactMoney({ currency: "CNY", amount_minor: MAX_KNP_MINOR.toString() }).amount_minor,
    ).toBe(MAX_KNP_MINOR.toString());
    for (const invalid of ["-1", "01", "1.0", "1e2", 100]) {
      expect(() => parseExactMoney({ currency: "CNY", amount_minor: invalid })).toThrow(
        /strings|integer string/,
      );
    }
    expect(() =>
      parseExactMoney({ currency: "CNY", amount_minor: (MAX_KNP_MINOR + 1n).toString() }),
    ).toThrow(/safe integer boundary/);
  });

  it("separates conversion metadata from enabled operating currencies", () => {
    expect(assertWorkbenchCurrencySupported("CNY")).toBe("CNY");
    expect(() => assertWorkbenchCurrencySupported("JPY")).toThrow(/not enabled/);
    expect(() => decimalMajorToMinor("ABC", "1")).toThrow(/absent/);
  });

  it("never pretends a historical JSON Number can recover its original token", () => {
    expect(() => rejectLegacyNumberMoney("CNY", 19.99)).toThrow(/cannot prove/);
    expect(() => rejectLegacyNumberMoney("CNY", Number.NaN)).toThrow(/not finite/);
  });

  it("uses exact non-negative half-up arithmetic", () => {
    expect(divideHalfUp(100n, 3n)).toBe(33n);
    expect(divideHalfUp(101n, 2n)).toBe(51n);
    expect(
      multiplyMinor(decimalMajorToMinor("CNY", "100.00"), 925n, 1000n).amount_minor,
    ).toBe("9250");
    expect(() => multiplyMinor(decimalMajorToMinor("CNY", "1.00"), -1n, 1n)).toThrow(
      /non-negative/,
    );
  });
});
