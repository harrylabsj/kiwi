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
import { MerchantAccessSource } from "../src/discovery/catalog-source/merchant-access.js";

const BASE = "https://catalog.example";
const ORIGIN = "https://pilot.example.app.workbuddy.host";
const AGENT = "cagt_access_1";

function accessBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catalog_agent_id: AGENT,
    runtime_origin: ORIGIN,
    provider: "workbuddy",
    access_mode: "share_parameter",
    parameter_name: "sharecode",
    secret_value: "share-code-1",
    config_version: 2,
    adapter_version: "workbuddy-share-v1",
    auth_mode: "signature",
    validated_at: "2026-10-27T00:00:00+00:00",
    updated_at: "2026-10-27T00:00:00+00:00",
    ...overrides,
  };
}

interface Call {
  url: string;
  headers: Headers;
}

function source(
  responses: Array<{ status: number; body?: unknown }>,
  opts: { nowMs?: () => number } = {},
): { client: MerchantAccessSource; calls: Call[] } {
  const calls: Call[] = [];
  const client = new MerchantAccessSource({
    baseUrl: BASE,
    sessionToken: "session-token",
    ...(opts.nowMs !== undefined ? { now: () => new Date(opts.nowMs!()) } : {}),
    fetchImpl: ((input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, headers: new Headers(init?.headers ?? {}) });
      const next = responses.shift();
      if (next === undefined) throw new Error(`unexpected request ${url}`);
      return Promise.resolve(
        new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
          status: next.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch,
  });
  return { client, calls };
}

describe("MerchantAccessSource", () => {
  it("fetches with the buyer session cookie and validates the payload", async () => {
    const { client, calls } = source([{ status: 200, body: accessBody() }]);
    const config = await client.get(AGENT, { runtimeOrigin: ORIGIN });
    expect(config?.secret_value).toBe("share-code-1");
    expect(config?.config_version).toBe(2);
    expect(calls[0]?.url).toBe(`${BASE}/v1/me/merchant-access/${AGENT}`);
    expect(calls[0]?.headers.get("cookie")).toBe("kiwi_session=session-token");
  });

  it("returns null when the catalog has no active configuration (404)", async () => {
    const { client } = source([{ status: 404, body: {} }]);
    await expect(client.get(AGENT, { runtimeOrigin: ORIGIN })).resolves.toBeNull();
  });

  it("maps rejected sessions to session_rejected instead of degrading to anonymous", async () => {
    const { client } = source([{ status: 403, body: { ok: false } }]);
    await expect(client.get(AGENT, { runtimeOrigin: ORIGIN })).rejects.toMatchObject({
      code: "session_rejected",
    });
  });

  it("rejects a config whose origin differs from the discovered merchant", async () => {
    const { client } = source([
      { status: 200, body: accessBody({ runtime_origin: "https://other.example" }) },
    ]);
    await expect(client.get(AGENT, { runtimeOrigin: ORIGIN })).rejects.toMatchObject({
      code: "contract_violation",
    });
  });

  it.each([
    ["未知 provider", { provider: "other" }],
    ["未知 adapter", { adapter_version: "v2" }],
    ["非签名认证", { auth_mode: "bearer" }],
    ["缺失秘密", { secret_value: "" }],
    ["非法版本", { config_version: 0 }],
    ["另一个 agent", { catalog_agent_id: "cagt_other" }],
    ["非法 origin", { runtime_origin: "http://pilot.example" }],
  ])("rejects %s payloads", async (_name, override) => {
    const { client } = source([{ status: 200, body: accessBody(override) }]);
    await expect(client.get(AGENT, { runtimeOrigin: ORIGIN })).rejects.toMatchObject({
      code: "contract_violation",
    });
  });

  it("caches for the TTL, then refreshes", async () => {
    let now = 1_000;
    const { client, calls } = source(
      [
        { status: 200, body: accessBody() },
        { status: 200, body: accessBody({ config_version: 3, secret_value: "share-code-2" }) },
      ],
      { nowMs: () => now },
    );
    await client.get(AGENT, { runtimeOrigin: ORIGIN });
    await client.get(AGENT, { runtimeOrigin: ORIGIN });
    expect(calls).toHaveLength(1);
    now += 60_001;
    const refreshed = await client.get(AGENT, { runtimeOrigin: ORIGIN });
    expect(calls).toHaveLength(2);
    expect(refreshed?.secret_value).toBe("share-code-2");
  });

  it("refuses to run without a session token", async () => {
    const client = new MerchantAccessSource({ baseUrl: BASE, fetchImpl: globalThis.fetch });
    await expect(client.get(AGENT, { runtimeOrigin: ORIGIN })).rejects.toMatchObject({
      code: "session_rejected",
    });
  });

  it("does not follow redirects", async () => {
    const fetchImpl = ((_input: string | URL | Request) =>
      Promise.resolve(
        new Response("", { status: 302, headers: { location: "https://evil.example/" } }),
      )) as typeof fetch;
    const client = new MerchantAccessSource({
      baseUrl: BASE,
      sessionToken: "session-token",
      fetchImpl,
    });
    await expect(client.get(AGENT, { runtimeOrigin: ORIGIN })).rejects.toMatchObject({
      code: "request_failed",
    });
  });
});
