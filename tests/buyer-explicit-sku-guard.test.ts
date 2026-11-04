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
    const candidates = result.task.candidates as
      | Array<{ status?: string; failure?: { detail?: string } }>
      | undefined;
    const candidate = candidates?.[0];
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
    const candidates = result.task.candidates as Array<{ status?: string }> | undefined;
    const candidate = candidates?.[0];
    expect(candidate?.status).toBe("failed");
  });

  it("rejects a mismatched quote on the recovery path as well", async () => {
    const store = new TaskApprovalStore({ dbPath: ":memory:" });
    const service = new KiwiBuyerService({
      store,
      principal: "buyer:test",
      buyerAgentId: "buyer:test",
      sessionId: "explicit-sku-recovery",
      delegationPolicy: policy,
      quoteFetcher: {
        async requestQuotes() {
          return [
            {
              merchant_id: "merchant-1",
              status: "failed",
              failure: {
                classification: "protocol_error",
                retryable: false,
                detail: "remote result unknown",
              },
            },
          ];
        },
        async recoverQuotes() {
          return [
            {
              merchant_id: "merchant-1",
              status: "succeeded",
              terms: {
                currency: "CNY",
                items: [
                  {
                    sku: "10225485016481",
                    quantity_value: 2,
                    quantity_unit: "盒",
                    unit_price_minor: 7000,
                  },
                ],
                total_price_minor: 14000,
              },
            },
          ];
        },
      },
      now: () => "2026-11-04T02:30:00.000Z",
    });
    const input = {
      intent: intent("10223889834191"),
      merchant_ids: ["merchant-1"],
      idempotency_key: "explicit-sku-recovery-key",
    };
    const first = await service.requestQuotes(input);
    expect(first.created).toBe(true);
    const recovered = await service.requestQuotes(input);
    const candidates = recovered.task.candidates as
      | Array<{ status?: string; terms?: unknown; failure?: { detail?: string } }>
      | undefined;
    expect(candidates?.[0]?.status).toBe("failed");
    expect(candidates?.[0]?.terms).toBeUndefined();
  });

  it("multi-item intent retains the existing first-item A2A boundary", async () => {
    const result = await serviceFor("10223889834191").requestQuotes({
      intent: {
        ...intent("10223889834191"),
        items: [
          { query: "测试商品", sku: "10223889834191", quantity: { value: 2, unit: "盒" } },
          { query: "第二件", sku: "second-sku", quantity: { value: 1, unit: "盒" } },
        ],
      },
      merchant_ids: ["merchant-1"],
    });
    const candidates = result.task.candidates as Array<{ status?: string }> | undefined;
    // A2A/KNP currently sends and admits one requested line; the first item's
    // SKU remains the binding boundary and existing behavior is unchanged.
    expect(candidates?.[0]?.status).toBe("succeeded");
  });

  it("keeps fuzzy intent behavior: merchant may choose the SKU when buyer supplied none", async () => {
    const result = await serviceFor("10225485016481").requestQuotes({
      intent: intent(),
      merchant_ids: ["merchant-1"],
    });
    const candidates = result.task.candidates as Array<{ status?: string }> | undefined;
    const candidate = candidates?.[0];
    expect(candidate?.status).toBe("succeeded");
  });
});
