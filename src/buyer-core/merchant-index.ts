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

  async search(query: string, opts?: { category?: string; region?: string }): Promise<MerchantRecord[]> {
    const records = await this.source.searchRecords({ q: query });
    const merchants = records
      .filter((r) => r.principal_type === "merchant")
      .filter((r) => r.merchant_id !== undefined)
      .filter((r) => {
        if (opts?.category !== undefined && !r.display_name.toLowerCase().includes(opts.category.toLowerCase())) {
          return false;
        }
        if (opts?.region !== undefined && !r.display_name.toLowerCase().includes(opts.region.toLowerCase())) {
          return false;
        }
        return true;
      })
      .map((r): MerchantRecord => mapRecord(r));
    return merchants;
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
}

/** 提取查询里的中文词（连续 CJK 长度≥2），用于标题相关度过滤。 */
function cjkTerms(query: string): string[] {
  const matches = query.match(/[一-鿿]{2,}/g);
  return matches ?? [];
}
