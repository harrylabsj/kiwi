/**
 * CommerceDataSource 测试（v0.7.0 WP-B / 完成定义 #5、#6、#7）。
 *
 * 架构调整（2026-08-07）：kiwi merchant 只与 shopping-cli 沟通——
 * ERP / 本地库接入已下沉到 shopping-cli 仓（`shopping_cli/data_sources/`，
 * migration v17 products.provenance）。kiwi 侧只保留：
 * - `CommerceDataSource` 接口（数据侧边界，≠ CommerceClient 通信侧
 *   ≠ CounterpartyChannel）；
 * - `ShoppingCliCommerceDataSource`（唯一数据入口）；
 * - `dataSourceProductSource`（MerchantProductSource 适配，price minor
 *   与 resolveProduct 的 ×100 约定一致）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  CommerceError,
  type CommerceDataSource,
  type CommerceField,
  type ProductFact,
  type ProductSearchQuery,
} from "../src/commerce/data-source.js";
import { ShoppingCliCommerceDataSource } from "../src/commerce/shopping-cli-source.js";
import { dataSourceProductSource } from "../src/a2a/server/merchant-handler.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cliFetch(routes: Record<string, (href: string) => Response>): typeof fetch {
  return (async (input: FetchInput, _init?: FetchInit): Promise<Response> => {
    const href = String(input);
    for (const [suffix, handler] of Object.entries(routes)) {
      if (href.includes(suffix)) return handler(href);
    }
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;
}

/** 最小 stub：dataSourceProductSource 适配测试用（不依赖 HTTP 形状）。 */
function stubSource(product?: ProductFact): CommerceDataSource {
  return {
    async getProduct(sku) {
      return product?.sku === sku ? product : undefined;
    },
    async getProducts(_query?: ProductSearchQuery): Promise<ProductFact[]> {
      return product === undefined ? [] : [product];
    },
    async getInventory(_sku: string): Promise<CommerceField<number> | undefined> {
      return undefined;
    },
    async getPrice(
      _sku: string,
    ): Promise<CommerceField<{ currency: string; amount_minor: number }> | undefined> {
      return undefined;
    },
    async getPublicListing(): Promise<Record<string, unknown>> {
      return {};
    },
    async health() {
      return { ok: true };
    },
  };
}

