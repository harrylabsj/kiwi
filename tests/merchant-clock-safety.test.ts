import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { ExternalAlertDeliveryStore } from "../src/alerts/external-delivery.js";
import { WorkbenchReconciliationStore } from "../src/http/merchant-management/reconciliation-worker.js";
import { ClockSafetyStore, probeReferenceClock } from "../src/merchant/clock-safety.js";
import { MerchantPromotionStore } from "../src/merchant/promotion-store.js";

const MERCHANT = "merchant-clock";
const BASE = Date.parse("2026-09-22T00:00:00.000Z");

function promotionInput() {
  return {
    skuRefs: ["sku-clock"],
    rule: {
      kind: "limited_price",
      unit_price: {
        currency: "CNY",
        amount_minor: "9900",
        currency_table_version: "iso4217-six-2026-08-01",
      },
    },
    audience: "public" as const,
    starts: "2026-09-21T00:00:00Z",
    ends: "2026-09-23T00:00:00Z",
    timezone: "UTC",
  };
}

describe("persistent clock-safety guard", () => {
  it("pauses after two >2s samples, alerts, permits withdrawal, and recovers", () => {
    const db = new DatabaseSync(":memory:");
    const alerts = new WorkbenchReconciliationStore({
      db,
      now: () => "2026-09-22T00:00:10.000Z",
    });
    const clock = new ClockSafetyStore({ db, alerts });
    const promotions = new MerchantPromotionStore({
      db,
      now: () => "2026-09-22T00:00:00.000Z",
      clockSafety: clock,
    });

    expect(() => promotions.createDraft(MERCHANT, promotionInput())).toThrow(/not been verified/);
    expect(
      clock.recordSample({
        merchantId: MERCHANT,
        referenceTimeMs: BASE,
        localTimeMs: BASE + 2_001,
      }),
    ).toMatchObject({ status: "healthy", consecutive_breaches: 1, offset_ms: 2_001 });
    const draft = promotions.createDraft(MERCHANT, promotionInput());
    promotions.publish(MERCHANT, draft.promotion_id, 1, {
      publishedBy: "owner-clock",
      approvalRef: "operation-clock",
    });

    expect(
      clock.recordSample({
        merchantId: MERCHANT,
        referenceTimeMs: BASE,
        localTimeMs: BASE + 2_500,
      }),
    ).toMatchObject({ status: "paused", consecutive_breaches: 2, offset_ms: 2_500 });
    expect(() => promotions.activeForSku(MERCHANT, "sku-clock", 1)).toThrow(/clock skew/);
    expect(() => promotions.createDraft(MERCHANT, promotionInput())).toThrow(/clock skew/);
    expect(alerts.listAlerts(MERCHANT).items).toMatchObject([
      { category: "clock_skew", severity: "critical", resolved_at: null },
    ]);

    expect(
      promotions.withdraw(MERCHANT, draft.promotion_id, 2, {
        publishedBy: "owner-clock",
        approvalRef: "operation-withdraw",
      }),
    ).toMatchObject({ revision: 3 });
    expect(
      clock.recordSample({
        merchantId: MERCHANT,
        referenceTimeMs: BASE,
        localTimeMs: BASE + 1_000,
      }),
    ).toMatchObject({ status: "healthy", consecutive_breaches: 0 });
    expect(alerts.listAlerts(MERCHANT).items[0]?.resolved_at).not.toBeNull();
    expect(promotions.createDraft(MERCHANT, promotionInput()).revision).toBe(1);
    db.close();
  });

  it("samples an HTTPS Date header and re-enqueues a later skew episode", async () => {
    const db = new DatabaseSync(":memory:");
    const alerts = new WorkbenchReconciliationStore({
      db,
      now: () => "2026-09-22T00:00:10.000Z",
    });
    const delivery = new ExternalAlertDeliveryStore({
      db,
      now: () => "2026-09-22T00:00:10.000Z",
    });
    const clock = new ClockSafetyStore({ db, alerts });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { headers: { date: new Date(BASE).toUTCString() }, status: 204 }),
      );
    const times = [BASE + 2_500, BASE + 2_500, BASE + 2_600, BASE + 2_600];
    const nowMs = () => times.shift() ?? BASE + 2_600;

    await probeReferenceClock(clock, {
      merchantId: MERCHANT,
      referenceUrl: new URL("https://time.example/"),
      fetchImpl,
      nowMs,
    });
    expect(
      await probeReferenceClock(clock, {
        merchantId: MERCHANT,
        referenceUrl: new URL("https://time.example/"),
        fetchImpl,
        nowMs,
      }),
    ).toMatchObject({ status: "paused" });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://time.example/"),
      expect.objectContaining({ redirect: "error" }),
    );
    expect(delivery.enqueueOutstanding()).toBe(1);
    const first = delivery.lease("clock-delivery");
    expect(first?.category).toBe("clock_skew");
    expect(first === undefined ? false : delivery.finish(first, { delivered: true })).toBe(true);

    clock.recordSample({ merchantId: MERCHANT, referenceTimeMs: BASE, localTimeMs: BASE });
    clock.recordSample({ merchantId: MERCHANT, referenceTimeMs: BASE, localTimeMs: BASE + 3_000 });
    clock.recordSample({ merchantId: MERCHANT, referenceTimeMs: BASE, localTimeMs: BASE + 3_000 });
    expect(delivery.enqueueOutstanding()).toBe(1);
    db.close();
  });
});
