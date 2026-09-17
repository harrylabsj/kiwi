/**
 * M0 商家公开资料（merchant-buddy 第 0 版工作包 B）测试。
 *
 * 覆盖：
 *  - KiwiCatalogMerchantIndex 三路合并：M0 公开资料与 Agent/Listing 按 merchant_id
 *    去重为一个主体；v1 商家实时能力不被静态资料降级；M0-only 商家 inquiry_available=false；
 *  - 单侧失败降级：publications 来源不可用保留 Agent/Listing 结果并标注；
 *    Agent/Listing 双侧失败保留 M0 结果并标注；全侧失败 fail-closed（不编造商家）；
 *  - RFQ 硬门：仅 M0 公开资料的商家 requestQuotes 服务层拒绝
 *    （merchant_inquiry_unavailable，不产生任务/不调用 fetcher）；v1 商家回归不受影响；
 *  - 工具门面投影：kiwi_search 输出携带 inquiry_available/publications 字段，
 *    kiwi_request_quotes 对 M0 商家 isError 且可解释。
 */
import { describe, expect, it } from "vitest";

import { KiwiCatalogMerchantIndex } from "../src/buyer-core/merchant-index.js";
import { KiwiBuyerService, type QuoteFetcher } from "../src/buyer-core/service.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import { buildKiwiTools } from "../src/mcp/tools.js";

const TS = "2026-09-17T10:00:00+08:00";

