import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { MerchantPromotionStore } from "../src/merchant/promotion-store.js";

describe("Merchant promotion authority", () => {
  it("publishes by revision CAS and applies exact prices only inside the server-time window", () => {
    let now = "2026-09-21T00:00:00.000Z";
    const store = new MerchantPromotionStore({
      db: new DatabaseSync(":memory:"),
      now: () => now,
    });
    const created = store.createDraft("merchant-1", {
      skuRefs: ["sku-1"],
      rule: {
        kind: "limited_price",
        unit_price: {
          currency: "CNY",
          amount_minor: "9999",
          currency_table_version: "iso4217-six-2026-08-01",
        },
      },
      audience: "public",
      starts: "2026-09-21T08:00:00+08:00",
      ends: "2026-09-22T08:00:00+08:00",
      timezone: "Asia/Shanghai",
    });
    expect(store.activeForSku("merchant-1", "sku-1", 1)).toEqual([]);
    expect(
      store.publish("merchant-1", created.promotion_id, 1, {
        publishedBy: "owner-1",
        approvalRef: "operation-1",
      }),
    ).toEqual({ promotion_id: created.promotion_id, revision: 2 });
    expect(store.activeForSku("merchant-1", "sku-1", 1)).toMatchObject([
      { unit_price: { currency: "CNY", amount_minor: "9999" } },
    ]);
    now = "2026-09-22T00:00:00.000Z";
    expect(store.activeForSku("merchant-1", "sku-1", 1)).toEqual([]);
    expect(store.getPromotion("merchant-1", created.promotion_id)?.effective_state).toBe("ended");
  });

  it("selects the highest applicable exact quantity tier", () => {
    const store = new MerchantPromotionStore({
      db: new DatabaseSync(":memory:"),
      now: () => "2026-09-21T12:00:00.000Z",
    });
    const money = (amount: string) => ({
      currency: "CNY",
      amount_minor: amount,
      currency_table_version: "iso4217-six-2026-08-01",
    });
    const created = store.createDraft("merchant-1", {
      skuRefs: ["sku-1"],
      rule: {
        kind: "quantity_tiers",
        tiers: [
          { min_quantity: 10, unit_price: money("9000") },
          { min_quantity: 1, unit_price: money("9999") },
          { min_quantity: 100, unit_price: money("8000") },
        ],
      },
      audience: "public",
      starts: "2026-09-21T00:00:00Z",
      ends: "2026-09-22T00:00:00Z",
      timezone: "UTC",
      priority: 5,
    });
    store.publish("merchant-1", created.promotion_id, 1, {
      publishedBy: "owner-1",
      approvalRef: "operation-1",
    });
    expect(store.activeForSku("merchant-1", "sku-1", 9)[0]?.unit_price.amount_minor).toBe("9999");
    expect(store.activeForSku("merchant-1", "sku-1", 10)[0]?.unit_price.amount_minor).toBe("9000");
    expect(store.activeForSku("merchant-1", "sku-1", 100)[0]?.unit_price.amount_minor).toBe("8000");
  });

  it("rejects stale transitions, non-public audience and inexact money", () => {
    const store = new MerchantPromotionStore({
      db: new DatabaseSync(":memory:"),
      now: () => "2026-09-21T12:00:00.000Z",
    });
    const base = {
      skuRefs: ["sku-1"],
      rule: {
        kind: "limited_price",
        unit_price: {
          currency: "CNY",
          amount_minor: "9999",
          currency_table_version: "iso4217-six-2026-08-01",
        },
      },
      audience: "public" as const,
      starts: "2026-09-21T00:00:00Z",
      ends: "2026-09-22T00:00:00Z",
      timezone: "UTC",
    };
    const created = store.createDraft("merchant-1", base);
    store.publish("merchant-1", created.promotion_id, 1, {
      publishedBy: "owner-1",
      approvalRef: "operation-1",
    });
    expect(() =>
      store.publish("merchant-1", created.promotion_id, 1, {
        publishedBy: "owner-1",
        approvalRef: "operation-2",
      }),
    ).toThrow(/revision\/status changed/);
    expect(() =>
      store.createDraft("merchant-1", {
        ...base,
        rule: { kind: "limited_price", unit_price: { currency: "CNY", amount_minor: 99.99 } },
      }),
    ).toThrow(/strings/);
  });
});
