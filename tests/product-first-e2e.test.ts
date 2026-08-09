/**
 * Product-first E2E（rev1.5 CD #28：Need → Listing Search → Merchant Agent →
 * Direct A2A → KNP Offer）。
 *
 * 覆盖：
 * - KiwiCatalogSource.searchListings 消费 /v1/listings/search：stub 响应必须
 *   过 validateListingSearchResult（防 stub 与 schema 漂移）；
 * - 结果形状：authority=discovery_projection / requires_direct_confirmation=true
 *   （CD #24）、owner_agent_id 绑定（CD #23）；
 * - negotiateWithAgent 注入 KiwiCatalogSource（CD #27）：listing →
 *   owner_agent_id → getRecord → resolveViaCatalog fresh verify（真实拉取
 *   merchant Agent Card）→ Direct A2A → KNP Offer，价格来自 merchant
 *   productSource 桩（Source-of-Truth boundary：catalog hint ≠ Offer）；
 * - 两域 freshness 独立组合（v0.4 DoD #11 / CD #25）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { KiwiCatalogSource, validateListingSearchResult } from "../src/discovery/index.js";
import { negotiateWithAgent } from "../src/a2a/negotiate.js";
import { startTestA2aStack, type CapturedInbound } from "./helpers.js";

const capture: CapturedInbound[] = [];

afterEach(async () => {
  capture.length = 0;
});

/** 商家商品库桩：sku-001 报价 99.00 元（真实价在商家侧，catalog hint 不权威）。 */
const productSource = {
  async getProduct(sku: string) {
    const prices: Record<string, { price: number; currency: string }> = {
      "sku-001": { price: 99, currency: "CNY" },
    };
    const p = prices[sku];
    if (p === undefined) throw new Error(`no product ${sku}`);
    return p;
  },
};

describe("product-first discovery E2E (CD #28)", () => {
  it("listing stub passes schema validation and carries CD #24 constants", async () => {
    const s = await startTestA2aStack({ productSource, capture });
    try {
      const source = new KiwiCatalogSource({ baseUrl: s.catalogUrl });
      const results = await source.searchListings({ q: "Test" });
      expect(results.length).toBe(1);
      // stub 与 schema 防漂移：每个结果过契约校验（失败即契约破坏）
      for (const result of results) {
        expect(validateListingSearchResult(result).listing.listing_id).toBe(result.listing.listing_id);
      }
      const first = results[0]!;
      expect(first.authority).toBe("discovery_projection");
      expect(first.requires_direct_confirmation).toBe(true);
      expect(first.listing.owner_agent_id).toBe("cagt_test_merchant_001");
      expect(first.listing.listing_type).toBe("product");
    } finally {
      await s.stop();
    }
  });

  it("search_listings → owner_agent_id → negotiateWithAgent reaches KNP Offer with merchant-side price", async () => {
    const s = await startTestA2aStack({ productSource, capture });
    try {
      const source = new KiwiCatalogSource({ baseUrl: s.catalogUrl });
      const results = await source.searchListings({ q: "Test" });
      expect(results.length).toBe(1);
      const first = results[0];
      expect(first).toBeDefined();
      const ownerAgentId = first!.agent.catalog_agent_id;

      const outcome = await negotiateWithAgent({
        catalog: s.catalogUrl,
        allowLoopback: true, // 本地 127.0.0.1 测试栈
        catalogSource: source,
        catalogAgentId: ownerAgentId,
        sku: "sku-001",
        dealPriceMinor: 8_500,
      });
      expect(outcome.ok).toBe(true);
      // Direct A2A + KNP Offer：Offer 价格来自 merchant productSource 桩
      // （99.00 元 = 9900 minor），不是 catalog hint——Source-of-Truth boundary
      expect(outcome.facts?.offerPriceMinor).toBe(9_900);
      expect(outcome.facts?.sku).toBe("sku-001");
    } finally {
      await s.stop();
    }
  });

  it("listing freshness and agent freshness vary independently (DoD #11 / CD #25)", async () => {
    const s = await startTestA2aStack({ productSource, capture });
    try {
      const source = new KiwiCatalogSource({ baseUrl: s.catalogUrl });
      // stub 默认组合：listing FRESH + agent fresh（合法，两域独立变化——DoD #11）
      const results = await source.searchListings({});
      expect(results.length).toBe(1);
      const fresh = results[0];
      expect(fresh).toBeDefined();
      expect(fresh!.listing.listing_freshness_state).toBe("FRESH");
      expect(fresh!.agent.freshness_state).toBe("fresh");
      // 词汇隔离（listing 大写两值 / agent 小写三值、无交集）由
      // listing-contracts.test.ts 词表契约测试锁定，此处只验证 stub 组合合法
    } finally {
      await s.stop();
    }
  });
});
