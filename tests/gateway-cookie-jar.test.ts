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
 * 网关访问 cookie 复用：首次带码后按 origin 存 cookie，之后免带分享码。
 * 平台明确说分享码面向人工分享、不适合大规模机器分发，所以买家必须复用
 * 这 30 天的 host-only cookie，而不是每个请求都带码。
 */

import { describe, expect, it } from "vitest";
import { A2AClient } from "../src/a2a/client/client.js";
import { GatewayCookieJar } from "../src/a2a/access/gateway-cookie-jar.js";

const NOW = Date.parse("2026-10-29T00:00:00Z");

describe("GatewayCookieJar", () => {
  it("captures the name=value pair and reports it per origin only", () => {
    const jar = new GatewayCookieJar();
    jar.capture("https://merchant.example", ["wb_access=abc123; Path=/; HttpOnly; Max-Age=2592000"], NOW);
    expect(jar.get("https://merchant.example", NOW)).toBe("wb_access=abc123");
    expect(jar.get("https://other.example", NOW)).toBeUndefined();
  });

  it("expires on Max-Age and on Expires", () => {
    const jar = new GatewayCookieJar();
    jar.capture("https://m.example", ["a=1; Max-Age=60"], NOW);
    expect(jar.get("https://m.example", NOW + 30_000)).toBe("a=1");
    expect(jar.get("https://m.example", NOW + 61_000)).toBeUndefined();

    jar.capture("https://m.example", ["b=2; Expires=Thu, 29 Oct 2026 01:00:00 GMT"], NOW);
    expect(jar.get("https://m.example", NOW + 1_000)).toBe("b=2");
    expect(jar.get("https://m.example", Date.parse("2026-10-29T01:00:01Z"))).toBeUndefined();
  });

  it("keeps the latest value when the gateway rotates the cookie", () => {
    const jar = new GatewayCookieJar();
    jar.capture("https://m.example", ["wb=old"], NOW);
    jar.capture("https://m.example", ["wb=new"], NOW);
    expect(jar.get("https://m.example", NOW)).toBe("wb=new");
  });
});

describe("A2AClient gateway cookie reuse", () => {
  const card = (origin: string) => `${origin}/a2a`;
  const rpcOk = (id: unknown) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { task: { id: "t1", status: { state: "completed" } } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("sends the sharecode once, then reuses the cookie without it", async () => {
    const jar = new GatewayCookieJar();
    const seen: Array<{ url: string; cookie?: string }> = [];
    const fetchImpl = (async (input: URL | string | Request, init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, ...(headers.get("cookie") ? { cookie: headers.get("cookie") as string } : {}) });
      const response = rpcOk(JSON.parse(String(init?.body ?? "{}")).id);
      if (!url.includes("sharecode=")) return response;
      // 首次带码：网关下发访问 cookie。
      const withCookie = new Response(await response.text(), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "wb_access=abc; Max-Age=2592000; Path=/; HttpOnly" },
      });
      return withCookie;
    }) as typeof fetch;

    const endpoint = card("https://merchant.example");
    const coded = `${endpoint}?sharecode=SECRET`;
    const first = new A2AClient({ url: endpoint, sendUrl: coded, fetchImpl, cookieJar: jar, timeoutMs: 2_000, skipDnsCheck: true });
    await first.getTask("t1");

    // 有 cookie 之后：不再带码（sendUrl 缺省 = 签名地址），但必须带上 cookie。
    const second = new A2AClient({ url: endpoint, fetchImpl, cookieJar: jar, timeoutMs: 2_000, skipDnsCheck: true });
    await second.getTask("t1");

    expect(seen[0]?.url).toContain("sharecode=SECRET");
    expect(seen[0]?.cookie).toBeUndefined();
    expect(seen[1]?.url).not.toContain("sharecode=");
    expect(seen[1]?.cookie).toBe("wb_access=abc");
  });
});
