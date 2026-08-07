/**
 * KiwiCatalogSource 测试（v0.7.0 WP-A / 完成定义 #2、#8）。
 *
 * 覆盖：
 *   - /v1/agents 新 API 消费：searchRecords / getRecord / searchCandidates /
 *     getCandidate 的响应解析与查询序列化（三态域 + handoff_destination_types）；
 *   - 契约校验：unknown/私有字段在 schema 层拒绝（#8）、非法枚举、信封错误、
 *     HTTP / 网络 / 超时失败、非法输入——全部 fail-closed；
 *   - normalizeCatalogAgent 三态域折叠优先级：rejected > suspended > unreachable
 *     > stale > verification_level（与 legacy BLOCKED 状态集语义一致）；
 *   - 词表单一来源：agent-record schema 的 handoff_destination_types 枚举与
 *     src/handoff/destination.ts 的 DESTINATION_TYPES 严格相等（禁止平行词表）；
 *   - resolveViaCatalog 集成：KiwiCatalogSource 满足 CatalogSource 接口。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AgentDiscovery,
  CatalogSourceError,
  KiwiCatalogSource,
} from "../src/discovery/index.js";
import { DESTINATION_TYPES } from "../src/handoff/destination.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 合法 CatalogAgentRecord（v0.3 §6/§7 形状，三正交状态域）。 */
function recordFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catalog_agent_id: "cagt_01JABC",
    principal_type: "merchant",
    merchant_id: "mrc_01JABC",
    display_name: "Acme Merchant",
    canonical_domain: "acme.example",
    agent_card_url: "https://acme.example/.well-known/agent-card.json",
    ucp_profile_url: "https://acme.example/.well-known/ucp",
    protocols: { a2a: ["1.0.0"], ucp: ["2026-04-08"] },
    capabilities: ["com.harrylabsj.shopping.capability:catalog"],
    skills: [{ skill_id: "commerce-negotiation", name: "Commerce Negotiation" }],
    hosting_mode: "direct_only",
    handoff_destination_types: ["external_checkout_url"],
    verification_level: "commerce_verified",
    freshness_state: "fresh",
    administrative_state: "active",
    last_verified_at: "2026-08-06T00:00:00Z",
    fresh_until: "2026-08-07T00:00:00Z",
    created_at: "2026-08-06T00:00:00Z",
    updated_at: "2026-08-06T12:00:00Z",
    ...overrides,
  };
}

