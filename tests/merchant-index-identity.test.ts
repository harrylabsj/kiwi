/**
 * 同一 merchant_id 下多个商家应用（catalog_agent_id）的合并身份一致性。
 *
 * 商品可以并列，但 card/runtime_access/门禁投影只能来自唯一确定的 agent；
 * 冲突时 fail-closed；resolveById 仍优先选择 listing 的实际 owner，并在
 * 无法唯一确定时返回 undefined；owner 信息缺失时保留商品但不编造路由。
 */
import { describe, expect, it } from "vitest";

import { KiwiCatalogMerchantIndex } from "../src/buyer-core/merchant-index.js";

const CATALOG = "https://catalog.example";
const MERCHANT = "mkt_test_1";
const AGENT_A = "cagt_agent_a";
const AGENT_B = "cagt_agent_b";
const NOW = "2026-11-03T00:00:00+00:00";

type RuntimeAccessFixture = {
  provider: "workbuddy";
  access_mode: "share_parameter";
  parameter_name: "sharecode";
  config_version: number;
  adapter_version: "workbuddy-share-v1";
  auth_mode: "signature";
};

const RUNTIME_ACCESS_A: RuntimeAccessFixture = {
  provider: "workbuddy",
  access_mode: "share_parameter",
  parameter_name: "sharecode",
  config_version: 1,
  adapter_version: "workbuddy-share-v1",
  auth_mode: "signature",
};
const RUNTIME_ACCESS_B: RuntimeAccessFixture = {
  ...RUNTIME_ACCESS_A,
  config_version: 2,
};

function agentRecord(
  agentId: string,
  merchantId: string,
  runtimeAccess: RuntimeAccessFixture | undefined,
) {
  return {
    catalog_agent_id: agentId,
    principal_type: "merchant" as const,
    merchant_id: merchantId,
    display_name: `商家应用 ${agentId}`,
    canonical_domain: "merchant.example",
    hosting_mode: "direct" as const,
    verification_level: "commerce_verified" as const,
    freshness_state: "fresh" as const,
    administrative_state: "active" as const,
    created_at: NOW,
    updated_at: NOW,
    agent_card_url: `${CATALOG}/v1/agents/${agentId}/agent-card.json`,
    capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"],
    ...(runtimeAccess !== undefined ? { runtime_access: runtimeAccess } : {}),
  };
}

function listingResult(ownerAgentId: string, merchantId: string, sku: string) {
  return {
    listing: {
      listing_id: `lst_${sku}`,
      listing_type: "product" as const,
      owner_agent_id: ownerAgentId,
      merchant_id: merchantId,
      title: `测试商品 ${sku}`,
      category: "个护",
      regions: ["华东"],
      commercial_hints: { lead_time_hint: "华东 1-2天" },
      listing_digest: "a".repeat(64),
      publication_state: "ACTIVE" as const,
      listing_freshness_state: "FRESH" as const,
      published_at: NOW,
      updated_at: NOW,
      fresh_until: NOW,
      source_product_ref: sku,
    },
    merchant: { merchant_id: merchantId, display_name: "同一商家" },
    agent: {
      catalog_agent_id: ownerAgentId,
      verification_level: "commerce_verified" as const,
      freshness_state: "fresh" as const,
      administrative_state: "active" as const,
    },
    listing_freshness_state: "FRESH" as const,
    authority: "discovery_projection" as const,
    requires_direct_confirmation: true as const,
  };
}

type Routes = {
  listings?: unknown[];
  agents?: unknown[];
  publications?: unknown[];
  agentsById?: Record<string, unknown>;
};

function catalogFetch(routes: Routes, calls: string[] = []) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === "/v1/listings/search") {
      return Response.json({ results: routes.listings ?? [], next_cursor: null });
    }
    if (url.pathname === "/v1/agents/search") {
      return Response.json({ results: routes.agents ?? [], next_cursor: null });
    }
    if (url.pathname === "/v1/merchant-publications/search") {
      return Response.json({ results: routes.publications ?? [], next_cursor: null });
    }
    if (url.pathname.startsWith("/v1/agents/")) {
      const agentId = url.pathname.split("/")[3] ?? "";
      const record = routes.agentsById?.[agentId];
      return record === undefined
        ? Response.json({ ok: false, error: "not found" }, { status: 404 })
        : Response.json({ agent: record });
    }
    return Response.json({});
  }) as typeof fetch;
}

function index(routes: Routes, calls: string[] = []) {
  return new KiwiCatalogMerchantIndex({
    baseUrl: CATALOG,
    fetchImpl: catalogFetch(routes, calls),
  });
}

