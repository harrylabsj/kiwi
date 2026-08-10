// 公开 spec 与实现侧权威文档防漂移（审查 BUG-05，2026-08-10）
//
// spec/ 是公开协议源：KNP 正文此前停在 rev1.1 / Draft / Kiwi v0.4+，与
// 实现侧权威（docs/protocol rev1.4、CURRENT-DOCS 指向）漂移 143 行——
// 第三方按公开 spec 实现会得到与当前实现不同的状态机与契约说明。校准后
// spec 与 rev1.4 必须逐字节一致；本测试防止再次无说明漂移。
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SPEC_FILE = path.resolve(__dirname, "..", "spec", "a2a", "extensions", "negotiation", "1.0");
const AUTHORITY_FILE = path.resolve(
  __dirname,
  "..",
  "docs",
  "protocol",
  "kiwi-negotiation-protocol-1.0-rev1.4.md",
);

describe("公开 spec 与实现侧权威文档同步（BUG-05）", () => {
  it("spec/ 与 rev1.4 逐字节一致（防无说明漂移）", () => {
    const spec = readFileSync(SPEC_FILE, "utf-8");
    const authority = readFileSync(AUTHORITY_FILE, "utf-8");
    expect(spec).toBe(authority);
  });

  it("身份元数据不残留版本回退前的错误身份（v1.0.0）", () => {
    const spec = readFileSync(SPEC_FILE, "utf-8");
    expect(spec).not.toContain("target_implementation: Kiwi v1.0.0");
    expect(spec).toContain("doc_revision: \"1.4\"");
  });
});
