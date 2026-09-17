/**
 * M4 买家关注（merchant-buddy 第 0 版设计 §2 买家路径 3-5、§4/§5）测试。
 *
 * 覆盖：
 *  - BuyerFollowsSource 请求形状：PUT/DELETE/GET 路径、cookie kiwi_session
 *    会话认证、JSON body、响应校验（fail-closed）；
 *  - 工具门面：kiwi_follow_merchant / kiwi_unfollow_merchant / kiwi_list_follows /
 *    kiwi_get_follow_updates 的请求与投影；merchant_id 缺失 → invalid_params；
 *  - 未配置 catalog 会话：四个工具返回可解释登录引导（fail-closed，不伪造身份）；
 *  - catalog 拒绝会话（HTTP 401）：引导重新登录；
 *  - updates 水位语义透传：第一次有增量、第二次为空（客户端不缓存重放、不本地过滤）。
 */
import { describe, expect, it } from "vitest";

import { BuyerFollowsSource } from "../src/discovery/catalog-source/buyer-follows.js";
import { KiwiBuyerService } from "../src/buyer-core/service.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import { buildKiwiTools } from "../src/mcp/tools.js";
import { KIWI_SOURCING_TOOLS } from "../src/mcp/types.js";

const TS = "2026-09-17T10:00:00+08:00";

const POLICY = {
  policy_id: "dp-m4-001",
  version: "1.0",
  principal: "company:acme-test",
  created_at: TS,
  expires_at: "2099-12-31T23:59:59+08:00",
  actions: {
    discover: { mode: "auto" },
    inquiry_rfq: { mode: "auto" },
    compare_offers: { mode: "auto" },
    counter_offer: { mode: "auto" },
    accept_nonbinding: { mode: "ask" },
    handoff: { mode: "ask" },
    payment: { mode: "never" },
  },
  limits: { max_rounds: 2, allowed_currencies: ["CNY"] },
};

const FOLLOW_VIEW = {
  merchant_id: "mkt-m0-002",
  merchant_name: "山地文具店",
  category: "生活用品",
  status: "active",
  consent_version: "",
  created_at: "2026-09-17T01:00:00+00:00",
  last_seen_at: "2026-09-17T01:00:00+00:00",
};

const UPDATE_GROUP = {
  merchant_id: "mkt-m0-002",
  merchant_name: "山地文具店",
  events: [
    {
      event_id: "mevt_001",
      merchant_id: "mkt-m0-002",
      publication_id: "mpub_001",
      event_type: "product_added",
      version: 1,
      payload: { title: "保温杯 316 不锈钢", category: "生活用品" },
      created_at: "2026-09-17T02:00:00+00:00",
    },
    {
      event_id: "mevt_002",
      merchant_id: "mkt-m0-002",
      publication_id: "mpub_001",
      event_type: "faq_updated",
      version: 2,
      payload: { title: "保温杯 316 不锈钢", faq_count: 3 },
      created_at: "2026-09-17T03:00:00+00:00",
    },
  ],
  last_seen_at: "2026-09-17T03:00:00+00:00",
};

interface CapturedCall {
  url: string;
  method: string;
  cookie?: string;
  body?: unknown;
}

