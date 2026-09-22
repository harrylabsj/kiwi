// merchant-client 读路径的精确库存语义（审查 P2-1，2026-08-10）
//
// design v0.3 §7：精确库存是私密 inventory。shopping-cli 公开端点只下发
// availability_hint；精确 stock 仅向商品所属商户本人（持 catalog 凭据）
// 返回。本测试锁定 kiwi 侧的两个适配点：
//   1. 匿名 wire（无 stock）解析不失败（stock 变可选）；
//   2. 读路径在凭据可解析时携带 Bearer token（owner 校验由网关做）。
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { StaticCredentialBroker } from "../src/agent/merchant/credential-broker.js";
import { HttpMerchantClient } from "../src/agent/merchant/merchant-client.js";
import {
  parseExactMerchantProduct,
  parseMerchantCatalogProduct,
} from "../src/agent/merchant/types.js";

describe("merchant read path exact-stock semantics (P2-1)", () => {
  it("parses exact product money without accepting JSON numbers", () => {
    expect(
      parseExactMerchantProduct({
        sku: "tea-a",
        merchant_id: "seller-a",
        title: "Longjing Gift Box",
        stock: 5,
        currency: "CNY",
        price_minor: "8800",
        currency_table_version: "kiwi-workbench-currency-v1-2026-09-21",
        authority_version: 1,
      }),
    ).toMatchObject({ price_minor: "8800", stock: 5 });
    expect(() =>
      parseExactMerchantProduct({
        sku: "tea-a",
        merchant_id: "seller-a",
        title: "Longjing Gift Box",
        stock: 5,
        currency: "CNY",
        price_minor: 8800,
        currency_table_version: "kiwi-workbench-currency-v1-2026-09-21",
        authority_version: 1,
      }),
    ).toThrow(/minor-unit string/);
  });

  it("listExactProducts uses the merchant endpoint and catalog credential", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const server = createServer((req, res) => {
      seenUrl = req.url ?? "";
      seenAuth = req.headers.authorization ?? "";
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          items: [
            {
              sku: "tea-a",
              merchant_id: "seller-a",
              title: "Longjing Gift Box",
              stock: 5,
              currency: "CNY",
              price_minor: "8800",
              currency_table_version: "kiwi-workbench-currency-v1-2026-09-21",
              authority_version: 1,
            },
          ],
          next_offset: null,
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const client = new HttpMerchantClient(
        `http://127.0.0.1:${port}`,
        new StaticCredentialBroker({ catalog: "tok-catalog" }),
      );
      expect(await client.listExactProducts("seller-a")).toMatchObject([
        { sku: "tea-a", price_minor: "8800" },
      ]);
      expect(seenUrl).toContain("/v1/merchant/products/exact?merchant_id=seller-a");
      expect(seenAuth).toBe("Bearer tok-catalog");
    } finally {
      server.close();
    }
  });
  it("queries an exact product operation receipt with the merchant credential", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const server = createServer((req, res) => {
      seenUrl = req.url ?? "";
      seenAuth = req.headers.authorization ?? "";
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          operation: {
            operation_id: "operation-1",
            merchant_id: "seller-a",
            operation_kind: "exact_product_money_update",
            sku: "tea-a",
            status: "succeeded",
            created_at: "2026-09-22T00:00:00Z",
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const client = new HttpMerchantClient(
        `http://127.0.0.1:${port}`,
        new StaticCredentialBroker({ catalog: "tok-catalog" }),
      );
      await expect(
        client.getProductOperation("seller-a", "operation-1"),
      ).resolves.toMatchObject({ operation_id: "operation-1", status: "succeeded" });
      expect(seenUrl).toContain("/v1/merchant/product-operations/operation-1?merchant_id=seller-a");
      expect(seenAuth).toBe("Bearer tok-catalog");
    } finally {
      server.close();
    }
  });
  it("parses product without exact stock (anonymous read)", () => {
    const product = parseMerchantCatalogProduct({
      sku: "tea-a",
      merchant_id: "seller-a",
      title: "Longjing Gift Box",
      price: 88,
      availability_hint: "in_stock",
    });
    expect(product.stock).toBeUndefined();
    expect(product.sku).toBe("tea-a");
    expect(product.price).toBe(88);
  });

  it("parses exact stock when the owner read returns it", () => {
    const product = parseMerchantCatalogProduct({
      sku: "tea-a",
      merchant_id: "seller-a",
      title: "Longjing Gift Box",
      price: 88,
      stock: 5,
    });
    expect(product.stock).toBe(5);
  });

  it("getProduct attaches catalog token and reads exact stock", async () => {
    let seenAuth = "";
    const server = createServer((_req, res) => {
      seenAuth = _req.headers.authorization ?? "";
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          product: {
            sku: "tea-a",
            merchant_id: "seller-a",
            title: "Longjing Gift Box",
            price: 88,
            stock: 5,
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const broker = new StaticCredentialBroker({ catalog: "tok-catalog" });
      const client = new HttpMerchantClient(`http://127.0.0.1:${port}`, broker);
      const product = await client.getProduct("tea-a");
      expect(product.stock).toBe(5);
      expect(seenAuth).toBe("Bearer tok-catalog");
    } finally {
      server.close();
    }
  });

  it("getProduct stays anonymous when no catalog credential is configured", async () => {
    let seenAuth: string | undefined = undefined;
    const server = createServer((_req, res) => {
      seenAuth = _req.headers.authorization ?? "";
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          product: {
            sku: "tea-a",
            merchant_id: "seller-a",
            title: "Longjing Gift Box",
            price: 88,
            availability_hint: "in_stock",
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const broker = new StaticCredentialBroker({});
      const client = new HttpMerchantClient(`http://127.0.0.1:${port}`, broker);
      const product = await client.getProduct("tea-a");
      expect(product.stock).toBeUndefined();
      expect(seenAuth).toBe("");
    } finally {
      server.close();
    }
  });

  it("K-M1: stalled response body is aborted by the timeout, not a permanent hang", async () => {
    // 服务端发头 + 部分 body 后停滞（永不 end）：此前的实现 timer 在 fetch
    // 头到达即清，await arrayBuffer() 永久挂起。readJsonBody 用同一 signal
    // abort 时 cancel 底层流——挂起的读被中断，工具调用以 transient 超时返回。
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.write("{");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const broker = new StaticCredentialBroker({ catalog: "tok-catalog" });
      const client = new HttpMerchantClient(`http://127.0.0.1:${port}`, broker, { timeoutMs: 200 });
      await expect(client.getProduct("tea-a")).rejects.toMatchObject({ kind: "transient" });
    } finally {
      server.close();
    }
  });
});
