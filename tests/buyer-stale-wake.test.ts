/**
 * 隔离回归：stale WorkBuddy 商家的按需唤醒。
 * 唤醒只是公开 GET；只有 catalog 重新读到商家心跳后，买家才允许询价。
 * 不访问生产，不读写凭据。
 */
import { describe, expect, it } from "vitest";
import { KiwiBuyerService, type MerchantIndex, type MerchantRecord, type QuoteCandidateInput } from "../src/buyer-core/service.js";
import { TaskApprovalStore } from "../src/buyer-core/store.js";
import { WorkBuddyStaleMerchantWake } from "../src/buyer-core/stale-merchant-wake.js";

const policy = {
  policy_id: "stale-wake-test",
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
    allowed_merchants: ["merchant-stale"],
    allowed_currencies: ["CNY"],
    max_unit_price: { currency: "CNY", amount_minor: 20000 },
    max_total_price: { currency: "CNY", amount_minor: 30000 },
    max_quantity: { value: 10, unit: "盒" },
  },
};
const intent = {
  intent_id: "stale-wake-intent",
  intent_type: "inquiry",
  items: [{ query: "测试商品", sku: "sku-1", quantity: { value: 2, unit: "盒" } }],
};
const quote: QuoteCandidateInput = {
  merchant_id: "merchant-stale",
  status: "succeeded",
  terms: {
    currency: "CNY",
    items: [{ sku: "sku-1", quantity_value: 2, quantity_unit: "盒", unit_price_minor: 7000 }],
    total_price_minor: 14000,
  },
};
function record(fresh: boolean): MerchantRecord {
  return {
    merchant_id: "merchant-stale",
    name: "stale fixture",
    verified: true,
    capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"],
    agent_card_url: "https://fixture.app.workbuddy.host/agent-card.json",
    freshness_state: fresh ? "fresh" : "stale",
    inquiry_available: fresh,
  };
}
function serviceFor(options: {
  fresh: () => boolean;
  onWake: () => void;
  delayMs?: number;
  staleWakeTimeoutMs?: number;
  quoteFetcher?: { requestQuotes(): Promise<QuoteCandidateInput[]> };
}) {
  const store = new TaskApprovalStore({ dbPath: ":memory:" });
  const index: MerchantIndex = {
    async search() {
      return [record(options.fresh())];
    },
    async resolveById() {
      return record(options.fresh());
    },
  };
  return new KiwiBuyerService({
    store,
    principal: "buyer:test",
    buyerAgentId: "buyer:test",
    sessionId: "stale-wake",
    delegationPolicy: policy,
    merchantIndex: index,
    quoteFetcher: options.quoteFetcher ?? { async requestQuotes() { return [quote]; } },
    staleWake: async () => {
      options.onWake();
      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      return true;
    },
    ...(options.staleWakeTimeoutMs !== undefined
      ? { staleWakeTimeoutMs: options.staleWakeTimeoutMs }
      : {}),
    now: () => "2026-11-04T04:20:00.000Z",
  });
}
function candidates(result: Awaited<ReturnType<KiwiBuyerService["requestQuotes"]>>) {
  return result.task.candidates as Array<{ status?: string }> | undefined;
}

