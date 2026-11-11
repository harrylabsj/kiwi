/**
 * 组合层回归：需要分享码且中继已接线的商家，在中继拒绝授权/撤销（404）后
 * 不得回退为带分享码直连；已加白/无 runtime_access 商家的原有直连不受影响。
 * 追加 S2 覆盖：runtime_access 投影缺失但目录仍有 active 分享码时，任何主机
 * 都不得带码直连；只有目录明确 404（无 active 配置）才给 WorkBuddy 主机
 * 显式 direct 信号。403/会话拒绝仍按未知处理，不据此推断白名单。
 *
 * 这里直接构造真实 buildBuyerService，只替换两个目录网络源：
 *  - OpenInquirySource：模拟 /public-inquiry 的 404（未开通/撤销统一口径）；
 *  - MerchantAccessSource：模拟目录仍保存着该商家的分享码配置。
 * 这样能钉住 build-service 的 forMerchant 组合顺序，而不是只测 fetcher 或 helper。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relaySources = vi.hoisted(() => ({
  openGet: vi.fn(),
  accessGet: vi.fn(),
}));

vi.mock("../src/discovery/catalog-source/open-inquiry.js", () => ({
  OpenInquirySource: class {
    async get(agentId: string, merchantId: string) {
      return await relaySources.openGet(agentId, merchantId);
    }
  },
}));

vi.mock("../src/discovery/catalog-source/merchant-access.js", () => ({
  MerchantAccessSource: class {
    async get(agentId: string, options: { runtimeOrigin?: string }) {
      return await relaySources.accessGet(agentId, options);
    }
  },
}));

import { OpenInquirySessionSigner } from "../src/a2a/open-inquiry-session.js";
import { A2AQuoteFetcher } from "../src/buyer-core/a2a-quote-fetcher.js";
import { buildBuyerService } from "../src/buyer-core/build-service.js";
import type { ProtocolTaskContext } from "../src/buyer-core/protocol-recovery.js";
import type { MerchantRecord, QuoteCandidateInput } from "../src/buyer-core/service.js";
import { DEFAULT_DELEGATION_POLICY } from "../src/mcp/cli.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { startTestA2aStack } from "./helpers.js";

const CATALOG = "https://catalog.kiwi.harrylabsj.com";
const INTENT = {
  intent_id: "intent-relay-denial-1",
  intent_type: "purchase",
  items: [{ query: "Test Product", sku: "sku-001", quantity: { value: 1, unit: "台" } }],
  constraints: { currency: "CNY", deadline: "2027-12-31T18:00:00Z" },
};
const CONTEXT: ProtocolTaskContext = {
  taskId: "task-relay-denial-1",
  createdAt: new Date().toISOString(),
  intentBindingDigest: contentDigest(INTENT),
};
const RUNTIME_ACCESS = {
  provider: "workbuddy",
  access_mode: "share_parameter",
  parameter_name: "sharecode",
  config_version: 1,
  adapter_version: "workbuddy-share-v1",
  auth_mode: "signature",
} as const;
const SHARE_CONFIG = {
  catalog_agent_id: "cagt_declared",
  runtime_origin: "https://merchant.example",
  secret_value: "SYNTHETIC-CODE",
  provider: "workbuddy",
  access_mode: "share_parameter",
  parameter_name: "sharecode",
  config_version: 1,
  adapter_version: "workbuddy-share-v1",
  auth_mode: "signature",
  validated_at: "2026-11-11T00:00:00Z",
  updated_at: "2026-11-11T00:00:00Z",
};
const DECLARED_MERCHANT: MerchantRecord = {
  merchant_id: "merchant-declared",
  name: "需要分享码的商家",
  verified: true,
  capabilities: [],
  catalog_agent_id: "cagt_declared",
  agent_card_url: "https://merchant.example/.well-known/agent-card.json",
  runtime_access: RUNTIME_ACCESS,
};

const dirs: string[] = [];
function buildService() {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-denial-"));
  dirs.push(dir);
  return buildBuyerService({
    dbPath: ":memory:",
    protocolStateDir: dir,
    principal: "buyer:relay-denial",
    buyerAgentId: "buyer-agent:relay-denial",
    sessionId: "relay-denial",
    policy: { ...DEFAULT_DELEGATION_POLICY, principal: "buyer:relay-denial" },
    catalogUrl: CATALOG,
    catalogSessionToken: "synthetic-buyer-session",
    a2aAllowPrivateRanges: true,
    a2aSkipDnsCheck: true,
    a2aTimeoutMs: 3000,
  });
}

function requestQuotes(
  service: ReturnType<typeof buildBuyerService>,
  merchants: MerchantRecord[],
): Promise<QuoteCandidateInput[]> {
  const fetcher = (service as unknown as {
    quoteFetcher: {
      requestQuotes(
        intent: Record<string, unknown>,
        merchants: MerchantRecord[],
        context?: ProtocolTaskContext,
      ): Promise<QuoteCandidateInput[]>;
    };
  }).quoteFetcher;
  return fetcher.requestQuotes(INTENT, merchants, CONTEXT);
}

beforeEach(() => {
  relaySources.openGet.mockReset();
  relaySources.accessGet.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("开放询价中继拒绝后不得回退带码直连", () => {
  it("声明 runtime_access 的商家：中继 404 时不取码、不直连，fail-closed", async () => {
    relaySources.openGet.mockResolvedValue(null);
    // 目录仍保存着该商家的分享码；修复只拒绝使用它，不删除/不推断白名单。
    relaySources.accessGet.mockResolvedValue(SHARE_CONFIG);
    const network = vi.fn(() => {
      throw new Error("network must not be used after relay denial");
    });
    vi.stubGlobal("fetch", network);

    const results = await requestQuotes(buildService(), [DECLARED_MERCHANT]);

    expect(relaySources.openGet).toHaveBeenCalledWith("cagt_declared", "merchant-declared");
    // 关键断言：中继 null 后不能再去目录取分享码（否则会拼出带码直连）。
    expect(relaySources.accessGet).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
  });

  it("声明 runtime_access 的商家：中继不可用（抛错）时同样不取码、不直连", async () => {
    relaySources.openGet.mockRejectedValue(new Error("relay lookup unavailable"));
    relaySources.accessGet.mockResolvedValue(SHARE_CONFIG);
    const network = vi.fn(() => {
      throw new Error("network must not be used after relay failure");
    });
    vi.stubGlobal("fetch", network);

    const results = await requestQuotes(buildService(), [DECLARED_MERCHANT]);

    // 组合层在中继回查抛错时直接失败，不会继续向目录取分享码。
    expect(relaySources.accessGet).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
  });

  it("声明 runtime_access 的商家：中继可用时仍优先走中继，不触达分享码配置", async () => {
    const relayCalls: string[] = [];
    relaySources.openGet.mockResolvedValue({
      endpoint: "https://merchant.example/a2a",
      signer: new OpenInquirySessionSigner(),
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        relayCalls.push(typeof input === "string" ? input : (input as URL).href);
        const body = JSON.parse(String(init?.body ?? "{}")) as { id?: unknown };
        return Response.json(
          { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "relay synthetic" } },
          { status: 502 },
        );
      }) as typeof fetch,
    });
    relaySources.accessGet.mockResolvedValue(SHARE_CONFIG);

    const results = await requestQuotes(buildService(), [DECLARED_MERCHANT]);

    expect(relayCalls).toHaveLength(1);
    expect(relaySources.accessGet).not.toHaveBeenCalled();
    expect(results[0]?.failure?.classification).toBe("protocol_error");
  });

  it("已加白/无 runtime_access 的商家：中继 404 后仍保留原无码直连", async () => {
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
      relaySources.openGet.mockResolvedValue(null);
      relaySources.accessGet.mockResolvedValue(null);

      const results = await requestQuotes(buildService(), [{
        merchant_id: "merchant-allowlisted",
        name: "已加白无码商家",
        verified: true,
        capabilities: [],
        catalog_agent_id: "cagt_allowlisted",
        agent_card_url: `${stack.merchantUrl}/.well-known/agent-card.json`,
      }]);

      expect(relaySources.openGet).toHaveBeenCalledWith("cagt_allowlisted", "merchant-allowlisted");
      // 无 runtime_access 的商家仍会回查目录（兼容旧路径），没有配置时继续直连。
      expect(relaySources.accessGet).toHaveBeenCalledTimes(1);
      expect(results[0]?.status).toBe("succeeded");
    } finally {
      await stack.stop();
    }
  });

  it("S2：未声明 runtime_access + WB 主机 + 目录仍有 active 分享码：中继 404 后不带码直连，fail-closed", async () => {
    relaySources.openGet.mockResolvedValue(null);
    relaySources.accessGet.mockResolvedValue({
      ...SHARE_CONFIG,
      catalog_agent_id: "cagt_undeclared_wb",
      runtime_origin: "https://acme.app.workbuddy.host",
    });
    const network = vi.fn(() => {
      throw new Error("no network request may be made with or without a share code");
    });
    vi.stubGlobal("fetch", network);

    const results = await requestQuotes(buildService(), [{
      merchant_id: "merchant-undeclared-wb",
      name: "投影缺失但目录仍有码的 WB 商家",
      verified: true,
      capabilities: [],
      catalog_agent_id: "cagt_undeclared_wb",
      agent_card_url: "https://acme.app.workbuddy.host/.well-known/agent-card.json",
    }]);

    // 目录仍有 active 分享码，说明它仍是分享码商家；中继 404 时不能把码交给
    // fetcher，更不能对 WB 主机带码直连。这里连无码直连也不应尝试。
    expect(relaySources.accessGet).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
  });

  it("已加白 WB 主机：目录明确 404（无 active 分享码）时生成显式 direct 信号", async () => {
    relaySources.openGet.mockResolvedValue(null);
    relaySources.accessGet.mockResolvedValue(null);
    const service = buildService();
    const quoteFetcher = (service as unknown as {
      quoteFetcher: {
        merchantAccess: {
          forMerchant(merchant: MerchantRecord): Promise<{ direct?: true; sendUrlFor(url: string): string } | null>;
        };
      };
    }).quoteFetcher;

    const access = await quoteFetcher.merchantAccess.forMerchant({
      merchant_id: "merchant-allowlisted-wb",
      name: "已加白 WB 商家",
      verified: true,
      capabilities: [],
      catalog_agent_id: "cagt_allowlisted_wb",
      agent_card_url: "https://acme.app.workbuddy.host/.well-known/agent-card.json",
    });

    expect(relaySources.accessGet).toHaveBeenCalledTimes(1);
    expect(access?.direct).toBe(true);
    expect(access?.sendUrlFor("https://merchant.example/a2a")).toBe("https://merchant.example/a2a");
  });

  it("fetcher 接受显式 direct 信号：WB 主机无码直连，线上零分享码", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "relay-s2-direct-"));
    dirs.push(dir);
    const calls: string[] = [];
    const network = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("agent-card.json")) {
        return Response.json({
          name: "allowlisted-workbuddy",
          url: "https://merchant.example/a2a",
          supportedInterfaces: [{ protocolBinding: "JSONRPC", url: "https://merchant.example/a2a" }],
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { id?: unknown };
      return Response.json(
        { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "synthetic direct" } },
        { status: 502 },
      );
    }) as typeof fetch;
    const fetcher = new A2AQuoteFetcher({
      protocolStateDir: dir,
      localBuyerAgentId: "buyer-relay-s2-direct",
      relayWired: true,
      allowPrivateRanges: true,
      skipDnsCheck: true,
      fetchImpl: network,
      merchantAccess: {
        forMerchant: async () => ({
          sendUrlFor: (url: string) => url,
          direct: true,
        }),
        forEndpoint: async () => ({
          sendUrlFor: (url: string) => url,
          direct: true,
        }),
      },
    });

    const results = await fetcher.requestQuotes(INTENT, [{
      merchant_id: "merchant-allowlisted-wb",
      name: "已加白 WB 商家",
      verified: true,
      capabilities: [],
      catalog_agent_id: "cagt_allowlisted_wb",
      agent_card_url: "https://acme.app.workbuddy.host/.well-known/agent-card.json",
    }], CONTEXT);

    expect(calls.some((url) => url.includes("agent-card.json"))).toBe(true);
    expect(calls.some((url) => url.includes("/a2a"))).toBe(true);
    expect(calls.every((url) => !url.includes("sharecode"))).toBe(true);
    expect(results[0]?.failure?.classification).not.toBe("access_unavailable");
  });

  it("目录回查 403/会话拒绝不等于已加白：WB 主机仍 fail-closed，不试探直连", async () => {
    relaySources.openGet.mockResolvedValue(null);
    relaySources.accessGet.mockRejectedValue(
      Object.assign(new Error("an active follow is required"), { code: "session_rejected" }),
    );
    const network = vi.fn(() => {
      throw new Error("a 403 must not be treated as an allowlist decision");
    });
    vi.stubGlobal("fetch", network);

    const results = await requestQuotes(buildService(), [{
      merchant_id: "merchant-unknown-wb",
      name: "目录回查被拒的 WB 商家",
      verified: true,
      capabilities: [],
      catalog_agent_id: "cagt_unknown_wb",
      agent_card_url: "https://acme.app.workbuddy.host/.well-known/agent-card.json",
    }]);

    expect(network).not.toHaveBeenCalled();
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
  });

  it("fetcher 终态门：中继已接线时，自定义 resolver 返回 legacy 带码传输也不得直连", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "relay-s2-gate-"));
    dirs.push(dir);
    const network = vi.fn(() => {
      throw new Error("legacy coded transport must not reach the network");
    });
    const fetcher = new A2AQuoteFetcher({
      protocolStateDir: dir,
      localBuyerAgentId: "buyer-relay-s2-gate",
      relayWired: true,
      allowPrivateRanges: true,
      skipDnsCheck: true,
      fetchImpl: network as typeof fetch,
      merchantAccess: {
        forMerchant: async () => ({
          sendUrlFor: (url: string) => `${url}?sharecode=SYNTH-S2`,
        }),
        forEndpoint: async () => ({
          sendUrlFor: (url: string) => `${url}?sharecode=SYNTH-S2`,
        }),
      },
    });

    const results = await fetcher.requestQuotes(INTENT, [{
      merchant_id: "merchant-custom-resolver-wb",
      name: "自定义 resolver 的 WB 商家",
      verified: true,
      capabilities: [],
      catalog_agent_id: "cagt_custom_resolver_wb",
      agent_card_url: "https://acme.app.workbuddy.host/.well-known/agent-card.json",
    }], CONTEXT);

    expect(network).not.toHaveBeenCalled();
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
    expect(results[0]?.failure?.detail).toContain("RELAY_REQUIRED");
  });

  it("非官方 Catalog：中继未接线，保留旧分享码直连传输（不影响第三方目录接入）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "relay-s2-nonofficial-"));
    dirs.push(dir);
    relaySources.accessGet.mockResolvedValue(SHARE_CONFIG);
    const service = buildBuyerService({
      dbPath: ":memory:",
      protocolStateDir: dir,
      principal: "buyer:relay-s2-nonofficial",
      buyerAgentId: "buyer-agent:relay-s2-nonofficial",
      sessionId: "relay-s2-nonofficial",
      policy: { ...DEFAULT_DELEGATION_POLICY, principal: "buyer:relay-s2-nonofficial" },
      catalogUrl: "https://custom-catalog.example",
      catalogSessionToken: "synthetic-buyer-session",
      a2aAllowPrivateRanges: true,
      a2aSkipDnsCheck: true,
    });
    const quoteFetcher = (service as unknown as {
      quoteFetcher: {
        merchantAccess: {
          forMerchant(merchant: MerchantRecord): Promise<{ sendUrlFor(url: string): string } | null>;
        };
      };
    }).quoteFetcher;

    const access = await quoteFetcher.merchantAccess.forMerchant(DECLARED_MERCHANT);

    expect(relaySources.openGet).not.toHaveBeenCalled();
    expect(access?.sendUrlFor("https://merchant.example/a2a")).toContain("sharecode=SYNTHETIC-CODE");
  });

  it("恢复路径终态门：中继已接线时，旧缓存的带码传输不得用于 getTask 恢复", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "relay-s2-recovery-"));
    dirs.push(dir);
    const network = vi.fn(() => {
      throw new Error("legacy coded recovery must not reach the network");
    });
    const fetcher = new A2AQuoteFetcher({
      protocolStateDir: dir,
      localBuyerAgentId: "buyer-relay-s2-recovery",
      relayWired: true,
      allowPrivateRanges: true,
      skipDnsCheck: true,
      fetchImpl: network as typeof fetch,
      merchantAccess: {
        forMerchant: async () => null,
        forEndpoint: async () => ({
          sendUrlFor: (url: string) => `${url}?sharecode=SYNTH-RECOVERY`,
        }),
      },
    });
    (fetcher as unknown as {
      recovery: {
        recover(
          context: ProtocolTaskContext,
          get: (endpoint: string, id: string) => Promise<unknown>,
        ): Promise<unknown[]>;
      };
    }).recovery = {
      recover: async (_context, get) => {
        await get("https://merchant.example/a2a", "task-1");
        return [];
      },
    };

    await expect(fetcher.recoverQuotes(CONTEXT)).rejects.toThrow(
      "legacy coded recovery is disabled",
    );
    expect(network).not.toHaveBeenCalled();
  });

  it("中继已接线时，非 WB 主机的 active 分享码同样 fail-closed，不只拦 WorkBuddy 主机", async () => {
    relaySources.openGet.mockResolvedValue(null);
    relaySources.accessGet.mockResolvedValue(SHARE_CONFIG);
    const network = vi.fn(() => {
      throw new Error("active share-code must not be used for any direct connection");
    });
    vi.stubGlobal("fetch", network);

    const results = await requestQuotes(buildService(), [{
      merchant_id: "merchant-undeclared-non-wb",
      name: "投影缺失但目录仍有码的普通主机商家",
      verified: true,
      capabilities: [],
      catalog_agent_id: "cagt_undeclared_non_wb",
      agent_card_url: "https://merchant.example/.well-known/agent-card.json",
    }]);

    expect(relaySources.accessGet).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
  });
});
