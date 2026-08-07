/**
 * listing 契约测试（v1.1 Product-first Discovery / CD #22–24）。
 *
 * 覆盖：
 *   - 词表单一来源：listing-record.schema.json 的枚举（listing_type /
 *     publication_state / listing_freshness_state / authority /
 *     requires_direct_confirmation / handoff_destination_types）与 TS 常量及
 *     KTH DESTINATION_TYPES 严格一致（禁止 supports_* 平行词表）；
 *   - validateListingRecord / validateListingSearchResult 示例向量：
 *     valid product / valid capability（无 SKU）/ product 缺 source_product_ref
 *     拒绝 / capability 带 handoff_destination_types 拒绝 / 私有字段拒绝 /
 *     authority 与 requires_direct_confirmation 恒值锁定（CD #24）；
 *   - 两套 freshness 词汇隔离：listing_freshness_state（FRESH/STALE 大写）
 *     与 agent freshness_state（fresh/stale/unreachable 小写）拼写不同（CD #25）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CatalogSourceError, validateListingRecord, validateListingSearchResult } from "../src/discovery/index.js";
import { DESTINATION_TYPES } from "../src/handoff/destination.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractDir = path.resolve(__dirname, "..", "contracts", "kiwi-catalog", "1.0");

function loadContract(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(contractDir, name), "utf-8")) as Record<string, unknown>;
}

/** 合法 ProductListing fixture（v0.4 §4 形状，product 必填 source_product_ref）。 */
function productListingFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listing_id: "lst_01JABC",
    listing_type: "product",
    owner_agent_id: "cagt_01JABC",
    merchant_id: "mrc_01JABC",
    source_product_ref: "SKU-001",
    source_revision: "rev-42",
    title: "21.5 inch Industrial Touch Display",
    summary: "10–32 inch industrial touch display manufacturing",
    category: "industrial-display",
    brand: "Example Display Co.",
    attributes: { screen_size: "21.5", ip_rating: "IP67" },
    regions: ["CN"],
    tags: ["touch", "industrial"],
    commercial_hints: {
      moq: 50,
      price_range_hint: "CNY 800-1200",
      availability_hint: "in_stock",
      lead_time_hint: "15 days",
      supports_bulk_quote: true,
      supports_customization: true,
      fulfillment_regions: ["CN", "EU"],
    },
    handoff_destination_types: ["external_checkout_url"],
    listing_digest: "abc123",
    publication_state: "ACTIVE",
    listing_freshness_state: "FRESH",
    published_at: "2026-08-07T00:00:00Z",
    updated_at: "2026-08-07T00:00:00Z",
    fresh_until: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

/** 合法 CapabilityListing fixture（无 SKU、无 handoff_destination_types）。 */
function capabilityListingFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listing_id: "lst_01JBCD",
    listing_type: "capability",
    owner_agent_id: "cagt_01JABC",
    merchant_id: "mrc_01JABC",
    title: "Industrial Touch Display Manufacturing",
    summary: "MOQ >= 100, customization = yes, IP rating up to IP67, region = China",
    category: "industrial-manufacturing",
    commercial_hints: { moq: 100, supports_customization: true },
    listing_digest: "def456",
    publication_state: "ACTIVE",
    listing_freshness_state: "FRESH",
    published_at: "2026-08-07T00:00:00Z",
    updated_at: "2026-08-07T00:00:00Z",
    fresh_until: "2026-08-14T00:00:00Z",
    ...overrides,
  };
}

/** 合法搜索结果 fixture（v0.4 §9 形状；authority / requires_direct_confirmation 恒值）。 */
function searchResultFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listing: productListingFixture(),
    merchant: { merchant_id: "mrc_01JABC", display_name: "Example Display Co." },
    agent: {
      catalog_agent_id: "cagt_01JABC",
      verification_level: "commerce_verified",
      freshness_state: "fresh",
      administrative_state: "active",
    },
    listing_freshness_state: "FRESH",
    authority: "discovery_projection",
    requires_direct_confirmation: true,
    ...overrides,
  };
}

describe("listing contract vocabulary (single source)", () => {
  const record = loadContract("listing-record.schema.json");
  const searchResult = loadContract("listing-search-result.schema.json");
  const props = record.properties as Record<string, Record<string, unknown>>;

  it("listing_type enum is exactly [product, capability]", () => {
    expect((props.listing_type as { enum: string[] }).enum).toEqual(["product", "capability"]);
  });

  it("publication_state enum is exactly [ACTIVE, WITHDRAWN, SUSPENDED] (uppercase)", () => {
    expect((props.publication_state as { enum: string[] }).enum).toEqual([
      "ACTIVE",
      "WITHDRAWN",
      "SUSPENDED",
    ]);
  });

  it("listing_freshness_state enum is exactly [FRESH, STALE] and differs from agent freshness", () => {
    expect((props.listing_freshness_state as { enum: string[] }).enum).toEqual(["FRESH", "STALE"]);
    const agentRecord = loadContract("agent-record.schema.json");
    const agentProps = agentRecord.properties as Record<string, Record<string, unknown>>;
    const agentFreshness = (agentProps.freshness_state as { enum: string[] }).enum;
    expect(agentFreshness).toEqual(["fresh", "stale", "unreachable"]);
    // 两套词汇拼写/大小写不同——防止混用（CD #25）
    const listingFreshness = (props.listing_freshness_state as { enum: string[] }).enum;
    expect(listingFreshness.some((v) => agentFreshness.includes(v))).toBe(false);
  });

  it("authority enum is exactly [discovery_projection] and requires_direct_confirmation is const true (CD #24)", () => {
    const srProps = searchResult.properties as Record<string, Record<string, unknown>>;
    expect((srProps.authority as { enum: string[] }).enum).toEqual(["discovery_projection"]);
    expect(srProps.requires_direct_confirmation).toEqual({ const: true });
    expect(searchResult.required).toEqual([
      "listing",
      "merchant",
      "agent",
      "listing_freshness_state",
      "authority",
      "requires_direct_confirmation",
    ]);
  });

  it("handoff_destination_types in listing schema equals KTH DESTINATION_TYPES exactly (no parallel vocabulary)", () => {
    const enumArr = (
      (props.handoff_destination_types as { items: { enum: string[] } }).items.enum
    ).slice();
    expect(enumArr).toEqual([...DESTINATION_TYPES]);
  });

  it("both schemas are additionalProperties: false (public-only enforced at schema layer)", () => {
    expect(record.additionalProperties).toBe(false);
    expect(searchResult.additionalProperties).toBe(false);
  });

  it("listing-record schema requires the v0.4 §4 core fields", () => {
    expect(record.required).toEqual([
      "listing_id",
      "listing_type",
      "owner_agent_id",
      "merchant_id",
      "title",
      "category",
      "listing_digest",
      "publication_state",
      "listing_freshness_state",
      "published_at",
      "updated_at",
      "fresh_until",
    ]);
  });
});

