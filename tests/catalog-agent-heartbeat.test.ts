/**
 * WP6：商家侧心跳客户端（catalog `POST .../heartbeat`）。
 *
 * 心跳只刷新 last_seen_at（不重新抓取资料、不消耗验证队列）；读侧按 TTL 派生
 * 新鲜度，离线商家因此不再被采购专家标成"可实时询价"。
 */
import { describe, expect, it } from "vitest";

import { sendCatalogAgentHeartbeat } from "../src/discovery/catalog-source/register.js";

interface Call {
  url: string;
  method: string;
  redirect: string | undefined;
  body: Record<string, unknown>;
  authorization: string | undefined;
}

function stubFetch(response: {
  status?: number;
  body?: unknown;
  capture?: Call[];
}): typeof fetch {
  return (async (input: string, init?: { method?: string; redirect?: string; body?: unknown; headers?: unknown }) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    response.capture?.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      redirect: init?.redirect === undefined ? undefined : String(init.redirect),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      authorization: headers.authorization,
    });
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("sendCatalogAgentHeartbeat", () => {
  it("POST 到该 agent 的 heartbeat 端点，带 owner_token，且不跟随重定向", async () => {
    const capture: Call[] = [];
    const result = await sendCatalogAgentHeartbeat({
      catalogBaseUrl: "http://127.0.0.1:8600/",
      catalogAgentId: "cagt-hb-1",
      ownerToken: "merchant-owner-token",
      fetchImpl: stubFetch({
        capture,
        body: { ok: true, last_seen_at: "2026-09-17T12:00:00+00:00", fresh_ttl_seconds: 900 },
      }),
    });
    expect(capture).toHaveLength(1);
    expect(capture[0]?.url).toBe("http://127.0.0.1:8600/v1/agent-catalog/agents/cagt-hb-1/heartbeat");
    expect(capture[0]?.method).toBe("POST");
    expect(capture[0]?.redirect).toBe("manual");
    expect(capture[0]?.body.owner_token).toBe("merchant-owner-token");
    // 凭据只经请求体（与 register 同规），不走 Authorization 头。
    expect(capture[0]?.authorization).toBeUndefined();
    expect(result.lastSeenAt).toBe("2026-09-17T12:00:00+00:00");
    expect(result.freshTtlSeconds).toBe(900);
  });

  it("ownerTokenSecret 形态派生 HMAC 凭据（legacy 路径）", async () => {
    const capture: Call[] = [];
    await sendCatalogAgentHeartbeat({
      catalogBaseUrl: "http://127.0.0.1:8600",
      catalogAgentId: "cagt-hb-2",
      ownerTokenSecret: "platform-secret",
      merchantId: "merchant-001",
      fetchImpl: stubFetch({ capture, body: { ok: true } }),
    });
    expect(typeof capture[0]?.body.owner_token).toBe("string");
    expect(String(capture[0]?.body.owner_token)).toHaveLength(64);
  });

  it("非 2xx / ok:false 一律抛错（心跳失败必须可见）", async () => {
    await expect(
      sendCatalogAgentHeartbeat({
        catalogBaseUrl: "http://127.0.0.1:8600",
        catalogAgentId: "cagt-hb-3",
        ownerToken: "t",
        fetchImpl: stubFetch({ status: 403, body: { ok: false, error: "invalid owner token" } }),
      }),
    ).rejects.toThrowError(/heartbeat failed: invalid owner token/);

    await expect(
      sendCatalogAgentHeartbeat({
        catalogBaseUrl: "http://127.0.0.1:8600",
        catalogAgentId: "cagt-hb-4",
        ownerToken: "t",
        fetchImpl: stubFetch({ status: 500, body: {} }),
      }),
    ).rejects.toThrowError(/heartbeat failed: HTTP 500/);
  });
});
