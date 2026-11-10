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
 * 审查 2026-11-10 P2：匿名派生身份必须
 * - 被准入策略识别为匿名（verified/closed 仍拒绝）；
 * - 使用可信客户端地址（信任反代时取 XFF 最右合法地址）；
 * - 带实例盐（HMAC），不同实例不可关联。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createA2aAuthVerifier } from "../src/a2a/node.js";
import { isAnonymousIdentity } from "../src/a2a/server/identity.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-anon-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function verifier(options: {
  admission: "open" | "verified" | "closed";
  trustForwardedFor?: boolean;
}) {
  return createA2aAuthVerifier({
    mode: "signature",
    signingKeyDir: tempDir(),
    signingKeyId: "anon-test",
    advertisedBase: "http://127.0.0.1:9000",
    admission: options.admission,
    ...(options.trustForwardedFor === undefined
      ? {}
      : { trustForwardedFor: options.trustForwardedFor }),
  });
}

function context(remoteAddress: string, forwardedFor?: string) {
  return {
    remoteAddress,
    authorizationHeader: undefined,
    method: "POST",
    url: "/a2a",
    headers:
      forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
  };
}

async function identityOf(
  v: ReturnType<typeof verifier>,
  ctx: ReturnType<typeof context>,
): Promise<string | undefined> {
  const result = await v.verify(ctx);
  expect(result.authenticated).toBe(true);
  return result.identity;
}

describe("derived anonymous identity", () => {
  it("is treated as anonymous by admission policies", async () => {
    for (const admission of ["verified", "closed"] as const) {
      const result = await verifier({ admission }).verify(
        context("203.0.113.9", "203.0.113.9"),
      );
      expect(result.authenticated).toBe(false);
    }
    expect(isAnonymousIdentity("anonymous:abc")).toBe(true);
    expect(isAnonymousIdentity("anonymous")).toBe(true);
    expect(isAnonymousIdentity("peer-1")).toBe(false);
  });

  it("derives a stable per-address identity with an instance salt", async () => {
    const v = verifier({ admission: "open", trustForwardedFor: true });
    const first = await identityOf(v, context("127.0.0.1", "203.0.113.1"));
    expect(first).toMatch(/^anonymous:[0-9a-f]{16}$/);
    expect(await identityOf(v, context("127.0.0.1", "203.0.113.1"))).toBe(first);
    const second = await identityOf(v, context("127.0.0.1", "203.0.113.2"));
    expect(second).not.toBe(first);
  });

  it("ignores XFF unless proxy trust is explicit", async () => {
    const v = verifier({ admission: "open", trustForwardedFor: false });
    const a = await identityOf(v, context("127.0.0.1", "203.0.113.1"));
    const b = await identityOf(v, context("127.0.0.1", "203.0.113.2"));
    expect(a).toBe(b);
  });

  it("uses the rightmost valid forwarded address", async () => {
    const v = verifier({ admission: "open", trustForwardedFor: true });
    const forgedLeft = await identityOf(
      v,
      context("127.0.0.1", "198.51.100.7, 203.0.113.5"),
    );
    const real = await identityOf(v, context("127.0.0.1", "203.0.113.5"));
    expect(forgedLeft).toBe(real);
  });
});