/** 按路径分派的 catalog stub fetch，捕获请求形状。 */
function stubCatalog(
  handler: (url: string, callIndex: number) => { status?: number; body?: unknown },
): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(init?.headers?.cookie !== undefined ? { cookie: init.headers.cookie } : {}),
      ...(init?.body !== undefined ? { body: JSON.parse(init.body) } : {}),
    });
    const picked = handler(url, calls.length - 1);
    return new Response(JSON.stringify(picked.body ?? {}), {
      status: picked.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeService(fetchImpl?: typeof fetch): KiwiBuyerService {
  return new KiwiBuyerService({
    store: new TaskApprovalStore({ dbPath: ":memory:" }),
    principal: "company:acme-test",
    buyerAgentId: "buyer-agent:test",
    sessionId: "session-test-1",
    delegationPolicy: POLICY,
    ...(fetchImpl !== undefined
      ? {
          followsClient: new BuyerFollowsSource({
            baseUrl: "http://127.0.0.1:8000",
            sessionToken: "sess-test-token",
            fetchImpl,
          }),
        }
      : {}),
  });
}

function callTool(service: KiwiBuyerService, name: string, args: Record<string, unknown>) {
  const tools = buildKiwiTools(service);
  return tools.find((t) => t.name === name)!.handle(args);
}

function textOf(result: { content?: Array<{ text?: string }> }): string {
  return result.content?.[0]?.text ?? "";
}

describe("工具词表（M4 买方范围）", () => {
  it("新增 4 个买家关注工具进入 KIWI_SOURCING_TOOLS 词表", () => {
    for (const name of [
      "kiwi_follow_merchant",
      "kiwi_unfollow_merchant",
      "kiwi_list_follows",
      "kiwi_get_follow_updates",
    ]) {
      expect(KIWI_SOURCING_TOOLS).toContain(name);
    }
  });
});

describe("kiwi_follow_merchant（显式关注）", () => {
  it("PUT /v1/me/follows/{id} 携带会话 cookie 与可选 category，投影 follow 与 created", async () => {
    const { fetchImpl, calls } = stubCatalog(() => ({
      body: { ok: true, follow: FOLLOW_VIEW, created: true },
    }));
    const service = makeService(fetchImpl);
    const res = await callTool(service, "kiwi_follow_merchant", {
      merchant_id: "mkt-m0-002",
      category: "生活用品",
    });
    expect(res.isError).toBeUndefined();
    // 请求形状：PUT + cookie 会话（无客户端伪造身份字段）。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe("http://127.0.0.1:8000/v1/me/follows/mkt-m0-002");
    expect(calls[0]?.cookie).toBe("kiwi_session=sess-test-token");
    expect(calls[0]?.body).toEqual({ category: "生活用品" });
    // 投影。
    const body = JSON.parse(textOf(res)) as {
      follow: Record<string, unknown>;
      created: boolean;
    };
    expect(body.created).toBe(true);
    expect(body.follow.merchant_id).toBe("mkt-m0-002");
    expect(body.follow.status).toBe("active");
    expect(body.follow.merchant_name).toBe("山地文具店");
  });

  it("重复关注幂等：created=false 原样透传", async () => {
    const { fetchImpl } = stubCatalog(() => ({
      body: { ok: true, follow: FOLLOW_VIEW, created: false },
    }));
    const service = makeService(fetchImpl);
    const res = await callTool(service, "kiwi_follow_merchant", { merchant_id: "mkt-m0-002" });
    expect(res.isError).toBeUndefined();
    expect((JSON.parse(textOf(res)) as { created: boolean }).created).toBe(false);
  });

  it("merchant_id 缺失 → invalid_params，不产生请求", async () => {
    const { fetchImpl, calls } = stubCatalog(() => ({ body: {} }));
    const service = makeService(fetchImpl);
    const res = await callTool(service, "kiwi_follow_merchant", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("invalid_params");
    expect(calls).toEqual([]);
  });
});

describe("kiwi_unfollow_merchant（取消关注）", () => {
  it("DELETE /v1/me/follows/{id}，投影 following=false（幂等）", async () => {
    const { fetchImpl, calls } = stubCatalog(() => ({
      body: { ok: true, merchant_id: "mkt-m0-002", following: false },
    }));
    const service = makeService(fetchImpl);
    const res = await callTool(service, "kiwi_unfollow_merchant", { merchant_id: "mkt-m0-002" });
    expect(res.isError).toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.cookie).toBe("kiwi_session=sess-test-token");
    const body = JSON.parse(textOf(res)) as { merchant_id: string; following: boolean };
    expect(body.merchant_id).toBe("mkt-m0-002");
    expect(body.following).toBe(false);
  });
});

describe("kiwi_list_follows（我的关注列表）", () => {
  it("GET /v1/me/follows 投影活跃关注列表", async () => {
    const { fetchImpl, calls } = stubCatalog(() => ({
      body: { ok: true, follows: [FOLLOW_VIEW] },
    }));
    const service = makeService(fetchImpl);
    const res = await callTool(service, "kiwi_list_follows", {});
    expect(res.isError).toBeUndefined();
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://127.0.0.1:8000/v1/me/follows");
    const body = JSON.parse(textOf(res)) as { follows: Array<Record<string, unknown>> };
    expect(body.follows).toHaveLength(1);
    expect(body.follows[0]?.merchant_id).toBe("mkt-m0-002");
    expect(body.follows[0]?.category).toBe("生活用品");
  });
});

describe("kiwi_get_follow_updates（主动拉取公开动态）", () => {
  it("updates 分组与事件 payload 原样透传（含 last_seen_at 水位）", async () => {
    const { fetchImpl, calls } = stubCatalog(() => ({
      body: { ok: true, updates: [UPDATE_GROUP] },
    }));
    const service = makeService(fetchImpl);
    const res = await callTool(service, "kiwi_get_follow_updates", {});
    expect(res.isError).toBeUndefined();
    expect(calls[0]?.url).toBe("http://127.0.0.1:8000/v1/me/follows/updates");
    const body = JSON.parse(textOf(res)) as {
      updates: Array<Record<string, unknown>>;
    };
    expect(body.updates).toHaveLength(1);
    const group = body.updates[0]!;
    expect(group.merchant_id).toBe("mkt-m0-002");
    expect(group.last_seen_at).toBe("2026-09-17T03:00:00+00:00");
    const events = group.events as Array<Record<string, unknown>>;
    expect(events.map((e) => e.event_type)).toEqual(["product_added", "faq_updated"]);
    expect((events[0]?.payload as Record<string, unknown>).title).toBe("保温杯 316 不锈钢");
  });

  it("水位语义透传：第一次有增量、第二次为空（客户端不缓存重放、不本地过滤）", async () => {
    const { fetchImpl, calls } = stubCatalog((_url, callIndex) =>
      callIndex === 0
        ? { body: { ok: true, updates: [UPDATE_GROUP] } }
        : { body: { ok: true, updates: [] } },
    );
    const service = makeService(fetchImpl);
    const first = await callTool(service, "kiwi_get_follow_updates", {});
    expect((JSON.parse(textOf(first)) as { updates: unknown[] }).updates).toHaveLength(1);
    // 上游推进水位后第二次拉取为空；客户端如实透传空结果，不重放上批事件。
    const second = await callTool(service, "kiwi_get_follow_updates", {});
    expect((JSON.parse(textOf(second)) as { updates: unknown[] }).updates).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe("会话认证边界（fail-closed）", () => {
  it("未配置 catalog 会话：四个工具返回可解释登录引导，不伪造买家身份", async () => {
    const service = makeService(undefined);
    for (const [name, args] of [
      ["kiwi_follow_merchant", { merchant_id: "mkt-m0-002" }],
      ["kiwi_unfollow_merchant", { merchant_id: "mkt-m0-002" }],
      ["kiwi_list_follows", {}],
      ["kiwi_get_follow_updates", {}],
    ] as const) {
      const res = await callTool(service, name, args);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("需要先在 Kiwi 目录登录");
    }
  });

  it("catalog 拒绝会话（HTTP 401）：引导重新登录 Kiwi 目录", async () => {
    const { fetchImpl } = stubCatalog(() => ({ status: 401, body: { detail: "login required" } }));
    const service = makeService(fetchImpl);
    const res = await callTool(service, "kiwi_list_follows", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("会话已过期或无效");
    expect(textOf(res)).toContain("重新登录 Kiwi 目录");
  });

  it("响应缺 follow 字段 → fail-closed 拒绝（不返回未校验数据）", async () => {
    const { fetchImpl } = stubCatalog(() => ({ body: { ok: true, created: true } }));
    const service = makeService(fetchImpl);
    const res = await callTool(service, "kiwi_follow_merchant", { merchant_id: "mkt-m0-002" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('follow response is missing field "follow"');
  });
});
