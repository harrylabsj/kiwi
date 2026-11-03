import { describe, expect, it } from "vitest";

import {
  canonicalUnitToken,
  normalizeUnitAliasMap,
  normalizeUnitFactorMap,
  multiplyQuantitySafe,
  normalizeUnitToken,
  resolveUnitConversion,
  unitConversionPolicy,
  unitsAreCanonicalAliases,
} from "../src/a2a/unit-alias.js";

describe("explicit box/盒 unit aliases", () => {
  it("matches box and 盒 in both directions", () => {
    expect(unitsAreCanonicalAliases("box", "盒")).toBe(true);
    expect(unitsAreCanonicalAliases("盒", "box")).toBe(true);
    expect(unitsAreCanonicalAliases("BOX", "盒")).toBe(true);
    expect(canonicalUnitToken("盒")).toBe("box");
    expect(normalizeUnitToken(" ＢＯＸ ")).toBe("box");
  });

  it("normalizes alias and package-factor config keys/values", () => {
    expect(normalizeUnitAliasMap({ "ＢＯＸ": "盒" })).toEqual({ box: "box" });
    expect(normalizeUnitFactorMap({ "ＢＯＸ": 12 })).toEqual({ box: 12 });
    expect(normalizeUnitFactorMap({ "盒": 1 })).toEqual({ box: 1 });
  });

  it("accepts redundant same-value normalized keys and rejects conflicting aliases", () => {
    expect(normalizeUnitAliasMap({ "BOX": "box", "盒": "盒" })).toEqual({ box: "box" });
    expect(normalizeUnitAliasMap({ "ＢＯＸ": "box", "box": "BOX" })).toEqual({ box: "box" });
    expect(() => normalizeUnitAliasMap({ "ＢＯＸ": "box", "盒": "piece" })).toThrow(
      /conflicting normalized unit alias/,
    );
  });

  it("accepts redundant same-value factors and rejects conflicting factors", () => {
    expect(normalizeUnitFactorMap({ "BOX": 12, "盒": 12 })).toEqual({ box: 12 });
    expect(normalizeUnitFactorMap({ "ＢＯＸ": 12, "box": 12 })).toEqual({ box: 12 });
    expect(() => normalizeUnitFactorMap({ "BOX": 12, "盒": 6 })).toThrow(
      /conflicting normalized unit package factor/,
    );
  });

  it("applies package factors only when the source unit is default_unit", () => {
    const policy = unitConversionPolicy({
      defaultUnit: "piece",
      packageFactors: { box: 12 },
    });
    expect(resolveUnitConversion(policy, "box", "盒")).toEqual({ kind: "identity", unit: "box" });
    expect(resolveUnitConversion(policy, "box", "box")).toEqual({ kind: "identity", unit: "box" });
    expect(resolveUnitConversion(policy, "piece", "box")).toEqual({
      kind: "factor",
      unit: "piece",
      factor: 12,
    });
    expect(resolveUnitConversion(policy, "kg", "box")).toEqual({
      kind: "mismatch",
      reason: "ambiguous_factor",
    });
  });

  it("keeps exact box/box 1:1; folded box/盒 with a conflicting alias is rejected", () => {
    const policy = unitConversionPolicy({
      defaultUnit: "piece",
      aliases: { "盒": "piece" },
    });
    expect(resolveUnitConversion(policy, "box", "box")).toEqual({ kind: "identity", unit: "box" });
    expect(resolveUnitConversion(policy, "box", "盒")).toEqual({
      kind: "mismatch",
      reason: "alias_conflict",
    });
  });

  it("respects explicit box:12 when default_unit is 盒", () => {
    const policy = unitConversionPolicy({
      defaultUnit: "盒",
      packageFactors: { box: 12 },
    });
    expect(resolveUnitConversion(policy, "盒", "盒")).toEqual({ kind: "identity", unit: "box" });
    expect(resolveUnitConversion(policy, "box", "box")).toEqual({ kind: "identity", unit: "box" });
    expect(resolveUnitConversion(policy, "盒", "box")).toEqual({
      kind: "mismatch",
      reason: "folded_factor_conflict",
    });
    expect(resolveUnitConversion(policy, "box", "盒")).toEqual({
      kind: "mismatch",
      reason: "folded_factor_conflict",
    });
  });

  it("rejects alias/factor ambiguity only when the source is the factor target", () => {
    const conflicted = unitConversionPolicy({
      defaultUnit: "piece",
      aliases: { "盒": "piece" },
      packageFactors: { box: 12 },
    });
    expect(resolveUnitConversion(conflicted, "piece", "盒")).toEqual({
      kind: "mismatch",
      reason: "alias_conflict",
    });
    const sameSource = unitConversionPolicy({
      defaultUnit: "piece",
      aliases: { "盒": "piece" },
      packageFactors: { box: 12 },
    });
    // 原文不同（box vs 盒）且 alias 指向 default_unit=piece：不能盲目 1:1。
    expect(resolveUnitConversion(sameSource, "box", "盒")).toEqual({
      kind: "mismatch",
      reason: "alias_conflict",
    });
    const oneToOne = unitConversionPolicy({
      defaultUnit: "piece",
      aliases: { "盒": "piece" },
      packageFactors: { box: 1 },
    });
    expect(resolveUnitConversion(oneToOne, "piece", "盒")).toEqual({ kind: "alias", unit: "piece" });
  });

  it("rejects an explicitly supplied alias that targets a non-default unit", () => {
    const policy = unitConversionPolicy({
      defaultUnit: "piece",
      aliases: { "盒": "kg" },
    });
    expect(resolveUnitConversion(policy, "kg", "盒")).toEqual({
      kind: "mismatch",
      reason: "alias_conflict",
    });
  });

  it("fails closed for direct factor=1 when the source is not the factor target", () => {
    const policy = unitConversionPolicy({
      defaultUnit: "piece",
      packageFactors: { box: 1 },
    });
    expect(resolveUnitConversion(policy, "kg", "box")).toEqual({
      kind: "mismatch",
      reason: "ambiguous_factor",
    });
  });

  it("legacy policy without defaultUnit preserves direct-constructor factor conversion", () => {
    const legacy = unitConversionPolicy({ packageFactors: { box: 12 } });
    expect(resolveUnitConversion(legacy, "piece", "box")).toEqual({
      kind: "factor",
      unit: "piece",
      factor: 12,
    });
  });

  it("rejects invalid direct factor values at policy construction", () => {
    for (const factor of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => normalizeUnitFactorMap({ box: factor })).toThrow(/positive safe integer/);
    }
    expect(normalizeUnitFactorMap({ box: 1 })).toEqual({ box: 1 });
    expect(normalizeUnitFactorMap({ box: Number.MAX_SAFE_INTEGER })).toEqual({
      box: Number.MAX_SAFE_INTEGER,
    });
  });

  it("safe quantity multiplication rejects non-safe products", () => {
    expect(multiplyQuantitySafe(Number.MAX_SAFE_INTEGER, 2)).toBeUndefined();
    expect(multiplyQuantitySafe(4503599627370495, 2)).toBe(9007199254740990);
    expect(multiplyQuantitySafe(2, 0)).toBeUndefined();
  });

  it("does not turn 个 or 件 into box", () => {
    expect(unitsAreCanonicalAliases("个", "box")).toBe(false);
    expect(unitsAreCanonicalAliases("件", "box")).toBe(false);
    expect(unitsAreCanonicalAliases("个", "盒")).toBe(false);
    expect(canonicalUnitToken("个")).toBe("个");
  });
});
