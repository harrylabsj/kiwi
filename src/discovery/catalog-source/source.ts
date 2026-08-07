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
 * ShoppingCliCatalogSource —— 通过 shopping-cli Commerce Agent Catalog 发现候选。
 *
 * 仓库归属（设计 §21）：Agent Catalog API / public CandidateAgent DTO 归
 * shopping-cli 仓所有；Kiwi 只实现 source 消费端。本类只负责：
 *
 *   GET {baseUrl}/v1/agent-catalog/agents/search    → {results: [CandidateAgent…]}
 *   GET {baseUrl}/v1/agent-catalog/agents/{id}      → {catalog_agent: CandidateAgent}
 *
 * 每次响应都按 vendored CandidateAgent DTO 1.0 schema 校验（契约 §5.1 guidance 1）。
 * 任何校验 / HTTP / 网络 / 超时失败抛 CatalogSourceError（fail-closed，§4.6），
 * 不静默容错、不自动降级。
 *
 * Catalog 返回的是 candidate，不是已证明的在线身份（契约 §1 / 设计 §8.2）：
 * 升级为 CounterpartyProfile 是 AgentDiscovery.resolveViaCatalog 的职责，不在此类。
 *
 * MVP Slice A/B（设计 §27）：Slice A 走 Hosted Agent Catalog；Slice B 走
 * Independent Agent Discovery，两者都从本类读取候选。
 */

import { CatalogSourceError } from "./errors.js";
import { validateCandidate } from "./schema.js";
import type { CandidateAgent, CatalogSearchQuery } from "./types.js";

export interface CatalogSourceDeps {
  /** Catalog 服务根 URL（http/https）。 */
  baseUrl: string;
  /** 拉取响应用的 fetch；缺省 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  /** 拉取超时 ms（默认 15000，对齐 AgentDiscovery）。 */
  timeoutMs?: number;
  /** 可选 bearer 凭证（Authorization: Bearer …）。 */
  authToken?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** baseUrl 合法性校验：http(s)、无 userinfo、无 query/fragment。 */
export function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CatalogSourceError("invalid_input", `catalog baseUrl is not a valid URL: "${value}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CatalogSourceError(
      "invalid_input",
      `catalog baseUrl must use http or https (got ${url.protocol})`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new CatalogSourceError(
      "invalid_input",
      "catalog baseUrl must not embed credentials (userinfo)",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new CatalogSourceError(
      "invalid_input",
      "catalog baseUrl must not include query or fragment",
    );
  }
  return value.replace(/\/+$/, "");
}

const SEARCH_QUERY_KEYS: readonly (keyof CatalogSearchQuery)[] = [
  "q",
  "category",
  "region",
  "skill",
  "capability",
  "protocol",
  "hosting_mode",
  "verification_status",
  "limit",
  "cursor",
];

/**
 * 序列化搜索查询。类型层已约束合法键；运行时出现未知键抛 invalid_input
 * （fail-closed，不静默丢弃调用方配置）。
 */
function buildSearchQuery(query: CatalogSearchQuery): string {
  for (const key of Object.keys(query)) {
    if (!SEARCH_QUERY_KEYS.includes(key as keyof CatalogSearchQuery)) {
      throw new CatalogSourceError("invalid_input", `unknown catalog search query key: "${key}"`);
    }
  }
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit <= 0) {
      throw new CatalogSourceError(
        "invalid_input",
        `catalog search limit must be a positive integer (got ${query.limit})`,
      );
    }
  }
  const entries: Array<[string, string]> = [];
  const push = (key: string, value: string | undefined): void => {
    if (value !== undefined) entries.push([key, value]);
  };
  push("q", query.q);
  push("category", query.category);
  push("region", query.region);
  push("skill", query.skill);
  push("capability", query.capability);
  push("protocol", query.protocol);
  push("hosting_mode", query.hosting_mode);
  push("verification_status", query.verification_status);
  if (query.limit !== undefined) push("limit", String(query.limit));
  push("cursor", query.cursor);
  return new URLSearchParams(entries).toString();
}

export class ShoppingCliCatalogSource {
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
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(this.deps.authToken !== undefined
            ? { authorization: `Bearer ${this.deps.authToken}` }
            : {}),
        },
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      const detail = err instanceof Error ? err.message : String(err);
      throw new CatalogSourceError(
        "request_failed",
        name === "AbortError"
          ? `catalog request timed out after ${timeoutMs}ms: ${url}`
          : `catalog request failed: ${url} (${detail})`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new CatalogSourceError(
        "request_failed",
        `catalog request returned HTTP ${response.status} from ${url}`,
      );
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new CatalogSourceError(
        "response_invalid",
        `catalog response from ${url} is not valid JSON`,
      );
    }
    return raw;
  }

  /**
   * 搜索候选（设计 §10.1）。响应信封 `{results: […]}`，逐个元素按 schema 校验；
   * 任何元素违规 → contract_violation。
   */
  async searchCandidates(query: CatalogSearchQuery = {}): Promise<CandidateAgent[]> {
    const qs = buildSearchQuery(query);
    const raw = await this.getJson(
      `/v1/agent-catalog/agents/search${qs.length > 0 ? `?${qs}` : ""}`,
    );
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CatalogSourceError(
        "response_invalid",
        "catalog search response must be a JSON object",
      );
    }
    const body = raw as Record<string, unknown>;
    if (!Array.isArray(body.results)) {
      throw new CatalogSourceError(
        "response_invalid",
        'catalog search response is missing array field "results"',
      );
    }
    return body.results.map((element) => validateCandidate(element));
  }

  /**
   * 按 catalog_agent_id 取单个候选。响应信封 `{catalog_agent: …}`（契约 §5）。
   */
  async getCandidate(catalogAgentId: string): Promise<CandidateAgent> {
    if (typeof catalogAgentId !== "string" || catalogAgentId.length === 0) {
      throw new CatalogSourceError("invalid_input", "catalogAgentId must be a non-empty string");
    }
    const raw = await this.getJson(
      `/v1/agent-catalog/agents/${encodeURIComponent(catalogAgentId)}`,
    );
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CatalogSourceError(
        "response_invalid",
        "catalog get response must be a JSON object",
      );
    }
    const body = raw as Record<string, unknown>;
    if (body.catalog_agent === undefined) {
      throw new CatalogSourceError(
        "response_invalid",
        'catalog get response is missing field "catalog_agent"',
      );
    }
    return validateCandidate(body.catalog_agent);
  }
}

// 类型级 re-export：方便上层只从桶出口导入时拿到查询 / hosting 类型。
export type { RawHostingMode } from "./types.js";