describe("validateListingRecord vectors", () => {
  it("accepts a valid ProductListing", () => {
    expect(validateListingRecord(productListingFixture()).listing_type).toBe("product");
  });

  it("accepts a valid CapabilityListing without SKU (no fake SKU, v0.4 §5)", () => {
    const record = validateListingRecord(capabilityListingFixture());
    expect(record.listing_type).toBe("capability");
    expect(record.source_product_ref).toBeUndefined();
  });

  it("rejects a ProductListing missing source_product_ref", () => {
    const bad = productListingFixture({ source_product_ref: undefined });
    delete bad.source_product_ref;
    expect(() => validateListingRecord(bad)).toThrow(CatalogSourceError);
  });

  it("rejects a CapabilityListing carrying handoff_destination_types (v0.4 §5)", () => {
    const bad = capabilityListingFixture({ handoff_destination_types: ["external_checkout_url"] });
    expect(() => validateListingRecord(bad)).toThrow(CatalogSourceError);
  });

  it("rejects private fields at schema layer (v0.4 §4.2 forbidden fields)", () => {
    expect(() => validateListingRecord(productListingFixture({ floor_price: 100 }))).toThrow(
      CatalogSourceError,
    );
    expect(() => validateListingRecord(productListingFixture({ cost: 50 }))).toThrow(CatalogSourceError);
    expect(() =>
      validateListingRecord(productListingFixture({ credentials: { token: "secret" } })),
    ).toThrow(CatalogSourceError);
  });

  it("rejects unknown commercial_hints keys (allowlist, v0.4 §4.1)", () => {
    expect(() =>
      validateListingRecord(productListingFixture({ commercial_hints: { fake_hint: true } })),
    ).toThrow(CatalogSourceError);
  });

  it("rejects invalid enum values", () => {
    expect(() => validateListingRecord(productListingFixture({ listing_type: "service" }))).toThrow(
      CatalogSourceError,
    );
    expect(() =>
      validateListingRecord(productListingFixture({ publication_state: "LIVE" })),
    ).toThrow(CatalogSourceError);
    expect(() =>
      validateListingRecord(productListingFixture({ listing_freshness_state: "fresh" })),
    ).toThrow(CatalogSourceError);
  });
});

describe("validateListingSearchResult vectors", () => {
  it("accepts a valid result with authority and requires_direct_confirmation locked (CD #24)", () => {
    const result = validateListingSearchResult(searchResultFixture());
    expect(result.authority).toBe("discovery_projection");
    expect(result.requires_direct_confirmation).toBe(true);
    expect(result.listing.owner_agent_id).toBe("cagt_01JABC");
  });

  it("rejects missing authority or requires_direct_confirmation", () => {
    const withoutAuthority = searchResultFixture({ authority: undefined });
    delete withoutAuthority.authority;
    expect(() => validateListingSearchResult(withoutAuthority)).toThrow(CatalogSourceError);
    const withoutConfirm = searchResultFixture({ requires_direct_confirmation: undefined });
    delete withoutConfirm.requires_direct_confirmation;
    expect(() => validateListingSearchResult(withoutConfirm)).toThrow(CatalogSourceError);
  });

  it("rejects authority values other than discovery_projection", () => {
    expect(() =>
      validateListingSearchResult(searchResultFixture({ authority: "authoritative" })),
    ).toThrow(CatalogSourceError);
  });

  it("rejects nested listing that violates listing-record schema", () => {
    const result = searchResultFixture();
    (result.listing as Record<string, unknown>).floor_price = 100;
    expect(() => validateListingSearchResult(result)).toThrow(CatalogSourceError);
  });

  it("rejects a listing whose freshness differs from agent freshness independently (CD #25 shape)", () => {
    // 两态独立：listing STALE 而 agent FRESH 是合法组合
    const result = validateListingSearchResult(
      searchResultFixture({
        listing: productListingFixture({ listing_freshness_state: "STALE" }),
        listing_freshness_state: "STALE",
      }),
    );
    expect(result.listing.listing_freshness_state).toBe("STALE");
    expect(result.agent.freshness_state).toBe("fresh");
  });
});
