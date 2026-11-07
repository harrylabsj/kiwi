/**
 * 日志/审计脱敏：sharecode 不得出现在错误或告警文本里。
 */
import { describe, expect, it } from "vitest";

import { sanitize } from "../src/merchant-core/storage/redact.js";

describe("sharecode redaction", () => {
  it("URL query、header、键值形式都被脱敏", () => {
    const raw = [
      "GET https://merchant.example/a2a?sharecode=abc123&x=1",
      "X-Share-Code: abc123",
      "sharecode=abc123",
      "prefix sharecode: abc123 suffix",
    ].join(" | ");
    const out = sanitize(raw);
    expect(out).not.toContain("abc123");
    expect(out).toContain("[redacted]");
  });

  it("普通文本与既有 token 脱敏保持可用", () => {
    expect(sanitize("ok nothing sensitive here")).toBe("ok nothing sensitive here");
    expect(sanitize("Bearer abc.def")).toContain("[redacted]");
  });
});
