/**
 * linkluck 线上验收回归：明确 SKU 的 RFQ 不得接受商家换品报价。
 * 只覆盖买家服务边界，不访问网络、不读商家凭据。
 */
import { describe, expect, it } from "vitest";
import { KiwiBuyerService } from "../src/buyer-core/service.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";

const policy = {
  policy_id: "test-explicit-sku",
  version: "1.0",
  principal: "buyer:test",
  expires_at: "2099-12-31T23:59:59Z",
  actions: {
    discover: { mode: "auto" },
    inquiry_rfq: { mode: "auto" },
    compare_offers: { mode: "auto" },
    counter_offer: { mode: "auto" },
    accept_nonbinding: { mode: "auto" },
    handoff: { mode: "ask" },
    payment: { mode: "never" },
  },
  limits: {
    allowed_merchants: ["merchant-1"],
    allowed_currencies: ["CNY"],
    max_unit_price: { currency: "CNY", amount_minor: 20000 },
    max_total_price: { currency: "CNY", amount_minor: 30000 },
    max_quantity: { value: 10, unit: "盒" },
  },
};

function intent(sku?: string) {
  return {
    intent_id: "linkluck-cross-sku-test",
    intent_type: "purchase",
    items: [
      {
        query: "测试商品",
        ...(sku !== undefined ? { sku } : {}),
        quantity: { value: 2, unit: "盒" },
      },
    ],
    constraints: { currency: "CNY" },
  };
}

function serviceFor(offeredSku: string) {
  const store = new TaskApprovalStore({ dbPath: ":memory:" });
  return new KiwiBuyerService({
    store,
    principal: "buyer:test",
    buyerAgentId: "buyer:test",
    sessionId: "explicit-sku",
    delegationPolicy: policy,
    quoteFetcher: {
      async requestQuotes() {
        return [
          {
            merchant_id: "merchant-1",
            status: "succeeded",
            terms: {
              currency: "CNY",
              items: [
                {
                  sku: offeredSku,
                  quantity_value: 2,
                  quantity_unit: "盒",
                  unit_price_minor: 7000,
                },
              ],
              total_price_minor: 14000,
            },
            provenance: { source: "a2a", sku: offeredSku },
          },
        ];
      },
    },
    now: () => "2026-11-04T02:30:00.000Z",
  });
}

describe("explicit SKU quote guard", () => {
  it("rejects a merchant quote for a different SKU", async () => {
    const result = await serviceFor("10225485016481").requestQuotes({
      intent: intent("10223889834191"),
      merchant_ids: ["merchant-1"],
    });
    const candidate = result.task.candidates?.[0] as
      | { status?: string; failure?: { detail?: string } }
      | undefined;
    expect(candidate?.status).toBe("failed");
    expect(candidate?.failure?.detail).toContain("SKU");
  });

  it("rejects a mixed quote containing the requested SKU and another product", async () => {
    const store = new TaskApprovalStore({ dbPath: ":memory:" });
    const service = new KiwiBuyerService({
      store,
      principal: "buyer:test",
      buyerAgentId: "buyer:test",
      sessionId: "explicit-sku-mixed",
      delegationPolicy: policy,
      quoteFetcher: {
        async requestQuotes() {
          return [
            {
              merchant_id: "merchant-1",
              status: "succeeded",
              terms: {
                currency: "CNY",
                items: [
                  { sku: "10223889834191", quantity_value: 2, quantity_unit: "盒", unit_price_minor: 7000 },
                  { sku: "10225485016481", quantity_value: 1, quantity_unit: "盒", unit_price_minor: 7000 },
                ],
                total_price_minor: 28000,
              },
            },
          ];
        },
      },
      now: () => "2026-11-04T02:30:00.000Z",
    });
    const result = await service.requestQuotes({
      intent: intent("10223889834191"),
      merchant_ids: ["merchant-1"],
    });
    const candidate = result.task.candidates?.[0] as { status?: string } | undefined;
    expect(candidate?.status).toBe("failed");
  });

  it("keeps fuzzy intent behavior: merchant may choose the SKU when buyer supplied none", async () => {
    const result = await serviceFor("10225485016481").requestQuotes({
      intent: intent(),
      merchant_ids: ["merchant-1"],
    });
    const candidate = result.task.candidates?.[0] as { status?: string } | undefined;
    expect(candidate?.status).toBe("succeeded");
  });
});
