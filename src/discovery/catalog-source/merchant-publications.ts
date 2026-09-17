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
 * MerchantPublicationsSource —— kiwi-catalog 商家公开资料（M0）只读客户端。
 *
 *   GET {baseUrl}/v1/merchant-publications/search → {ok, results: […], next_cursor}
 *
 * 契约来源：kiwi-catalog 仓 kiwi_catalog/services/merchant_publications.py 的
 * public_projection（schema v29，merchant-buddy 第 0 版设计 §4 M0 表）。上游暂无
 * vendored JSON schema，本文件用手写校验锁定关键不变量（fail-closed）：
 *   - source_kind 恒为 merchant_declared（商家声明，不是 Kiwi 背书）；
 *   - inquiry_available 恒为 false（M0 不产生 Agent Card / A2A 端点 / 实时报价）。
 *
 * 与 KiwiCatalogSource 的关系：同一 catalog 服务的第三个搜索面；出站加固
 * （不跟随重定向、超时、响应大小上限）与错误语义（CatalogSourceError）保持一致。
 */

import { CatalogSourceError } from "./errors.js";
import { PRODUCT_VERSION } from "../../product-cli.js";
import { isRedirectResponse, readJsonBody, SafeHttpError } from "../../net/safe-http.js";
import { validateBaseUrl } from "./source.js";
import type { CatalogSourceDeps } from "./source.js";

const DEFAULT_TIMEOUT_MS = 15_000;
/** 分页拉取上限（与 KiwiCatalogSource 同一防御：游标不前进/循环保护）。 */
const MAX_SEARCH_PAGES = 100;

/**
 * kiwi-catalog 商家公开资料（M0）wire 投影。仅收纳买方发现需要的公开字段；
 * faq/summary 等大字段不进搜索投影（工具返回大小控制）。
 */
export interface MerchantPublicationRecord {
  readonly publication_id: string;
  readonly merchant_id: string;
  readonly merchant_display_name: string;
  /** 命中查询的商品名（商家声明）。 */
  readonly title: string;
  readonly category?: string;
  readonly shop_platform?: string;
  readonly shop_url?: string;
  readonly source_kind: "merchant_declared";
  readonly status: "draft" | "published" | "withdrawn";
  readonly published_at?: string;
  readonly updated_at: string;
  /** M0 恒 false（schema 层不变量）；为 true 的响应视为协议级违规。 */
  readonly inquiry_available: false;
}

/** 公开资料搜索查询（上游键集：q/category/merchant_id/limit/cursor）。 */
export interface MerchantPublicationSearchQuery {
  q?: string;
  category?: string;
  /** 精确限定商家（RFQ 硬门按 merchant_id 解析用）。 */
  merchant_id?: string;
  limit?: number;
  /** 分页游标（searchPublications 内部翻页用；调用方无需直接设置）。 */
  cursor?: string;
}

const PUBLICATION_SEARCH_QUERY_KEYS: readonly string[] = [
  "q",
  "category",
  "merchant_id",
  "limit",
  "cursor",
];

/**
 * 手写校验（上游无 vendored schema 时的 fail-closed 兜底）：必需公开字段 +
 * 两个 M0 不变量。失败抛 contract_violation，绝不把未校验对象当合法结果。
 */
export function validateMerchantPublication(value: unknown): MerchantPublicationRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogSourceError("contract_violation", "MerchantPublication must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  for (const field of [
    "publication_id",
    "merchant_id",
    "merchant_display_name",
    "title",
    "updated_at",
  ]) {
    if (typeof record[field] !== "string" || record[field] === "") {
      throw new CatalogSourceError(
        "contract_violation",
        `MerchantPublication missing non-empty string field "${field}"`,
      );
    }
  }
  if (record.source_kind !== "merchant_declared") {
    throw new CatalogSourceError(
      "contract_violation",
      `MerchantPublication source_kind must be "merchant_declared" (got ${String(record.source_kind)})`,
    );
  }
  if (record.inquiry_available !== false) {
    // M0 不变量：公开资料绝不声称可实时询价（不产生虚假 Agent/实时报价标记）。
    throw new CatalogSourceError(
      "contract_violation",
      "MerchantPublication inquiry_available must be false (M0 invariant)",
    );
  }
  for (const field of ["category", "shop_platform", "shop_url", "published_at"] as const) {
    const v = record[field];
    if (v !== undefined && v !== null && typeof v !== "string") {
      throw new CatalogSourceError(
        "contract_violation",
        `MerchantPublication field "${field}" must be a string when present`,
      );
    }
  }
  return record as unknown as MerchantPublicationRecord;
}

