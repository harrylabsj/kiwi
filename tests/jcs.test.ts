/**
 * RFC 8785 JCS canonicalization 测试（src/negotiation/jcs.ts）：
 *  - 键序无关、数值序列化严格按 ECMAScript Number::toString（RFC 8785 的权威
 *    定义）：`-0` → "0"、正指数保留 '+'（1e21 → "1e+21"）、负指数 "1e-7"
 *    （审查 2-4，2026-10-07：此前实现把 -0 序列化为 "-0"、剥掉正指数 '+'，
 *    与 RFC 8785 Appendix B 向量不符、跨实现 digest 断裂，已修）；
 *  - U+2028/U+2029 字面保留（审查修正，2026-08-10：RFC 8785 §3.2.2.1 只
 *    MUST-escape quotation mark / reverse solidus / 控制字符 U+0000-U+001F；
 *    U+2028/U+2029 是 U+2000 段非控制字符，字面输出。此前转义它们会让 digest
 *    与符合规范的实现不一致）；控制字符仍正常转义。
 */
import { describe, expect, it } from "vitest";
import { canonicalize, contentDigest } from "../src/negotiation/jcs.js";

describe("RFC 8785 canonicalize", () => {
  it("sorts keys deterministically", () => {
    expect(canonicalize({ b: 1, a: "x" })).toBe('{"a":"x","b":1}');
  });

  // 审查 2-4：RFC 8785 §3.2.2.2 数值序列化 = ECMAScript Number::toString。
  // 旧实现的错误注释曾把「-0 保留」「正指数去 '+'」锁进测试——均为对 RFC 的
  // 误读，此处按 RFC 8785 Appendix B 向量更正（有意的行为变更，digest 不兼容）。
  it("serializes -0 as 0 and keeps '+' on positive exponents (RFC 8785 Appendix B)", () => {
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(1e21)).toBe("1e+21");
    expect(canonicalize(1e22)).toBe("1e+22");
    expect(canonicalize(1e30)).toBe("1e+30");
    expect(canonicalize(1.5e21)).toBe("1.5e+21");
    expect(canonicalize(-1e21)).toBe("-1e+21");
  });

  it("keeps fixed notation at the decimal/exponent boundaries (Number::toString)", () => {
    // ES 切换指数记法的边界：< 1e21 用定点，< 1e-6 用定点，否则指数。
    expect(canonicalize(1e20)).toBe("100000000000000000000");
    expect(canonicalize(9e15)).toBe("9000000000000000");
    expect(canonicalize(1e-6)).toBe("0.000001");
    expect(canonicalize(1e-7)).toBe("1e-7");
    expect(canonicalize(5e-324)).toBe("5e-324");
    expect(canonicalize(0)).toBe("0");
  });

  it("produces RFC 8785-compatible digests for boundary numbers", () => {
    // 与标准 JCS 库互操作：对含 -0 / 1e21 的内容，digest 基于规范形字节串。
    expect(contentDigest({ amount: -0 })).toBe(
      contentDigest(JSON.parse('{"amount":0}') as unknown),
    );
    expect(contentDigest({ threshold: 1e21 })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(canonicalize({ a: 1e21, b: -0 })).toBe('{"a":1e+21,"b":0}');
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
