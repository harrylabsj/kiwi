/**
 * A2A v1 请求头测试（issue 05）：版本解析、扩展激活/拒绝、KNP URI 单一来源。
 */
import { describe, expect, it } from "vitest";
import {
  activateKnp,
  KNP_EXTENSION_PATH,
  parseExtensions,
  parseVersion,
  SUPPORTED_A2A_VERSION,
} from "../src/a2a/v1/headers.js";
import { KIWI_NEGOTIATION_EXTENSION_PATH } from "../src/discovery/agent-card/index.js";

const KNP_URI = `https://merchant.example${KNP_EXTENSION_PATH}`;

describe("A2A v1 headers（issue 05）", () => {
  it("KNP extension path 与 Card 声明单一来源", () => {
    expect(KNP_EXTENSION_PATH).toBe(KIWI_NEGOTIATION_EXTENSION_PATH);
    expect(KNP_EXTENSION_PATH).toBe("/a2a/extensions/negotiation/1.0");
  });

  it("parseVersion：缺省/空 → undefined，值 → trim", () => {
    expect(parseVersion(undefined)).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
    expect(parseVersion(" 1.0 ")).toBe("1.0");
  });

  it("parseExtensions：逗号分隔去空白", () => {
    expect(parseExtensions(undefined)).toEqual([]);
    expect(parseExtensions("")).toEqual([]);
    expect(parseExtensions(` ${KNP_URI} , https://x.example/ext`)).toEqual([
      KNP_URI,
      "https://x.example/ext",
    ]);
  });

  it("activateKnp：支持集内含 KNP → 激活；未知扩展 → fail-closed", () => {
    const supported = new Set([KNP_URI]);
    expect(activateKnp([KNP_URI], supported).knpActive).toBe(true);
    expect(() => activateKnp([`https://evil.example/ext`], supported)).toThrow(/unsupported/);
    // 未知 + KNP 混搭 → 仍 fail-closed（先拒绝未知）
    expect(() => activateKnp([KNP_URI, `https://evil.example/ext`], supported)).toThrow(/unsupported/);
  });

  it("SUPPORTED_A2A_VERSION = 1.0", () => {
    expect(SUPPORTED_A2A_VERSION).toBe("1.0");
  });
});
