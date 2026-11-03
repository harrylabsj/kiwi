import { describe, expect, it } from "vitest";

import {
  canonicalUnitToken,
  normalizeUnitAliasMap,
  normalizeUnitFactorMap,
  normalizeUnitToken,
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

  it("does not turn 个 or 件 into box", () => {
    expect(unitsAreCanonicalAliases("个", "box")).toBe(false);
    expect(unitsAreCanonicalAliases("件", "box")).toBe(false);
    expect(unitsAreCanonicalAliases("个", "盒")).toBe(false);
    expect(canonicalUnitToken("个")).toBe("个");
  });
});
