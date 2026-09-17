/**
 * `trimTrailingSlashes` 的语义基线（CodeQL js/polynomial-redos 收口）。
 *
 * 该助手替换了散落各处的 `value.replace(/\/+$/, "")`：语义必须逐字一致，
 * 否则 baseUrl 拼接会悄悄变样（多一个或少一个斜杠都会打出 404 的路径）。
 */
import { describe, expect, it } from "vitest";

import { trimTrailingSlashes } from "../src/net/url.js";

/** 被替换掉的旧写法，用作等价性对照。 */
function legacy(value: string): string {
  return value.replace(/\/+$/, "");
}

describe("trimTrailingSlashes", () => {
  it("去掉末尾连续斜杠", () => {
    expect(trimTrailingSlashes("http://127.0.0.1:8600")).toBe("http://127.0.0.1:8600");
    expect(trimTrailingSlashes("http://127.0.0.1:8600/")).toBe("http://127.0.0.1:8600");
    expect(trimTrailingSlashes("http://127.0.0.1:8600////")).toBe("http://127.0.0.1:8600");
    expect(trimTrailingSlashes("https://merchant.example/base/")).toBe("https://merchant.example/base");
  });

  it("不碰中间的斜杠与空串", () => {
    expect(trimTrailingSlashes("https://a.example/b/c")).toBe("https://a.example/b/c");
    expect(trimTrailingSlashes("")).toBe("");
  });

  it("全斜杠输入得到空串（与旧写法一致，不是保留一个）", () => {
    expect(trimTrailingSlashes("///")).toBe("");
    expect(trimTrailingSlashes("/")).toBe("");
  });

  it("与旧正则写法逐例等价（含长尾斜杠串）", () => {
    const cases = [
      "",
      "/",
      "///",
      "http://a",
      "http://a/",
      "http://a//////////",
      "http://a/b/",
      "a/b//",
      "/".repeat(5000),
      `${"http://a".padEnd(1000, "x")}${"/".repeat(3000)}`,
    ];
    for (const value of cases) {
      expect(trimTrailingSlashes(value)).toBe(legacy(value));
    }
  });
});
