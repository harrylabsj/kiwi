/**
 * RFC 8785 JCS canonicalization 测试（src/negotiation/jcs.ts）：
 *  - 键序无关、-0 保留、指数归一化（既有行为锁定）；
 *  - U+2028/U+2029 转义（评审项 A2：JSON.stringify 原样输出这两个字符，
 *    RFC 8785 §3.2.2.1 要求转义——否则与按规范转义的实现产生不同 digest，
 *    跨实现互操作断裂；对象 key 同样适用）。
 */
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/negotiation/jcs.js";

describe("RFC 8785 canonicalize", () => {
  it("sorts keys and normalizes numbers deterministically", () => {
    expect(canonicalize({ b: 1, a: "x" })).toBe('{"a":"x","b":1}');
    expect(canonicalize(-0)).toBe("-0");
    // RFC 8785：正指数去掉 '+'（1e21 是规范形，非 1e+21）
    expect(canonicalize(1e21)).toBe("1e21");
    expect(canonicalize(1e-7)).toBe("1e-7");
  });

  it("escapes U+2028 / U+2029 in string values (RFC 8785 §3.2.2.1)", () => {
    // 直接构造字符（避免源码内不可见字面量）
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    expect(canonicalize(`a${ls}b`)).toBe('"a\\u2028b"');
    expect(canonicalize(`a${ps}b`)).toBe('"a\\u2029b"');
    // 输出确为 6 字符转义（反斜杠 + u2028），而非不可见字符直出
    const out = canonicalize(`x${ls}y`);
    expect(out).toBe('"x\\u2028y"');
    expect(out.charCodeAt(2)).toBe(0x5c); // `\`
    expect(out.charCodeAt(3)).toBe(0x75); // `u`
  });

  it("escapes U+2028 / U+2029 in object keys", () => {
    const ls = String.fromCharCode(0x2028);
    expect(canonicalize({ [`k${ls}`]: 1 })).toBe('{"k\\u2028":1}');
  });

  it("keeps plain text unchanged (identity for normal input)", () => {
    expect(canonicalize("hello\n世界")).toBe('"hello\\n世界"');
  });
});
