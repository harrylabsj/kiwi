/**
 * 双来源搜索（工作包 A）：Network 结构化查询状态 + 商品摘要 + 两端共用场景矩阵。
 *
 * 依据：Kiwi-Buyer-双来源搜索设计文档 v1.1 §7（查询状态）、§10（实施约定）、
 * §12（验收标准）、§17（结构化返回）、§19（验证计划）。
 *
 * 覆盖：
 *  - 组件级状态：单侧超时/失败/端点不存在（能力缺失）与真实空结果必须可区分；
 *  - 结果判定：只有 completed + no_match 才是「本次没有匹配」；
 *  - 商品摘要：只透出 catalog listing 的真实字段，未知不补造，每商家≤3 条；
 *  - service 汇总：未接线 → not_searched；旧索引保守口径（不判 no_match）；
 *  - 门面透传：kiwi_search 增量字段与旧字段兼容；
 *  - 场景矩阵 fixture 的结构与规则（两端对话验收共用）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { KiwiCatalogMerchantIndex } from "../src/buyer-core/merchant-index.js";
import { SOURCE_QUERY_STATUSES } from "../src/buyer-core/network-search.js";
import { PRICE_KINDS } from "../src/buyer-core/product-summary.js";
import { KiwiBuyerService, type MerchantIndex } from "../src/buyer-core/service.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import { buildKiwiTools } from "../src/mcp/tools.js";

const NOW = "2026-09-25T10:00:00Z";

const POLICY = {
  policy_id: "dp-dual-source-001",
  version: "1.0",
  principal: "company:acme-test",
  created_at: NOW,
  expires_at: "2099-12-31T23:59:59Z",
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

/** v1 可路由商家（带 agent_card_url，fresh）。 */
const AGENT_V1 = {
  catalog_agent_id: "cagt-test-001",
  principal_type: "merchant",
  merchant_id: "merchant-cat-001",
  display_name: "西湖日用",
  canonical_domain: "xihu.example",
  agent_card_url: "https://xihu.example/.well-known/agent-card.json",
  ucp_profile_url: "https://xihu.example/.well-known/ucp",
  capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"],
  hosting_mode: "direct_only",
  verification_level: "commerce_verified",
  freshness_state: "fresh",
  administrative_state: "active",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

/** 合法 ListingSearchResult（形状对齐 contracts/kiwi-catalog/1.0）。 */
function listingResult(
  listing: Record<string, unknown> = {},
  searchResult: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    listing: {
      listing_id: "lst_01JABC",
      listing_type: "product",
      owner_agent_id: "cagt-test-001",
      merchant_id: "merchant-cat-001",
      source_product_ref: "SKU-001",
      title: "316 不锈钢保温杯 500ml",
      category: "生活用品",
      brand: "山系",
      attributes: { 容量: "500ml", 材质: "316 不锈钢" },
      commercial_hints: {
        moq: 10,
        price_range_hint: "¥12-15/件",
        availability_hint: "现货",
        lead_time_hint: "华东 2-3 天",
      },
      listing_digest: "digest-1",
      publication_state: "ACTIVE",
      listing_freshness_state: "FRESH",
      published_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
      fresh_until: "2026-10-01T00:00:00Z",
      ...listing,
    },
    merchant: { merchant_id: "merchant-cat-001", display_name: "西湖日用" },
    agent: {
      catalog_agent_id: "cagt-test-001",
      verification_level: "commerce_verified",
      freshness_state: "fresh",
      administrative_state: "active",
    },
    listing_freshness_state: "FRESH",
    authority: "discovery_projection",
    requires_direct_confirmation: true,
    ...searchResult,
  };
}

interface RouteStub {
  status?: number;
  body?: unknown;
  /** true = 永不响应，直到 AbortSignal 中止（模拟超时）。 */
  hang?: boolean;
}

