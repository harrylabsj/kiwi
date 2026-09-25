/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * KiwiCatalogMerchantIndex —— kiwi-catalog 驱动的 MerchantIndex（战略 v2.5 §3.2）。
 *
 * kiwi-catalog 收缩为 Merchant Discovery & Routing Index：保存 Merchant
 * Identity、Verification、Freshness、Category/Region、RFQ/KNP 支持、UCP Profile
 * URL 与 A2A Agent Card。真实商品信息由 Buyer 访问 Merchant 的 UCP Catalog /
 * 声明的权威 endpoint，kiwi-catalog 不是商品 truth source。
 *
 * 本实现包装现有 KiwiCatalogSource（/v1/agents、/v1/listings）与
 * MerchantPublicationsSource（/v1/merchant-publications，M0 商家公开资料）；
 * search 失败（catalog 不可达）时由上层 service 降级为可解释 note，不编造商家。
 */

import { KiwiCatalogSource } from "../discovery/catalog-source/kiwi-source.js";
import {
  MerchantPublicationsSource,
  type MerchantPublicationRecord,
} from "../discovery/catalog-source/merchant-publications.js";
import type { CatalogSourceDeps } from "../discovery/catalog-source/source.js";
import type { CatalogAgentRecord } from "../discovery/catalog-source/kiwi-record.js";
import { trimTrailingSlashes } from "../net/url.js";
import type { MerchantPublicationSummary, MerchantRecord } from "./service.js";
import {
  classifyComponentFailure,
  summarizeNetworkSearch,
  type NetworkSearchComponent,
  type NetworkSearchComponentName,
  type NetworkSearchDiagnostics,
} from "./network-search.js";
import { MAX_PRODUCTS_PER_MERCHANT, summarizeListing } from "./product-summary.js";

/** 三路 allSettled 结果 → 组件状态（fulfilled 即 completed，rejected 按错误码分类）。 */
function componentOf(
  name: NetworkSearchComponentName,
  result: PromiseSettledResult<unknown[]>,
): NetworkSearchComponent {
  return result.status === "fulfilled"
    ? { name, status: "completed" }
    : classifyComponentFailure(name, result.reason);
}

export interface KiwiCatalogMerchantIndexOptions {
  baseUrl: string;
  authToken?: string;
  /** 稳定匿名买家身份（catalog 用量统计）；透传为 X-Buyer-Id 头。 */
  buyerId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 可注入时钟（`network_search.searched_at`）；缺省系统时间。 */
  now?: () => string;
}

const VERIFIED_LEVELS = new Set(["domain_verified", "agent_verified", "commerce_verified"]);

/** 离线态（catalog 读时按 TTL 派生的 freshness_state）。 */
const STALE_FRESHNESS_STATES = new Set(["stale", "unreachable"]);

/** agent 是否新鲜：未设置按 fresh 处理（旧 catalog / legacy 索引向后兼容）。 */
function isAgentFresh(record: { freshness_state?: string }): boolean {
  const state = record.freshness_state;
  return state === undefined || !STALE_FRESHNESS_STATES.has(state);
}

export class KiwiCatalogMerchantIndex {
  private readonly source: KiwiCatalogSource;
  private readonly publications: MerchantPublicationsSource;
  private readonly now: () => string;
  /** 上一次 search 的非致命降级说明（单侧失败容忍时填充）。 */
  private searchNotes: string[] = [];