const POLICY = {
  policy_id: "dp-m0-001",
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

const INTENT = {
  intent_id: "intent-m0-0001",
  intent_type: "purchase",
  items: [{ query: "保温杯", quantity: { value: 2, unit: "个" } }],
  constraints: { currency: "CNY" },
  context_projection: {
    disclosure_boundary: "commerce_required",
    projected_fields: ["items", "constraints"],
  },
};

/** 合法 CatalogAgentRecord（v1 可路由商家：带 agent_card_url）。 */
const AGENT_V1 = {
  catalog_agent_id: "cagt-test-001",
  principal_type: "merchant",
  merchant_id: "merchant-cat-001",
  display_name: "西湖数码",
  canonical_domain: "xihu.example",
  agent_card_url: "https://xihu.example/.well-known/agent-card.json",
  ucp_profile_url: "https://xihu.example/.well-known/ucp",
  capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"],
  hosting_mode: "direct_only",
  verification_level: "domain_verified",
  freshness_state: "fresh",
  administrative_state: "active",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

/** M0 公开资料行（形状对齐 kiwi-catalog public_projection）。 */
function publication(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    publication_id: "mpub_001",
    merchant_id: "mkt-m0-002",
    merchant_display_name: "山地文具店",
    title: "保温杯 316 不锈钢",
    category: "生活用品",
    summary: "商家声明的公开资料",
    shop_platform: "taobao",
    shop_url: "https://shop.example/taobao123",
    faq: [],
    source_kind: "merchant_declared",
    status: "published",
    version: 1,
    published_at: "2026-09-10T02:00:00+00:00",
    expires_at: "",
    updated_at: "2026-09-12T03:00:00+00:00",
    inquiry_available: false,
    ...overrides,
  };
}

interface StubRoutes {
  agents?: { status?: number; body?: unknown };
  listings?: { status?: number; body?: unknown };
  publications?: { status?: number; body?: unknown };
}

/** 按路径分派的 catalog stub fetch。 */
function stubCatalog(routes: StubRoutes): typeof fetch {
  return (async (input: string): Promise<Response> => {
    const url = String(input);
    const pick = url.includes("/v1/merchant-publications/search")
      ? routes.publications
      : url.includes("/v1/listings/search")
        ? routes.listings
        : url.includes("/v1/agents/search")
          ? routes.agents
          : undefined;
    if (pick === undefined) {
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }
    const status = pick.status ?? 200;
    const body = pick.body ?? {};
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const EMPTY_AGENTS = { results: [], next_cursor: null };
const EMPTY_LISTINGS = { results: [], next_cursor: null };

function makeService(fetchImpl: typeof fetch, quoteFetcher?: QuoteFetcher): KiwiBuyerService {
  return new KiwiBuyerService({
    store: new TaskApprovalStore({ dbPath: ":memory:" }),
    principal: "company:acme-test",
    buyerAgentId: "buyer-agent:test",
    sessionId: "session-test-1",
    delegationPolicy: POLICY,
    merchantIndex: new KiwiCatalogMerchantIndex({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl,
    }),
    ...(quoteFetcher !== undefined ? { quoteFetcher } : {}),
  });
}

describe("WP6：Agent 新鲜度（服务离线不再标可实时询价）", () => {
  it("agent 存在但 freshness_state=stale → inquiry_available=false，且给出降级说明", async () => {
    const fetchImpl = stubCatalog({
      agents: {
        body: { results: [{ ...AGENT_V1, freshness_state: "stale" }], next_cursor: null },
      },
      listings: { body: EMPTY_LISTINGS },
      publications: { body: { results: [], next_cursor: null } },
    });
    const index = new KiwiCatalogMerchantIndex({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
    const merchants = await index.search("保温杯");
    const v1 = merchants.find((m) => m.merchant_id === "merchant-cat-001");
    expect(v1?.inquiry_available).toBe(false);
    expect(v1?.agent_card_url).toBeDefined();
    expect(index.lastSearchNotes().join(" ")).toContain("服务当前离线");
  });

  it("unreachable 同样降级（fresh 之外的离线态都不可实时询价）", async () => {
    const stale = stubCatalog({
      agents: {
        body: { results: [{ ...AGENT_V1, freshness_state: "unreachable" }], next_cursor: null },
      },
      listings: { body: EMPTY_LISTINGS },
      publications: { body: { results: [], next_cursor: null } },
    });
    const indexStale = new KiwiCatalogMerchantIndex({
      baseUrl: "http://127.0.0.1:8000",
      fetchImpl: stale,
    });
    expect(
      (await indexStale.search("保温杯")).find((m) => m.merchant_id === "merchant-cat-001")
        ?.inquiry_available,
    ).toBe(false);

  });

  it("记录缺 freshness_state（违反冻结契约）→ fail-closed，不标可实时询价", async () => {
    // agent-record 契约把 freshness_state 列为必填：缺字段视为契约违规，
    // 该来源判失败并如实标注——绝不因为没有新鲜度信息就默认"在线"。
    const broken: Record<string, unknown> = { ...AGENT_V1 };
    delete broken.freshness_state;
    const fetchImpl = stubCatalog({
      agents: { body: { results: [broken], next_cursor: null } },
      listings: { body: EMPTY_LISTINGS },
      publications: { body: { results: [], next_cursor: null } },
    });
    const index = new KiwiCatalogMerchantIndex({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
    const merchants = await index.search("保温杯");
    expect(merchants.find((m) => m.merchant_id === "merchant-cat-001")).toBeUndefined();
  });

  it("RFQ 硬门：离线商家返回 merchant_offline，且不产生任务", async () => {
    const fetchImpl = stubCatalog({
      agents: {
        body: { results: [{ ...AGENT_V1, freshness_state: "stale" }], next_cursor: null },
      },
      listings: { body: EMPTY_LISTINGS },
      publications: { body: { results: [], next_cursor: null } },
    });
    const service = makeService(fetchImpl);
    await expect(
      service.requestQuotes({
        intent: INTENT,
        merchant_ids: ["merchant-cat-001"],
        idempotency_key: "idem-wp6-1",
      }),
    ).rejects.toThrowError(/merchant_offline|不在线/);
  });
});

describe("KiwiCatalogMerchantIndex：M0 公开资料三路合并", () => {
  it("同一商家同时命中 Agent 与公开资料时去重为一个主体，实时能力来自 Agent 侧", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: { results: [AGENT_V1], next_cursor: null } },
      listings: { body: EMPTY_LISTINGS },
      publications: {
        body: {
          ok: true,
          results: [
            publication({
              publication_id: "mpub_v1",
              merchant_id: "merchant-cat-001",
              merchant_display_name: "西湖数码",
              title: "保温杯 316 不锈钢",
            }),
            publication({ publication_id: "mpub_m0", merchant_id: "mkt-m0-002" }),
          ],
          next_cursor: "",
        },
      },
    });
    const index = new KiwiCatalogMerchantIndex({ baseUrl: "http://127.0.0.1:8000", fetchImpl });
    const merchants = await index.search("保温杯");
    expect(merchants).toHaveLength(2);

    // v1 商家：一个主体，可实时询价，公开资料并列展示。
    const v1 = merchants.find((m) => m.merchant_id === "merchant-cat-001");
    expect(v1).toBeDefined();
    expect(v1?.inquiry_available).toBe(true);
    expect(v1?.agent_card_url).toContain("agent-card.json");
    expect(v1?.source_kind).toBeUndefined();
    expect(v1?.publications).toHaveLength(1);
    expect(v1?.publications?.[0]?.title).toBe("保温杯 316 不锈钢");
    expect(v1?.publications?.[0]?.source_kind).toBe("merchant_declared");

    // M0-only 商家：资料可查，不可实时询价，保留命中商品名/来源/更新时间。
    const m0 = merchants.find((m) => m.merchant_id === "mkt-m0-002");
    expect(m0).toBeDefined();
    expect(m0?.name).toBe("山地文具店");
    expect(m0?.inquiry_available).toBe(false);
    expect(m0?.source_kind).toBe("merchant_declared");
    expect(m0?.agent_card_url).toBeUndefined();
    expect(m0?.verified).toBe(false);
    expect(m0?.publications?.[0]?.updated_at).toBe("2026-09-12T03:00:00+00:00");
    expect(m0?.publications?.[0]?.shop_url).toBe("https://shop.example/taobao123");
    expect(index.lastSearchNotes()).toEqual([]);
  });

  it("publications 来源不可用：保留 Agent/Listing 结果并标注该来源暂不可用", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: { results: [AGENT_V1], next_cursor: null } },
      listings: { body: EMPTY_LISTINGS },
      publications: { status: 404 },
    });
    const service = makeService(fetchImpl);
    const result = await service.search({ query: "保温杯" });
    expect(result.merchants).toHaveLength(1);
    expect(result.merchants[0]?.merchant_id).toBe("merchant-cat-001");
    expect(result.note).toContain("商家公开资料");
    expect(result.note).toContain("暂不可用");
  });

  it("Agent/Listing 双侧失败：保留 M0 公开资料结果并标注，不 fail-closed", async () => {
    const fetchImpl = stubCatalog({
      agents: { status: 500 },
      listings: { status: 500 },
      publications: {
        body: { ok: true, results: [publication({})], next_cursor: "" },
      },
    });
    const service = makeService(fetchImpl);
    const result = await service.search({ query: "保温杯" });
    expect(result.merchants).toHaveLength(1);
    expect(result.merchants[0]?.merchant_id).toBe("mkt-m0-002");
    expect(result.merchants[0]?.inquiry_available).toBe(false);
    expect(result.note).toContain("Agent/Listing");
    expect(result.note).toContain("暂不可用");
  });

  it("全侧失败：fail-closed 降级为可解释 note，不凭模型记忆补全商家", async () => {
    const fetchImpl = stubCatalog({
      agents: { status: 500 },
      listings: { status: 500 },
      publications: { status: 500 },
    });
    const service = makeService(fetchImpl);
    const result = await service.search({ query: "保温杯" });
    expect(result.merchants).toEqual([]);
    expect(result.note).toContain("unreachable");
  });

  it("公开资料投影违反 M0 不变量（inquiry_available=true）→ 该来源按失败容忍，不污染结果", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: EMPTY_AGENTS },
      listings: { body: EMPTY_LISTINGS },
      publications: {
        body: {
          ok: true,
          results: [publication({ inquiry_available: true })],
          next_cursor: "",
        },
      },
    });
    const service = makeService(fetchImpl);
    const result = await service.search({ query: "保温杯" });
    expect(result.merchants).toEqual([]);
    expect(result.note).toContain("暂不可用");
  });
});

