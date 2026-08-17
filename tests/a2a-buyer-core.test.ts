/**
 * kiwi-buyer-mcp A2A 轨测试（战略 v2.5 Phase 2 接线 A2A/UCP）。
 *
 * 覆盖：
 *  - KiwiCatalogMerchantIndex listings 感知发现（/v1/listings/search → matching_skus +
 *    agent_card_url）；
 *  - A2AQuoteFetcher 经 agent card 解析 JSONRPC 端点 → 发 rfq envelope → 轮询拿真实
 *    offer（startTestA2aStack + capture 断言入站 action）；
 *  - A2ANegotiator 读 candidate provenance → counter_offer → 拿商家真实回复。
 */
import { describe, expect, it } from "vitest";

import { startTestA2aStack } from "./helpers.js";

const INTENT = {
  intent_id: "intent-a2a-0001",
  intent_type: "purchase",
  items: [{ query: "Test Product", sku: "sku-001", quantity: { value: 2, unit: "台" } }],
  constraints: {
    currency: "CNY",
    deadline: "2026-08-30T18:00:00Z",
  },
  context_projection: {
    disclosure_boundary: "commerce_required",
    projected_fields: ["items", "constraints"],
  },
};

describe("KiwiCatalogMerchantIndex（listings 感知发现）", () => {
  it("商品查询经 /v1/listings/search 返回商家 + matching_skus + agent_card_url", async () => {
    const { KiwiCatalogMerchantIndex } = await import("../src/buyer-core/merchant-index.js");
    const stack = await startTestA2aStack({});
    try {
      const index = new KiwiCatalogMerchantIndex({ baseUrl: stack.catalogUrl });
      const merchants = await index.search("Test Product");
      expect(merchants).toHaveLength(1);
      const merchant = merchants[0]!;
      expect(merchant.merchant_id).toBe("merchant-001");
      expect(merchant.name).toBe("Test Merchant");
      expect(merchant.verified).toBe(true);
      // listings 商品事实 → matching_skus；agents 身份 → agent_card_url（A2A 磋商必需）。
      expect(merchant.matching_skus).toEqual(["sku-001"]);
      expect(merchant.agent_card_url).toBe(`${stack.merchantUrl}/.well-known/agent-card.json`);
      expect(merchant.capabilities).toContain("com.harrylabsj.kiwi.shopping.negotiation");
    } finally {
      await stack.stop();
    }
  });
});

describe("A2AQuoteFetcher（catalog 发现 → A2A 直连 merchant RFQ）", () => {
  it("解析 agent card 端点、发送 rfq envelope、轮询拿真实 offer", async () => {
    const { A2AQuoteFetcher } = await import("../src/buyer-core/a2a-quote-fetcher.js");
    const { KiwiCatalogMerchantIndex } = await import("../src/buyer-core/merchant-index.js");
    const capture: Array<{ action: string; senderIdentity: string; envelope: Record<string, unknown> }> = [];
    const stack = await startTestA2aStack({
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "Test Product", stock: 120 }),
      },
      capture,
    });
    try {
      const index = new KiwiCatalogMerchantIndex({ baseUrl: stack.catalogUrl });
      const merchants = await index.search("Test Product");
      const fetcher = new A2AQuoteFetcher({
        allowPrivateRanges: true,
        skipDnsCheck: true,
        pollIntervalMs: 50,
        timeoutMs: 3000,
      });
      const results = await fetcher.requestQuotes(INTENT, merchants);
      expect(results).toHaveLength(1);
      const result = results[0]!;
      expect(result.status).toBe("succeeded");
      expect(result.provenance?.source).toBe("a2a");
      expect(result.provenance?.negotiation_id).toBeDefined();
      expect(result.provenance?.offer_id).toBeDefined();
      // a2a_endpoint = agent card JSONRPC 端点（供 A2ANegotiator 复用）。
      expect(result.provenance?.a2a_endpoint).toBe(`${stack.merchantUrl}/`);
      // 真实回复：商家 offer 的单价（189 元 → 18900 minor）从回复 envelope 解析。
      const offer = JSON.parse(result.provenance!.reply_text!) as {
        payload: { terms: { items: Array<{ unit_price: { amount_minor: number } }> } };
      };
      expect(offer.payload.terms.items[0]!.unit_price.amount_minor).toBe(18900);
      // 入站第一条是 rfq envelope（capture 数组由 startTestA2aStack 填充）。
      expect(capture[0]?.action).toBe("rfq");
    } finally {
      await stack.stop();
    }
  });

  it("merchant 无 agent_card_url → failed + 可解释 classification", async () => {
    const { A2AQuoteFetcher } = await import("../src/buyer-core/a2a-quote-fetcher.js");
    const fetcher = new A2AQuoteFetcher({ allowPrivateRanges: true, skipDnsCheck: true });
    const results = await fetcher.requestQuotes(INTENT, [
      { merchant_id: "merchant-no-card", name: "无 card 商家", verified: false, capabilities: [] },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.failure?.classification).toBe("unreachable");
  });
});

describe("A2ANegotiator（A2A 直连 merchant CounterOffer）", () => {
  it("读 candidate provenance → counter_offer → 拿商家真实回复", async () => {
    const { A2AQuoteFetcher } = await import("../src/buyer-core/a2a-quote-fetcher.js");
    const { A2ANegotiator } = await import("../src/buyer-core/a2a-negotiator.js");
    const { KiwiCatalogMerchantIndex } = await import("../src/buyer-core/merchant-index.js");
    const stack = await startTestA2aStack({
      productSource: {
        getProduct: async () => ({ price: 189, currency: "CNY", title: "Test Product", stock: 120 }),
      },
    });
    try {
      const index = new KiwiCatalogMerchantIndex({ baseUrl: stack.catalogUrl });
      const merchants = await index.search("Test Product");
      const fetcher = new A2AQuoteFetcher({
        allowPrivateRanges: true,
        skipDnsCheck: true,
        pollIntervalMs: 50,
        timeoutMs: 3000,
      });
      const fetched = await fetcher.requestQuotes(INTENT, merchants);
      expect(fetched[0]?.status).toBe("succeeded");

      const negotiator = new A2ANegotiator({
        allowPrivateRanges: true,
        skipDnsCheck: true,
        defaultDiscountRate: 0.1,
      });
      const step = await negotiator.negotiate(
        "task-a2a-001",
        INTENT,
        { round: 1, action: "counter_offer", summary: "还价 10%" },
        [fetched[0]!] as unknown as Array<Record<string, unknown>>,
      );
      // 商家对 counter 有真实回复（step.reply），且不是"无上下文"失败。
      expect(step.reply).toBeDefined();
      expect(step.summary).not.toContain("无 A2A 会话上下文");
      const reply = JSON.parse(step.reply!) as { action?: string };
      expect(reply.action).toBeDefined();
    } finally {
      await stack.stop();
    }
  });

  it("缺 A2A 会话上下文 → 追加可解释 summary，不编造还价", async () => {
    const { A2ANegotiator } = await import("../src/buyer-core/a2a-negotiator.js");
    const negotiator = new A2ANegotiator({ allowPrivateRanges: true, skipDnsCheck: true });
    const step = await negotiator.negotiate("task-a2a-002", INTENT, {
      round: 1,
      action: "counter_offer",
      summary: "还价",
    }, []);
    expect(step.reply).toBeUndefined();
    expect(step.summary).toContain("无 A2A 会话上下文");
  });
});
