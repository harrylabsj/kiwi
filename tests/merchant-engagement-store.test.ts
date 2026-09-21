import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { MerchantEngagementStore } from "../src/merchant/engagement-store.js";

describe("verified broadcast engagement facts", () => {
  it("separates received, presented and clicked with ordering and idempotency", () => {
    const store = new MerchantEngagementStore({
      db: new DatabaseSync(":memory:"),
      now: () => "2026-09-22T00:00:00.000Z",
    });
    const base = {
      merchantId: "m1",
      buyerPrincipalId: "buyer-1",
      broadcastId: "broadcast-1",
      occurredAt: "2026-09-22T00:00:00.000Z",
    };
    expect(() =>
      store.record({ ...base, eventType: "presented", idempotencyKey: "presented-first" }),
    ).toThrow(/prior received/u);
    const received = store.record({
      ...base,
      eventType: "received",
      idempotencyKey: "received-1",
    });
    expect(received.replayed).toBe(false);
    expect(store.record({ ...base, eventType: "received", idempotencyKey: "received-1" })).toEqual({
      ...received,
      replayed: true,
    });
    store.record({ ...base, eventType: "presented", idempotencyKey: "presented-1" });
    store.record({ ...base, eventType: "clicked", idempotencyKey: "clicked-1" });
    expect(store.summary("m1")).toEqual({ received: 1, presented: 1, clicked: 1 });
    expect(store.summary("other")).toEqual({ received: 0, presented: 0, clicked: 0 });
  });

  it("rejects idempotency-key reuse with changed facts", () => {
    const store = new MerchantEngagementStore({ db: new DatabaseSync(":memory:") });
    store.record({
      merchantId: "m1",
      buyerPrincipalId: "buyer-1",
      broadcastId: "broadcast-1",
      eventType: "received",
      idempotencyKey: "same-key",
      occurredAt: "2026-09-22T00:00:00.000Z",
    });
    expect(() =>
      store.record({
        merchantId: "m1",
        buyerPrincipalId: "buyer-1",
        broadcastId: "broadcast-2",
        eventType: "received",
        idempotencyKey: "same-key",
        occurredAt: "2026-09-22T00:00:00.000Z",
      }),
    ).toThrow(/reused/u);
  });
});
