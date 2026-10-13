import { describe, expect, it } from "vitest";
import type { MerchantClient, MerchantCatalogProduct } from "../src/agent/merchant/types.js";
import { parseMerchantCatalogProduct } from "../src/agent/merchant/types.js";
import { MerchantClientCommerceDataSource } from "../src/merchant-core/rfq/data-source-adapter.js";

function fixture() {
  let now = "2026-10-13T00:00:00Z";
  let price = 0;
  let unit = "box";
  let stock: number | undefined = 10;
  const client = {
    async getProduct(): Promise<MerchantCatalogProduct> {
      return parseMerchantCatalogProduct({ sku: "OWNED", merchant_id: "merchant-owned", title: "Owned fixture", currency: "CNY", price, unit, stock });
    },
    async getInventorySnapshot() { return { sku: "OWNED", stock, unit, observed_at: now }; },
  } as unknown as MerchantClient;
  const source = new MerchantClientCommerceDataSource({ client, merchantId: "merchant-owned", priceUnit: "yuan", now: () => now });
  return { source, price: (value: number) => { price = value; }, unit: (value: string) => { unit = value; }, stock: (value: number | undefined) => { stock = value; }, now: (value: string) => { now = value; } };
}

describe("actual source adapter precision and truthful content observations", () => {
  it("admits zero, rejects sub-minor price without rounding", async () => {
    const f = fixture(); expect((await f.source.getPrice("OWNED"))?.value.amount_minor).toBe(0);
    f.price(85.005); await expect(f.source.getPrice("OWNED")).rejects.toMatchObject({ code: "invalid_input" });
    f.price(85.01); expect((await f.source.getPrice("OWNED"))?.value.amount_minor).toBe(8501);
  });
  it("content-derived price version excludes read time and changes with real unit/price", async () => {
    const f = fixture(); const original = await f.source.getPrice("OWNED");
    expect(original?.source_version).toMatch(/^adapter-content-v1:sha256:/);
    f.now("2026-10-13T00:00:30Z"); const later = await f.source.getPrice("OWNED"); expect(later?.source_version).toBe(original?.source_version); expect(later?.verified_at).not.toBe(original?.verified_at);
    f.unit("kg"); expect((await f.source.getPrice("OWNED"))?.source_version).not.toBe(original?.source_version);
  });
  it("inventory observation version is value based, and unknown remains absent", async () => {
    const f = fixture(); const original = await f.source.getInventory("OWNED"); expect(original?.source_version).toMatch(/^inventory-content-v1:sha256:/);
    f.now("2026-10-13T00:00:30Z"); expect((await f.source.getInventory("OWNED"))?.source_version).toBe(original?.source_version);
    f.stock(9); expect((await f.source.getInventory("OWNED"))?.source_version).not.toBe(original?.source_version);
    f.stock(undefined); expect(await f.source.getInventory("OWNED")).toBeUndefined();
  });
});
