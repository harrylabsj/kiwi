/**
 * 关注总数客户端（`MerchantPublicationClient.fetchFollowerStats`）的 HTTP 行为基线。
 *
 * 覆盖端到端链路的**网关→目录**这一段（工具层测试用的是假客户端，盖不到这里）：
 * - 打的是目录的 `GET /v1/merchant-publications/stats`；
 * - 带该商家的 `cmt_` 凭据（Bearer）；
 * - 不跟随重定向（出站纪律）；
 * - 响应缺 `followers_total` 或不是非负数字时 **fail-closed 报错**，不把 undefined
 *   当成 0 回给商家（"看起来没人关注"和"读不到"是两件事，不能混）。
 */
import { describe, expect, it } from "vitest";

import { MerchantPublicationClient } from "../src/merchant-gateway/catalog-publications.js";

interface Call {
  url: string;
  method: string;
  redirect: string | undefined;
  authorization: string | undefined;
}

function stubFetch(response: { status?: number; body?: unknown; capture?: Call[] }): typeof fetch {
  return (async (
    input: string,
    init?: { method?: string; redirect?: string; headers?: unknown },
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    response.capture?.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      redirect: init?.redirect === undefined ? undefined : String(init.redirect),
      authorization: headers.authorization,
    });
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const BASE = "https://catalog.kiwi.example";

function client(fetchImpl: typeof fetch): MerchantPublicationClient {
  return new MerchantPublicationClient({ baseUrl: BASE, fetchImpl });
}

describe("fetchFollowerStats", () => {
  it("GET stats 端点，带商家 Bearer 凭据，且不跟随重定向", async () => {
    const capture: Call[] = [];
    const result = await client(
      stubFetch({
        capture,
        body: { ok: true, stats: { merchant_id: "mkt_1", followers_total: 7 } },
      }),
    ).fetchFollowerStats("cmt_merchant_token");
    expect(capture).toHaveLength(1);
    expect(capture[0]?.url).toBe(`${BASE}/v1/merchant-publications/stats`);
    expect(capture[0]?.method).toBe("GET");
    expect(capture[0]?.redirect).toBe("manual");
    expect(capture[0]?.authorization).toBe("Bearer cmt_merchant_token");
    expect(result.followersTotal).toBe(7);
  });

  it("0 是合法值（确实没人关注），不是错误", async () => {
    const result = await client(
      stubFetch({ body: { ok: true, stats: { followers_total: 0 } } }),
    ).fetchFollowerStats("cmt_t");
    expect(result.followersTotal).toBe(0);
  });

  it("缺 followers_total / 非法值时 fail-closed（不把读不到当成 0）", async () => {
    await expect(
      client(stubFetch({ body: { ok: true, stats: {} } })).fetchFollowerStats("cmt_t"),
    ).rejects.toThrowError(/followers_total/);
    await expect(
      client(
        stubFetch({ body: { ok: true, stats: { followers_total: -1 } } }),
      ).fetchFollowerStats("cmt_t"),
    ).rejects.toThrowError(/followers_total/);
    await expect(
      client(
        stubFetch({ body: { ok: true, stats: { followers_total: "7" } } }),
      ).fetchFollowerStats("cmt_t"),
    ).rejects.toThrowError(/followers_total/);
  });

  it("空凭据直接拒绝（不发出请求）", async () => {
    const capture: Call[] = [];
    await expect(
      client(stubFetch({ capture, body: {} })).fetchFollowerStats("   "),
    ).rejects.toThrowError(/merchant credential/);
    expect(capture).toHaveLength(0);
  });
});