describe("ShoppingCliCommerceDataSource（唯一数据入口）", () => {
  it("getProduct 解析 {product} 信封：price 元→minor 转换 + UPSTREAM_PROXY 标注", async () => {
    const source = new ShoppingCliCommerceDataSource({
      baseUrl: "https://shopping-cli.example",
      fetchImpl: cliFetch({
        "/products/SKU-001": () =>
          jsonResponse({
            product: { sku: "SKU-001", title: "Coffee", price: 99, currency: "CNY", stock: 12 },
          }),
      }),
    });
    const product = await source.getProduct("SKU-001");
    expect(product?.title).toBe("Coffee");
    expect(product?.price_minor).toBe(9900); // 99 元 → 9900 minor
    expect(product?.stock).toBe(12);
    const inventory = await source.getInventory("SKU-001");
    expect(inventory?.authority).toBe("UPSTREAM_PROXY");
    expect(inventory?.source).toBe("shopping-cli");
  });

  it("lossy 价格 fail-closed：price_minor 缺省而非静默舍入（审查 P2-P）", async () => {
    const source = new ShoppingCliCommerceDataSource({
      baseUrl: "https://shopping-cli.example",
      fetchImpl: cliFetch({
        "/products/SKU-001": () =>
          jsonResponse({
            product: { sku: "SKU-001", title: "Lossy", price: 19.999, currency: "CNY" },
          }),
      }),
    });
    const product = await source.getProduct("SKU-001");
    // 19.999 元 → 1999.9 minor：此前 Math.round 静默抹平为 2000（¥20.00），
    // 错误价格进入 offer terms；现在 price_minor 缺省（调用方回退演示价）
    expect(product?.price_minor).toBeUndefined();
  });

  it("两位小数价格仍无损转换（审查 P2-P 正例）", async () => {
    const source = new ShoppingCliCommerceDataSource({
      baseUrl: "https://shopping-cli.example",
      fetchImpl: cliFetch({
        "/products/SKU-001": () =>
          jsonResponse({
            product: { sku: "SKU-001", title: "Exact", price: 19.99, currency: "CNY" },
          }),
      }),
    });
    const product = await source.getProduct("SKU-001");
    expect(product?.price_minor).toBe(1999);
  });

  it("解析 handoff_destination + 精确 stock（审查 X-M1）：带 owner 凭据的私有成交入口到达数据源", async () => {
    const source = new ShoppingCliCommerceDataSource({
      baseUrl: "https://shopping-cli.example",
      fetchImpl: cliFetch({
        "/products/SKU-001": () =>
          jsonResponse({
            product: {
              sku: "SKU-001",
              title: "Handoff",
              price: 8999,
              currency: "CNY",
              stock: 120,
              handoff_destination: "https://shop.veyquo.example/checkout",
            },
          }),
      }),
    });
    const product = await source.getProduct("SKU-001");
    expect(product?.handoff_destination).toBe("https://shop.veyquo.example/checkout");
    expect(product?.stock).toBe(120);
    expect(product?.availability_hint).toBeUndefined();
  });

  it("匿名投影降级：精确 stock → availability_hint 显式携带（审查 X-M1，不再静默丢失）", async () => {
    const source = new ShoppingCliCommerceDataSource({
      baseUrl: "https://shopping-cli.example",
      fetchImpl: cliFetch({
        "/products/SKU-001": () =>
          jsonResponse({
            product: {
              sku: "SKU-001",
              title: "Anon",
              price: 99,
              currency: "CNY",
              availability_hint: "in_stock",
            },
          }),
      }),
    });
    const product = await source.getProduct("SKU-001");
    expect(product?.stock).toBeUndefined(); // 匿名投影无精确库存
    expect(product?.availability_hint).toBe("in_stock");
    expect(product?.handoff_destination).toBeUndefined(); // 匿名投影剥除
  });

  it("404 → undefined（未知 SKU 的接口承诺，供调用方回退演示价）", async () => {
    const source = new ShoppingCliCommerceDataSource({
      baseUrl: "https://shopping-cli.example",
      fetchImpl: cliFetch({}),
    });
    expect(await source.getProduct("NOPE")).toBeUndefined();
  });

  it("getProducts 解析 {results} 信封（/search/products）", async () => {
    const source = new ShoppingCliCommerceDataSource({
      baseUrl: "https://shopping-cli.example",
      fetchImpl: cliFetch({
        "/search/products": () =>
          jsonResponse({
            results: [
              { sku: "A", price: 10, currency: "CNY" },
              { sku: "B", price: 20, currency: "CNY" },
            ],
          }),
      }),
    });
    const products = await source.getProducts();
    expect(products.map((p) => p.sku)).toEqual(["A", "B"]);
    expect(products[0]?.price_minor).toBe(1000);
  });

  it("getProducts 关键词走 wire 参数 query（与 shopping-cli 两分支一致）", async () => {
    let seenUrl = "";
    const source = new ShoppingCliCommerceDataSource({
      baseUrl: "https://shopping-cli.example",
      fetchImpl: cliFetch({
        "/search/products": (url: string) => {
          seenUrl = url;
          return jsonResponse({ results: [] });
        },
      }),
    });
    const products = await source.getProducts({ query: "longjing", limit: 5 });
    expect(products).toEqual([]);
    expect(seenUrl).toContain("/search/products?limit=5&query=longjing");
    expect(seenUrl).not.toContain("q=");
  });

  it("结构错误 fail-closed（缺 product / 缺 results / 非对象）", async () => {
    const noProduct = new ShoppingCliCommerceDataSource({
      baseUrl: "https://shopping-cli.example",
      fetchImpl: cliFetch({ "/products/X": () => jsonResponse({ foo: 1 }) }),
    });
    await expect(noProduct.getProduct("X")).rejects.toMatchObject({ code: "request_failed" });

    const noResults = new ShoppingCliCommerceDataSource({
      baseUrl: "https://shopping-cli.example",
      fetchImpl: cliFetch({ "/search/products": () => jsonResponse({ foo: 1 }) }),
    });
    await expect(noResults.getProducts()).rejects.toMatchObject({ code: "request_failed" });
  });

  it("网络失败/非法 baseUrl fail-closed", async () => {
    const net = (async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const broken = new ShoppingCliCommerceDataSource({
      baseUrl: "https://shopping-cli.example",
      fetchImpl: net,
    });
    await expect(broken.getProduct("X")).rejects.toMatchObject({ code: "request_failed" });
    expect(() => new ShoppingCliCommerceDataSource({ baseUrl: "ftp://x" })).toThrow(CommerceError);
  });

  // ── 审查 P2-02：所有失败路径都要清理超时 timer ───────────────────────────
  it("fetch 失败路径清理超时 timer（P2-02）：不触发迟到的 abort", async () => {
    vi.useFakeTimers();
    try {
      const aborted: string[] = [];
      const fetchImpl = (async (_input: FetchInput, init?: FetchInit) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => aborted.push("abort"));
        throw new Error("network down"); // fetch 立即失败
      }) as typeof fetch;
      const source = new ShoppingCliCommerceDataSource({
        baseUrl: "http://shopping-cli.example",
        timeoutMs: 100,
        fetchImpl,
      });
      await expect(source.getProduct("SKU-1")).rejects.toMatchObject({ code: "request_failed" });
      // 推进远超 timeout：若 timer 未清理，会触发 controller.abort() → abort 事件。
      await vi.advanceTimersByTimeAsync(10_000);
      expect(aborted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redirect 响应路径清理超时 timer（P2-02）：不触发迟到的 abort", async () => {
    vi.useFakeTimers();
    try {
      const aborted: string[] = [];
      const fetchImpl = (async (_input: FetchInput, init?: FetchInit) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => aborted.push("abort"));
        return new Response("", { status: 302, headers: { location: "https://evil.example/" } });
      }) as typeof fetch;
      const source = new ShoppingCliCommerceDataSource({
        baseUrl: "http://shopping-cli.example",
        timeoutMs: 100,
        fetchImpl,
      });
      await expect(source.getProduct("SKU-1")).rejects.toThrow(/must not follow redirects/);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(aborted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dataSourceProductSource", () => {
  it("把 CommerceDataSource 适配成 MerchantProductSource（price minor → 元，×100 约定一致）", async () => {
    const source = stubSource({
      sku: "SKU-001",
      title: "Beans",
      price_minor: 83500,
      currency: "CNY",
      stock: 9,
      handoff_destination: "https://shop.veyquo.example/checkout",
    });
    const adapter = dataSourceProductSource(source);
    const product = await adapter.getProduct("SKU-001");
    expect(product?.price).toBe(835); // 83500 minor → 835.00 元
    expect(product?.currency).toBe("CNY");
    expect(product?.title).toBe("Beans");
    expect(product?.stock).toBe(9);
    // 审查 X-M1：handoff 成交入口必须经适配器到达 MerchantProductSource。
    expect(product?.handoff_destination).toBe("https://shop.veyquo.example/checkout");
  });

  it("未知 SKU → 抛错（由 merchant-handler 的调用方决定演示价回退）", async () => {
    const adapter = dataSourceProductSource(stubSource());
    await expect(adapter.getProduct("NOPE")).rejects.toThrow(/no price/);
  });
});
