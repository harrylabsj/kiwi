/**
 * ShoppingCliCatalogSource + AgentDiscovery.resolveViaCatalog 测试（v2.3，设计 §21 / MVP Slice A/B）。
 *
 * 覆盖：
 *   - ShoppingCliCatalogSource：searchCandidates / getCandidate 对契约响应的解析、
 *     query 序列化、契约校验（contract_violation）、信封校验（response_invalid）、
 *     HTTP / 网络 / 超时失败（request_failed）、非法输入（invalid_input）；
 *   - resolveViaCatalog 集成：候选**不**被直接信任（fresh resolve 走 Agent Card）、
 *     verification.status blocked 过滤（含 includeBlocked 放宽）、hosting.mode →
 *     通道候选映射（direct_only / hosted_only / hybrid / unknown，不自动降级）；
 *   - SSRF 边界：candidate 的 agent_card_url 指向非法 scheme 时，resolve() 现有
 *     fail-closed 防护生效（断言抛错，不在 catalog-source 重复实现防护）。
 */
import { describe, expect, it } from "vitest";
import {
  AgentDiscovery,
  CatalogSourceError,
  ShoppingCliCatalogSource,
} from "../src/discovery/index.js";
import type { CandidateAgent, CatalogSearchQuery } from "../src/discovery/index.js";
import type { CounterpartyProfile } from "../src/counterparty/channel.js";
import { selectChannelCandidate } from "../src/counterparty/index.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 契约 1.0 合法候选（§8.2 示例形状，去除 EXAMPLE_ONLY 占位符）。 */
function candidateFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catalog_agent_id: "cagt_01JABC",
    merchant: { id: "mrc_01JABC", name: "Acme Merchant", domain: "acme.example" },
    discovery: {
      agent_card_url: "https://acme.example/.well-known/agent-card.json",
      ucp_profile_url: "https://acme.example/.well-known/ucp",
    },
    protocols: { a2a: ["1.0.0"], ucp: ["2026-04-08"] },
    capabilities: ["com.harrylabsj.shopping.capability:catalog"],
    verification: { status: "discovered", last_verified_at: "2026-08-06T00:00:00Z" },
    hosting: { mode: "direct_only" },
    contract: { name: "candidate-agent", version: "1.0" },
    ...overrides,
  };
}