describe("stale merchant on-demand wake", () => {
  it("wake alone never marks fresh; heartbeat-backed catalog re-read is required", async () => {
    let fresh = false;
    let wakes = 0;
    const service = serviceFor({ fresh: () => fresh, onWake: () => { wakes += 1; } });
    await expect(
      service.requestQuotes({ intent, merchant_ids: ["merchant-stale"] }),
    ).rejects.toMatchObject({ code: "merchant_offline" });
    expect(wakes).toBe(1);
  });

  it("allows the quote only after the catalog reports fresh following wake", async () => {
    let fresh = false;
    let wakes = 0;
    const service = serviceFor({ fresh: () => fresh, onWake: () => { fresh = true; wakes += 1; } });
    const result = await service.requestQuotes({ intent, merchant_ids: ["merchant-stale"] });
    expect(wakes).toBe(1);
    expect(candidates(result)?.[0]?.status).toBe("succeeded");
  });

  it("rate-limits a still-stale merchant: a second immediate attempt does not wake again", async () => {
    let wakes = 0;
    const service = serviceFor({ fresh: () => false, onWake: () => { wakes += 1; } });
    await expect(service.requestQuotes({ intent, merchant_ids: ["merchant-stale"] })).rejects.toMatchObject({ code: "merchant_offline" });
    await expect(service.requestQuotes({ intent, merchant_ids: ["merchant-stale"] })).rejects.toMatchObject({ code: "merchant_offline" });
    expect(wakes).toBe(1);
  });

  it("singleflights concurrent wake attempts", async () => {
    let fresh = false;
    let wakes = 0;
    const service = serviceFor({
      fresh: () => fresh,
      onWake: () => { wakes += 1; fresh = true; },
      delayMs: 30,
    });
    const [a, b] = await Promise.all([
      service.requestQuotes({ intent, merchant_ids: ["merchant-stale"] }),
      service.requestQuotes({ intent, merchant_ids: ["merchant-stale"] }),
    ]);
    expect(wakes).toBe(1);
    expect(candidates(a)?.[0]?.status).toBe("succeeded");
    expect(candidates(b)?.[0]?.status).toBe("succeeded");
  });
});

  it("refreshes a stale search result only after catalog heartbeat re-read", async () => {
    let fresh = false;
    let wakes = 0;
    const service = serviceFor({ fresh: () => fresh, onWake: () => { fresh = true; wakes += 1; } });
    const result = await service.search({ query: "测试商品" });
    expect(wakes).toBe(1);
    expect(result.merchants[0]?.freshness_state).toBe("fresh");
    expect(result.merchants[0]?.inquiry_available).toBe(true);
  });

  it("bounds a hanging wake with staleWakeTimeoutMs and never marks fresh locally", async () => {
    let wakes = 0;
    const service = serviceFor({
      fresh: () => false,
      onWake: () => { wakes += 1; },
      delayMs: 200,
      staleWakeTimeoutMs: 10,
    });
    await expect(service.requestQuotes({ intent, merchant_ids: ["merchant-stale"] })).rejects.toMatchObject({ code: "merchant_offline" });
    expect(wakes).toBe(1);
  });

  it("does not wake a merchant with only an M0 public profile", async () => {
    let wakes = 0;
    const store = new TaskApprovalStore({ dbPath: ":memory:" });
    const m0: MerchantRecord = {
      merchant_id: "merchant-m0",
      name: "M0",
      verified: false,
      capabilities: [],
      source_kind: "merchant_declared",
      freshness_state: "stale",
      inquiry_available: false,
    };
    const service = new KiwiBuyerService({
      store,
      principal: "buyer:test",
      buyerAgentId: "buyer:test",
      sessionId: "m0",
      delegationPolicy: { ...policy, limits: { ...policy.limits, allowed_merchants: ["merchant-m0"] } },
      merchantIndex: {
        async search() { return [m0]; },
        async resolveById() { return m0; },
      },
      quoteFetcher: { async requestQuotes() { return [quote]; } },
      staleWake: async () => { wakes += 1; return true; },
      now: () => "2026-11-04T04:20:00.000Z",
    });
    await expect(service.requestQuotes({ intent: { ...intent, intent_id: "m0-intent" }, merchant_ids: ["merchant-m0"] })).rejects.toMatchObject({ code: "merchant_inquiry_unavailable" });
    expect(wakes).toBe(0);
  });

describe("WorkBuddy wake probe SSRF boundaries", () => {
  function response(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }
  it("sends /livez without sharecode and does not treat 403 as freshness", async () => {
    const calls: Array<{ url: string; init?: NonNullable<Parameters<typeof fetch>[1]> }> = [];
    const wake = new WorkBuddyStaleMerchantWake({
      skipDnsCheck: true,
      fetchImpl: (async (url: URL, init?: NonNullable<Parameters<typeof fetch>[1]>) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/agent-card.json")) {
          return response({
            url: "https://fixture.app.workbuddy.host",
            supportedInterfaces: [{ url: "https://fixture.app.workbuddy.host/a2a" }],
          });
        }
        return response({ ok: true }, 403);
      }) as typeof fetch,
    });
    // true only means the probe request was sent; it never mutates freshness.
    await expect(wake.wake(record(false))).resolves.toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://fixture.app.workbuddy.host/agent-card.json",
      "https://fixture.app.workbuddy.host/livez",
    ]);
    expect(calls.every((c) => c.init?.redirect === "error")).toBe(true);
    expect(calls.some((c) => c.url.includes("sharecode"))).toBe(false);
  });

  it("rejects private/literal-IP card targets without fetching", async () => {
    let calls = 0;
    const wake = new WorkBuddyStaleMerchantWake({
      skipDnsCheck: true,
      fetchImpl: (async () => { calls += 1; return response({}); }) as typeof fetch,
    });
    const privateRecord = { ...record(false), agent_card_url: "https://127.0.0.1/card.json" };
    await expect(wake.wake(privateRecord)).resolves.toBe(false);
    expect(calls).toBe(0);
  });

  it("rejects a card that advertises only non-WorkBuddy endpoints", async () => {
    const calls: string[] = [];
    const wake = new WorkBuddyStaleMerchantWake({
      skipDnsCheck: true,
      fetchImpl: (async (url: URL) => {
        calls.push(String(url));
        return response({ url: "https://other.example/a2a", supportedInterfaces: [] });
      }) as typeof fetch,
    });
    await expect(wake.wake(record(false))).resolves.toBe(false);
    expect(calls).toEqual(["https://fixture.app.workbuddy.host/agent-card.json"]);
  });
});