describe("RFQ 硬门：仅 M0 公开资料的商家不得发起 kiwi_request_quotes", () => {
  function countingFetcher(calls: Array<unknown>): QuoteFetcher {
    return {
      async requestQuotes(_intent, merchants) {
        calls.push(merchants.map((m) => m.merchant_id));
        return merchants.map((m) => ({
          merchant_id: m.merchant_id,
          status: "succeeded" as const,
          provenance: { source: "a2a" },
        }));
      },
    };
  }

  it("M0-only 商家：服务层拒绝（merchant_inquiry_unavailable），不产生任务、不调用 fetcher", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: EMPTY_AGENTS },
      listings: { body: EMPTY_LISTINGS },
      publications: {
        body: { ok: true, results: [publication({})], next_cursor: "" },
      },
    });
    const calls: Array<unknown> = [];
    const service = makeService(fetchImpl, countingFetcher(calls));
    await expect(
      service.requestQuotes({
        intent: INTENT,
        idempotency_key: "rfq-m0-block",
        merchant_ids: ["mkt-m0-002"],
      }),
    ).rejects.toMatchObject({ code: "merchant_inquiry_unavailable" });
    // fetcher 未被调用（无 RFQ fan-out）。
    expect(calls).toEqual([]);
    // 未产生任务：同幂等键重试仍走硬门拒绝，而非命中已建任务。
    await expect(
      service.requestQuotes({
        intent: INTENT,
        idempotency_key: "rfq-m0-block",
        merchant_ids: ["mkt-m0-002"],
      }),
    ).rejects.toMatchObject({ code: "merchant_inquiry_unavailable" });
  });

  it("拒绝文案可解释：仅公开资料，尚未开通 Kiwi 实时询价", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: EMPTY_AGENTS },
      listings: { body: EMPTY_LISTINGS },
      publications: {
        body: { ok: true, results: [publication({})], next_cursor: "" },
      },
    });
    const service = makeService(fetchImpl);
    await expect(
      service.requestQuotes({ intent: INTENT, merchant_ids: ["mkt-m0-002"] }),
    ).rejects.toThrow(/仅公开资料，尚未开通 Kiwi 实时询价/);
  });

  it("v1 商家（同时发布 M0 资料）回归：硬门不误伤，RFQ 正常 fan-out", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: { results: [AGENT_V1], next_cursor: null } },
      listings: { body: EMPTY_LISTINGS },
      publications: {
        body: {
          ok: true,
          results: [publication({ publication_id: "mpub_v1", merchant_id: "merchant-cat-001" })],
          next_cursor: "",
        },
      },
    });
    const calls: Array<unknown> = [];
    const service = makeService(fetchImpl, countingFetcher(calls));
    const result = await service.requestQuotes({
      intent: INTENT,
      idempotency_key: "rfq-v1-ok",
      merchant_ids: ["merchant-cat-001"],
    });
    expect(result.created).toBe(true);
    expect(calls).toEqual([["merchant-cat-001"]]);
    expect(result.task.status).toBe("succeeded");
  });
});

