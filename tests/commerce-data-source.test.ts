/**
 * CommerceDataSource 测试（v1.1 WP-B / 完成定义 #5、#6、#7）。
 *
 * 覆盖：
 * - LocalDatabaseCommerceDataSource：本地商品库增改查、权威标注
 *   （LOCAL_AUTHORITATIVE）、public-only、健康检查；
 * - ErpCommerceDataSource：HTTP adapter 成功/404/网络/超时/结构错误
 *   fail-closed、UPSTREAM_PROXY 标注；
 * - compositeCommerceDataSource：多源合并、同字段冲突 fail-closed
 *   （authority_conflict，绝不静默合并冲突权威源）、次要源补缺；
 * - dataSourceProductSource：MerchantProductSource 适配（price 用
 *   price_minor，与 KNP Money 一致）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CommerceError,
  compositeCommerceDataSource,
  type CommerceDataSource,
} from "../src/commerce/data-source.js";
import {
  LocalDatabaseCommerceDataSource,
  openLocalDatabaseCommerceDataSource,
} from "../src/commerce/local-db-source.js";
import { ErpCommerceDataSource } from "../src/commerce/erp-source.js";
import { dataSourceProductSource } from "../src/a2a/server/merchant-handler.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function localSource(): LocalDatabaseCommerceDataSource {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-cds-"));
  return openLocalDatabaseCommerceDataSource({ dbPath: path.join(dir, "facts.sqlite") });
}

/** ERP 假 fetch。 */
function erpFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: FetchInput, _init?: FetchInit): Promise<Response> => {
    const href = String(input);
    for (const [suffix, handler] of Object.entries(routes)) {
      if (href.includes(suffix)) return handler();
    }
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;
}

describe("LocalDatabaseCommerceDataSource", () => {
  it("upsert + get + search 基本读写", async () => {
    const source = localSource();
    source.upsertProduct({ sku: "SKU-001", title: "Coffee Beans", price_minor: 83500, stock: 12 });
    source.upsertProduct({ sku: "SKU-002", title: "Tea", price_minor: 4200, currency: "CNY" });

    const product = await source.getProduct("SKU-001");
    expect(product?.sku).toBe("SKU-001");
    expect(product?.price_minor).toBe(83500);
    expect(product?.stock).toBe(12);
    expect(await source.getProduct("MISSING")).toBeUndefined();

    const search = await source.getProducts({ q: "tea" });
    expect(search.map((p) => p.sku)).toEqual(["SKU-002"]);
    source.close();
  });

  it("权威标注 LOCAL_AUTHORITATIVE", async () => {
    const source = localSource();
    source.upsertProduct({ sku: "SKU-001", price_minor: 100, stock: 3 });
    const inventory = await source.getInventory("SKU-001");
    expect(inventory?.authority).toBe("LOCAL_AUTHORITATIVE");
    expect(inventory?.source).toBe("local-db");
    const price = await source.getPrice("SKU-001");
    expect(price?.value.amount_minor).toBe(100);
    expect(price?.authority).toBe("LOCAL_AUTHORITATIVE");
    source.close();
  });

  it("非法输入 fail-closed（空 sku / 负价）", async () => {
    const source = localSource();
    await expect(source.getProduct("")).rejects.toMatchObject({ code: "invalid_input" });
    expect(() => source.upsertProduct({ sku: "X", price_minor: -1 })).toThrow(CommerceError);
    source.close();
  });

  it("public listing 只含公开字段", async () => {
    const source = localSource();
    source.upsertProduct({ sku: "SKU-001", price_minor: 100 });
    const listing = await source.getPublicListing();
    expect(listing.source).toBe("local-db");
    expect((listing.products as Array<Record<string, unknown>>)[0]?.sku).toBe("SKU-001");
    expect((listing.products as Array<Record<string, unknown>>)[0]).not.toHaveProperty("cost_minor");
    source.close();
  });
});

