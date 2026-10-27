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
  buildWorkbuddyDualAddress,
  WorkbuddyAddressError,
} from "../src/a2a/access/workbuddy-address.js";

const ENDPOINT = "https://merchant.example/a2a";

describe("buildWorkbuddyDualAddress", () => {
  it("appends the share code to the send address only", () => {
    const { signUrl, sendUrl } = buildWorkbuddyDualAddress(ENDPOINT, "abc-123");
    expect(signUrl).toBe(ENDPOINT);
    expect(sendUrl).toBe(`${ENDPOINT}?sharecode=abc-123`);
  });

  it("keeps business parameters byte-for-byte, in order, with duplicates", () => {
    const business = `${ENDPOINT}?b=2&a=hello%20world&b=2&empty=`;
    const { signUrl, sendUrl } = buildWorkbuddyDualAddress(business, "abc");
    expect(signUrl).toBe(business);
    expect(sendUrl).toBe(`${business}&sharecode=abc`);
  });

  it("does not create an empty parameter after a trailing ampersand", () => {
    const { sendUrl } = buildWorkbuddyDualAddress(`${ENDPOINT}?a=1&`, "abc");
    expect(sendUrl).toBe(`${ENDPOINT}?a=1&sharecode=abc`);
  });

  it("percent-encodes the code so it cannot terminate the query", () => {
    const { sendUrl } = buildWorkbuddyDualAddress(ENDPOINT, "a&b=c d/+%");
    expect(sendUrl).toBe(`${ENDPOINT}?sharecode=a%26b%3Dc%20d%2F%2B%25`);
  });

  it.each([
    ["非 https", "http://merchant.example/a2a", "NOT_HTTPS"],
    ["userinfo", "https://u:p@merchant.example/a2a", "USERINFO"],
    ["fragment", `${ENDPOINT}#x`, "FRAGMENT"],
    ["已带分享码", `${ENDPOINT}?sharecode=old`, "EXISTING_SHARE_PARAMETER"],
    ["编码后的分享码", `${ENDPOINT}?x=1&%73harecode=old`, "EXISTING_SHARE_PARAMETER"],
    ["非 URL", "not-a-url", "INVALID_SIGN_URL"],
  ])("rejects %s", (_name, url, code) => {
    let caught: unknown;
    try {
      buildWorkbuddyDualAddress(url, "abc");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkbuddyAddressError);
    expect((caught as WorkbuddyAddressError).code).toBe(code);
  });

  it("refuses an empty code", () => {
    expect(() => buildWorkbuddyDualAddress(ENDPOINT, "  ")).toThrow(
      expect.objectContaining({ code: "INVALID_SIGN_URL" }),
    );
  });

  it("derives both addresses from the same origin", () => {
    const { signUrl, sendUrl } = buildWorkbuddyDualAddress(
      "https://merchant.example:443/a2a?x=1",
      "abc",
    );
    expect(new URL(signUrl).origin).toBe(new URL(sendUrl).origin);
  });
});
