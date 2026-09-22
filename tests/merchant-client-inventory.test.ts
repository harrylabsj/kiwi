// v1 库存写入的客户端路径 + 回执（B 线）。
//
// 这条链路存在的唯一理由：**让库存写入可对账**。legacy 的 `updateInventory` 走
// `PATCH /products/{sku}`，不落回执，于是外部写落进 UNKNOWN 时无法查明副作用是否
// 真的发生过。本文件锁定三个适配点：
//   1. wire：PATCH 到 v1 库存端点，body 带 operation_id，凭据走 catalog token；
//   2. 词表：`product_inventory_update` 被解析器接受，未知 kind 仍被拒；
//   3. 替身：写入落回执、同 operation_id 重放不产生第二次效果、异 sku 复用被拒。
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { StaticCredentialBroker } from "../src/agent/merchant/credential-broker.js";
import { FakeMerchantClient } from "../src/agent/merchant/fake-merchant-client.js";
import { HttpMerchantClient } from "../src/agent/merchant/merchant-client.js";
import {
  parseMerchantProductOperation,
  type ExactMerchantProduct,
  type MerchantCatalogProduct,
} from "../src/agent/merchant/types.js";

const CURRENCY_TABLE = "kiwi-workbench-currency-v1-2026-09-21";

function exactProduct(sku = "tea-a", stock = 5): ExactMerchantProduct {
  return {
    sku,
    merchant_id: "seller-a",
    title: "Longjing Gift Box",
    description: "",
    category: "",
    tags: [],
    stock,
    currency: "CNY",
    price_minor: "8800",
    currency_table_version: CURRENCY_TABLE,
    authority_version: 1,
    delivery_attributes: [],
    handoff_destination: "",
  };
}

function legacyProduct(sku = "tea-a", stock = 5): MerchantCatalogProduct {
  return {
    sku,
    merchant_id: "seller-a",
    title: "Longjing Gift Box",
    description: "",
    category: "",
    tags: [],
    price: 88,
    currency: "CNY",
    stock,
    delivery_attributes: [],
    paused: false,
  };
}

describe("v1 库存写入：wire 形状", () => {
  it("PATCH 到库存端点，body 带 operation_id，用 catalog 凭据", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenBody = "";
    const server = createServer((req, res) => {
      seenUrl = req.url ?? "";
      seenAuth = req.headers.authorization ?? "";
      req.on("data", (c) => (seenBody += String(c)));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, product: exactProduct("tea-a", 42) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const client = new HttpMerchantClient(
        `http://127.0.0.1:${port}`,
        new StaticCredentialBroker({ catalog: "tok-catalog" }),
      );
      const updated = await client.updateInventoryExact({
        operation_id: "operation-inventory-1",
        merchant_id: "seller-a",
        sku: "tea-a",
        stock: 42,
        currency_table_version: CURRENCY_TABLE,
      });
      expect(updated).toMatchObject({ sku: "tea-a", stock: 42, price_minor: "8800" });
      expect(seenUrl).toContain("/v1/merchant/products/tea-a/inventory");
      expect(seenAuth).toBe("Bearer tok-catalog");
      const body = JSON.parse(seenBody) as Record<string, unknown>;
      expect(body).toMatchObject({
        operation_id: "operation-inventory-1",
        merchant_id: "seller-a",
        stock: 42,
        currency_table_version: CURRENCY_TABLE,
      });
    } finally {
      server.close();
    }
  });
});

describe("operation kind 词表", () => {
  const base = {
    operation_id: "op-1",
    merchant_id: "seller-a",
    sku: "tea-a",
    status: "succeeded" as const,
    created_at: "2026-09-22T00:00:00Z",
  };

  it("接受 product_inventory_update", () => {
    expect(
      parseMerchantProductOperation({ ...base, operation_kind: "product_inventory_update" }),
    ).toMatchObject({ operation_kind: "product_inventory_update" });
  });

  it("仍然接受既有两个 exact kind", () => {
    for (const kind of ["exact_product_create", "exact_product_money_update"] as const) {
      expect(parseMerchantProductOperation({ ...base, operation_kind: kind })).toMatchObject({
        operation_kind: kind,
      });
    }
  });

  it("未知 kind 仍然被拒（fail-closed）", () => {
    expect(() =>
      parseMerchantProductOperation({ ...base, operation_kind: "product_listing_change" }),
    ).toThrow(/operation_kind is invalid/);
  });
});

describe("替身：写入落回执且可重放", () => {
  function client(): FakeMerchantClient {
    return new FakeMerchantClient({
      products: [legacyProduct()],
      exactProducts: [exactProduct()],
    });
  }

  it("写入后回执可按 operation_id 查回，且库存与两套读面一致", async () => {
    const c = client();
    const updated = await c.updateInventoryExact({
      operation_id: "op-inv",
      merchant_id: "seller-a",
      sku: "tea-a",
      stock: 42,
      currency_table_version: CURRENCY_TABLE,
    });
    expect(updated.stock).toBe(42);
    // legacy 读面同步（两套读面不能各说各话）
    expect((await c.getProduct("tea-a")).stock).toBe(42);
    const receipt = await c.getProductOperation("seller-a", "op-inv");
    expect(receipt).toMatchObject({
      operation_kind: "product_inventory_update",
      sku: "tea-a",
      status: "succeeded",
    });
  });

  it("同 operation_id 重放返回原状态，不产生第二次效果", async () => {
    const c = client();
    await c.updateInventoryExact({
      operation_id: "op-replay",
      merchant_id: "seller-a",
      sku: "tea-a",
      stock: 7,
      currency_table_version: CURRENCY_TABLE,
    });
    // 中间改一次
    await c.updateInventoryExact({
      operation_id: "op-other",
      merchant_id: "seller-a",
      sku: "tea-a",
      stock: 99,
      currency_table_version: CURRENCY_TABLE,
    });
    const replay = await c.updateInventoryExact({
      operation_id: "op-replay",
      merchant_id: "seller-a",
      sku: "tea-a",
      stock: 7,
      currency_table_version: CURRENCY_TABLE,
    });
    // 重放**不覆盖**中间那次改动——这正是"重放不等于重做"
    expect(replay.stock).toBe(99);
    expect((await c.getProduct("tea-a")).stock).toBe(99);
  });

  it("同 operation_id 复用到别的 sku → 拒", async () => {
    const c = new FakeMerchantClient({
      products: [legacyProduct("tea-a"), legacyProduct("tea-b")],
      exactProducts: [exactProduct("tea-a"), exactProduct("tea-b")],
    });
    await c.updateInventoryExact({
      operation_id: "op-reuse",
      merchant_id: "seller-a",
      sku: "tea-a",
      stock: 7,
      currency_table_version: CURRENCY_TABLE,
    });
    await expect(
      c.updateInventoryExact({
        operation_id: "op-reuse",
        merchant_id: "seller-a",
        sku: "tea-b",
        stock: 7,
        currency_table_version: CURRENCY_TABLE,
      }),
    ).rejects.toThrow(/operation id was reused/);
  });
});
