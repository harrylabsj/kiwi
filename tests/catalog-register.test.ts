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
 * Catalog 注册 client（src/discovery/catalog-source/register.ts）测试：
 *   - 成功：POST /v1/agent-catalog/agents/register 返回 ok + catalog_agent_id + status；
 *   - fail closed：非 2xx / error 信封 → CatalogSourceError(request_failed)；
 *   - 网络失败：fetch 抛错 → CatalogSourceError(request_failed)；
 *   - 请求体：domain / agent_card_url / ucp_profile_url / merchant_id 正确携带。
 */
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { CatalogSourceError } from "../src/discovery/catalog-source/errors.js";
import { registerCatalogAgent } from "../src/discovery/catalog-source/register.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("registerCatalogAgent", () => {
  it("registers successfully and returns catalog_agent_id + status", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const result = await registerCatalogAgent({
      catalogBaseUrl: "http://127.0.0.1:8600/",
      domain: "merchant.test",
      agentCardUrl: "http://127.0.0.1:9000/.well-known/agent-card.json",
      ucpProfileUrl: "http://127.0.0.1:9000/.well-known/ucp",
      merchantId: "merchant-a",
      ownerTokenSecret: "test-secret",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return jsonResponse({
          ok: true,
          catalog_agent: { catalog_agent_id: "cagt_01ABC", status: "discovered" },
          verification_enqueued: true,
          idempotent: false,
        });
      },
    });
    expect(result).toMatchObject({
      ok: true,
      catalogAgentId: "cagt_01ABC",
      status: "discovered",
      verificationEnqueued: true,
    });
    const call = calls[0];
    expect(call).toBeDefined();
    expect(call!.url).toBe("http://127.0.0.1:8600/v1/agent-catalog/agents/register");
    const payload = JSON.parse(call!.body);
    expect(payload).toMatchObject({
      domain: "merchant.test",
      agent_card_url: "http://127.0.0.1:9000/.well-known/agent-card.json",
      ucp_profile_url: "http://127.0.0.1:9000/.well-known/ucp",
      merchant_id: "merchant-a",
    });
    // owner_token = HMAC-SHA256("test-secret", "kiwi-catalog-owner:merchant-a")
    expect(payload.owner_token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips merchant binding when ownerTokenSecret is absent (public self-register)", async () => {
    const calls: Array<{ body: string }> = [];
    await registerCatalogAgent({
      catalogBaseUrl: "http://127.0.0.1:8600",
      domain: "merchant.test",
      agentCardUrl: "http://127.0.0.1:9000/card.json",
      merchantId: "merchant-a",
      fetchImpl: async (_url, init) => {
        calls.push({ body: String(init?.body) });
        return jsonResponse({ ok: true, catalog_agent: { catalog_agent_id: "cagt_X", status: "discovered" } });
      },
    });
    const payload = JSON.parse(calls[0]!.body);
    expect(payload.merchant_id).toBeUndefined();
    expect(payload.owner_token).toBeUndefined();
  });

  it("fails closed on an error envelope (fail-closed, §4.6)", async () => {
    await expect(
      registerCatalogAgent({
        catalogBaseUrl: "http://127.0.0.1:8600",
        domain: "merchant.test",
        agentCardUrl: "http://127.0.0.1:9000/card.json",
        fetchImpl: async () => jsonResponse({ ok: false, error: "missing required field: domain" }, 400),
      }),
    ).rejects.toMatchObject({ code: "request_failed" });
  });

  it("fails closed on a network error", async () => {
    await expect(
      registerCatalogAgent({
        catalogBaseUrl: "http://127.0.0.1:1",
        domain: "merchant.test",
        agentCardUrl: "http://127.0.0.1:9000/card.json",
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).rejects.toBeInstanceOf(CatalogSourceError);
  });

  it("propagates non-2xx with error detail", async () => {
    await expect(
      registerCatalogAgent({
        catalogBaseUrl: "http://127.0.0.1:8600",
        domain: "merchant.test",
        agentCardUrl: "http://127.0.0.1:9000/card.json",
        fetchImpl: async () => jsonResponse({ detail: "rate limited" }, 429),
      }),
    ).rejects.toThrow(/catalog register failed/);
  });

  it("K-M2: rejects an invalid catalog base URL (protocol / userinfo) before sending token", async () => {
    await expect(
      registerCatalogAgent({
        catalogBaseUrl: "ftp://evil.example",
        domain: "merchant.test",
        agentCardUrl: "http://127.0.0.1:9000/card.json",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      registerCatalogAgent({
        catalogBaseUrl: "http://user:pass@evil.example",
        domain: "merchant.test",
        agentCardUrl: "http://127.0.0.1:9000/card.json",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("K-M2: register times out (injected short timeout) instead of hanging", async () => {
    // 服务端永不响应：缺省 AbortSignal.timeout 在超时后 abort——挂死 catalog
    // 不再永久卡住 /register（串行链内）。
    const server = createServer(() => {
      // never respond
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(
        registerCatalogAgent({
          catalogBaseUrl: `http://127.0.0.1:${port}`,
          domain: "merchant.test",
          agentCardUrl: "http://127.0.0.1:9000/card.json",
          timeoutMs: 200,
        }),
      ).rejects.toBeInstanceOf(CatalogSourceError);
    } finally {
      server.close();
    }
  });
});