/** 按路径分派的 catalog stub（agents / listings / merchant-publications）。 */
function stubCatalog(routes: {
  agents?: RouteStub;
  listings?: RouteStub;
  publications?: RouteStub;
}): typeof fetch {
  return (async (input: string, init?: { signal?: AbortSignal }): Promise<Response> => {
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
    if (pick.hang === true) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError")),
        );
      });
    }
    return new Response(JSON.stringify(pick.body ?? {}), {
      status: pick.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const EMPTY = { results: [], next_cursor: null };

function makeIndex(fetchImpl: typeof fetch, timeoutMs?: number): KiwiCatalogMerchantIndex {
  return new KiwiCatalogMerchantIndex({
    baseUrl: "http://127.0.0.1:8000",
    fetchImpl,
    now: () => NOW,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

function makeService(merchantIndex?: MerchantIndex): KiwiBuyerService {
  return new KiwiBuyerService({
    store: new TaskApprovalStore({ dbPath: ":memory:" }),
    principal: "company:acme-test",
    buyerAgentId: "buyer-agent:test",
    sessionId: "session-test-1",
    delegationPolicy: POLICY,
    ...(merchantIndex !== undefined ? { merchantIndex } : {}),
  });
}

// ── 场景矩阵（两端共用清单）────────────────────────────────────────────────

interface DualSourceCase {
  id: string;
  design_ref: string | null;
  title: string;
  layer: "search" | "display" | "quote";
  network: string | null;
  network_result_state: string | null;
  network_match: string | null;
  internet: string | null;
  send_evidence: boolean | null;
  merchant_replied_with_price: boolean | null;
  must_not_claim: string[];
  expectation: string;
}

const fixture = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests/fixtures/dual-source-search-cases.json"), "utf8"),
) as { cases: DualSourceCase[] };

/** 宿主侧的互联网一路状态（本仓不产生，仅清单约束）。 */
const HOST_INTERNET_STATES = [
  "completed",
  "partial",
  "failed",
  "timeout",
  "unavailable",
  "not_searched",
] as const;

describe("双来源场景矩阵（设计 §12 + §7/§8 规则）", () => {
  it("覆盖设计 §12 全部 16 个场景 + 补充场景，id 唯一无缺无重", () => {
    const ids = fixture.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const designRefs = fixture.cases.map((c) => c.design_ref).filter((ref) => ref !== null);
    expect(designRefs.sort()).toEqual(
      Array.from({ length: 16 }, (_, i) => `S${String(i + 1).padStart(2, "0")}`),
    );
    for (const each of fixture.cases) {
      expect(each.title.length).toBeGreaterThan(0);
      expect(each.expectation.length).toBeGreaterThan(0);
      expect(Array.isArray(each.must_not_claim)).toBe(true);
      expect(["search", "display", "quote"]).toContain(each.layer);
    }
  });

  it("network / internet 取值都在各自词表内", () => {
    for (const each of fixture.cases) {
      if (each.network !== null) {
        expect(SOURCE_QUERY_STATUSES as readonly string[]).toContain(each.network);
      }
      if (each.internet !== null) {
        expect(HOST_INTERNET_STATES as readonly string[]).toContain(each.internet);
      }
    }
  });

  it("只有 completed + no_match 之外的场景，禁止出现『无供应商／暂无匹配』结论", () => {
    for (const each of fixture.cases) {
      const decisiveNoMatch =
        each.network === "completed" && each.network_result_state === "no_match";
      if (decisiveNoMatch) continue;
      const forbiddenForSource =
        each.network === "error" ||
        each.network === "timeout" ||
        each.network === "not_searched" ||
        (each.network === "partial" && each.network_result_state === "undetermined");
      if (!forbiddenForSource) continue;
      expect(
        each.must_not_claim,
        `${each.id}（${each.title}）在非确定无匹配时必须禁止『无供应商』结论`,
      ).toContain("无供应商");
    }
  });

  it("无发送证据不得出现『已发送』，商家未报价不得出现『已报价』（§8.2 证据要求）", () => {
    for (const each of fixture.cases) {
      if (each.layer !== "quote") continue;
      if (each.send_evidence !== true) {
        expect(each.must_not_claim, `${each.id} 无发送证据`).toContain("已发送");
      }
      if (each.merchant_replied_with_price !== true) {
        expect(each.must_not_claim, `${each.id} 未含价格回复`).toContain("已报价");
      }
    }
  });
});

// ── 组件级状态与结果判定 ───────────────────────────────────────────────────

describe("KiwiCatalogMerchantIndex：组件状态与结果判定（设计 §17）", () => {
  it("三路完成且有命中 → completed + has_candidates", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: { results: [AGENT_V1], next_cursor: null } },
      listings: { body: { results: [listingResult()], next_cursor: "" } },
      publications: { body: { results: [], next_cursor: "" } },
    });
    const { merchants, diagnostics } = await makeIndex(fetchImpl).searchWithDiagnostics("保温杯");
    expect(merchants).toHaveLength(1);
    expect(diagnostics).toMatchObject({
      source: "kiwi_network",
      status: "completed",
      result_state: "has_candidates",
      searched_at: NOW,
      components: [
        { name: "listings", status: "completed" },
        { name: "agents", status: "completed" },
        { name: "merchant_publications", status: "completed" },
      ],
    });
  });

  it("三路完成但无命中 → completed + no_match（只有此时才能说「本次没有匹配」）", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: EMPTY },
      listings: { body: EMPTY },
      publications: { body: EMPTY },
    });
    const { merchants, diagnostics } = await makeIndex(fetchImpl).searchWithDiagnostics("保温杯");
    expect(merchants).toEqual([]);
    expect(diagnostics.status).toBe("completed");
    expect(diagnostics.result_state).toBe("no_match");
    expect(diagnostics.notes).toEqual([]);
  });

  it("listing 超时 → 组件 timeout + 来源 partial，已有候选照常上报", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: { results: [AGENT_V1], next_cursor: null } },
      listings: { hang: true },
      publications: { body: EMPTY },
    });
    const { merchants, diagnostics } = await makeIndex(fetchImpl, 50).searchWithDiagnostics(
      "保温杯",
    );
    expect(merchants).toHaveLength(1);
    expect(diagnostics.status).toBe("partial");
    expect(diagnostics.result_state).toBe("has_candidates");
    expect(diagnostics.components).toEqual([
      { name: "listings", status: "timeout", reason: "request_timeout" },
      { name: "agents", status: "completed" },
      { name: "merchant_publications", status: "completed" },
    ]);
    // 部分完成必须如实标注覆盖不完整（不静默降级）。
    expect(diagnostics.notes.join(" ")).toContain("覆盖不完整");
  });

  it("publications 端点不存在 → 组件 not_searched（能力缺失），空结果不判 no_match", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: EMPTY },
      listings: { body: EMPTY },
      publications: { status: 404 },
    });
    const { diagnostics } = await makeIndex(fetchImpl).searchWithDiagnostics("保温杯");
    expect(diagnostics.components).toEqual([
      { name: "listings", status: "completed" },
      { name: "agents", status: "completed" },
      { name: "merchant_publications", status: "not_searched", reason: "endpoint_unavailable" },
    ]);
    expect(diagnostics.status).toBe("partial");
    expect(diagnostics.result_state).toBe("undetermined");
  });

  it("全侧失败 → searchWithDiagnostics 不抛错，如实报 timeout/error 与 undetermined", async () => {
    const timeouts = stubCatalog({
      agents: { hang: true },
      listings: { hang: true },
      publications: { hang: true },
    });
    const allTimeout = await makeIndex(timeouts, 50).searchWithDiagnostics("保温杯");
    expect(allTimeout.diagnostics.status).toBe("timeout");
    expect(allTimeout.diagnostics.result_state).toBe("undetermined");
    expect(allTimeout.diagnostics.notes.join(" ")).toContain("查询未完成");

    const errors = stubCatalog({
      agents: { status: 500 },
      listings: { status: 500 },
      publications: { status: 500 },
    });
    const allError = await makeIndex(errors).searchWithDiagnostics("保温杯");
    expect(allError.diagnostics.status).toBe("error");
    expect(allError.diagnostics.result_state).toBe("undetermined");
  });

  it("商家离线（freshness_state=stale）不改变查询状态，只影响可询价能力", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: { results: [{ ...AGENT_V1, freshness_state: "stale" }], next_cursor: null } },
      listings: { body: EMPTY },
      publications: { body: EMPTY },
    });
    const { merchants, diagnostics } = await makeIndex(fetchImpl).searchWithDiagnostics("保温杯");
    expect(merchants[0]?.inquiry_available).toBe(false);
    expect(diagnostics.status).toBe("completed");
    expect(diagnostics.result_state).toBe("has_candidates");
    expect(diagnostics.notes.join(" ")).toContain("服务当前离线");
  });
});

