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
 * 本实现包装现有 KiwiCatalogSource（/v1/agents）；search 失败（catalog 不可达）
 * 时由上层 service 降级为可解释 note，不编造商家。
 */

import { KiwiCatalogSource } from "../discovery/catalog-source/kiwi-source.js";
import type { CatalogSourceDeps } from "../discovery/catalog-source/source.js";
import type { CatalogAgentRecord } from "../discovery/catalog-source/kiwi-record.js";
import type { MerchantRecord } from "./service.js";

export interface KiwiCatalogMerchantIndexOptions {
  baseUrl: string;
  authToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const VERIFIED_LEVELS = new Set(["domain_verified", "agent_verified", "commerce_verified"]);

export class KiwiCatalogMerchantIndex {
  private readonly source: KiwiCatalogSource;

  constructor(options: KiwiCatalogMerchantIndexOptions) {
    const deps: CatalogSourceDeps = {
      baseUrl: options.baseUrl,
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    };
    this.source = new KiwiCatalogSource(deps);
  }

  /**
   * 商品查询 → catalog listings 搜索（/v1/listings/search，title/category/brand/
   * summary LIKE）找"能供应该商品的商家"，携带 matching_skus；商家身份/Agent Card
   * → /v1/agents/search 补齐 agent_card_url/ucp_profile_url/capabilities。
   *
   * 合并语义（镜像 MarketplaceMerchantIndex 去重）：
   * - listing 命中但 agents 无匹配的商家，用 getRecord(owner_agent_id) 定向补
   *   agent_card_url（商家数有界，不编造）。
   * - catalog 不可达时按 service 层降级为可解释 note；单侧失败容忍（listings 端点
   *   在旧 catalog 上可能不存在），双侧失败才 fail-closed。
   */
  async search(query: string, opts?: { category?: string; region?: string }): Promise<MerchantRecord[]> {
    const [listingsRes, agentsRes] = await Promise.allSettled([
      this.source.searchListings({
        q: query,
        listing_type: "product",
        ...(opts?.category !== undefined ? { category: opts.category } : {}),
        ...(opts?.region !== undefined ? { region: opts.region } : {}),
        limit: 50,
      }),
      this.source.searchRecords({ q: query }),
    ]);
    if (listingsRes.status === "rejected" && agentsRes.status === "rejected") {
      // 双侧失败才抛（fail-closed）；单侧失败容忍，保留可用侧结果。
      throw agentsRes.reason;
    }
    const listings = listingsRes.status === "fulfilled" ? listingsRes.value : [];
    const agents = agentsRes.status === "fulfilled" ? agentsRes.value : [];

    const byId = new Map<string, MerchantRecord>();
    for (const r of listings) {
      const merchantId = r.merchant.merchant_id ?? r.listing.owner_agent_id;
      if (merchantId === undefined || merchantId === "") continue;
      const sku = r.listing.source_product_ref ?? r.listing.listing_id;
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
        });
      } else {
        existing.matching_skus = existing.matching_skus ? [...existing.matching_skus, sku] : [sku];
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
        if (r.capabilities !== undefined && r.capabilities.length > 0) {
          existing.capabilities = [...r.capabilities];
        }
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
    return [...byId.values()];
  }

  /**
   * 按 merchant_id 解析完整记录（含 agent_card_url / matching_skus）。
   *
   * requestQuotes 的兜底：宿主传的 merchant_ids 来自一次成功的 kiwi_search，但
   * requestQuotes 内部会用 intent 的 query 再搜一遍——用户意图文本（如"买一个
   * 保温杯 预算82元"）未必命中 catalog 的 title/category LIKE，导致匹配不到、
   * 商家丢 agent_card_url（A2A 无法磋商）。此处按 merchant_id 直接解析：agents 面
   * 按 merchant_id/catalog_agent_id 匹配，listings 面按 merchant_id 匹配并补
   * owner agent card。catalog 商家数小，全量扫描可接受。
   */
  async resolveById(merchantId: string): Promise<MerchantRecord | undefined> {
    if (merchantId === undefined || merchantId === "") return undefined;
    const [agentsRes, listingsRes] = await Promise.allSettled([
      this.source.searchRecords({}),
      this.source.searchListings({ limit: 50 }),
    ]);
    if (agentsRes.status === "rejected" && listingsRes.status === "rejected") throw agentsRes.reason;
    const agents = agentsRes.status === "fulfilled" ? agentsRes.value : [];
    const listings = listingsRes.status === "fulfilled" ? listingsRes.value : [];

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
    if (listing === undefined && agent === undefined) return undefined;

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
      return record;
    }
    return mapRecord(agent as CatalogAgentRecord);
  }
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
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
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