/** 序列化公开资料搜索查询。未知键 → invalid_input（fail-closed）。 */
function buildPublicationSearchQuery(query: MerchantPublicationSearchQuery): string {
  for (const key of Object.keys(query)) {
    if (!PUBLICATION_SEARCH_QUERY_KEYS.includes(key)) {
      throw new CatalogSourceError(
        "invalid_input",
        `unknown merchant-publications search query key: "${key}"`,
      );
    }
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) {
    throw new CatalogSourceError(
      "invalid_input",
      `merchant-publications search limit must be a positive integer (got ${query.limit})`,
    );
  }
  const entries: Array<[string, string]> = [];
  const push = (key: string, value: string | undefined): void => {
    if (value !== undefined) entries.push([key, value]);
  };
  push("q", query.q);
  push("category", query.category);
  push("merchant_id", query.merchant_id);
  if (query.limit !== undefined) push("limit", String(query.limit));
  push("cursor", query.cursor);
  return new URLSearchParams(entries).toString();
}

export class MerchantPublicationsSource {
  private readonly baseUrl: string;
  private readonly deps: CatalogSourceDeps;

  constructor(deps: CatalogSourceDeps) {
    this.baseUrl = validateBaseUrl(deps.baseUrl);
    this.deps = deps;
  }

  /** 核心请求：超时 / HTTP / 网络失败统一映射为 CatalogSourceError。 */
  private async getJson(requestPath: string): Promise<unknown> {
    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${this.baseUrl}${requestPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let raw: unknown;
    try {
      try {
        response = await fetchImpl(url, {
          // 出站加固：绝不跟随重定向（3xx 目标不经过校验，且可能转发 Bearer 头）。
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "user-agent": `kiwi-buyer/${PRODUCT_VERSION}`,
            ...(this.deps.authToken !== undefined
              ? { authorization: `Bearer ${this.deps.authToken}` }
              : {}),
            ...(this.deps.buyerId !== undefined ? { "x-buyer-id": this.deps.buyerId } : {}),
          },
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        const detail = err instanceof Error ? err.message : String(err);
        throw new CatalogSourceError(
          "request_failed",
          name === "AbortError"
            ? `kiwi-catalog request timed out after ${timeoutMs}ms: ${url}`
            : `kiwi-catalog request failed: ${url} (${detail})`,
        );
      }
      if (isRedirectResponse(response)) {
        throw new CatalogSourceError(
          "request_failed",
          `kiwi-catalog request must not follow redirects (HTTP ${response.status} from ${url})`,
        );
      }
      if (!response.ok) {
        throw new CatalogSourceError(
          "request_failed",
          `kiwi-catalog request returned HTTP ${response.status} from ${url}`,
        );
      }
      try {
        raw = await readJsonBody(response, { signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new CatalogSourceError(
            "request_failed",
            `kiwi-catalog request timed out after ${timeoutMs}ms while reading response: ${url}`,
          );
        }
        throw new CatalogSourceError(
          "response_invalid",
          err instanceof SafeHttpError && err.code === "response_too_large"
            ? `kiwi-catalog response from ${url}: ${err.message}`
            : `kiwi-catalog response from ${url} is not valid JSON`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
    return raw;
  }

  /**
   * 公开检索商家公开资料（仅 published 未过期由上游保证）。分页完整拉取，
   * 跨页按 publication_id 去重；limit 是总返回上限而非页大小（同 searchRecords
   * 的历史教训）。旧 catalog 无此端点时抛 request_failed（HTTP 404），由
   * 调用方（KiwiCatalogMerchantIndex）按单侧失败容忍处理。
   */
  async searchPublications(
    query: MerchantPublicationSearchQuery = {},
  ): Promise<MerchantPublicationRecord[]> {
    const records: MerchantPublicationRecord[] = [];
    const seen = new Set<string>();
    const limit = query.limit;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const qs = buildPublicationSearchQuery({
        ...query,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (limit !== undefined && records.length >= limit) break;
      const raw = await this.getJson(
        `/v1/merchant-publications/search${qs.length > 0 ? `?${qs}` : ""}`,
      );
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new CatalogSourceError(
          "response_invalid",
          "merchant-publications search response must be a JSON object",
        );
      }
      const body = raw as Record<string, unknown>;
      if (!Array.isArray(body.results)) {
        throw new CatalogSourceError(
          "response_invalid",
          'merchant-publications search response is missing array field "results"',
        );
      }
      for (const element of body.results) {
        if (limit !== undefined && records.length >= limit) break;
        const record = validateMerchantPublication(element);
        if (seen.has(record.publication_id)) continue;
        seen.add(record.publication_id);
        records.push(record);
      }
      const next = body.next_cursor;
      if (typeof next !== "string" || next === "") break;
      cursor = next;
    }
    return limit !== undefined ? records.slice(0, limit) : records;
  }
}