  constructor(options: KiwiCatalogMerchantIndexOptions) {
    const deps: CatalogSourceDeps = {
      baseUrl: options.baseUrl,
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.buyerId !== undefined ? { buyerId: options.buyerId } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    };
    this.source = new KiwiCatalogSource(deps);
    this.publications = new MerchantPublicationsSource(deps);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  lastSearchNotes(): string[] {
    return [...this.searchNotes];
  }

  /**
   * 商品查询 → catalog listings 搜索（/v1/listings/search，title/category/brand/
   * summary LIKE）找"能供应该商品的商家"，携带 matching_skus；商家身份/Agent Card
   * → /v1/agents/search 补齐 agent_card_url/ucp_profile_url/capabilities；M0 商家
   * 公开资料 → /v1/merchant-publications/search 补"资料可查"商家（merchant-buddy
   * 第 0 版 §4 M0 表步骤 4）。
   *
   * 合并语义（镜像 MarketplaceMerchantIndex 去重）：
   * - 按 merchant_id 去重：同一商家同时命中 Agent/Listing 与 M0 公开资料时只显示
   *   一个主体，公开资料并列在 publications；可实时询价能力（inquiry_available）
   *   只来自 Agent 侧（agent_card_url），不因 M0 静态资料降级或虚标。
   * - listing 命中但 agents 无匹配的商家，用 getRecord(owner_agent_id) 定向补
   *   agent_card_url（商家数有界，不编造）。
   * - 失败语义：Agent/Listing 两侧都失败且 publications 也失败才 fail-closed；
   *   单侧（含 publications 端点不存在的旧 catalog）容忍并在 note 标注该来源
   *   暂不可用，不凭模型记忆补全商家。
   */
  async search(query: string, opts?: { category?: string; region?: string }): Promise<MerchantRecord[]> {
    const outcome = await this.runSearch(query, opts);
    if (outcome.failure !== undefined) throw outcome.failure;
    return outcome.merchants;
  }

  /**
   * 与 `search` 同源，但把**本次**查询的组件状态随结果返回：诊断随结果走，
   * 不依赖可被并发搜索覆盖的实例级 `lastSearchNotes`（设计 §17）。
   *
   * 与 `search` 的唯一差别：全侧失败不抛错——失败本身就是要如实上报的状态
   * （`status: timeout|error` + `result_state: undetermined`），由 service 汇总
   * 进 `network_search`；`search()` 保留原 fail-closed 抛错契约供旧调用方使用。
   */
  async searchWithDiagnostics(
    query: string,
    opts?: { category?: string; region?: string },
  ): Promise<{ merchants: MerchantRecord[]; diagnostics: NetworkSearchDiagnostics }> {
    const outcome = await this.runSearch(query, opts);
    return { merchants: outcome.merchants, diagnostics: outcome.diagnostics };
  }

  private async runSearch(
    query: string,
    opts?: { category?: string; region?: string },
  ): Promise<{
    merchants: MerchantRecord[];
    diagnostics: NetworkSearchDiagnostics;
    failure?: unknown;
  }> {
    const [listingsRes, agentsRes, publicationsRes] = await Promise.allSettled([
      this.source.searchListings({
        q: query,
        listing_type: "product",
        ...(opts?.category !== undefined ? { category: opts.category } : {}),
        ...(opts?.region !== undefined ? { region: opts.region } : {}),
        limit: 50,
      }),
      this.source.searchRecords({ q: query }),
      this.publications.searchPublications({
        q: query,
        ...(opts?.category !== undefined ? { category: opts.category } : {}),
        limit: 50,
      }),
    ]);
    // 组件级状态：成功/超时/失败/能力缺失必须分开上报（设计 §7/§17），
    // 宿主据此如实说明，而不是把"目录不可达"说成"没有匹配"。
    const components: NetworkSearchComponent[] = [
      componentOf("listings", listingsRes),
      componentOf("agents", agentsRes),
      componentOf("merchant_publications", publicationsRes),
    ];
    const statusOf = (name: NetworkSearchComponentName): NetworkSearchComponent["status"] =>
      components.find((component) => component.name === name)?.status ?? "not_searched";
    const listingsStatus = statusOf("listings");
    const agentsStatus = statusOf("agents");
    const publicationsStatus = statusOf("merchant_publications");
    const agentSideFailed = listingsStatus !== "completed" && agentsStatus !== "completed";
    const notes: string[] = [];
    if (agentSideFailed) {
      notes.push("Agent/Listing 发现来源暂不可用，当前仅含商家公开资料（资料可查）结果");
    } else if (listingsStatus !== "completed" || agentsStatus !== "completed") {
      // 单侧不可用：仍有结果可展示，但覆盖确实不完整（设计 §17 要求单个内部
      // 来源失败也能被标为部分完成）。只读 note 的旧宿主据此保守表述。
      notes.push(
        `${listingsStatus !== "completed" ? "商品（listings）" : "商家（agents）"}来源本次查询未完成，当前结果覆盖不完整`,
      );
    }
    if (publicationsStatus !== "completed") {
      notes.push("商家公开资料（merchant-publications）来源暂不可用，当前仅含 Agent/Listing 结果");
    }
    const listings = listingsRes.status === "fulfilled" ? listingsRes.value : [];
    const agents = agentsRes.status === "fulfilled" ? agentsRes.value : [];
    const publications = publicationsRes.status === "fulfilled" ? publicationsRes.value : [];

    const byId = new Map<string, MerchantRecord>();
    for (const r of listings) {
      const merchantId = r.merchant.merchant_id ?? r.listing.owner_agent_id;
      if (merchantId === undefined || merchantId === "") continue;
      const sku = r.listing.source_product_ref ?? r.listing.listing_id;
      const product = summarizeListing(r);
      const existing = byId.get(merchantId);
      if (existing === undefined) {
        byId.set(merchantId, {
          merchant_id: merchantId,
          name: r.merchant.display_name,
          verified: VERIFIED_LEVELS.has(r.agent.verification_level),
          category: r.listing.category,
          region: r.listing.regions?.[0],
          capabilities: [],
          matching_skus: [sku],
          delivery: r.listing.commercial_hints?.lead_time_hint,
          products: [product],
        });
      } else {
        existing.matching_skus = existing.matching_skus ? [...existing.matching_skus, sku] : [sku];
        // 商品摘要按 catalog 返回顺序取前 N 条（控制工具返回体积，设计 §17）。
        if ((existing.products?.length ?? 0) < MAX_PRODUCTS_PER_MERCHANT) {
          existing.products = [...(existing.products ?? []), product];
        }
      }
    }
    for (const r of agents) {
      if (r.principal_type !== "merchant") continue;
      const merchantId = r.merchant_id ?? r.catalog_agent_id;
      if (merchantId === undefined || merchantId === "") continue;
      const existing = byId.get(merchantId);
      if (existing === undefined) {
        byId.set(merchantId, mapRecord(r));
      } else {
        if (r.verification_level !== undefined) {
          existing.verified = VERIFIED_LEVELS.has(r.verification_level);
        }
        existing.ucp_profile_url = r.ucp_profile_url ?? existing.ucp_profile_url;
        existing.agent_card_url = r.agent_card_url ?? existing.agent_card_url;
        existing.freshness_state = r.freshness_state ?? existing.freshness_state;
        if (r.capabilities !== undefined && r.capabilities.length > 0) {
          existing.capabilities = [...r.capabilities];
        }
      }
    }
    // M0 公开资料合并：同一 merchant_id 去重为一个主体；已有 Agent/Listing 命中
    // 的商家只并列 publications（实时能力不被静态资料降级），仅 M0 命中的商家
    // 标 source_kind=merchant_declared（RFQ 硬门依据），保留命中商品名/来源/更新时间。
    for (const p of publications) {
      const merchantId = p.merchant_id;
      if (merchantId === "") continue;
      const summary = mapPublication(p);
      const existing = byId.get(merchantId);
      if (existing === undefined) {
        byId.set(merchantId, {
          merchant_id: merchantId,
          name: p.merchant_display_name,
          verified: false,
          ...(p.category !== undefined && p.category !== "" ? { category: p.category } : {}),
          capabilities: [],
          source_kind: "merchant_declared",
          publications: [summary],
        });
      } else {
        existing.publications = [...(existing.publications ?? []), summary];
      }
    }
    // listing 命中但缺 Agent Card 的商家：定向取 owner Agent record 补 agent_card_url
    // （A2A 磋商必需；商家数有界）。
    await Promise.all(
      listings.map(async (r) => {
        const merchantId = r.merchant.merchant_id ?? r.listing.owner_agent_id;
        const rec = byId.get(merchantId);
        if (rec === undefined || rec.agent_card_url !== undefined) return;
        try {
          const owner = await this.source.getRecord(r.listing.owner_agent_id);
          rec.agent_card_url = owner.agent_card_url;
          rec.ucp_profile_url = owner.ucp_profile_url ?? rec.ucp_profile_url;
          if (owner.capabilities !== undefined && owner.capabilities.length > 0) {
            rec.capabilities = [...owner.capabilities];
          }
        } catch {
          // 商家不可达：保留已收集字段，不编造。
        }
      }),
    );
    // inquiry_available 只由 Agent 侧决定（有可路由 agent_card_url 才可实时询价），
    // 且 agent 必须**新鲜**：商家服务离线后不再标"可实时询价"，但公开资料仍可查
    // （WP6 / 发布计划 §3.6）。freshness_state 由 catalog 读时按 TTL 派生；缺字段
    // （旧 catalog / legacy 来源）视为 fresh，保持向后兼容。
    const records = [...byId.values()].map((rec) => ({
      ...rec,
      inquiry_available: rec.agent_card_url !== undefined && isAgentFresh(rec),
    }));
    const staleCount = records.filter(
      (rec) => rec.agent_card_url !== undefined && !isAgentFresh(rec),
    ).length;
    if (staleCount > 0) {
      notes.push(
        `${staleCount} 个商家的服务当前离线（未在有效期内上报心跳），暂不可实时询价；公开资料仍可查`,
      );
    }
    // 商家离线是候选的可询价状态，不改变来源查询状态（设计 §17）。
    const completedCount = components.filter((component) => component.status === "completed").length;
    const attemptedCount = components.filter((component) => component.status !== "not_searched").length;
    let failure: unknown;
    if (completedCount === 0 && attemptedCount > 0) {
      // 全侧失败才抛（fail-closed）；任何一侧可用都保留其结果。
      if (agentsRes.status === "rejected") {
        failure = agentsRes.reason;
      } else if (publicationsRes.status === "rejected") {
        failure = publicationsRes.reason;
      }
      // note 必须显式说明"查询未完成"：只读 note 的宿主（含旧版）不能把它
      // 当成"没有匹配"（设计 §7 故障处理）。
      notes.push(
        `Kiwi Network 本次查询未完成：${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
    const diagnostics = summarizeNetworkSearch({
      components,
      candidateCount: records.length,
      searchedAt: this.now(),
      notes,
    });
    // 兼容 lastSearchNotes（实例级，旧调用方/宿主）；诊断本身随结果返回。
    this.searchNotes = notes;
    return failure === undefined
      ? { merchants: records, diagnostics }
      : { merchants: records, diagnostics, failure };
  }

  /**
   * 按 merchant_id 解析完整记录（含 agent_card_url / matching_skus）。
   *
   * requestQuotes 的兜底：宿主传的 merchant_ids 来自一次成功的 kiwi_search，但
   * requestQuotes 内部会用 intent 的 query 再搜一遍——用户意图文本（如"买一个
   * 保温杯 预算82元"）未必命中 catalog 的 title/category LIKE，导致匹配不到、
   * 商家丢 agent_card_url（A2A 无法磋商）。此处按 merchant_id 直接解析：agents 面
   * 按 merchant_id/catalog_agent_id 匹配，listings 面按 merchant_id 匹配并补
   * owner agent card，publications 面按 merchant_id 精确过滤。catalog 商家数小，
   * 全量扫描可接受。
   *
   * M0：Agent/Listing 两侧都无命中、仅公开资料命中时返回 source_kind=
   * merchant_declared 的记录（无 agent_card_url）——service 层 RFQ 硬门据此
   * 拒绝，不编造可路由能力。
   */
  async resolveById(merchantId: string): Promise<MerchantRecord | undefined> {
    if (merchantId === undefined || merchantId === "") return undefined;
    const [agentsRes, listingsRes, publicationsRes] = await Promise.allSettled([
      this.source.searchRecords({}),
      this.source.searchListings({ limit: 50 }),
      this.publications.searchPublications({ merchant_id: merchantId, limit: 50 }),
    ]);
    if (agentsRes.status === "rejected" && listingsRes.status === "rejected") throw agentsRes.reason;
    const agents = agentsRes.status === "fulfilled" ? agentsRes.value : [];
    const listings = listingsRes.status === "fulfilled" ? listingsRes.value : [];
    // publications 失败容忍（旧 catalog 无此端点）：M0 信息缺失时退化为既有行为。
    const publications = publicationsRes.status === "fulfilled" ? publicationsRes.value : [];
    const publicationSummaries = publications.map(mapPublication);

    // 审查：host 传入的 merchant_ids 可能来自 catalog_agent_id（cagt_…）或
    // merchant_id（mkt_…）。不能用 `??` 短路（merchant_id 存在时忽略 agent id，
    // 导致 cagt_ 传入 → resolveById undefined → "merchant has no agent card URL"）。
    const listing = listings.find(
      (l) =>
        l.merchant.merchant_id === merchantId ||
        l.listing.owner_agent_id === merchantId,
    );
    const agent = agents.find(
      (a) => a.merchant_id === merchantId || a.catalog_agent_id === merchantId,
    )
      ?? (listing !== undefined
        ? agents.find((a) => a.catalog_agent_id === listing.listing.owner_agent_id)
        : undefined);
    if (listing === undefined && agent === undefined) {
      // 仅 M0 公开资料命中：可解析但不可路由（inquiry_available=false）。
      const first = publications[0];
      if (first === undefined) return undefined;
      return {
        merchant_id: first.merchant_id,
        name: first.merchant_display_name,
        verified: false,
        ...(first.category !== undefined && first.category !== "" ? { category: first.category } : {}),
        capabilities: [],
        inquiry_available: false,
        source_kind: "merchant_declared",
        publications: publicationSummaries,
      };
    }
    if (listing !== undefined) {
      // listing 优先：商品事实（matching_skus/category/region）+ agent card
      const record: MerchantRecord = {
        merchant_id: listing.merchant.merchant_id ?? listing.listing.owner_agent_id,
        name: listing.merchant.display_name,
        verified: VERIFIED_LEVELS.has(listing.agent.verification_level),
        category: listing.listing.category,
        region: listing.listing.regions?.[0],
        capabilities: [],
        matching_skus: [listing.listing.source_product_ref ?? listing.listing.listing_id],
        delivery: listing.listing.commercial_hints?.lead_time_hint,
      };
      if (agent !== undefined) {
        record.agent_card_url = agent.agent_card_url;
        record.ucp_profile_url = agent.ucp_profile_url ?? record.ucp_profile_url;
        record.capabilities = agent.capabilities ? [...agent.capabilities] : record.capabilities;
      } else {
        try {
          const owner = await this.source.getRecord(listing.listing.owner_agent_id);
          record.agent_card_url = owner.agent_card_url;
          record.ucp_profile_url = owner.ucp_profile_url ?? record.ucp_profile_url;
          if (owner.capabilities !== undefined && owner.capabilities.length > 0) {
            record.capabilities = [...owner.capabilities];
          }
        } catch {
          // 商家不可达：保留已收集字段，不编造
        }
      }
      if (publicationSummaries.length > 0) record.publications = publicationSummaries;
      record.inquiry_available = record.agent_card_url !== undefined;
      return record;
    }
    const mapped = mapRecord(agent as CatalogAgentRecord);
    if (publicationSummaries.length > 0) mapped.publications = publicationSummaries;
    mapped.inquiry_available = mapped.agent_card_url !== undefined;
    return mapped;
  }
}

/** M0 公开资料 → 搜索投影摘要（不含 faq/summary 大字段，控制工具返回大小）。 */
function mapPublication(record: MerchantPublicationRecord): MerchantPublicationSummary {
  return {
    publication_id: record.publication_id,
    title: record.title,
    source_kind: record.source_kind,
    updated_at: record.updated_at,
    ...(record.published_at !== undefined && record.published_at !== ""
      ? { published_at: record.published_at }
      : {}),
    ...(record.category !== undefined && record.category !== "" ? { category: record.category } : {}),
    ...(record.shop_url !== undefined && record.shop_url !== "" ? { shop_url: record.shop_url } : {}),
  };
}

function mapRecord(record: CatalogAgentRecord): MerchantRecord {
  return {
    merchant_id: record.merchant_id ?? record.catalog_agent_id,
    name: record.display_name,
    verified: record.verification_level !== undefined
      ? VERIFIED_LEVELS.has(record.verification_level)
      : false,
    category: record.capabilities?.some((c) => c.includes("catalog")) ? "catalog" : undefined,
    region: undefined,
    ucp_profile_url: record.ucp_profile_url,
    agent_card_url: record.agent_card_url,
    capabilities: record.capabilities ? [...record.capabilities] : [],
    // 新鲜度透传（WP6）：catalog 读时按 last_seen_at + TTL 派生。
    freshness_state: record.freshness_state,
  };
}

export interface MarketplaceMerchantIndexOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ProductSearchRow {
  merchant_id?: string;
  merchant_name?: string;
  sku?: string;
  title?: string;
  price?: number;
  stock?: number;
  category?: string;
}

/**
 * MarketplaceMerchantIndex —— 基于 marketplace 真实商品 FTS 的 MerchantIndex。
 *
 * 商品查询 → /search/products 找"能供应该商品的商家"（真实商品/库存事实），
 * 去重返回可路由 MerchantRecord。这解决 kiwi_search 对"谁有货"的意图（§3.2：
 * 需要真实商品信息时访问 Merchant 的权威 endpoint；本索引用 marketplace 的
 * 真实商品数据做路由，不拥有/不编造商品 truth）。
 */
export class MarketplaceMerchantIndex {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MarketplaceMerchantIndexOptions) {
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async search(query: string, _opts?: { category?: string; region?: string }): Promise<MerchantRecord[]> {
    const url = `${this.baseUrl}/search/products?query=${encodeURIComponent(query)}`;
    const res = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`marketplace /search/products ${res.status}`);
    const data = (await res.json()) as { results?: ProductSearchRow[] };
    const rows = data.results ?? [];
    const terms = cjkTerms(query);
    const seen = new Map<string, { record: MerchantRecord; skus: Map<string, number> }>();
    for (const row of rows) {
      const merchantId = row.merchant_id;
      if (merchantId === undefined || merchantId === "") continue;
      const title = row.title ?? "";
      // 相关度：标题命中的查询中文词数（≥2 字词）。FTS 对中文噪声大，
      // 只保留标题含查询关键词的商品，避免把"长尾夹"当"扩展坞"的匹配。
      const relevance = terms.reduce((n, term) => (title.includes(term) ? n + 1 : n), 0);
      if (relevance === 0 || row.sku === undefined || row.sku === "") continue;
      const entry = seen.get(merchantId);
      if (entry === undefined) {
        seen.set(merchantId, {
          record: {
            merchant_id: merchantId,
            name: row.merchant_name ?? merchantId,
            verified: true,
            category: row.category,
            region: undefined,
            capabilities: ["com.harrylabsj.kiwi.shopping.negotiation"],
          },
          skus: new Map<string, number>(),
        });
      }
      seen.get(merchantId)?.skus.set(row.sku, Math.max(relevance, seen.get(merchantId)?.skus.get(row.sku) ?? 0));
    }
    return [...seen.values()].map(({ record, skus }) => ({
      ...record,
      matching_skus:
        skus.size > 0 ? [...skus.entries()].sort((a, b) => b[1] - a[1]).map(([sku]) => sku) : undefined,
    }));
  }

  /**
   * marketplace 路径是 legacy（试点 shopping-cli 直连），fetcher 不依赖
   * agent_card_url；按 merchant_id 无法从商品 FTS 端点解析，返回 undefined →
   * service 回落最小记录（marketplace fetcher 仍可工作）。
   */
  async resolveById(_merchantId: string): Promise<MerchantRecord | undefined> {
    return undefined;
  }
}

/** 提取查询里的中文词（连续 CJK 长度≥2），用于标题相关度过滤。 */
function cjkTerms(query: string): string[] {
  const matches = query.match(/[一-鿿]{2,}/g);
  return matches ?? [];
}
