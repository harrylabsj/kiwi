// Code review 2026-11-10 P1-3: default discount counter offers must stay in
// integer minor units, otherwise the delegation gate rejects nearly every
// common price (any current amount not a multiple of 10 minor units).
import { describe, expect, it } from "vitest";

import { targetPriceMinor } from "../src/buyer-core/a2a-negotiator.js";

describe("targetPriceMinor (P1-3)", () => {
  it("keeps integer minor units for prices that are not round deca-minor", () => {
    for (const current of [14907, 8901, 12345, 999, 70, 1234567]) {
      const target = targetPriceMinor({}, current, 0.1);
      expect(Number.isSafeInteger(target)).toBe(true);
      expect(target).toBeGreaterThanOrEqual(0);
      expect(target).toBe(Math.max(0, Math.round(current * 0.9)));
    }
  });

  it("prefers an explicit target_unit_price in minor units", () => {
    expect(
      targetPriceMinor({ constraints: { target_unit_price: { currency: "CNY", amount_minor: 13500 } } }, 14907, 0.1),
    ).toBe(13500);
  });

  it("derives from budget and quantity without floating minor output", () => {
    const target = targetPriceMinor({ constraints: { budget: { amount_minor: 30000 } }, items: [{ quantity: { value: 2, unit: "piece" } }] }, 14907, 0.1);
    expect(target).toBe(15000);
    expect(Number.isSafeInteger(target)).toBe(true);
  });
});

// P1-6: CSV import must run the same private-floor policy as single-product
// create/update, and the approval preview must expose each row's action/price.
import { DatabaseSync } from "node:sqlite";

import { parseProductCsv, executeProductsImport } from "../src/merchant-core/product-import.js";
import { MerchantOperationStore } from "../src/merchant-core/operations.js";
import { FakeMerchantClient, fakeMerchantProduct } from "../src/agent/merchant/fake-merchant-client.js";

describe("CSV import floor + preview (P1-6)", () => {
  it("preview lists each row action and price", () => {
    const csv = "sku,title,price,stock\nNEW-1,New item,12.5,3\nOLD-1,Old item,9,1";
    const { preview } = parseProductCsv(csv, new Set(["OLD-1"]));
    expect(preview.rows).toEqual([
      { line: 2, sku: "NEW-1", action: "create", price: 12.5 },
      { line: 3, sku: "OLD-1", action: "update", price: 9 },
    ]);
  });

  it("rejects a below-floor row without creating the product", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const operations = new MerchantOperationStore({ db, now: () => new Date().toISOString() });
      const client = new FakeMerchantClient();
      const created: string[] = [];
      client.createProduct = async (p) => {
        created.push(p.sku);
        return fakeMerchantProduct({ sku: p.sku, title: p.title, price: p.price, stock: p.stock });
      };
      const result = await executeProductsImport({
        csv: "sku,title,price,stock\nLOW-1,Too cheap,5,1",
        idempotencyKey: "floor-1",
        merchantId: "merchant-001",
        merchantClient: client,
        operations,
        enforceFloor: (price) => {
          if (typeof price === "number" && price < 10) {
            throw new Error("执行被硬策略拒绝：价格低于私有底价");
          }
        },
      });
      expect(created).toEqual([]);
      const operation = "operation" in result ? result.operation : result;
      expect(["failed", "partially_failed"]).toContain(operation.status);
      expect(JSON.stringify(operation.receipts)).toContain("底价");
    } finally {
      db.close();
    }
  });
});
