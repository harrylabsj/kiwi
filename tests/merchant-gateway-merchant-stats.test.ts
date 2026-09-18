/**
 * 经营汇总客户端（`MerchantPublicationClient.fetchStats`）的 HTTP 行为基线。
 *
 * 覆盖端到端链路的**网关→目录**这一段（工具层测试用的是假客户端，盖不到这里）：
 * - 打的是目录的 `GET /v1/merchant-publications/stats`；
 * - 带该商家的 `cmt_` 凭据（Bearer）；
 * - 不跟随重定向（出站纪律）；
 * - 关注数/浏览数缺失或不是非负数字时 **fail-closed 报错**，不把 undefined 当成 0
 *   （"看起来没人关注/没人看"和"读不到"是两件事，不能混）。
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

const FULL = {
  ok: true,
  stats: {
    merchant_id: "mkt_1",
    followers_total: 7,
    views_total: 120,
    publications: [
      {
        publication_id: "mpub_1",
        title: "明前龙井",
        status: "published",
        view_count: 100,
        published_at: "2026-09-01T00:00:00Z",
      },
      {
        publication_id: "mpub_2",
        title: "保温杯",
        status: "draft",
        view_count: 20,
        published_at: "",
      },
    ],
  },
};

describe("fetchStats", () => {
  it("GET stats 端点，带商家 Bearer 凭据，且不跟随重定向", async () => {
    const capture: Call[] = [];
    const result = await client(stubFetch({ capture, body: FULL })).fetchStats("cmt_merchant_token");
    expect(capture).toHaveLength(1);
    expect(capture[0]?.url).toBe(`${BASE}/v1/merchant-publications/stats`);
    expect(capture[0]?.method).toBe("GET");
    expect(capture[0]?.redirect).toBe("manual");
    expect(capture[0]?.authorization).toBe("Bearer cmt_merchant_token");
    expect(result.followersTotal).toBe(7);
    expect(result.viewsTotal).toBe(120);
    expect(result.publications.map((p) => [p.publicationId, p.status, p.viewCount])).toEqual([
      ["mpub_1", "published", 100],
      ["mpub_2", "draft", 20],
    ]);
  });

  it("0 是合法值（确实没人关注/没人看），不是错误", async () => {
    const result = await client(
      stubFetch({ body: { ok: true, stats: { followers_total: 0, views_total: 0 } } }),
    ).fetchStats("cmt_t");
    expect(result.followersTotal).toBe(0);
    expect(result.viewsTotal).toBe(0);
    // 没有资料时 publications 缺省为空数组，而不是 undefined。
    expect(result.publications).toEqual([]);
  });

  it("关注数 / 浏览数缺失或非法时 fail-closed（不把读不到当成 0）", async () => {
    await expect(
      client(stubFetch({ body: { ok: true, stats: { views_total: 1 } } })).fetchStats("cmt_t"),
    ).rejects.toThrowError(/followers_total/);
    await expect(
      client(stubFetch({ body: { ok: true, stats: { followers_total: 1 } } })).fetchStats("cmt_t"),
    ).rejects.toThrowError(/views_total/);
    await expect(
      client(
        stubFetch({ body: { ok: true, stats: { followers_total: -1, views_total: 0 } } }),
      ).fetchStats("cmt_t"),
    ).rejects.toThrowError(/followers_total/);
    await expect(
      client(
        stubFetch({ body: { ok: true, stats: { followers_total: "7", views_total: 0 } } }),
      ).fetchStats("cmt_t"),
    ).rejects.toThrowError(/followers_total/);
  });

  it("空凭据直接拒绝（不发出请求）", async () => {
    const capture: Call[] = [];
    await expect(
      client(stubFetch({ capture, body: {} })).fetchStats("   "),
    ).rejects.toThrowError(/merchant credential/);
    expect(capture).toHaveLength(0);
  });
});
