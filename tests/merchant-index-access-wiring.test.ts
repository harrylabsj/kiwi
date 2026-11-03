/**
 * 买家门禁元数据接线回归。
 *
 * 背景：真实 linkluck 任务中 listing 优先记录丢了 catalog_agent_id/runtime_access，
 * 买家绕过目录开放询价中继直连 WorkBuddy 应用，收到 403 非 JSON。本文件钉住：
 *  - search 的 listing 首命中 / agent 合并 / 按 ID 回查 / 仅 owner 回查都保留同一商家
 *    的 catalog_agent_id 与 runtime_access；
 *  - 身份不一致 fail-closed；
 *  - 受门禁商家缺访问传输时 fail-closed（不静默直连）；
 *  - 有 catalog_agent_id 时即使缺 runtime_access 也能走中继；
 *  - 中继把上游 403 翻译成 502 JSON 后，买家按 502 归类而不是误报 403；
 *  - 恢复用路线提示保留 agentId/merchantId/endpoint。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { KiwiCatalogMerchantIndex } from "../src/buyer-core/merchant-index.js";
import { A2AQuoteFetcher } from "../src/buyer-core/a2a-quote-fetcher.js";
import { OpenInquirySessionSigner } from "../src/a2a/open-inquiry-session.js";
import { OpenInquiryRouteStore } from "../src/buyer-core/open-inquiry-route-store.js";
import { createOpenInquiryTransport } from "../src/a2a/client/open-inquiry-transport.js";

const CATALOG = "https://catalog.example";
const MERCHANT = "mkt_test_1";
const AGENT = "cagt_test_1";
const CARD = `${CATALOG}/v1/agents/${AGENT}/agent-card.json`;
const ENDPOINT = "https://merchant.example/a2a";
const RELAY = "https://catalog.example/v1/agents/cagt_test_1/public-inquiry";
const NOW = "2026-11-03T00:00:00+00:00";

const RUNTIME_ACCESS = {
  provider: "workbuddy",
  access_mode: "share_parameter",
  parameter_name: "sharecode",
  config_version: 1,
  adapter_version: "workbuddy-share-v1",
  auth_mode: "signature",
} as const;

const AGENT_RECORD = {
  catalog_agent_id: AGENT,
  principal_type: "merchant",
  merchant_id: MERCHANT,
  display_name: "门禁商家",
  canonical_domain: "merchant.example",
  hosting_mode: "direct",
  verification_level: "commerce_verified",
  freshness_state: "fresh",
  administrative_state: "active",
  created_at: NOW,
  updated_at: NOW,
  agent_card_url: CARD,
  protocols: { a2a: [] },
  runtime_access: RUNTIME_ACCESS,
};

const LISTING_RESULT = {
  listing: {
    listing_id: "lst_test_1",
    listing_type: "product",
    owner_agent_id: AGENT,
    merchant_id: MERCHANT,
    title: "测试商品",
    category: "个护",
    listing_digest: "a".repeat(64),
    publication_state: "ACTIVE",
    listing_freshness_state: "FRESH",
    published_at: NOW,
    updated_at: NOW,
    fresh_until: NOW,
    source_product_ref: "SKU-TEST-1",
  },
  merchant: { merchant_id: MERCHANT, display_name: "门禁商家" },
  agent: { catalog_agent_id: AGENT, verification_level: "commerce_verified", freshness_state: "fresh", administrative_state: "active" },
  listing_freshness_state: "FRESH",
  authority: "discovery_projection",
  requires_direct_confirmation: true,
};

type Routes = {
  listings?: unknown;
  agents?: unknown;
  publications?: unknown;
  agentById?: unknown;
};

function catalogFetch(routes: Routes, calls: string[]) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === "/v1/listings/search") return Response.json(routes.listings ?? { results: [], next_cursor: null });
    if (url.pathname === "/v1/agents/search") return Response.json(routes.agents ?? { results: [], next_cursor: null });
    if (url.pathname === "/v1/merchant-publications/search") return Response.json(routes.publications ?? { results: [], next_cursor: null });
    if (url.pathname.startsWith("/v1/agents/")) return Response.json({ agent: routes.agentById ?? AGENT_RECORD });
    return Response.json({});
  }) as typeof fetch;
}

function index(routes: Routes, calls: string[] = []) {
  return new KiwiCatalogMerchantIndex({ baseUrl: CATALOG, fetchImpl: catalogFetch(routes, calls) });
}

function protocolOptions() {
  const dir = mkdtempSync(path.join(tmpdir(), "merchant-index-access-"));
  return { dir, options: { protocolStateDir: dir, localBuyerAgentId: "buyer-access-test" } };
}
const INTENT = {
  intent_id: "intent-access-1",
  intent_type: "purchase",
  items: [{ query: "测试商品", sku: "SKU-TEST-1", quantity: { value: 1, unit: "件" } }],
  constraints: { currency: "CNY", deadline: "2027-12-31T18:00:00Z" },
};
function context() {
  return { taskId: "task-access-1", createdAt: new Date().toISOString(), intentBindingDigest: "sha256:" + "0".repeat(64) };
}

describe("门禁元数据接线（listing/agent/回查/恢复）", () => {
  it("search listing 首命中：owner 回查补齐 catalog_agent_id 与 runtime_access", async () => {
    const calls: string[] = [];
    const indexUnderTest = index({ listings: { results: [LISTING_RESULT], next_cursor: null } }, calls);
    const [record] = await indexUnderTest.search("测试商品");
    expect(record?.merchant_id).toBe(MERCHANT);
    expect(record?.catalog_agent_id).toBe(AGENT);
    expect(record?.runtime_access).toEqual(RUNTIME_ACCESS);
    expect(record?.agent_card_url).toBe(CARD);
    expect(calls).toContain(`/v1/agents/${AGENT}`);
  });

  it("search agent 合并：同一商家补齐 catalog_agent_id 与 runtime_access", async () => {
    const indexUnderTest = index({
      listings: { results: [LISTING_RESULT], next_cursor: null },
      agents: { results: [AGENT_RECORD], next_cursor: null },
    });
    const [record] = await indexUnderTest.search("测试商品");
    expect(record?.catalog_agent_id).toBe(AGENT);
    expect(record?.runtime_access).toEqual(RUNTIME_ACCESS);
    expect(record?.agent_card_url).toBe(CARD);
  });

  it("search 仅 agent 首命中：mapRecord 保留门禁元数据", async () => {
    const indexUnderTest = index({ agents: { results: [AGENT_RECORD], next_cursor: null } });
    const [record] = await indexUnderTest.search("门禁商家");
    expect(record?.catalog_agent_id).toBe(AGENT);
    expect(record?.runtime_access).toEqual(RUNTIME_ACCESS);
  });

  it("resolveById listing + agent：保留同一商家的 catalog_agent_id/runtime_access", async () => {
    const indexUnderTest = index({
      listings: { results: [LISTING_RESULT], next_cursor: null },
      agents: { results: [AGENT_RECORD], next_cursor: null },
    });
    const record = await indexUnderTest.resolveById(MERCHANT);
    expect(record?.catalog_agent_id).toBe(AGENT);
    expect(record?.runtime_access).toEqual(RUNTIME_ACCESS);
    expect(record?.agent_card_url).toBe(CARD);
  });

  it("resolveById 仅 owner 回查：仍带 catalog_agent_id 与 runtime_access", async () => {
    const calls: string[] = [];
    const indexUnderTest = index({ listings: { results: [LISTING_RESULT], next_cursor: null } }, calls);
    const record = await indexUnderTest.resolveById(MERCHANT);
    expect(record?.catalog_agent_id).toBe(AGENT);
    expect(record?.runtime_access).toEqual(RUNTIME_ACCESS);
    expect(calls).toContain(`/v1/agents/${AGENT}`);
  });

  it("resolveById 身份不一致时 fail-closed（返回 undefined，不挂他人门禁）", async () => {
    const mismatched = { ...AGENT_RECORD, merchant_id: "mkt_other" };
    const indexUnderTest = index({
      listings: { results: [LISTING_RESULT], next_cursor: null },
      agents: { results: [mismatched], next_cursor: null },
    });
    expect(await indexUnderTest.resolveById(MERCHANT)).toBeUndefined();
  });
});

describe("受门禁商家不得静默直连 / 中继契约", () => {
  it("缺访问传输时 fail-closed，且完全不发出直连请求", async () => {
    const { dir, options } = protocolOptions();
    const hits: string[] = [];
    try {
      const fetcher = new A2AQuoteFetcher({
        ...options,
        allowPrivateRanges: true,
        skipDnsCheck: true,
        fetchImpl: (async (input: string | URL | Request) => {
          hits.push(String(input));
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
        merchantAccess: {
          forEndpoint: async () => null,
          forMerchant: async () => null,
        },
      });
      const results = await fetcher.requestQuotes(INTENT, [{
        merchant_id: MERCHANT,
        name: "门禁商家",
        verified: true,
        capabilities: [],
        catalog_agent_id: AGENT,
        agent_card_url: CARD,
        runtime_access: RUNTIME_ACCESS,
      }], context());
      expect(results[0]?.failure?.classification).toBe("access_unavailable");
      expect(hits).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("中继把上游 403 翻译为 502 JSON：买家按 502 归类，不误报 403", async () => {
    const { dir, options } = protocolOptions();
    const hits: string[] = [];
    try {
      const relayFetch = createOpenInquiryTransport({
        catalogOrigin: CATALOG, catalogAgentId: AGENT, merchantEndpoint: ENDPOINT,
        fetchImpl: (async (input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
          hits.push(String(input));
          const body = JSON.parse(String(init?.body ?? "{}")) as { id?: unknown };
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "商家服务暂不可用，请稍后重试" },
          }, { status: 502 });
        }) as typeof fetch,
      });
      const fetcher = new A2AQuoteFetcher({
        ...options,
        allowPrivateRanges: true,
        skipDnsCheck: true,
        merchantAccess: {
          forEndpoint: async () => null,
          forMerchant: async () => ({
            sendUrlFor: (url: string) => url,
            openInquiry: { endpoint: ENDPOINT, signer: new OpenInquirySessionSigner(), fetchImpl: relayFetch },
          }),
        },
      });
      const results = await fetcher.requestQuotes(INTENT, [{
        merchant_id: MERCHANT,
        name: "门禁商家",
        verified: true,
        capabilities: [],
        catalog_agent_id: AGENT,
        agent_card_url: CARD,
        runtime_access: RUNTIME_ACCESS,
      }], context());
      expect(hits).toEqual([RELAY]);
      // 中继把上游 403 收敛为 502 JSON-RPC 错误；买家只看到"结果未确认"，
      // 不再是上游 403 的非 JSON 响应。
      expect(results[0]?.failure?.classification).toBe("protocol_error");
      expect(results[0]?.failure?.retryable).toBe(false);
      expect(results[0]?.failure?.detail).not.toContain("403");
      expect(results[0]?.failure?.detail).toBe(
        "protocol operation has no confirmed result and may already have executed; only existing receipt polling is allowed",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("恢复用路线提示保留同一商家身份（agentId/merchantId/endpoint）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "open-inquiry-routes-"));
    try {
      const store = new OpenInquiryRouteStore(dir, "https://catalog.kiwi.harrylabsj.com");
      store.remember({ agentId: AGENT, merchantId: MERCHANT, endpoint: ENDPOINT });
      expect(store.get(ENDPOINT)).toEqual({ agentId: AGENT, merchantId: MERCHANT, endpoint: ENDPOINT });
      expect(() => store.remember({ agentId: "cagt_other", merchantId: "mkt_other", endpoint: ENDPOINT })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
