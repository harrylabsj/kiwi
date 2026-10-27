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

import { describe, expect, it } from "vitest";
import {
  assertShareLinkMatchesRuntimeOrigin,
  buildWorkbuddyAccessConfig,
  buildWorkbuddyAccessRevocation,
  parseWorkbuddyShareLink,
  WorkbuddyShareLinkError,
} from "../src/cloud/access/workbuddy-share-link.js";

const ORIGIN = "https://pilot.example.app.workbuddy.host";

describe("parseWorkbuddyShareLink", () => {
  it("parses the canonical share link into a pure origin and the code", () => {
    const link = parseWorkbuddyShareLink(`${ORIGIN}/a2a?sharecode=abc-123`);
    expect(link.origin).toBe(ORIGIN);
    expect(link.parameterName).toBe("sharecode");
    expect(link.secretValue).toBe("abc-123");
    expect(link.extraParameters).toEqual([]);
  });

  it("keeps extra business parameters aside instead of folding them into the config", () => {
    const link = parseWorkbuddyShareLink(`${ORIGIN}/a2a?x=1&sharecode=abc&y=2`);
    expect(link.origin).toBe(ORIGIN);
    expect(link.secretValue).toBe("abc");
    expect(link.extraParameters).toEqual([
      ["x", "1"],
      ["y", "2"],
    ]);
  });

  it("accepts an explicit default port and normalizes it out of the origin", () => {
    const link = parseWorkbuddyShareLink(`https://pilot.example.app.workbuddy.host:443/a2a?sharecode=abc`);
    expect(link.origin).toBe(ORIGIN);
  });

  it.each([
    ["非 HTTPS", "http://pilot.example.app.workbuddy.host/a2a?sharecode=abc", "NOT_HTTPS"],
    ["userinfo", "https://user:pw@pilot.example.app.workbuddy.host/a2a?sharecode=abc", "USERINFO"],
    ["fragment", `${ORIGIN}/a2a?sharecode=abc#frag`, "FRAGMENT"],
    ["非默认端口", "https://pilot.example.app.workbuddy.host:8443/a2a?sharecode=abc", "INVALID_PORT"],
    ["缺失分享码", `${ORIGIN}/a2a`, "MISSING_SHARECODE"],
    ["重复分享码", `${ORIGIN}/a2a?sharecode=a&sharecode=b`, "DUPLICATE_SHARECODE"],
    ["空分享码", `${ORIGIN}/a2a?sharecode=`, "EMPTY_SHARECODE"],
    ["空白分享码", `${ORIGIN}/a2a?sharecode=%20`, "EMPTY_SHARECODE"],
    ["空串", "", "MALFORMED_URL"],
    ["非 URL", "not a url", "MALFORMED_URL"],
    ["超长分享码", `${ORIGIN}/a2a?sharecode=${"x".repeat(4097)}`, "SHARECODE_TOO_LONG"],
  ])("rejects %s without partial results", (_name, raw, code) => {
    let caught: unknown;
    try {
      parseWorkbuddyShareLink(raw);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkbuddyShareLinkError);
    expect((caught as WorkbuddyShareLinkError).code).toBe(code);
  });

  it("does not accept a non-string value", () => {
    expect(() => parseWorkbuddyShareLink(undefined)).toThrow(WorkbuddyShareLinkError);
  });
});

describe("assertShareLinkMatchesRuntimeOrigin", () => {
  it("accepts the bound origin, with or without a trailing slash on the runtime side", () => {
    const link = parseWorkbuddyShareLink(`${ORIGIN}/a2a?sharecode=abc`);
    expect(() => assertShareLinkMatchesRuntimeOrigin(link, ORIGIN)).not.toThrow();
    expect(() => assertShareLinkMatchesRuntimeOrigin(link, `${ORIGIN}/`)).not.toThrow();
  });

  it("refuses a link that points at a different deployment", () => {
    const link = parseWorkbuddyShareLink(`${ORIGIN}/a2a?sharecode=abc`);
    expect(() =>
      assertShareLinkMatchesRuntimeOrigin(link, "https://other.example.app.workbuddy.host"),
    ).toThrow(/不是本实例的公网入口/);
    expect(() => assertShareLinkMatchesRuntimeOrigin(link, "https://other.example.app.workbuddy.host")).toThrow(
      expect.objectContaining({ code: "ORIGIN_MISMATCH" }),
    );
  });

  it("does not treat http and https as the same origin", () => {
    const link = parseWorkbuddyShareLink(`${ORIGIN}/a2a?sharecode=abc`);
    expect(() =>
      assertShareLinkMatchesRuntimeOrigin(link, "http://pilot.example.app.workbuddy.host"),
    ).toThrow(WorkbuddyShareLinkError);
  });

  it("fails closed when the runtime has no origin", () => {
    const link = parseWorkbuddyShareLink(`${ORIGIN}/a2a?sharecode=abc`);
    expect(() => assertShareLinkMatchesRuntimeOrigin(link, "  ")).toThrow(
      expect.objectContaining({ code: "ORIGIN_MISMATCH" }),
    );
  });
});

describe("access config shapes", () => {
  it("builds the catalog wire shape with the CAS head", () => {
    const link = parseWorkbuddyShareLink(`${ORIGIN}/a2a?sharecode=abc-123`);
    expect(buildWorkbuddyAccessConfig(link, 0)).toEqual({
      provider: "workbuddy",
      access_mode: "share_parameter",
      parameter_name: "sharecode",
      secret_value: "abc-123",
      adapter_version: "workbuddy-share-v1",
      auth_mode: "signature",
      expected_version: 0,
    });
  });

  it("rejects an impossible CAS head", () => {
    const link = parseWorkbuddyShareLink(`${ORIGIN}/a2a?sharecode=abc`);
    expect(() => buildWorkbuddyAccessConfig(link, -1)).toThrow(WorkbuddyShareLinkError);
    expect(() => buildWorkbuddyAccessConfig(link, 1.5)).toThrow(WorkbuddyShareLinkError);
  });

  it("builds the revocation shape only for a real current version", () => {
    expect(buildWorkbuddyAccessRevocation(3)).toEqual({ access_mode: "none", expected_version: 3 });
    expect(() => buildWorkbuddyAccessRevocation(0)).toThrow(WorkbuddyShareLinkError);
  });
});
