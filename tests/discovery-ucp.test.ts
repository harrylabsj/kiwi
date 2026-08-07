/**
 * AgentDiscovery UCP 集成（WP3）测试 —— domain 双发现入口 + UCP intersection 纳入档案。
 *
 * 覆盖（基线 §25 / §33）：
 *   - domain → UCP 成功且含 a2a transport → 用 profile endpoint 拉 Agent Card，
 *     CounterpartyProfile 携带 ucp_profile + ucp_intersection；
 *   - domain → UCP 成功但无 a2a transport → 回退 /.well-known/agent-card.json；
 *   - domain → UCP 失败（404）→ 回退 /.well-known/agent-card.json；
 *   - domain → UCP 失败 + Agent Card 也失败 → fail-closed（card_fetch_failed）；
 *   - UCP capability intersection 纳入 profile（与 A2A binding intersection 两个维度并存）；
 *   - ucp.disabled → v0.5 直接 well-known Agent Card。
 */
import { describe, expect, it } from "vitest";
import { AgentDiscovery, buildKiwiVendorProfile, validateUcpProfile } from "../src/discovery/index.js";
import { selectChannelCandidate } from "../src/counterparty/index.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** 最小合法 Agent Card（passes parseAgentCard：结构 + secret 扫描）。 */
function agentCard(
  baseUrl = "https://merchant.example",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "Acme Merchant",
    description: "test merchant",
    provider: { organization: "Acme", url: baseUrl },
    version: "1.0",
    url: baseUrl,
    supportedInterfaces: [
      { url: `${baseUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    capabilities: { extendedAgentCard: true },
    ...overrides,
  };
}

/** 合法 Merchant UCP profile：com.harrylabsj.kiwi.shopping → authority kiwi.harrylabsj.com，a2a transport。 */
function merchantUcpProfile(
  agentCardUrl = "https://merchant.example/.well-known/agent-card.json",
): Record<string, unknown> {
  return buildKiwiVendorProfile({ agentCardUrl });
}

/** 仅 rest transport（无 a2a）的合法 UCP profile。 */
function noA2aProfile(): Record<string, unknown> {
  return {
    ucp: {
      version: "2026-04-08",
      services: {
        "com.example.shopping": [
          {
            version: "1.0",
            spec: "https://example.com/specs/shopping.json",
            transport: "rest",
            endpoint: "https://example.com/api",
          },
        ],
      },
    },
  };
}

/** 按 URL 路由的注入 fetch：/.well-known/ucp 走 ucp handler，其余走 card handler。 */
function routerFetch(opts: {
  ucp?: () => Response;
  card?: () => Response;
}): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: FetchInput, _init?: FetchInit): Promise<Response> => {
    const href = String(input);
    calls.push(href);
    if (href.includes("/.well-known/ucp")) {
      if (opts.ucp !== undefined) return opts.ucp();
      return jsonResponse({ error: "not found" }, 404);
    }
    if (opts.card !== undefined) return opts.card();
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const DEFAULT_UCP_DEP = {
  ucp: { resolver: { skipDnsCheck: true } },
  skipDnsCheck: true, // fetchCard 的 SSRF DNS 复查跳过（注入 fetchImpl 测试替身）
};

describe("AgentDiscovery.resolve: domain → UCP 优先（双发现入口）", () => {
  it("UCP 成功且含 a2a transport → 从 profile endpoint 拉 Agent Card，不拉默认 card 路径", async () => {
    const { fetchImpl, calls } = routerFetch({
      ucp: () =>
        jsonResponse(merchantUcpProfile(), 200, { "cache-control": "public, max-age=300" }),
      card: () => jsonResponse(agentCard()),
    });
    const discovery = new AgentDiscovery({ fetchImpl, ...DEFAULT_UCP_DEP });

    const profile = await discovery.resolve({ domain: "merchant.example" });

    // 只请求 UCP 入口 + profile 里的 a2a endpoint（Agent Card URL），没有默认 card 路径。
    expect(calls).toEqual([
      "https://merchant.example/.well-known/ucp",
      "https://merchant.example/.well-known/agent-card.json",
    ]);
    expect(profile.source).toBe("domain:merchant.example");
    expect(profile.ucp_profile?.ucp.version).toBe("2026-04-08");
    expect(profile.ucp_fallback_reason).toBeUndefined();
    expect(profile.agent_card.name).toBe("Acme Merchant");
    expect(selectChannelCandidate(profile)?.kind).toBe("a2a-direct");
  });

  it("UCP 成功但无 a2a transport → 回退 /.well-known/agent-card.json", async () => {
    const { fetchImpl, calls } = routerFetch({
      ucp: () =>
        jsonResponse(noA2aProfile(), 200, { "cache-control": "public, max-age=300" }),
      card: () => jsonResponse(agentCard()),
    });
    const discovery = new AgentDiscovery({ fetchImpl, ...DEFAULT_UCP_DEP });

    const profile = await discovery.resolve({ domain: "merchant.example" });

    expect(calls).toEqual([
      "https://merchant.example/.well-known/ucp",
      "https://merchant.example/.well-known/agent-card.json",
    ]);
    expect(profile.ucp_fallback_reason).toContain("no a2a transport endpoint");
    expect(profile.ucp_profile).toBeUndefined();
    expect(profile.agent_card.name).toBe("Acme Merchant");
  });

  it("UCP 失败（404 → profile_bad_status）→ 回退 /.well-known/agent-card.json", async () => {
    const { fetchImpl, calls } = routerFetch({
      card: () => jsonResponse(agentCard()),
    });
    const discovery = new AgentDiscovery({ fetchImpl, ...DEFAULT_UCP_DEP });

    const profile = await discovery.resolve({ domain: "merchant.example" });

    expect(calls).toEqual([
      "https://merchant.example/.well-known/ucp",
      "https://merchant.example/.well-known/agent-card.json",
    ]);
    expect(profile.ucp_fallback_reason).toContain("ucp:profile_bad_status");
    expect(profile.ucp_profile).toBeUndefined();
    expect(profile.agent_card.name).toBe("Acme Merchant");
  });

  it("UCP 失败 + Agent Card 也失败 → fail-closed（card_fetch_failed）", async () => {
    const { fetchImpl } = routerFetch({});
    const discovery = new AgentDiscovery({ fetchImpl, ...DEFAULT_UCP_DEP });

    await expect(discovery.resolve({ domain: "merchant.example" })).rejects.toMatchObject({
      code: "card_fetch_failed",
    });
  });

  it("UCP profile 非法（非 profile JSON）→ 回退 card（fail-closed 校验，不视为 UCP 成功）", async () => {
    const { fetchImpl, calls } = routerFetch({
      ucp: () => jsonResponse(agentCard(), 200, { "cache-control": "public, max-age=300" }),
      card: () => jsonResponse(agentCard()),
    });
    const discovery = new AgentDiscovery({ fetchImpl, ...DEFAULT_UCP_DEP });

    const profile = await discovery.resolve({ domain: "merchant.example" });

    expect(calls).toEqual([
      "https://merchant.example/.well-known/ucp",
      "https://merchant.example/.well-known/agent-card.json",
    ]);
    expect(profile.ucp_fallback_reason).toContain("profile_malformed");
    expect(profile.agent_card.name).toBe("Acme Merchant");
  });
});

describe("AgentDiscovery.resolve: UCP capability intersection 纳入 CounterpartyProfile", () => {
  it("配置 localProfile → ucp_intersection 与 A2A binding intersection 两个维度并存", async () => {
    // Kiwi 平台侧 profile 声明同名的 com.harrylabsj.kiwi.shopping.negotiation v1.0。
    const localProfile = buildKiwiVendorProfile({
      agentCardUrl: "https://buyer.example/.well-known/agent-card.json",
    });
    const { fetchImpl } = routerFetch({
      ucp: () =>
        jsonResponse(merchantUcpProfile(), 200, { "cache-control": "public, max-age=300" }),
      card: () => jsonResponse(agentCard()),
    });
    const discovery = new AgentDiscovery({
      fetchImpl,
      ucp: { resolver: { skipDnsCheck: true }, localProfile },
      skipDnsCheck: true, // fetchCard SSRF DNS 复查跳过（注入 fetchImpl）
    });

    const profile = await discovery.resolve({ domain: "merchant.example" });

    // A2A binding intersection（现有维度）。
    expect(profile.intersection.compatible).toBe(true);
    expect(profile.intersection.selected?.protocolBinding).toBe("JSONRPC");
    // UCP capability intersection（新维度）。
    expect(profile.ucp_intersection?.compatible).toBe(true);
    expect(profile.ucp_intersection?.active).toEqual([
      { name: "com.harrylabsj.kiwi.shopping.negotiation", version: "1.0" },
    ]);
    expect(profile.ucp_intersection?.excluded).toEqual([]);
    expect(profile.ucp_profile?.ucp.capabilities?.["com.harrylabsj.kiwi.shopping.negotiation"]).toHaveLength(1);
  });

  it("localProfile 与对端无同名能力 → ucp_intersection.compatible=false（业务结果，非 transport 错误）", async () => {
    const localProfile = buildKiwiVendorProfile({
      agentCardUrl: "https://buyer.example/.well-known/agent-card.json",
      capabilityName: "com.harrylabsj.kiwi.shopping.order",
      serviceName: "com.harrylabsj.kiwi.shopping",
    });
    const { fetchImpl } = routerFetch({
      ucp: () =>
        jsonResponse(merchantUcpProfile(), 200, { "cache-control": "public, max-age=300" }),
      card: () => jsonResponse(agentCard()),
    });
    const discovery = new AgentDiscovery({
      fetchImpl,
      ucp: { resolver: { skipDnsCheck: true }, localProfile },
      skipDnsCheck: true, // fetchCard SSRF DNS 复查跳过（注入 fetchImpl）
    });

    const profile = await discovery.resolve({ domain: "merchant.example" });

    expect(profile.ucp_intersection?.compatible).toBe(false);
    expect(profile.ucp_intersection?.excluded).toEqual([
      { name: "com.harrylabsj.kiwi.shopping.negotiation", reason: "no_mutual" },
    ]);
    // A2A 通道不受 UCP 交集影响（两个维度独立）。
    expect(profile.intersection.compatible).toBe(true);
    expect(selectChannelCandidate(profile)?.kind).toBe("a2a-direct");
  });

  it("UCP 路径失败回退时无 ucp_intersection（只记 fallback_reason）", async () => {
    const localProfile = buildKiwiVendorProfile({
      agentCardUrl: "https://buyer.example/.well-known/agent-card.json",
    });
    const { fetchImpl } = routerFetch({ card: () => jsonResponse(agentCard()) });
    const discovery = new AgentDiscovery({
      fetchImpl,
      ucp: { resolver: { skipDnsCheck: true }, localProfile },
      skipDnsCheck: true, // fetchCard SSRF DNS 复查跳过（注入 fetchImpl）
    });

    const profile = await discovery.resolve({ domain: "merchant.example" });

    expect(profile.ucp_fallback_reason).toContain("ucp:profile_bad_status");
    expect(profile.ucp_profile).toBeUndefined();
    expect(profile.ucp_intersection).toBeUndefined();
    expect(profile.agent_card.name).toBe("Acme Merchant");
  });
});

describe("AgentDiscovery.resolve: 构造出的 Kiwi vendor profile 自洽", () => {
  it("buildKiwiVendorProfile 输出过 validate（测试数据自身的 sanity）", () => {
    const result = validateUcpProfile(merchantUcpProfile());
    expect(result.rejected).toEqual([]);
  });
});