/** 按 URL 路由的 catalog 假 fetch。 */
function catalogFetch(opts: { search?: () => Response; get?: () => Response }): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: FetchInput, _init?: FetchInit): Promise<Response> => {
    const href = String(input);
    calls.push(href);
    if (href.includes("/v1/agent-catalog/agents/search")) {
      return opts.search?.() ?? jsonResponse({ results: [] });
    }
    if (href.includes("/v1/agent-catalog/agents/")) {
      return opts.get?.() ?? jsonResponse({ error: "not found" }, 404);
    }
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** 最小合法 Agent Card（passes parseAgentCard）。 */
function agentCard(
  baseUrl = "https://merchant.example",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "Real Merchant",
    description: "test merchant",
    provider: { organization: "Real", url: baseUrl },
    version: "1.0",
    url: baseUrl,
    supportedInterfaces: [
      { url: `${baseUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    capabilities: { extendedAgentCard: true },
    ...overrides,
  };
}

/** 只实现 searchCandidates 的最小假 source（integration 测试隔离 catalog HTTP）。 */
function fakeSource(candidates: CandidateAgent[]): ShoppingCliCatalogSource {
  return {
    searchCandidates: async () => candidates,
    getCandidate: async () => {
      throw new CatalogSourceError("invalid_input", "fake source does not implement getCandidate");
    },
  } as unknown as ShoppingCliCatalogSource;
}

/** 为 AgentDiscovery 提供 card 抓取的假 fetch；非 http(s) scheme 抛错（模拟真实 fetch）。 */
function cardFetch(card: Record<string, unknown>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: FetchInput, _init?: FetchInit): Promise<Response> => {
    const href = String(input);
    calls.push(href);
    if (!href.startsWith("http://") && !href.startsWith("https://")) {
      throw new TypeError(`fetch failed: unsupported scheme for ${href}`);
    }
    return jsonResponse(card);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// ShoppingCliCatalogSource 单元
// ---------------------------------------------------------------------------

describe("ShoppingCliCatalogSource", () => {
  it("searchCandidates 返回契约候选 → 类型解析正确（含 query 序列化）", async () => {
    const { fetchImpl, calls } = catalogFetch({
      search: () => jsonResponse({ results: [candidateFixture()] }),
    });
    const source = new ShoppingCliCatalogSource({
      baseUrl: "https://catalog.example/",
      fetchImpl,
    });

    const candidates = await source.searchCandidates({ q: "coffee", limit: 5 });

    expect(calls[0]).toContain("/v1/agent-catalog/agents/search");
    expect(calls[0]).toContain("q=coffee");
    expect(calls[0]).toContain("limit=5");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.catalog_agent_id).toBe("cagt_01JABC");
    expect(candidates[0]?.merchant?.name).toBe("Acme Merchant");
    expect(candidates[0]?.verification.status).toBe("discovered");
    expect(candidates[0]?.hosting.mode).toBe("direct_only");
    expect(candidates[0]?.capabilities).toEqual(["com.harrylabsj.shopping.capability:catalog"]);
  });

  it("getCandidate 返回契约候选（catalog_agent 信封）", async () => {
    const { fetchImpl, calls } = catalogFetch({
      get: () => jsonResponse({ catalog_agent: candidateFixture() }),
    });
    const source = new ShoppingCliCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    const candidate = await source.getCandidate("cagt_01JABC");

    expect(calls[0]).toContain("/v1/agent-catalog/agents/cagt_01JABC");
    expect(candidate.catalog_agent_id).toBe("cagt_01JABC");
    expect(candidate.contract).toEqual({ name: "candidate-agent", version: "1.0" });
  });

  it("contract_violation：缺必填字段 → 抛 contract_violation", async () => {
    const { fetchImpl } = catalogFetch({
      search: () =>
        jsonResponse({
          results: [candidateFixture(), { ...candidateFixture(), contract: undefined }],
        }),
    });
    const source = new ShoppingCliCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(source.searchCandidates()).rejects.toMatchObject({ code: "contract_violation" });
  });

  it("contract_violation：hosting.mode 非法枚举 → contract_violation", async () => {
    const { fetchImpl } = catalogFetch({
      search: () =>
        jsonResponse({ results: [candidateFixture({ hosting: { mode: "totally_legit" } })] }),
    });
    const source = new ShoppingCliCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(source.searchCandidates()).rejects.toMatchObject({ code: "contract_violation" });
  });

  it("contract_violation：catalog_agent_id 为空串（minLength 1）→ contract_violation", async () => {
    const { fetchImpl } = catalogFetch({
      search: () => jsonResponse({ results: [candidateFixture({ catalog_agent_id: "" })] }),
    });
    const source = new ShoppingCliCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(source.searchCandidates()).rejects.toMatchObject({ code: "contract_violation" });
  });

  it("response_invalid：search 响应缺 results 数组 → response_invalid", async () => {
    const { fetchImpl } = catalogFetch({ search: () => jsonResponse({ foo: 1 }) });
    const source = new ShoppingCliCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(source.searchCandidates()).rejects.toMatchObject({ code: "response_invalid" });
  });

  it("response_invalid：get 响应缺 catalog_agent → response_invalid", async () => {
    const { fetchImpl } = catalogFetch({ get: () => jsonResponse({ foo: 1 }) });
    const source = new ShoppingCliCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(source.getCandidate("cagt_01JABC")).rejects.toMatchObject({
      code: "response_invalid",
    });
  });

  it("request_failed：HTTP 500 → request_failed", async () => {
    const { fetchImpl } = catalogFetch({ search: () => jsonResponse({ error: "boom" }, 500) });
    const source = new ShoppingCliCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(source.searchCandidates()).rejects.toMatchObject({ code: "request_failed" });
  });

  it("request_failed：网络异常 → request_failed", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const source = new ShoppingCliCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(source.searchCandidates()).rejects.toMatchObject({ code: "request_failed" });
  });

  it("request_failed：超时（AbortSignal）→ request_failed", async () => {
    const fetchImpl = (async (_input: FetchInput, init?: FetchInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    const source = new ShoppingCliCatalogSource({
      baseUrl: "https://catalog.example",
      fetchImpl,
      timeoutMs: 50,
    });

    await expect(source.searchCandidates()).rejects.toMatchObject({
      code: "request_failed",
      message: /timed out/,
    });
  });

  it("invalid_input：非法 baseUrl（非 http/s scheme）→ invalid_input", () => {
    let error: unknown;
    try {
      new ShoppingCliCatalogSource({ baseUrl: "ftp://catalog.example" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CatalogSourceError);
    expect((error as CatalogSourceError).code).toBe("invalid_input");
  });

  it("invalid_input：未知 query 键 → invalid_input", async () => {
    const { fetchImpl } = catalogFetch({ search: () => jsonResponse({ results: [] }) });
    const source = new ShoppingCliCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(
      source.searchCandidates({ bogus: "x" } as unknown as CatalogSearchQuery),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("invalid_input：limit 非法（0）→ invalid_input", async () => {
    const { fetchImpl } = catalogFetch({ search: () => jsonResponse({ results: [] }) });
    const source = new ShoppingCliCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(source.searchCandidates({ limit: 0 })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

// ---------------------------------------------------------------------------
// AgentDiscovery.resolveViaCatalog 集成
// ---------------------------------------------------------------------------

describe("AgentDiscovery.resolveViaCatalog", () => {
  it("未配置 catalog source → invalid_input", async () => {
    const discovery = new AgentDiscovery();
    await expect(discovery.resolveViaCatalog()).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("候选不被直接信任：fresh resolve 从 Agent Card 拉取真实档案", async () => {
    // candidate 声称 merchant.name = "Acme Merchant"，但真实 card 的 identity 是 "Real"。
    const candidate = candidateFixture() as unknown as CandidateAgent;
    const card = agentCard();
    const { fetchImpl, calls } = cardFetch(card);
    const discovery = new AgentDiscovery({
      fetchImpl,
      catalog: { source: fakeSource([candidate]) },
    });

    const results = await discovery.resolveViaCatalog();

    expect(results).toHaveLength(1);
    // fresh resolve 实际抓取了 candidate 的 agent_card_url，而不是直接信任候选元数据。
    expect(calls).toContain("https://acme.example/.well-known/agent-card.json");
    expect(results[0]?.candidate.catalog_agent_id).toBe("cagt_01JABC");
    const profile: CounterpartyProfile | undefined = results[0]?.profile;
    expect(profile?.identity).toBe("Real");
    expect(profile?.agent_card.name).toBe("Real Merchant");
    expect(profile?.source).toBe("card:https://acme.example/.well-known/agent-card.json");
    expect(selectChannelCandidate(profile as CounterpartyProfile)?.kind).toBe("a2a-direct");
  });

  it("REJECTED candidate 被默认过滤（不进入 fresh resolve）", async () => {
    const rejected = candidateFixture({
      catalog_agent_id: "cagt_rejected",
      verification: { status: "rejected", last_verified_at: "2026-08-06T00:00:00Z" },
    }) as unknown as CandidateAgent;
    const healthy = candidateFixture({
      catalog_agent_id: "cagt_healthy",
      discovery: { agent_card_url: "https://healthy.example/card.json" },
    }) as unknown as CandidateAgent;
    const card = agentCard("https://healthy.example");
    const { fetchImpl, calls } = cardFetch(card);
    const discovery = new AgentDiscovery({
      fetchImpl,
      catalog: { source: fakeSource([rejected, healthy]) },
    });

    const results = await discovery.resolveViaCatalog();

    expect(results.map((r) => r.candidate.catalog_agent_id)).toEqual(["cagt_healthy"]);
    // rejected 候选的 card 从未被抓取。
    expect(calls).not.toContain("https://acme.example/.well-known/agent-card.json");
    expect(calls).toContain("https://healthy.example/card.json");
  });

  it("includeBlocked: true 显式放宽 → blocked 候选也进入 fresh resolve", async () => {
    const rejected = candidateFixture({
      verification: { status: "rejected", last_verified_at: "2026-08-06T00:00:00Z" },
    }) as unknown as CandidateAgent;
    const card = agentCard();
    const { fetchImpl } = cardFetch(card);
    const discovery = new AgentDiscovery({
      fetchImpl,
      catalog: { source: fakeSource([rejected]), includeBlocked: true },
    });

    const results = await discovery.resolveViaCatalog();

    expect(results.map((r) => r.candidate.catalog_agent_id)).toEqual(["cagt_01JABC"]);
  });

  it("hosting.mode=direct_only + 有 a2a binding → 只给 a2a-direct 候选", async () => {
    const candidate = candidateFixture({
      hosting: { mode: "direct_only" },
    }) as unknown as CandidateAgent;
    const { fetchImpl } = cardFetch(agentCard());
    const discovery = new AgentDiscovery({
      fetchImpl,
      hosted: { configured: true, config_id: "local" },
      catalog: { source: fakeSource([candidate]) },
    });

    const results = await discovery.resolveViaCatalog();

    expect(results[0]?.profile.channel_candidates).toEqual([
      { kind: "a2a-direct", url: "https://merchant.example/a2a" },
    ]);
    expect(selectChannelCandidate(results[0]?.profile as CounterpartyProfile)?.kind).toBe(
      "a2a-direct",
    );
  });

  it("hosting.mode=hosted_only → 即使有 a2a binding 也只给 shopping-cli-hosted（不自动降级/不扩权）", async () => {
    const candidate = candidateFixture({
      hosting: { mode: "hosted_only" },
    }) as unknown as CandidateAgent;
    const { fetchImpl } = cardFetch(agentCard());
    const discovery = new AgentDiscovery({
      fetchImpl,
      hosted: { configured: true, config_id: "local" },
      catalog: { source: fakeSource([candidate]) },
    });

    const results = await discovery.resolveViaCatalog();

    // resolve() 会给出 [a2a-direct, shopping-cli-hosted]，但 hosted_only 收窄为仅 hosted。
    expect(results[0]?.profile.channel_candidates).toEqual([
      { kind: "shopping-cli-hosted", config_id: "local" },
    ]);
  });

  it("hosting.mode=unknown → 仅当 resolve 实际发现 a2a binding 才给 direct", async () => {
    const withA2a = candidateFixture({
      hosting: { mode: "unknown" },
    }) as unknown as CandidateAgent;
    const { fetchImpl } = cardFetch(agentCard());
    const discovery = new AgentDiscovery({
      fetchImpl,
      catalog: { source: fakeSource([withA2a]) },
    });

    const results = await discovery.resolveViaCatalog();

    expect(results).toHaveLength(1);
    expect(results[0]?.profile.channel_candidates).toEqual([
      { kind: "a2a-direct", url: "https://merchant.example/a2a" },
    ]);
  });

  it("hosting.mode=unknown + 无 a2a binding → 不自动给 hosted 候选（跳过该候选）", async () => {
    const unknownNoA2a = candidateFixture({
      hosting: { mode: "unknown" },
    }) as unknown as CandidateAgent;
    // 只暴露 GRPC binding → 与 Kiwi 默认 JSONRPC 不兼容。
    const card = agentCard("https://merchant.example", {
      supportedInterfaces: [
        { url: "https://merchant.example/a2a", protocolBinding: "GRPC", protocolVersion: "1.0" },
      ],
    });
    const { fetchImpl } = cardFetch(card);
    const discovery = new AgentDiscovery({
      fetchImpl,
      hosted: { configured: true, config_id: "local" },
      catalog: { source: fakeSource([unknownNoA2a]) },
    });

    const results = await discovery.resolveViaCatalog();

    // resolve() 给 [shopping-cli-hosted]，但 unknown 收窄后无 direct → 无可用通道 → 跳过。
    expect(results).toEqual([]);
  });

  it("hosting.mode=hybrid → direct + hosted 都保留（优先序仍由 selectChannelCandidate 决定）", async () => {
    const candidate = candidateFixture({
      hosting: { mode: "hybrid" },
    }) as unknown as CandidateAgent;
    const { fetchImpl } = cardFetch(agentCard());
    const discovery = new AgentDiscovery({
      fetchImpl,
      hosted: { configured: true, config_id: "local" },
      catalog: { source: fakeSource([candidate]) },
    });

    const results = await discovery.resolveViaCatalog();

    expect(results[0]?.profile.channel_candidates.map((c) => c.kind)).toEqual([
      "a2a-direct",
      "shopping-cli-hosted",
    ]);
    expect(selectChannelCandidate(results[0]?.profile as CounterpartyProfile)?.kind).toBe(
      "a2a-direct",
    );
  });

  it("legacy hosting.mode=direct → 归一化为 direct_only（契约 §4.8 向后兼容）", async () => {
    const candidate = candidateFixture({
      hosting: { mode: "direct" },
    }) as unknown as CandidateAgent;
    const { fetchImpl } = cardFetch(agentCard());
    const discovery = new AgentDiscovery({
      fetchImpl,
      hosted: { configured: true, config_id: "local" },
      catalog: { source: fakeSource([candidate]) },
    });

    const results = await discovery.resolveViaCatalog();

    // direct（legacy）→ direct_only：即便配置了 hosted 也只给 direct。
    expect(results[0]?.profile.channel_candidates).toEqual([
      { kind: "a2a-direct", url: "https://merchant.example/a2a" },
    ]);
  });

  it("候选无 agent_card_url 且无 merchant.domain → 跳过（无法 fresh verify）", async () => {
    const noResolve = candidateFixture({
      discovery: undefined,
      merchant: { id: "mrc_01JABC", name: "Acme Merchant" },
    }) as unknown as CandidateAgent;
    const card = agentCard();
    const { fetchImpl, calls } = cardFetch(card);
    const discovery = new AgentDiscovery({
      fetchImpl,
      catalog: { source: fakeSource([noResolve]) },
    });

    const results = await discovery.resolveViaCatalog();

    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("SSRF 边界：agent_card_url 指向非法 scheme → resolve() 现有防护抛错（不重复实现防护）", async () => {
    const evil = candidateFixture({
      discovery: { agent_card_url: "ftp://evil.example/card.json" },
    }) as unknown as CandidateAgent;
    const { fetchImpl } = cardFetch(agentCard());
    const discovery = new AgentDiscovery({
      fetchImpl,
      catalog: { source: fakeSource([evil]) },
    });

    // resolve() 的 fetchCard 对非 http(s) scheme 的抓取失败 → card_fetch_failed。
    await expect(discovery.resolveViaCatalog()).rejects.toMatchObject({
      code: "card_fetch_failed",
    });
  });

  it("fail-closed：候选 fresh resolve 失败（card 抓取 404）→ 抛错，不静默丢弃", async () => {
    const candidate = candidateFixture() as unknown as CandidateAgent;
    const fetchImpl = (async (): Promise<Response> =>
      jsonResponse({ error: "not found" }, 404)) as typeof fetch;
    const discovery = new AgentDiscovery({
      fetchImpl,
      catalog: { source: fakeSource([candidate]) },
    });

    await expect(discovery.resolveViaCatalog()).rejects.toMatchObject({
      code: "card_fetch_failed",
    });
  });
});
