/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 回显探针（I-01）：摘要必须"可公开"——参数值、请求头值、请求体内容与分享码
 * 都不得出现在输出里。
 */

import { describe, expect, it } from "vitest";
import { summarizeProbeRequest } from "../src/tools/workbuddy-echo.js";

function summary(url: string, headers: Record<string, string> = {}, body = "") {
  return summarizeProbeRequest({
    method: "POST",
    url,
    headers,
    body: Buffer.from(body, "utf8"),
    receivedAt: "2026-10-27T00:00:00.000Z",
  });
}

describe("summarizeProbeRequest", () => {
  it("reports query parameter names and order without leaking the share code", () => {
    const result = summary("/a2a?x=1&sharecode=SUPER-SECRET-CODE&y=hello%20world");
    expect(result.query_names).toEqual(["x", "sharecode", "y"]);
    expect(result.sharecode).toEqual({ present: true, length: "SUPER-SECRET-CODE".length });
    expect(JSON.stringify(result)).not.toContain("SUPER-SECRET-CODE");
    // 业务参数按原样保留（用于判断平台是否重编码）。
    expect(result.raw_query).toContain("y=hello%20world");
    expect(result.raw_query).toContain("sharecode=<redacted");
  });

  it("redacts a duplicate share code as well", () => {
    const result = summary("/a2a?sharecode=AAA&sharecode=BBB");
    expect(result.query_names).toEqual(["sharecode", "sharecode"]);
    expect(JSON.stringify(result)).not.toContain("AAA");
    expect(JSON.stringify(result)).not.toContain("BBB");
  });

  it("never echoes header values, only their digests", () => {
    const result = summary("/a2a", {
      authorization: "Bearer platform-token-123",
      "signature-input": 'sig1=("@method");keyid="buyer"',
      "content-digest": "sha-256=:abc:",
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("platform-token-123");
    expect(text).not.toContain("buyer");
    const auth = result.headers.find((header) => header.name === "authorization");
    expect(auth?.scheme).toBe("Bearer");
    expect(auth?.values_sha256).toHaveLength(1);
    expect(result.headers.map((header) => header.name)).toEqual([
      "authorization",
      "content-digest",
      "signature-input",
    ]);
  });

  it("reports the body by length and digest only", () => {
    const result = summary("/a2a", {}, '{"secret":"payload-value"}');
    expect(result.body.length).toBe(Buffer.byteLength('{"secret":"payload-value"}'));
    expect(result.body.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain("payload-value");
  });

  it("records the path exactly as received", () => {
    expect(summary("/a2a?x=1").path).toBe("/a2a");
    expect(summary("/some/other/path").path).toBe("/some/other/path");
  });
});
