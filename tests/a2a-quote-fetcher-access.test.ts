/**
 * 买家报价门禁接线：缺少 runtime_access 时不能提前跳过目录开放询价中继，
 * 同时普通商家直连、缺失信息与协议恢复路径保持原语义。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { A2AQuoteFetcher } from "../src/buyer-core/a2a-quote-fetcher.js";
import { OpenInquirySessionSigner } from "../src/a2a/open-inquiry-session.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { startTestA2aStack } from "./helpers.js";

const dirs: string[] = [];
function protocolOptions() {
  const dir = mkdtempSync(path.join(tmpdir(), "a2a-quote-access-"));
  dirs.push(dir);
  return { protocolStateDir: dir, localBuyerAgentId: "buyer-access-test" };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const INTENT = {
  intent_id: "intent-access-1",
  intent_type: "purchase",
  items: [{ query: "Test Product", sku: "sku-001", quantity: { value: 2, unit: "台" } }],
  constraints: { currency: "CNY", deadline: "2027-12-31T18:00:00Z" },
};
function context() {
  return {
    taskId: "task-access-1",
    createdAt: new Date().toISOString(),
    intentBindingDigest: contentDigest(INTENT),
  };
}

function openRelayFetch(calls: string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = JSON.parse(String(init?.body ?? "{}")) as { id?: unknown };
    return Response.json(
      { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "open inquiry synthetic" } },
      { status: 502 },
    );
  }) as typeof fetch;
}

const NO_RUNTIME_ACCESS = {
  merchant_id: "merchant-open",
  name: "免登录询价商家",
  verified: true,
  capabilities: [],
  catalog_agent_id: "cagt_open",
};

describe("A2AQuoteFetcher：runtime_access 缺失与中继", () => {
  it("缺少 runtime_access 时仍使用开放询价中继，不提前跳过", async () => {
    const calls: string[] = [];
    const endpoint = "https://merchant.example/a2a";
    const fetcher = new A2AQuoteFetcher({
      ...protocolOptions(),
      allowPrivateRanges: true,
      skipDnsCheck: true,
      merchantAccess: {
        forEndpoint: async () => null,
        forMerchant: async () => ({
          sendUrlFor: (url: string) => url,
          openInquiry: {
            endpoint,
            signer: new OpenInquirySessionSigner(),
            fetchImpl: openRelayFetch(calls),
          },
        }),
      },
    });

    const results = await fetcher.requestQuotes(INTENT, [NO_RUNTIME_ACCESS], context());
    // 关键回归：不能在 accessForMerchant 里因 runtime_access 缺失直接返回 null。
    expect(calls).toContain(endpoint);
    expect(results[0]?.failure?.detail).not.toBe("merchant has no agent card URL");
    expect(results[0]?.failure?.classification).toBe("protocol_error");
  });

  it("普通商家直连：resolver 回查失败不阻止无 runtime_access 的 agent card 直连", async () => {
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
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
        merchantAccess: {
          forEndpoint: async () => null,
          forMerchant: async () => {
            throw new Error("open inquiry lookup failed");
          },
        },
      });
      const results = await fetcher.requestQuotes(
        INTENT,
        [{
          ...NO_RUNTIME_ACCESS,
          agent_card_url: `${stack.merchantUrl}/.well-known/agent-card.json`,
        }],
        context(),
      );
      expect(results[0]?.status).toBe("succeeded");
    } finally {
      await stack.stop();
    }
  });

  it("未声明 runtime_access 时不套用 legacy 分享码传输", async () => {
    const stack = await startTestA2aStack({
      now: () => new Date().toISOString(),
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
      let sendUrlCalls = 0;
      const fetcher = new A2AQuoteFetcher({
        ...protocolOptions(),
        allowPrivateRanges: true,
        skipDnsCheck: true,
        pollIntervalMs: 20,
        timeoutMs: 3000,
        merchantAccess: {
          forEndpoint: async () => null,
          forMerchant: async () => ({
            sendUrlFor: (url: string) => {
              sendUrlCalls += 1;
              return `${url}?sharecode=should-not-be-used`;
            },
          }),
        },
      });
      const results = await fetcher.requestQuotes(
        INTENT,
        [{
          ...NO_RUNTIME_ACCESS,
          agent_card_url: `${stack.merchantUrl}/.well-known/agent-card.json`,
        }],
        context(),
      );
      expect(results[0]?.status).toBe("succeeded");
      expect(sendUrlCalls).toBe(0);
    } finally {
      await stack.stop();
    }
  });

  it("缺少 runtime_access 且无 agent card 时仍按直连语义报缺卡（不误报 access_unavailable）", async () => {
    const fetcher = new A2AQuoteFetcher({
      ...protocolOptions(),
      merchantAccess: { forEndpoint: async () => null, forMerchant: async () => null },
    });
    const results = await fetcher.requestQuotes(INTENT, [NO_RUNTIME_ACCESS], context());
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("unreachable");
    expect(results[0]?.failure?.detail).toBe("merchant has no agent card URL");
  });

  it("缺少 runtime_access 但 card 指向 WorkBuddy：resolver 异常时 fail-closed，不静默直连", async () => {
    let hits = 0;
    const fetcher = new A2AQuoteFetcher({
      ...protocolOptions(),
      fetchImpl: (async () => {
        hits += 1;
        return Response.json({});
      }) as typeof fetch,
      merchantAccess: {
        forEndpoint: async () => null,
        forMerchant: async () => {
          throw new Error("open inquiry lookup failed");
        },
      },
    });
    const results = await fetcher.requestQuotes(INTENT, [{
      ...NO_RUNTIME_ACCESS,
      agent_card_url: "https://acme.app.workbuddy.host/.well-known/agent-card.json",
    }], context());
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
    expect(hits).toBe(0);
  });

  it("缺少 runtime_access 但 card 指向 WorkBuddy：resolver 为空或缺失时也不直连", async () => {
    const workbuddyMerchant = {
      ...NO_RUNTIME_ACCESS,
      agent_card_url: "https://acme.app.workbuddy.host/.well-known/agent-card.json",
    };
    for (const merchantAccess of [
      { forEndpoint: async () => null, forMerchant: async () => null },
      undefined,
    ]) {
      let hits = 0;
      const fetcher = new A2AQuoteFetcher({
        ...protocolOptions(),
        fetchImpl: (async () => {
          hits += 1;
          return Response.json({});
        }) as typeof fetch,
        ...(merchantAccess !== undefined ? { merchantAccess } : {}),
      });
      const results = await fetcher.requestQuotes(INTENT, [workbuddyMerchant], context());
      expect(results[0]?.failure?.classification).toBe("access_unavailable");
      expect(hits).toBe(0);
    }
  });

  it("恢复路径按端点回查开放询价路线", async () => {
    const calls: string[] = [];
    const endpoint = "https://merchant.example/a2a";
    let forEndpointCalls = 0;
    const fetcher = new A2AQuoteFetcher({
      ...protocolOptions(),
      allowPrivateRanges: true,
      skipDnsCheck: true,
      merchantAccess: {
        forMerchant: async () => null,
        forEndpoint: async (endpointUrl: string) => {
          forEndpointCalls += 1;
          return {
            sendUrlFor: (url: string) => url,
            openInquiry: {
              endpoint: endpointUrl,
              signer: new OpenInquirySessionSigner(),
              fetchImpl: openRelayFetch(calls),
            },
          };
        },
      },
    });
    // 只注入恢复循环，验证 forEndpoint → openInquiry 传输的接线；不重放新请求。
    (fetcher as unknown as { recovery: unknown }).recovery = {
      recover: async (
        _context: unknown,
        get: (endpoint: string, taskId: string) => Promise<unknown>,
      ) => {
        await get(endpoint, "task-1").catch(() => undefined);
        return [];
      },
    };
    const results = await fetcher.recoverQuotes(context());
    expect(results).toEqual([]);
    expect(forEndpointCalls).toBe(1);
    expect(calls).toContain(endpoint);
  });
});