describe("工具门面投影（kiwi_search / kiwi_request_quotes）", () => {
  it("kiwi_search 输出携带 inquiry_available 与 publications 投影字段", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: { results: [AGENT_V1], next_cursor: null } },
      listings: { body: EMPTY_LISTINGS },
      publications: {
        body: { ok: true, results: [publication({})], next_cursor: "" },
      },
    });
    const service = makeService(fetchImpl);
    const tools = buildKiwiTools(service);
    const res = await tools.find((t) => t.name === "kiwi_search")!.handle({ query: "保温杯" });
    expect(res.isError).toBeUndefined();
    const body = JSON.parse(res.content?.[0]?.text ?? "{}") as {
      merchants: Array<Record<string, unknown>>;
    };
    const m0 = body.merchants.find((m) => m.merchant_id === "mkt-m0-002");
    expect(m0?.inquiry_available).toBe(false);
    expect(m0?.source_kind).toBe("merchant_declared");
    const pubs = m0?.publications as Array<Record<string, unknown>>;
    expect(pubs[0]?.title).toBe("保温杯 316 不锈钢");
    expect(pubs[0]?.source_kind).toBe("merchant_declared");
    const v1 = body.merchants.find((m) => m.merchant_id === "merchant-cat-001");
    expect(v1?.inquiry_available).toBe(true);
  });

  it("kiwi_request_quotes 对 M0 商家返回 isError + merchant_inquiry_unavailable", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: EMPTY_AGENTS },
      listings: { body: EMPTY_LISTINGS },
      publications: {
        body: { ok: true, results: [publication({})], next_cursor: "" },
      },
    });
    const calls: Array<unknown> = [];
    const service = makeService(fetchImpl, {
      async requestQuotes(_intent, merchants) {
        calls.push(merchants);
        return [];
      },
    });
    const tools = buildKiwiTools(service);
    const res = await tools
      .find((t) => t.name === "kiwi_request_quotes")!
      .handle({
        intent: INTENT,
        merchant_ids: ["mkt-m0-002"],
      });
    expect(res.isError).toBe(true);
    const text = res.content?.[0]?.text ?? "";
    expect(text).toContain("merchant_inquiry_unavailable");
    expect(text).toContain("尚未开通 Kiwi 实时询价");
    expect(calls).toEqual([]);
  });
});
