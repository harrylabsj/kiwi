/**
 * 买家按目录公开 `buyer_access` 路由（非凭据投影）。
 *
 * 覆盖：
 *  - 旧记录/旧目录不带 buyer_access 时保持 legacy 行为；
 *  - 显式 direct：即使 runtime_access 仍在，也不取码/不中继；
 *  - 显式 relay：只接受目录中继，中继不可用即 fail-closed，绝不取码直连；
 *  - unknown：终态 fail-closed，不猜 relay/direct；
 *  - 单次 403 不被解释成白名单，也不触发分享码回退；
 *  - `include=buyer_access` 的 wire 形状与旧客户端兼容。
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

import { buildBuyerService } from "../src/buyer-core/build-service.js";
import type { ProtocolTaskContext } from "../src/buyer-core/protocol-recovery.js";
import type { MerchantRecord } from "../src/buyer-core/service.js";
import { KiwiCatalogSource } from "../src/discovery/catalog-source/kiwi-source.js";
import { validateCatalogAgentRecord } from "../src/discovery/catalog-source/kiwi-schema.js";
import { DEFAULT_DELEGATION_POLICY } from "../src/mcp/cli.js";
import { contentDigest } from "../src/negotiation/jcs.js";

const CATALOG = "https://catalog.kiwi.harrylabsj.com";
const INTENT = {
  intent_id: "intent-buyer-access-route",
  intent_type: "purchase",
  items: [{ query: "Test Product", sku: "sku-001", quantity: { value: 1, unit: "台" } }],
  constraints: { currency: "CNY", deadline: "2027-12-31T18:00:00Z" },
};
const CONTEXT: ProtocolTaskContext = {
  taskId: "task-buyer-access-route",
  createdAt: new Date().toISOString(),
  intentBindingDigest: contentDigest(INTENT),
};

const RUNTIME_ACCESS = {
  provider: "workbuddy" as const,
  access_mode: "share_parameter" as const,
  parameter_name: "sharecode" as const,
  config_version: 1,
  adapter_version: "workbuddy-share-v1" as const,
  auth_mode: "signature" as const,
};

function merchant(overrides: Partial<MerchantRecord> = {}): MerchantRecord {
  return {
    merchant_id: "merchant-buyer-access",
    name: "买家路由商家",
    verified: true,
    capabilities: [],
    catalog_agent_id: "cagt_buyer_access",
    agent_card_url: "https://acme.app.workbuddy.host/.well-known/agent-card.json",
    ...overrides,
  };
}

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "buyer-access-route-"));
  dirs.push(dir);
  return dir;
}

function buildService(dir: string) {
  return buildBuyerService({
    dbPath: ":memory:",
    protocolStateDir: dir,
    principal: "buyer:buyer-access-route",
    buyerAgentId: "buyer-agent:buyer-access-route",
    sessionId: "buyer-access-route",
    policy: { ...DEFAULT_DELEGATION_POLICY, principal: "buyer:buyer-access-route" },
    catalogUrl: CATALOG,
    catalogSessionToken: "synthetic-buyer-session",
    a2aAllowPrivateRanges: true,
    a2aSkipDnsCheck: true,
    a2aTimeoutMs: 3000,
  });
}

function merchantAccess(service: ReturnType<typeof buildBuyerService>) {
  return (service as unknown as {
    quoteFetcher: {
      merchantAccess: {
        forMerchant(
          merchant: MerchantRecord,
        ): Promise<
          { direct?: true; relayRequired?: true; openInquiry?: unknown; sendUrlFor(url: string): string } | null
        >;
      };
    };
  }).quoteFetcher.merchantAccess;
}

function requestQuotes(service: ReturnType<typeof buildBuyerService>, merchants: MerchantRecord[]) {
  const fetcher = (service as unknown as {
    quoteFetcher: {
      requestQuotes(
        intent: Record<string, unknown>,
        merchants: MerchantRecord[],
        context?: ProtocolTaskContext,
      ): Promise<Array<{ status: string; failure?: { classification?: string } }>>;
    };
  }).quoteFetcher;
  return fetcher.requestQuotes(INTENT, merchants, CONTEXT);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catalog_agent_id: "cagt_01JABC",
    principal_type: "merchant",
    merchant_id: "mrc_01JABC",
    display_name: "Acme Merchant",
    canonical_domain: "acme.example",
    agent_card_url: "https://acme.example/.well-known/agent-card.json",
    hosting_mode: "direct_only",
    verification_level: "commerce_verified",
    freshness_state: "fresh",
    administrative_state: "active",
    created_at: "2026-08-06T00:00:00Z",
    updated_at: "2026-08-06T12:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  relaySources.openGet.mockReset();
  relaySources.accessGet.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("目录公开 buyer_access 投影", () => {
  it("schema 接受合法投影，拒绝未知 state/多余字段", () => {
    const record = recordFixture({
      buyer_access: {
        schema_version: 1,
        state: "direct",
        source: "merchant_setting",
        mode: "no_share_code",
        revision: 3,
        updated_at: "2026-11-11T00:00:00Z",
        platform_verification: "unverified",
      },
    });
    expect(validateCatalogAgentRecord(record).buyer_access?.state).toBe("direct");
    expect(() =>
      validateCatalogAgentRecord(
        recordFixture({
          buyer_access: {
            schema_version: 1,
            state: "platform_whitelisted",
            source: "merchant_setting",
            revision: 1,
            platform_verification: "unverified",
          },
        }),
      ),
    ).toThrow(/schema validation/);
    expect(() =>
      validateCatalogAgentRecord(
        recordFixture({
          buyer_access: {
            schema_version: 1,
            state: "direct",
            source: "merchant_setting",
            revision: 1,
            platform_verification: "verified",
          },
        }),
      ),
    ).toThrow(/schema validation/);
  });

  it("旧记录不带 buyer_access 仍通过 schema（旧客户端兼容）", () => {
    expect(validateCatalogAgentRecord(recordFixture()).buyer_access).toBeUndefined();
  });

  it("search/get 显式请求 include=buyer_access", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const href = String(input);
      calls.push(href);
      if (href.includes("/v1/agents/search")) {
        return jsonResponse({ results: [recordFixture()] });
      }
      if (href.includes("/v1/agents/")) {
        return jsonResponse({ agent: recordFixture() });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });
    await source.searchRecords({ include: "buyer_access" });
    await source.getRecord("cagt_01JABC");
    expect(calls[0]).toContain("include=buyer_access");
    expect(calls[1]).toContain("include=buyer_access");
  });
});

describe("买家路由按显式状态选择", () => {
  it("显式 direct：即使 runtime_access 仍在，也不取码/不中继", async () => {
    const dir = makeDir();
    relaySources.openGet.mockResolvedValue({
      endpoint: "https://acme.app.workbuddy.host/a2a",
      signer: {},
      fetchImpl: async () => jsonResponse({}),
    });
    relaySources.accessGet.mockResolvedValue({
      secret_value: "SYNTHETIC-MUST-NOT-BE-USED",
      catalog_agent_id: "cagt_buyer_access",
      runtime_origin: "https://acme.app.workbuddy.host",
      provider: "workbuddy",
      access_mode: "share_parameter",
      parameter_name: "sharecode",
      config_version: 1,
      adapter_version: "workbuddy-share-v1",
      auth_mode: "signature",
      validated_at: "",
      updated_at: "",
    });
    const access = await merchantAccess(buildService(dir)).forMerchant(
      merchant({
        runtime_access: RUNTIME_ACCESS,
        buyer_access: {
          schema_version: 1,
          state: "direct",
          source: "merchant_setting",
          mode: "no_share_code",
          revision: 2,
          platform_verification: "unverified",
        },
      }),
    );
    expect(access?.direct).toBe(true);
    expect(access?.sendUrlFor("https://acme.app.workbuddy.host/a2a"))
      .toBe("https://acme.app.workbuddy.host/a2a");
    expect(relaySources.openGet).not.toHaveBeenCalled();
    expect(relaySources.accessGet).not.toHaveBeenCalled();
  });

  it("显式 relay：只走目录中继，中继不可用即 relayRequired", async () => {
    const dir = makeDir();
    relaySources.openGet.mockResolvedValue(null);
    relaySources.accessGet.mockResolvedValue({
      secret_value: "SYNTHETIC-MUST-NOT-BE-USED",
      catalog_agent_id: "cagt_buyer_access",
      runtime_origin: "https://acme.app.workbuddy.host",
      provider: "workbuddy",
      access_mode: "share_parameter",
      parameter_name: "sharecode",
      config_version: 1,
      adapter_version: "workbuddy-share-v1",
      auth_mode: "signature",
      validated_at: "",
      updated_at: "",
    });
    const service = buildService(dir);
    const access = await merchantAccess(service).forMerchant(
      merchant({
        runtime_access: RUNTIME_ACCESS,
        buyer_access: {
          schema_version: 1,
          state: "relay",
          source: "merchant_setting",
          mode: "share_code",
          revision: 1,
          platform_verification: "unverified",
        },
      }),
    );
    expect(access?.relayRequired).toBe(true);
    expect(relaySources.accessGet).not.toHaveBeenCalled();
  });

  it("显式 relay 查询网络失败：终态 access_unavailable，不回退直连", async () => {
    const dir = makeDir();
    relaySources.openGet.mockRejectedValue(new Error("relay network down"));
    const results = await requestQuotes(buildService(dir), [
      merchant({
        buyer_access: {
          schema_version: 1,
          state: "relay",
          source: "merchant_setting",
          mode: "share_code",
          revision: 1,
          platform_verification: "unverified",
        },
      }),
    ]);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("access_unavailable");
    expect(relaySources.accessGet).not.toHaveBeenCalled();
  });

  it("显式 relay 成功时返回中继传输，仍不取分享码", async () => {
    const dir = makeDir();
    relaySources.openGet.mockResolvedValue({
      endpoint: "https://acme.app.workbuddy.host/a2a",
      signer: {},
      fetchImpl: async () => jsonResponse({}),
    });
    const access = await merchantAccess(buildService(dir)).forMerchant(
      merchant({
        runtime_access: RUNTIME_ACCESS,
        buyer_access: {
          schema_version: 1,
          state: "relay",
          source: "merchant_setting",
          mode: "share_code",
          revision: 1,
          platform_verification: "unverified",
        },
      }),
    );
    expect(access?.openInquiry).toBeDefined();
    expect(relaySources.accessGet).not.toHaveBeenCalled();
  });

  it("unknown：终态 fail-closed，不猜 relay/direct", async () => {
    const dir = makeDir();
    await expect(
      merchantAccess(buildService(dir)).forMerchant(
        merchant({
          runtime_access: RUNTIME_ACCESS,
          buyer_access: {
            schema_version: 1,
            state: "unknown",
            source: "authorization_changed",
            revision: 1,
            platform_verification: "unverified",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_ROUTE_UNKNOWN" });
    expect(relaySources.openGet).not.toHaveBeenCalled();
    expect(relaySources.accessGet).not.toHaveBeenCalled();
  });

  it("显式 direct 被 403 时失败，不把单次 403 当白名单、不取码回退", async () => {
    const dir = makeDir();
    relaySources.accessGet.mockResolvedValue({
      secret_value: "SYNTHETIC-MUST-NOT-BE-USED",
      catalog_agent_id: "cagt_buyer_access",
      runtime_origin: "https://acme.app.workbuddy.host",
      provider: "workbuddy",
      access_mode: "share_parameter",
      parameter_name: "sharecode",
      config_version: 1,
      adapter_version: "workbuddy-share-v1",
      auth_mode: "signature",
      validated_at: "",
      updated_at: "",
    });
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      requested.push(String(input));
      return jsonResponse({ error: "forbidden" }, 403);
    }));
    const results = await requestQuotes(buildService(dir), [
      merchant({
        runtime_access: RUNTIME_ACCESS,
        buyer_access: {
          schema_version: 1,
          state: "direct",
          source: "merchant_setting",
          mode: "no_share_code",
          revision: 1,
          platform_verification: "unverified",
        },
      }),
    ]);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.failure?.classification).toBe("access_denied");
    expect(relaySources.accessGet).not.toHaveBeenCalled();
    expect(requested.every((url) => !url.includes("sharecode"))).toBe(true);
  });
});
