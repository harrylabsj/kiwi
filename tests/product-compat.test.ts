/**
 * 组件版本兼容矩阵测试（product-strategy rev1.1 §13/§19 D3）。
 *
 * 矩阵单一来源 = product-compat.ts；doctor 与 publish 共同消费。
 * 覆盖：版本解析（容忍前缀）、比较、范围判定（含边界/失败 fail-closed）。
 */
import { describe, expect, it } from "vitest";
import type { VersionRange } from "../src/product-compat.js";
import {
  SHOPPING_CLI_COMPAT,
  compareVersions,
  compatRangeText,
  parseVersion,
  versionInRange,
} from "../src/product-compat.js";

describe("parseVersion", () => {
  it("parses bare and prefixed x.y.z versions", () => {
    expect(parseVersion("2.0.0")).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(parseVersion("shopping.py 2.0.0")).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(parseVersion("v3.1.4-beta")).toEqual({ major: 3, minor: 1, patch: 4 });
  });

  it("fails closed on unparseable text", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("not a version")).toBeNull();
    expect(parseVersion("2.0")).toBeNull(); // 缺 patch
  });
});

describe("compareVersions", () => {
  it("orders semantically", () => {
    expect(compareVersions({ major: 1, minor: 9, patch: 9 }, { major: 2, minor: 0, patch: 0 })).toBe(-1);
    expect(compareVersions({ major: 2, minor: 0, patch: 0 }, { major: 2, minor: 0, patch: 0 })).toBe(0);
    expect(compareVersions({ major: 2, minor: 1, patch: 0 }, { major: 2, minor: 0, patch: 9 })).toBe(1);
  });
});

describe("versionInRange (matrix single source)", () => {
  it("accepts versions inside [min, maxExclusive)", () => {
    expect(versionInRange("2.0.0", SHOPPING_CLI_COMPAT)).toBe(true); // 下边界含
    expect(versionInRange("2.9.9", SHOPPING_CLI_COMPAT)).toBe(true);
    expect(versionInRange("shopping.py 2.0.0", SHOPPING_CLI_COMPAT)).toBe(true);
  });

  it("rejects versions below min (无上限：3.0.0+ 均接受)", () => {
    expect(versionInRange("1.9.9", SHOPPING_CLI_COMPAT)).toBe(false);
    expect(versionInRange("3.0.0", SHOPPING_CLI_COMPAT)).toBe(true); // 不限上界
    expect(versionInRange("4.0.0", SHOPPING_CLI_COMPAT)).toBe(true);
  });

  it("honors maxExclusive when present (有上限范围)", () => {
    const bounded: VersionRange = { min: "1.0.0", maxExclusive: "2.0.0" };
    expect(versionInRange("1.5.0", bounded)).toBe(true);
    expect(versionInRange("2.0.0", bounded)).toBe(false); // 上边界不含
  });

  it("rejects unparseable version text (fail-closed)", () => {
    expect(versionInRange("", SHOPPING_CLI_COMPAT)).toBe(false);
    expect(versionInRange("not-a-version", SHOPPING_CLI_COMPAT)).toBe(false);
  });

  it("range text is human readable (无上限)", () => {
    expect(compatRangeText(SHOPPING_CLI_COMPAT)).toBe(">= 2.0.0");
    expect(compatRangeText({ min: "1.0.0", maxExclusive: "2.0.0" })).toBe(">= 1.0.0 < 2.0.0");
  });
});