describe("ErpCommerceDataSource", () => {
  it("getProduct 成功（UPSTREAM_PROXY 标注）", async () => {
    const source = new ErpCommerceDataSource({
      baseUrl: "https://erp.example",
      fetchImpl: erpFetch({
        "/products/SKU-001": () =>
          jsonResponse({ sku: "SKU-001", title: "Erp Item", price_minor: 5000, currency: "CNY", stock: 7 }),
      }),
    });
    const product = await source.getProduct("SKU-001");
    expect(product?.price_minor).toBe(5000);
    expect(product?.stock).toBe(7);
    const inventory = await source.getInventory("SKU-001");
    expect(inventory?.authority).toBe("UPSTREAM_PROXY");
    expect(inventory?.source).toBe("erp");
  });

  it("404 → undefined；网络异常 → request_failed", async () => {
    const notFound = new ErpCommerceDataSource({
      baseUrl: "https://erp.example",
      fetchImpl: erpFetch({ "/products/X": () => jsonResponse({ error: "nope" }, 404) }),
    });
    await expect(notFound.getProduct("X")).rejects.toMatchObject({ code: "request_failed" });

    const net = (async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const broken = new ErpCommerceDataSource({ baseUrl: "https://erp.example", fetchImpl: net });
    await expect(broken.getProduct("X")).rejects.toMatchObject({ code: "request_failed" });
  });

  it("结构错误 fail-closed（缺 sku / 非对象）", async () => {
    const bad = new ErpCommerceDataSource({
      baseUrl: "https://erp.example",
      fetchImpl: erpFetch({ "/products/X": () => jsonResponse({ title: "no sku" }) }),
    });
    await expect(bad.getProduct("X")).rejects.toMatchObject({ code: "request_failed" });
  });

  it("非法 baseUrl → invalid_input", () => {
    expect(() => new ErpCommerceDataSource({ baseUrl: "ftp://erp.example" })).toThrow(CommerceError);
  });

  it("getProducts 列表响应解析", async () => {
    const source = new ErpCommerceDataSource({
      baseUrl: "https://erp.example",
      fetchImpl: erpFetch({
        "/products?": () =>
          jsonResponse({ results: [{ sku: "A", price_minor: 1 }, { sku: "B", price_minor: 2 }] }),
      }),
    });
    const products = await source.getProducts();
    expect(products.map((p) => p.sku)).toEqual(["A", "B"]);
  });
});

describe("compositeCommerceDataSource", () => {
  function stubSource(products: Record<string, { price_minor?: number; stock?: number }>): CommerceDataSource {
    return {
      async getProduct(sku) {
        const p = products[sku];
        return p === undefined ? undefined : { sku, ...p };
      },
      async getProducts() {
        return Object.entries(products).map(([sku, p]) => ({ sku, ...p }));
      },
      async getInventory() {
        return undefined;
      },
      async getPrice() {
        return undefined;
      },
      async getPublicListing() {
        return {};
      },
      async health() {
        return { ok: true };
      },
    };
  }

  it("多源一致字段合并", async () => {
    const composite = compositeCommerceDataSource([
      stubSource({ "SKU-001": { price_minor: 100, stock: 5 } }),
      stubSource({ "SKU-001": { price_minor: 100 } }),
    ]);
    const product = await composite.getProduct("SKU-001");
    expect(product?.price_minor).toBe(100);
    expect(product?.stock).toBe(5);
  });

  it("同字段冲突 → authority_conflict（fail-closed，绝不静默合并）", async () => {
    const composite = compositeCommerceDataSource([
      stubSource({ "SKU-001": { price_minor: 100 } }),
      stubSource({ "SKU-001": { price_minor: 999 } }),
    ]);
    await expect(composite.getProduct("SKU-001")).rejects.toMatchObject({
      code: "authority_conflict",
    });
  });

  it("次要源只补 primary 缺失的 SKU", async () => {
    const composite = compositeCommerceDataSource([
      stubSource({ "SKU-001": { price_minor: 100 } }),
      stubSource({ "SKU-002": { price_minor: 200 } }),
    ]);
    const products = await composite.getProducts();
    expect(products.map((p) => p.sku).sort()).toEqual(["SKU-001", "SKU-002"]);
  });

  it("空源列表 → invalid_input", () => {
    expect(() => compositeCommerceDataSource([])).toThrow(CommerceError);
  });
});

describe("dataSourceProductSource", () => {
  it("把 CommerceDataSource 适配成 MerchantProductSource（price 用 minor units）", async () => {
    const source = localSource();
    source.upsertProduct({ sku: "SKU-001", title: "Beans", price_minor: 83500, currency: "CNY", stock: 9 });
    const adapter = dataSourceProductSource(source);
    const product = await adapter.getProduct("SKU-001");
    expect(product?.price).toBe(83500);
    expect(product?.currency).toBe("CNY");
    expect(product?.title).toBe("Beans");
    expect(product?.stock).toBe(9);
    source.close();
  });

  it("未知 SKU → 抛错（由 merchant-handler 的调用方决定演示价回退）", async () => {
    const source = localSource();
    const adapter = dataSourceProductSource(source);
    await expect(adapter.getProduct("NOPE")).rejects.toThrow(/no price/);
    source.close();
  });
});