// ── 商品摘要 ───────────────────────────────────────────────────────────────

describe("MerchantRecord.products：只透出商家声明的真实字段", () => {
  it("listing 命中 → 商品名/规格/商家资料价/起订量/交期/更新时间 + 信息性质", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: EMPTY },
      listings: { body: { results: [listingResult()], next_cursor: "" } },
      publications: { body: EMPTY },
    });
    const { merchants } = await makeIndex(fetchImpl).searchWithDiagnostics("保温杯");
    const products = merchants[0]?.products;
    expect(products).toHaveLength(1);
    expect(products?.[0]).toEqual({
      listing_id: "lst_01JABC",
      title: "316 不锈钢保温杯 500ml",
      brand: "山系",
      category: "生活用品",
      attributes: { 容量: "500ml", 材质: "316 不锈钢" },
      price: { kind: "merchant_listed_price", hint: "¥12-15/件" },
      moq: 10,
      availability_hint: "现货",
      lead_time_hint: "华东 2-3 天",
      updated_at: "2026-09-20T00:00:00Z",
      basis: "merchant_listed",
      authority: "discovery_projection",
    });
    // 价格类型必须是价格词表成员，且不是报价。
    expect(PRICE_KINDS as readonly string[]).toContain(products?.[0]?.price.kind);
  });

  it("无价格/起订量声明 → to_be_quoted 且字段缺省（不补造）", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: EMPTY },
      listings: {
        body: {
          results: [
            listingResult({
              brand: undefined,
              attributes: undefined,
              commercial_hints: undefined,
            }),
          ],
          next_cursor: "",
        },
      },
      publications: { body: EMPTY },
    });
    const { merchants } = await makeIndex(fetchImpl).searchWithDiagnostics("保温杯");
    const product = merchants[0]?.products?.[0];
    expect(product?.price).toEqual({ kind: "to_be_quoted" });
    expect(product?.moq).toBeUndefined();
    expect(product?.availability_hint).toBeUndefined();
    expect(product?.brand).toBeUndefined();
    // 商家级 delivery 也来自 listing，未知时保持缺省。
    expect(merchants[0]?.delivery).toBeUndefined();
  });

  it("每商家最多 3 条商品摘要（工具返回体积上限）", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: EMPTY },
      listings: {
        body: {
          results: [
            listingResult({ listing_id: "lst_1", source_product_ref: "SKU-1" }),
            listingResult({ listing_id: "lst_2", source_product_ref: "SKU-2" }),
            listingResult({ listing_id: "lst_3", source_product_ref: "SKU-3" }),
            listingResult({ listing_id: "lst_4", source_product_ref: "SKU-4" }),
          ],
          next_cursor: "",
        },
      },
      publications: { body: EMPTY },
    });
    const { merchants } = await makeIndex(fetchImpl).searchWithDiagnostics("保温杯");
    expect(merchants).toHaveLength(1);
    expect(merchants[0]?.products?.map((product) => product.listing_id)).toEqual([
      "lst_1",
      "lst_2",
      "lst_3",
    ]);
    // matching_skus 保持原有累积行为（旧宿主仍可读）。
    expect(merchants[0]?.matching_skus).toEqual(["SKU-1", "SKU-2", "SKU-3", "SKU-4"]);
  });
});