/** 按 URL 路由的 /v1/agents 假 fetch。 */
function kiwiFetch(opts: { search?: () => Response; get?: () => Response }): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: FetchInput, _init?: FetchInit): Promise<Response> => {
    const href = String(input);
    calls.push(href);
    if (href.includes("/v1/agents/search")) {
      return opts.search?.() ?? jsonResponse({ results: [] });
    }
    if (href.includes("/v1/agents/")) {
      return opts.get?.() ?? jsonResponse({ error: "not found" }, 404);
    }
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** 最小合法 Agent Card（passes parseAgentCard）。 */
function agentCard(
  baseUrl = "https://acme.example",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "Acme Real",
    description: "test merchant",
    provider: { organization: "Acme Real", url: baseUrl },
    version: "1.0",
    url: baseUrl,
    supportedInterfaces: [
      { url: `${baseUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    capabilities: { extendedAgentCard: true },
    ...overrides,
  };
}

/** card 抓取假 fetch。 */
function cardFetch(card: Record<string, unknown>): typeof fetch {
  return (async (input: FetchInput, _init?: FetchInit): Promise<Response> => {
    const href = String(input);
    if (!href.startsWith("http://") && !href.startsWith("https://")) {
      throw new TypeError(`fetch failed: unsupported scheme for ${href}`);
    }
    return jsonResponse(card);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// KiwiCatalogSource 单元
// ---------------------------------------------------------------------------

describe("KiwiCatalogSource", () => {
  it("searchRecords 解析 record 并序列化查询（三态域 + handoff 词表）", async () => {
    const { fetchImpl, calls } = kiwiFetch({
      search: () => jsonResponse({ results: [recordFixture()] }),
    });
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example/", fetchImpl });

    const records = await source.searchRecords({
      q: "coffee",
      verification_level: "commerce_verified",
      freshness_state: "fresh",
      administrative_state: "active",
      handoff_destination_types: ["external_checkout_url", "quote_document"],
      limit: 5,
    });

    expect(calls[0]).toContain("/v1/agents/search");
    expect(calls[0]).toContain("q=coffee");
    expect(calls[0]).toContain("verification_level=commerce_verified");
    expect(calls[0]).toContain("freshness_state=fresh");
    expect(calls[0]).toContain("administrative_state=active");
    expect(calls[0]).toContain("handoff_destination_types=external_checkout_url%2Cquote_document");
    expect(calls[0]).toContain("limit=5");
    expect(records).toHaveLength(1);
    expect(records[0]?.catalog_agent_id).toBe("cagt_01JABC");
    expect(records[0]?.verification_level).toBe("commerce_verified");
    expect(records[0]?.handoff_destination_types).toEqual(["external_checkout_url"]);
  });

  it("searchRecords caps the total at limit across pages (limit 是总量不是页大小)", async () => {
    // 回归：limit 曾只当页大小，翻页直到无游标 → --limit 2 返回全部 3 条。
    const page1 = {
      results: [
        recordFixture({ catalog_agent_id: "cagt_a" }),
        recordFixture({ catalog_agent_id: "cagt_b" }),
      ],
      next_cursor: "cursor-1",
    };
    const page2 = {
      results: [recordFixture({ catalog_agent_id: "cagt_c" })],
      next_cursor: "",
    };
    let searchCalls = 0;
    const fetchImpl = (async (input: FetchInput): Promise<Response> => {
      const href = String(input);
      if (href.includes("/v1/agents/search")) {
        searchCalls += 1;
        return jsonResponse(searchCalls === 1 ? page1 : page2);
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });
    const records = await source.searchRecords({ limit: 2 });
    expect(records.length).toBe(2);
    expect(records.map((r) => r.catalog_agent_id)).toEqual(["cagt_a", "cagt_b"]);
    expect(searchCalls).toBe(1); // 已达 limit，不再翻第二页
  });

  it("searchCandidates 折叠三态域 → CandidateAgent 共享形状", async () => {
    const { fetchImpl } = kiwiFetch({
      search: () => jsonResponse({ results: [recordFixture()] }),
    });
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    const candidates = await source.searchCandidates();

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    expect(candidate?.catalog_agent_id).toBe("cagt_01JABC");
    expect(candidate?.merchant?.name).toBe("Acme Merchant");
    expect(candidate?.merchant?.domain).toBe("acme.example");
    expect(candidate?.discovery?.agent_card_url).toBe(
      "https://acme.example/.well-known/agent-card.json",
    );
    expect(candidate?.verification.status).toBe("commerce_verified");
    expect(candidate?.hosting.mode).toBe("direct_only");
    expect(candidate?.contract).toEqual({ name: "candidate-agent", version: "1.0" });
    // handoff 词表不进入 CandidateAgent（DTO 1.0 additionalProperties: false）。
    expect(candidate?.capabilities).toEqual(["com.harrylabsj.shopping.capability:catalog"]);
  });

  it("折叠优先级：administrative rejected 最重 → rejected", async () => {
    const { fetchImpl } = kiwiFetch({
      search: () =>
        jsonResponse({
          results: [
            recordFixture({
              verification_level: "commerce_verified",
              freshness_state: "fresh",
              administrative_state: "rejected",
            }),
          ],
        }),
    });
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    const candidates = await source.searchCandidates();
    expect(candidates[0]?.verification.status).toBe("rejected");
  });

  it("折叠优先级：suspended > unreachable > stale > level", async () => {
    const { fetchImpl } = kiwiFetch({
      search: () =>
        jsonResponse({
          results: [
            recordFixture({
              verification_level: "commerce_verified",
              freshness_state: "unreachable",
              administrative_state: "suspended",
            }),
            recordFixture({
              catalog_agent_id: "cagt_b",
              verification_level: "domain_verified",
              freshness_state: "unreachable",
              administrative_state: "active",
            }),
            recordFixture({
              catalog_agent_id: "cagt_c",
              verification_level: "agent_verified",
              freshness_state: "stale",
              administrative_state: "active",
            }),
            recordFixture({
              catalog_agent_id: "cagt_d",
              verification_level: "discovered",
              freshness_state: "fresh",
              administrative_state: "active",
            }),
          ],
        }),
    });
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    const candidates = await source.searchCandidates();
    expect(candidates.map((c) => c.verification.status)).toEqual([
      "suspended",
      "unreachable",
      "stale",
      "discovered",
    ]);
  });

  it("getRecord / getCandidate（agent 信封）", async () => {
    const { fetchImpl, calls } = kiwiFetch({
      get: () => jsonResponse({ agent: recordFixture() }),
    });
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    const record = await source.getRecord("cagt_01JABC");
    expect(calls[0]).toContain("/v1/agents/cagt_01JABC");
    expect(record.merchant_id).toBe("mrc_01JABC");

    const candidate = await source.getCandidate("cagt_01JABC");
    expect(candidate.verification.status).toBe("commerce_verified");
  });

  it("contract_violation：未知/私有字段（additionalProperties）在 schema 层拒绝（#8）", async () => {
    const { fetchImpl } = kiwiFetch({
      search: () =>
        jsonResponse({
          results: [
            recordFixture({
              floor_price_minor: 100,
              cost_vault_ref: "secret",
            } as Record<string, unknown>),
          ],
        }),
    });
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(source.searchRecords()).rejects.toMatchObject({ code: "contract_violation" });
  });

  it("contract_violation：handoff_destination_types 平行词表（supports_*）→ 拒绝", async () => {
    const { fetchImpl } = kiwiFetch({
      search: () =>
        jsonResponse({
          results: [
            recordFixture({ handoff_destination_types: ["supports_external_checkout"] }),
          ],
        }),
    });
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(source.searchRecords()).rejects.toMatchObject({ code: "contract_violation" });
  });

  it("contract_violation：缺必填三态域 → 拒绝", async () => {
    const { fetchImpl } = kiwiFetch({
      search: () =>
        jsonResponse({
          results: [
            recordFixture({ administrative_state: undefined } as Record<string, unknown>),
          ],
        }),
    });
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(source.searchRecords()).rejects.toMatchObject({ code: "contract_violation" });
  });

  it("response_invalid：search 缺 results / get 缺 agent → response_invalid", async () => {
    const source = new KiwiCatalogSource({
      baseUrl: "https://catalog.example",
      fetchImpl: kiwiFetch({ search: () => jsonResponse({ foo: 1 }) }).fetchImpl,
    });
    await expect(source.searchRecords()).rejects.toMatchObject({ code: "response_invalid" });

    const source2 = new KiwiCatalogSource({
      baseUrl: "https://catalog.example",
      fetchImpl: kiwiFetch({ get: () => jsonResponse({ foo: 1 }) }).fetchImpl,
    });
    await expect(source2.getRecord("cagt_01JABC")).rejects.toMatchObject({
      code: "response_invalid",
    });
  });

  it("request_failed：HTTP 500 / 网络异常 / 超时 → request_failed", async () => {
    const source = new KiwiCatalogSource({
      baseUrl: "https://catalog.example",
      fetchImpl: kiwiFetch({ search: () => jsonResponse({ error: "boom" }, 500) }).fetchImpl,
    });
    await expect(source.searchRecords()).rejects.toMatchObject({ code: "request_failed" });

    const net = (async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const source2 = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl: net });
    await expect(source2.searchRecords()).rejects.toMatchObject({ code: "request_failed" });

    const hanging = (async (_i: FetchInput, init?: FetchInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    const source3 = new KiwiCatalogSource({
      baseUrl: "https://catalog.example",
      fetchImpl: hanging,
      timeoutMs: 50,
    });
    await expect(source3.searchRecords()).rejects.toMatchObject({
      code: "request_failed",
      message: /timed out/,
    });
  });

  it("invalid_input：未知查询键 / 空 handoff 数组 / 非法 limit / 非法 baseUrl", async () => {
    const { fetchImpl } = kiwiFetch({ search: () => jsonResponse({ results: [] }) });
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });

    await expect(
      source.searchRecords({ bogus: "x" } as unknown as Parameters<
        KiwiCatalogSource["searchRecords"]
      >[0]),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(source.searchRecords({ handoff_destination_types: [] })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(source.searchRecords({ limit: 0 })).rejects.toMatchObject({
      code: "invalid_input",
    });

    let error: unknown;
    try {
      new KiwiCatalogSource({ baseUrl: "ftp://catalog.example" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CatalogSourceError);
    expect((error as CatalogSourceError).code).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// 词表单一来源契约（架构 rev1.4.1 §35A：禁止平行词表）
// ---------------------------------------------------------------------------

describe("handoff destination vocabulary single-source", () => {
  it("agent-record schema 的 handoff_destination_types 枚举 === DESTINATION_TYPES", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const schema = JSON.parse(
      readFileSync(
        path.join(here, "..", "contracts", "kiwi-catalog", "1.0", "agent-record.schema.json"),
        "utf-8",
      ),
    ) as { properties: { handoff_destination_types: { items: { enum: string[] } } } };
    const schemaEnum = schema.properties.handoff_destination_types.items.enum;
    expect(schemaEnum.slice().sort()).toEqual([...DESTINATION_TYPES].sort());
    // schema 枚举与 TS 常量顺序一致（保持单一来源的稳定性）。
    expect(schemaEnum).toEqual([...DESTINATION_TYPES]);
  });
});

// ---------------------------------------------------------------------------
// resolveViaCatalog 集成（KiwiCatalogSource 满足 CatalogSource 接口）
// ---------------------------------------------------------------------------

describe("AgentDiscovery.resolveViaCatalog with KiwiCatalogSource", () => {
  it("候选经 fresh resolve 升级（三态域折叠后的 shared 形状进入同一路径）", async () => {
    const { fetchImpl } = kiwiFetch({
      search: () => jsonResponse({ results: [recordFixture()] }),
    });
    const card = agentCard();
    const discovery = new AgentDiscovery({
      fetchImpl: cardFetch(card),
      skipDnsCheck: true, // 注入的 fetchImpl 测试替身
      catalog: { source: new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl }) },
    });

    const results = await discovery.resolveViaCatalog();

    expect(results).toHaveLength(1);
    expect(results[0]?.candidate.catalog_agent_id).toBe("cagt_01JABC");
    expect(results[0]?.candidate.verification.status).toBe("commerce_verified");
    // fresh resolve 走 candidate 的 agent_card_url，不直接信任 record 元数据。
    expect(results[0]?.profile.identity).toBe("Acme Real");
  });

  it("三态域折叠出的 blocked 状态被默认过滤（suspended → 不进入 fresh resolve）", async () => {
    const { fetchImpl } = kiwiFetch({
      search: () =>
        jsonResponse({
          results: [
            recordFixture({
              catalog_agent_id: "cagt_blocked",
              administrative_state: "suspended",
            }),
            recordFixture({ catalog_agent_id: "cagt_ok" }),
          ],
        }),
    });
    const card = agentCard();
    const discovery = new AgentDiscovery({
      fetchImpl: cardFetch(card),
      skipDnsCheck: true, // 注入的 fetchImpl 测试替身
      catalog: { source: new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl }) },
    });

    const results = await discovery.resolveViaCatalog();

    expect(results.map((r) => r.candidate.catalog_agent_id)).toEqual(["cagt_ok"]);
  });
});

/** listing 搜索响应桩（/v1/listings/search + /{id}；Kiwi 形状）。 */
function listingFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listing: {
      listing_id: "lst_01JABC",
      listing_type: "product",
      owner_agent_id: "cagt_01JABC",
      merchant_id: "mrc_01JABC",
      source_product_ref: "SKU-001",
      title: "21.5 inch Industrial Touch Display",
      category: "industrial-display",
      listing_digest: "abc123",
      publication_state: "ACTIVE",
      listing_freshness_state: "FRESH",
      published_at: "2026-08-07T00:00:00Z",
      updated_at: "2026-08-07T00:00:00Z",
      fresh_until: "2026-08-08T00:00:00Z",
      ...(overrides.listing as Record<string, unknown> | undefined),
    },
    merchant: { merchant_id: "mrc_01JABC", display_name: "Acme Merchant" },
    agent: {
      catalog_agent_id: "cagt_01JABC",
      verification_level: "commerce_verified",
      freshness_state: "fresh",
      administrative_state: "active",
    },
    listing_freshness_state: "FRESH",
    authority: "discovery_projection",
    requires_direct_confirmation: true,
    ...(overrides.searchResult as Record<string, unknown> | undefined),
  };
}

describe("KiwiCatalogSource listing methods (v0.4 / CD #22-#24)", () => {
  it("searchListings parses results and keeps CD #24 constants", async () => {
    const fetchImpl = (async (input: FetchInput): Promise<Response> => {
      if (String(input).includes("/v1/listings/search")) {
        return jsonResponse({ results: [listingFixture()], next_cursor: "" });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });
    const results = await source.searchListings({ q: "touch", listing_type: "product" });
    expect(results.length).toBe(1);
    expect(results[0]?.authority).toBe("discovery_projection");
    expect(results[0]?.requires_direct_confirmation).toBe(true);
    expect(results[0]?.listing.owner_agent_id).toBe("cagt_01JABC");
    expect(results[0]?.listing.source_product_ref).toBe("SKU-001");
  });

  it("searchListings caps the total at limit across pages (limit 是总量不是页大小)", async () => {
    // 回归：limit 曾只当页大小，翻页直到无游标 → --limit 3 返回全部 4 条。
    const page1 = {
      results: [
        listingFixture({ listing: { listing_id: "lst_a" } }),
        listingFixture({ listing: { listing_id: "lst_b" } }),
      ],
      next_cursor: "cursor-1",
    };
    const page2 = {
      results: [
        listingFixture({ listing: { listing_id: "lst_c" } }),
        listingFixture({ listing: { listing_id: "lst_d" } }),
      ],
      next_cursor: "",
    };
    const fetchImpl = (async (input: FetchInput): Promise<Response> => {
      if (String(input).includes("/v1/listings/search")) {
        return jsonResponse(String(input).includes("cursor-1") ? page2 : page1);
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });
    const results = await source.searchListings({ limit: 3 });
    expect(results.length).toBe(3);
    expect(results.map((r) => r.listing.listing_id)).toEqual(["lst_a", "lst_b", "lst_c"]);
  });

  it("searchListings rejects unknown query keys (fail-closed)", async () => {
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl: fetch });
    await expect(source.searchListings({ mystery: "x" } as never)).rejects.toThrow("unknown");
  });

  it("searchListings rejects a result that violates the schema (private field)", async () => {
    const bad = listingFixture({ searchResult: { floor_price: 100 } });
    const fetchImpl = (async (input: FetchInput): Promise<Response> => {
      if (String(input).includes("/v1/listings/search")) {
        return jsonResponse({ results: [bad], next_cursor: "" });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });
    await expect(source.searchListings({})).rejects.toMatchObject({ code: "contract_violation" });
  });

  it("getListing returns the record and validates it", async () => {
    const fetchImpl = (async (input: FetchInput): Promise<Response> => {
      if (String(input).includes("/v1/listings/")) {
        return jsonResponse({ listing: listingFixture().listing });
      }
      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;
    const source = new KiwiCatalogSource({ baseUrl: "https://catalog.example", fetchImpl });
    const listing = await source.getListing("lst_01JABC");
    expect(listing.listing_type).toBe("product");
    await expect(source.getListing("")).rejects.toMatchObject({ code: "invalid_input" });
  });
});