describe("KiwiCatalogMerchantIndex：多商家应用身份一致性", () => {
  it("同一 merchant_id 的两条 listing 来自不同应用：商品并列但路由/门禁 fail-closed", async () => {
    const indexUnderTest = index({
      listings: [
        listingResult(AGENT_A, MERCHANT, "SKU-A"),
        listingResult(AGENT_B, MERCHANT, "SKU-B"),
      ],
      agentsById: {
        [AGENT_A]: agentRecord(AGENT_A, MERCHANT, RUNTIME_ACCESS_A),
        [AGENT_B]: agentRecord(AGENT_B, MERCHANT, RUNTIME_ACCESS_B),
      },
    });
    const [record] = await indexUnderTest.search("测试商品");
    expect(record?.merchant_id).toBe(MERCHANT);
    expect(record?.products).toHaveLength(2);
    expect(record?.matching_skus).toEqual(["SKU-A", "SKU-B"]);
    expect(record?.catalog_agent_id).toBeUndefined();
    expect(record?.agent_card_url).toBeUndefined();
    expect(record?.runtime_access).toBeUndefined();
    expect(record?.inquiry_available).toBe(false);
    expect(record?.capabilities).toEqual([]);
    expect(record?.verified).toBe(false);
  });

  it("listing owner A + agents 合并命中 B：不把 B 的 card/门禁挂到 A 的商品上", async () => {
    const indexUnderTest = index({
      listings: [listingResult(AGENT_A, MERCHANT, "SKU-A")],
      agents: [agentRecord(AGENT_B, MERCHANT, RUNTIME_ACCESS_B)],
      agentsById: {
        [AGENT_A]: agentRecord(AGENT_A, MERCHANT, RUNTIME_ACCESS_A),
      },
    });
    const [record] = await indexUnderTest.search("测试商品");
    expect(record?.merchant_id).toBe(MERCHANT);
    expect(record?.catalog_agent_id).toBeUndefined();
    expect(record?.agent_card_url).toBeUndefined();
    expect(record?.runtime_access).toBeUndefined();
    expect(record?.inquiry_available).toBe(false);
  });

  it("resolveById 优先选 listing 的实际 owner，不被列表里另一个应用顶替", async () => {
    const indexUnderTest = index({
      listings: [listingResult(AGENT_A, MERCHANT, "SKU-A")],
      // 另一个应用排在前面；必须以 listing.owner 为准回退到 A。
      agents: [
        agentRecord(AGENT_B, MERCHANT, RUNTIME_ACCESS_B),
        agentRecord(AGENT_A, MERCHANT, RUNTIME_ACCESS_A),
      ],
      agentsById: {
        [AGENT_A]: agentRecord(AGENT_A, MERCHANT, RUNTIME_ACCESS_A),
      },
    });
    const record = await indexUnderTest.resolveById(MERCHANT);
    expect(record?.catalog_agent_id).toBe(AGENT_A);
    expect(record?.runtime_access).toEqual(RUNTIME_ACCESS_A);
    expect(record?.agent_card_url).toContain(AGENT_A);
  });

  it("resolveById 无 listing 且同一商家有多个不同应用：身份不唯一，fail-closed", async () => {
    const indexUnderTest = index({
      agents: [
        agentRecord(AGENT_A, MERCHANT, RUNTIME_ACCESS_A),
        agentRecord(AGENT_B, MERCHANT, RUNTIME_ACCESS_B),
      ],
    });
    expect(await indexUnderTest.resolveById(MERCHANT)).toBeUndefined();
  });

  it("resolveById 同一商家多条 listing 分属不同应用：身份不唯一，fail-closed", async () => {
    const indexUnderTest = index({
      listings: [
        listingResult(AGENT_A, MERCHANT, "SKU-A"),
        listingResult(AGENT_B, MERCHANT, "SKU-B"),
      ],
      agents: [
        agentRecord(AGENT_A, MERCHANT, RUNTIME_ACCESS_A),
        agentRecord(AGENT_B, MERCHANT, RUNTIME_ACCESS_B),
      ],
    });
    expect(await indexUnderTest.resolveById(MERCHANT)).toBeUndefined();
  });

  it("owner 信息缺失：保留商品但不编造 card/runtime_access", async () => {
    const indexUnderTest = index({
      listings: [listingResult(AGENT_A, MERCHANT, "SKU-A")],
      agents: [],
      // 没有 agentById：getRecord 404。
    });
    const [record] = await indexUnderTest.search("测试商品");
    expect(record?.merchant_id).toBe(MERCHANT);
    expect(record?.products).toHaveLength(1);
    expect(record?.agent_card_url).toBeUndefined();
    expect(record?.runtime_access).toBeUndefined();
    expect(record?.inquiry_available).toBe(false);
  });

  it("listing 自报 owner 与 join 的 agent 不一致：不采用任一应用的门禁身份", async () => {
    const mismatched = listingResult(AGENT_A, MERCHANT, "SKU-A");
    // 模拟上游 join 错位：listing.owner=A，但 join 出来的 agent 投影=B。
    mismatched.agent.catalog_agent_id = AGENT_B;
    const indexUnderTest = index({
      listings: [mismatched],
      agents: [],
      agentsById: {
        [AGENT_A]: agentRecord(AGENT_A, MERCHANT, RUNTIME_ACCESS_A),
        [AGENT_B]: agentRecord(AGENT_B, MERCHANT, RUNTIME_ACCESS_B),
      },
    });
    const [record] = await indexUnderTest.search("测试商品");
    expect(record?.catalog_agent_id).toBeUndefined();
    expect(record?.agent_card_url).toBeUndefined();
    expect(record?.runtime_access).toBeUndefined();
    expect(record?.inquiry_available).toBe(false);
  });
});
