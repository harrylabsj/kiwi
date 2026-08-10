/**
 * RFC 8785 JCS canonicalization 测试（src/negotiation/jcs.ts）：
 *  - 键序无关、-0 保留、指数归一化（既有行为锁定）；
 *  - U+2028/U+2029 字面保留（审查修正，2026-08-10：RFC 8785 §3.2.2.1 只
 *    MUST-escape quotation mark / reverse solidus / 控制字符 U+0000-U+001F；
 *    U+2028/U+2029 是 U+2000 段非控制字符，字面输出。此前转义它们会让 digest
 *    与符合规范的实现不一致）；控制字符仍正常转义。
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

  it("preserves U+2028 / U+2029 literally in string values (RFC 8785 §3.2.2.1)", () => {
    // 直接构造字符（避免源码内不可见字面量）
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    // 字面码点输出——转义它们会与符合规范的 JCS 实现产生不同 digest。
    expect(canonicalize(`a${ls}b`)).toBe(`"a${ls}b"`);
    expect(canonicalize(`a${ps}b`)).toBe(`"a${ps}b"`);
    // 输出确为原字面字符（码点 0x2028），而非 6 字符反斜杠转义。
    const out = canonicalize(`x${ls}y`);
    expect(out.charCodeAt(2)).toBe(0x2028);
    expect(out.length).toBe(5); // 引号 + x + U+2028 + y + 引号
  });

  it("preserves U+2028 / U+2029 literally in object keys", () => {
    const ls = String.fromCharCode(0x2028);
    expect(canonicalize({ [`k${ls}`]: 1 })).toBe(`{"k${ls}":1}`);
  });

  it("retains control-character escaping (U+0000-U+001F)", () => {
    // 控制字符仍必须转义（与 JSON.stringify 行为一致，RFC 8785 MUST-escape）。
    expect(canonicalize("hello\n世界")).toBe('"hello\\n世界"');
    const nul = String.fromCharCode(0x00);
    expect(canonicalize(`a${nul}b`)).toBe('"a\\u0000b"');
    const tab = String.fromCharCode(0x09);
    expect(canonicalize(`a${tab}b`)).toBe('"a\\tb"');
  });
});
