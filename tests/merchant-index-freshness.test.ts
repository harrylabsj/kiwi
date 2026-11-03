/**
 * 买家端在线状态：listing 首命中、owner 回查与 resolveById 必须保留
 * agent.freshness_state，stale 商家不能被当成在线；正常 fresh 商家保持兼容。
 */
import { describe, expect, it } from "vitest";

import { KiwiCatalogMerchantIndex } from "../src/buyer-core/merchant-index.js";

const CATALOG = "https://catalog.example";
const MERCHANT = "mkt_fresh_1";
const AGENT = "cagt_fresh_1";
const NOW = "2026-11-03T00:00:00+00:00";

function agentRecord(freshness: "fresh" | "stale" | "unreachable") {
  return {
    catalog_agent_id: AGENT,
    principal_type: "merchant" as const,
    merchant_id: MERCHANT,
    display_name: "在线状态商家",
    canonical_domain: "merchant.example",
    hosting_mode: "direct" as const,
    verification_level: "commerce_verified" as const,
    freshness_state: freshness,
    administrative_state: "active" as const,
    created_at: NOW,
    updated_at: NOW,
    agent_card_url: `${CATALOG}/v1/agents/${AGENT}/agent-card.json`,
    capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"],
    runtime_access: {
      provider: "workbuddy" as const,
      access_mode: "share_parameter" as const,
      parameter_name: "sharecode" as const,
      config_version: 1,
      adapter_version: "workbuddy-share-v1" as const,
      auth_mode: "signature" as const,
    },
  };
}

function listingResult(freshness: "fresh" | "stale" | "unreachable") {
  return {
    listing: {
      listing_id: "lst_fresh_1",
      listing_type: "product" as const,
      owner_agent_id: AGENT,
      merchant_id: MERCHANT,
      title: "测试商品",
      category: "个护",
      regions: ["华东"],
      commercial_hints: { lead_time_hint: "华东 1-2天" },
      listing_digest: "a".repeat(64),
      publication_state: "ACTIVE" as const,
      listing_freshness_state: "FRESH" as const,
      published_at: NOW,
      updated_at: NOW,
      fresh_until: NOW,
      source_product_ref: "SKU-FRESH-1",
    },
    merchant: { merchant_id: MERCHANT, display_name: "在线状态商家" },
    agent: {
      catalog_agent_id: AGENT,
      verification_level: "commerce_verified" as const,
      freshness_state: freshness,
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

function catalogFetch(routes: Routes) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
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

function index(routes: Routes) {
  return new KiwiCatalogMerchantIndex({
    baseUrl: CATALOG,
    fetchImpl: catalogFetch(routes),
  });
}

describe("KiwiCatalogMerchantIndex：在线状态传播", () => {
  it("listing 首命中 + owner 回查 stale：保留 stale，不标可实时询价", async () => {
    const indexUnderTest = index({
      listings: [listingResult("stale")],
      agents: [],
      agentsById: { [AGENT]: agentRecord("stale") },
    });
    const [record] = await indexUnderTest.search("测试商品");
    expect(record?.agent_card_url).toBe(`${CATALOG}/v1/agents/${AGENT}/agent-card.json`);
    expect(record?.freshness_state).toBe("stale");
    expect(record?.inquiry_available).toBe(false);
  });

  it("agent 合并 stale 覆盖 listing 首命中的 fresh：不标可实时询价", async () => {
    const indexUnderTest = index({
      listings: [listingResult("fresh")],
      agents: [agentRecord("stale")],
      agentsById: { [AGENT]: agentRecord("stale") },
    });
    const [record] = await indexUnderTest.search("测试商品");
    expect(record?.freshness_state).toBe("stale");
    expect(record?.inquiry_available).toBe(false);
  });

  it("resolveById listing + agent stale：按 ID 回查也不标可实时询价", async () => {
    const indexUnderTest = index({
      listings: [listingResult("stale")],
      agents: [agentRecord("stale")],
      agentsById: { [AGENT]: agentRecord("stale") },
    });
    const record = await indexUnderTest.resolveById(MERCHANT);
    expect(record?.agent_card_url).toBeDefined();
    expect(record?.freshness_state).toBe("stale");
    expect(record?.inquiry_available).toBe(false);
  });

  it("恢复路径（resolveById 仅 owner 回查）stale：不标可实时询价", async () => {
    const indexUnderTest = index({
      listings: [listingResult("stale")],
      agents: [],
      agentsById: { [AGENT]: agentRecord("stale") },
    });
    const record = await indexUnderTest.resolveById(MERCHANT);
    expect(record?.agent_card_url).toBeDefined();
    expect(record?.freshness_state).toBe("stale");
    expect(record?.inquiry_available).toBe(false);
  });

  it("只命中 agent 的 stale resolveById：不标可实时询价", async () => {
    const indexUnderTest = index({
      agents: [agentRecord("stale")],
      agentsById: { [AGENT]: agentRecord("stale") },
    });
    const record = await indexUnderTest.resolveById(MERCHANT);
    expect(record?.freshness_state).toBe("stale");
    expect(record?.inquiry_available).toBe(false);
  });

  it("正常 fresh 商家保持可实时询价（兼容）", async () => {
    const indexUnderTest = index({
      listings: [listingResult("fresh")],
      agents: [],
      agentsById: { [AGENT]: agentRecord("fresh") },
    });
    const [record] = await indexUnderTest.search("测试商品");
    expect(record?.freshness_state).toBe("fresh");
    expect(record?.inquiry_available).toBe(true);
  });
});
