/**
 * RFQ SKU 选择：用户明确指定的 SKU 不能被 matching_skus[0] 覆盖。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { A2AQuoteFetcher } from "../src/buyer-core/a2a-quote-fetcher.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { startTestA2aStack, type CapturedInbound } from "./helpers.js";

const dirs: string[] = [];
function protocolOptions() {
  const dir = mkdtempSync(path.join(tmpdir(), "a2a-quote-sku-"));
  dirs.push(dir);
  return { protocolStateDir: dir, localBuyerAgentId: "buyer-sku-test" };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const INTENT = {
  intent_id: "intent-sku-1",
  intent_type: "purchase",
  items: [{ query: "Test Product", sku: "sku-001", quantity: { value: 1, unit: "台" } }],
  constraints: { currency: "CNY", deadline: "2027-12-31T18:00:00Z" },
};
function context() {
  return {
    taskId: "task-sku-1",
    createdAt: new Date().toISOString(),
    intentBindingDigest: contentDigest(INTENT),
  };
}

function merchant(matchingSkus: string[] | undefined, cardUrl: string) {
  return {
    merchant_id: "merchant-sku",
    name: "SKU 商家",
    verified: true,
    capabilities: [],
    agent_card_url: cardUrl,
    ...(matchingSkus !== undefined ? { matching_skus: matchingSkus } : {}),
  };
}

function firstRfqSku(capture: CapturedInbound[]): unknown {
  const payload = capture[0]?.envelope.payload as
    | { items?: Array<{ sku?: unknown }> }
    | undefined;
  return payload?.items?.[0]?.sku;
}

describe("A2AQuoteFetcher：明确 SKU 不能被发现结果覆盖", () => {
  it("明确的 SKU 不在商家 matching_skus 中：安全拒绝且不发网络请求", async () => {
    let hits = 0;
    const fetcher = new A2AQuoteFetcher({
      allowPrivateRanges: true,
      skipDnsCheck: true,
      fetchImpl: (async () => {
        hits += 1;
        return Response.json({});
      }) as typeof fetch,
    });
    const results = await fetcher.requestQuotes(INTENT, [
      merchant(["SKU-OTHER"], "https://merchant.example/.well-known/agent-card.json"),
    ]);
    expect(hits).toBe(0);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("invalid_request");
    expect(results[0]?.failure?.retryable).toBe(false);
  });

  it("明确 SKU 命中多个 matching_skus 中的第二项：RFQ 使用用户 SKU", async () => {
    const capture: CapturedInbound[] = [];
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
      capture,
      productSource: {
        getProduct: async () => ({
          price: 189,
          currency: "CNY",
          title: "Test Product",
          stock: 10,
          unit: "台",
          source_evidence: { system: "owned-test-fixture" },
        }),
      },
    });
    try {
      const fetcher = new A2AQuoteFetcher({
        ...protocolOptions(),
        allowPrivateRanges: true,
        skipDnsCheck: true,
        pollIntervalMs: 20,
        timeoutMs: 3000,
      });
      const results = await fetcher.requestQuotes(
        INTENT,
        [merchant(["SKU-OTHER", "sku-001"], `${stack.merchantUrl}/.well-known/agent-card.json`)],
        context(),
      );
      expect(results[0]?.status).toBe("succeeded");
      expect(firstRfqSku(capture)).toBe("sku-001");
    } finally {
      await stack.stop();
    }
  });

  it("未明确 SKU、商家有多个匹配商品：保持既有行为取第一个匹配 SKU", async () => {
    const capture: CapturedInbound[] = [];
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
      capture,
      productSource: {
        getProduct: async () => ({
          price: 189,
          currency: "CNY",
          title: "Test Product",
          stock: 10,
          unit: "台",
          source_evidence: { system: "owned-test-fixture" },
        }),
      },
    });
    try {
      const intent = {
        ...INTENT,
        items: [{ query: "Test Product", quantity: { value: 1, unit: "台" } }],
      };
      const fetcher = new A2AQuoteFetcher({
        ...protocolOptions(),
        allowPrivateRanges: true,
        skipDnsCheck: true,
        pollIntervalMs: 20,
        timeoutMs: 3000,
      });
      const results = await fetcher.requestQuotes(
        intent,
        [merchant(["sku-001", "SKU-2"], `${stack.merchantUrl}/.well-known/agent-card.json`)],
        {
          taskId: "task-sku-2",
          createdAt: new Date().toISOString(),
          intentBindingDigest: contentDigest(intent),
        },
      );
      expect(results[0]?.status).toBe("succeeded");
      expect(firstRfqSku(capture)).toBe("sku-001");
    } finally {
      await stack.stop();
    }
  });

  it("明确 SKU 但商家没有 matching_skus：信任用户输入并正常询价", async () => {
    const capture: CapturedInbound[] = [];
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
      capture,
      productSource: {
        getProduct: async () => ({
          price: 189,
          currency: "CNY",
          title: "Test Product",
          stock: 10,
          unit: "台",
          source_evidence: { system: "owned-test-fixture" },
        }),
      },
    });
    try {
      const fetcher = new A2AQuoteFetcher({
        ...protocolOptions(),
        allowPrivateRanges: true,
        skipDnsCheck: true,
        pollIntervalMs: 20,
        timeoutMs: 3000,
      });
      const results = await fetcher.requestQuotes(
        INTENT,
        [merchant(undefined, `${stack.merchantUrl}/.well-known/agent-card.json`)],
        context(),
      );
      expect(results[0]?.status).toBe("succeeded");
      expect(firstRfqSku(capture)).toBe("sku-001");
    } finally {
      await stack.stop();
    }
  });
});