// ── service 汇总与门面透传 ─────────────────────────────────────────────────

describe("KiwiBuyerService.search：汇总与兼容口径", () => {
  it("未注入 MerchantIndex → not_searched（不是无匹配，也不是失败）", async () => {
    const result = await makeService().search({ query: "保温杯" });
    expect(result.merchants).toEqual([]);
    expect(result.note).toContain("not wired");
    expect(result.network_search).toEqual({
      source: "kiwi_network",
      status: "not_searched",
      result_state: "undetermined",
      components: [],
      notes: [],
    });
  });

  it("旧索引（无 searchWithDiagnostics）空结果 → partial + undetermined，不判 no_match", async () => {
    const legacy: MerchantIndex = {
      async search() {
        return [];
      },
      async resolveById() {
        return undefined;
      },
    };
    const result = await makeService(legacy).search({ query: "保温杯" });
    expect(result.merchants).toEqual([]);
    expect(result.note).toBeUndefined();
    expect(result.network_search.status).toBe("partial");
    expect(result.network_search.result_state).toBe("undetermined");
    expect(result.network_search.components).toEqual([]);
  });

  it("旧索引抛错 → error + undetermined + 可解释 note（不编造商家）", async () => {
    const broken: MerchantIndex = {
      async search() {
        throw new Error("connection refused");
      },
      async resolveById() {
        throw new Error("connection refused");
      },
    };
    const result = await makeService(broken).search({ query: "保温杯" });
    expect(result.merchants).toEqual([]);
    expect(result.note).toContain("unreachable");
    expect(result.network_search.status).toBe("error");
    expect(result.network_search.result_state).toBe("undetermined");
    expect(result.network_search.notes.join(" ")).toContain("unreachable");
  });

  it("kiwi_search 透传 network_search，旧字段 merchants/note 保持不变", async () => {
    const fetchImpl = stubCatalog({
      agents: { body: EMPTY },
      listings: { body: { results: [listingResult()], next_cursor: "" } },
      publications: { body: EMPTY },
    });
    const service = makeService(makeIndex(fetchImpl));
    const tool = buildKiwiTools(service).find((each) => each.name === "kiwi_search");
    const res = await tool?.handle({ query: "保温杯" });
    expect(res?.isError).toBeUndefined();
    const body = JSON.parse(res?.content?.[0]?.text ?? "{}") as {
      merchants: Array<Record<string, unknown>>;
      network_search: Record<string, unknown>;
    };
    expect(body.merchants).toHaveLength(1);
    expect(body.network_search).toMatchObject({
      source: "kiwi_network",
      status: "completed",
      result_state: "has_candidates",
    });
    // 旧字段仍在（已发布宿主只读 merchants + note）。
    expect(body.merchants[0]?.merchant_id).toBe("merchant-cat-001");
    expect(body.merchants[0]?.products).toHaveLength(1);
  });
});
