// v1 上下架写入的客户端路径 + 回执（B 线：上下架）。
//
// 这条链路存在的唯一理由：**让上下架写入可对账**。legacy `pauseListing` 在上游
// 连状态都没有（fail-closed 报「不可得」），不落回执，于是外部写落进 UNKNOWN 时
// 无法查明副作用是否真的发生过。本文件锁定三个适配点：
//   1. wire：PATCH 到 v1 listing 端点，body 带 operation_id 与严格 bool 的
//      paused，凭据走 catalog token；
//   2. 词表：`product_listing_change` 被解析器接受，未知 kind 仍被拒；
//   3. 替身：写入落回执（响应体携带 paused 目标态）、同 operation_id 重放不
//      产生第二次效果、异 sku 复用被拒、两套读面同步。
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

function exactProduct(sku = "tea-a", listingPaused = false): ExactMerchantProduct {
  return {
    sku,
    merchant_id: "seller-a",
    title: "Longjing Gift Box",
    description: "",
    category: "",
    tags: [],
    stock: 5,
    listing_paused: listingPaused,
    currency: "CNY",
    price_minor: "8800",
    currency_table_version: CURRENCY_TABLE,
    authority_version: 1,
    delivery_attributes: [],
    handoff_destination: "",
  };
}

function legacyProduct(sku = "tea-a", paused = false): MerchantCatalogProduct {
  return {
    sku,
    merchant_id: "seller-a",
    title: "Longjing Gift Box",
    description: "",
    category: "",
    tags: [],
    price: 88,
    currency: "CNY",
    stock: 5,
    delivery_attributes: [],
    paused,
  };
}

describe("v1 上下架写入：wire 形状", () => {
  it("PATCH 到 listing 端点，body 带 operation_id 与严格 bool 的 paused，用 catalog 凭据", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenBody = "";
    const server = createServer((req, res) => {
      seenUrl = req.url ?? "";
      seenAuth = req.headers.authorization ?? "";
      req.on("data", (c) => (seenBody += String(c)));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, product: exactProduct("tea-a", true) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const client = new HttpMerchantClient(
        `http://127.0.0.1:${port}`,
        new StaticCredentialBroker({ catalog: "tok-catalog" }),
      );
      const updated = await client.updateListingExact({
        operation_id: "operation-listing-1",
        merchant_id: "seller-a",
        sku: "tea-a",
        paused: true,
        currency_table_version: CURRENCY_TABLE,
      });
      expect(updated).toMatchObject({ sku: "tea-a", listing_paused: true, price_minor: "8800" });
      expect(seenUrl).toContain("/v1/merchant/products/tea-a/listing");
      expect(seenAuth).toBe("Bearer tok-catalog");
      const body = JSON.parse(seenBody) as Record<string, unknown>;
      expect(body).toMatchObject({
        operation_id: "operation-listing-1",
        merchant_id: "seller-a",
        paused: true,
        currency_table_version: CURRENCY_TABLE,
      });
      // paused 必须以 JSON bool 上 wire（"false" 这类串会被上游拒，且语义方向相反）
      expect(typeof body["paused"]).toBe("boolean");
    } finally {
      server.close();
    }
  });
});

describe("operation kind 词表（listing）", () => {
  const base = {
    operation_id: "op-1",
    merchant_id: "seller-a",
    sku: "tea-a",
    status: "succeeded" as const,
    created_at: "2026-09-22T00:00:00Z",
  };

  it("接受 product_listing_change", () => {
    expect(
      parseMerchantProductOperation({ ...base, operation_kind: "product_listing_change" }),
    ).toMatchObject({ operation_kind: "product_listing_change" });
  });

  it("未知 kind 仍然被拒（fail-closed）", () => {
    expect(() =>
      parseMerchantProductOperation({ ...base, operation_kind: "kind_not_in_vocabulary" }),
    ).toThrow(/operation_kind is invalid/);
  });
});

describe("替身：上下架写入落回执且可重放", () => {
  function client(): FakeMerchantClient {
    return new FakeMerchantClient({
      products: [legacyProduct()],
      exactProducts: [exactProduct()],
    });
  }

  it("写入后回执可按 operation_id 查回，响应体带 paused 目标态，两套读面一致", async () => {
    const c = client();
    const updated = await c.updateListingExact({
      operation_id: "op-lst",
      merchant_id: "seller-a",
      sku: "tea-a",
      paused: true,
      currency_table_version: CURRENCY_TABLE,
    });
    expect(updated.listing_paused).toBe(true);
    // legacy 读面同步（两套读面不能各说各话）
    expect((await c.getProduct("tea-a")).paused).toBe(true);
    const receipt = await c.getProductOperation("seller-a", "op-lst");
    expect(receipt).toMatchObject({
      operation_kind: "product_listing_change",
      sku: "tea-a",
      status: "succeeded",
    });
    // 回执响应体携带 paused 目标态——对账核对的是语义，不只是状态
    expect((receipt.result?.["product"] as { listing_paused?: unknown }).listing_paused).toBe(true);
  });

  it("同 operation_id 重放返回原状态，不产生第二次效果", async () => {
    const c = client();
    await c.updateListingExact({
      operation_id: "op-replay",
      merchant_id: "seller-a",
      sku: "tea-a",
      paused: true,
      currency_table_version: CURRENCY_TABLE,
    });
    // 中间改一次（恢复销售）
    await c.updateListingExact({
      operation_id: "op-other",
      merchant_id: "seller-a",
      sku: "tea-a",
      paused: false,
      currency_table_version: CURRENCY_TABLE,
    });
    const replay = await c.updateListingExact({
      operation_id: "op-replay",
      merchant_id: "seller-a",
      sku: "tea-a",
      paused: true,
      currency_table_version: CURRENCY_TABLE,
    });
    // 重放**不覆盖**中间那次改动——这正是"重放不等于重做"
    expect(replay.listing_paused).toBe(false);
    expect((await c.getProduct("tea-a")).paused).toBe(false);
  });

  it("同 operation_id 复用到别的 sku → 拒", async () => {
    const c = new FakeMerchantClient({
      products: [legacyProduct("tea-a"), legacyProduct("tea-b")],
      exactProducts: [exactProduct("tea-a"), exactProduct("tea-b")],
    });
    await c.updateListingExact({
      operation_id: "op-reuse",
      merchant_id: "seller-a",
      sku: "tea-a",
      paused: true,
      currency_table_version: CURRENCY_TABLE,
    });
    await expect(
      c.updateListingExact({
        operation_id: "op-reuse",
        merchant_id: "seller-a",
        sku: "tea-b",
        paused: true,
        currency_table_version: CURRENCY_TABLE,
      }),
    ).rejects.toThrow(/operation id was reused/);
  });
});
