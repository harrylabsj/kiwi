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
 * KiwiCatalogSource —— 消费 kiwi-catalog 独立服务的新 API（产品文档 v0.3 §9）。
 *
 *   GET {baseUrl}/v1/agents/search   → {results: [CatalogAgentRecord…], next_cursor?}
 *   GET {baseUrl}/v1/agents/{id}     → {agent: CatalogAgentRecord}
 *
 * 每个响应元素按 contracts/kiwi-catalog/1.0/agent-record.schema.json 校验（#8 在
 * schema 层强制：additionalProperties: false，私有字段进不来）。任何校验 / HTTP /
 * 网络 / 超时失败抛 CatalogSourceError（fail-closed），不静默容错、不自动降级。
 *
 * 与 ShoppingCliCatalogSource 的关系：后者消费 legacy `/v1/agent-catalog/*`
 * （DTO 1.0 直接）；本类消费新 `/v1/agents/*`（三正交状态域 record），经
 * normalizeCatalogAgent 折叠为共享 CandidateAgent 形状，两者都满足
 * `CatalogSource` 接口（resolve.ts 的 resolveViaCatalog 可互换）。
 *
 * `handoff_destination_types` 搜索词表从 src/handoff/destination.ts import
 * （单一来源，禁止 supports_* 平行词表；架构 rev1.4.1 §35A 一致性原则）。
 */

import { CatalogSourceError } from "./errors.js";
import { validateBaseUrl } from "./source.js";
import type { CatalogSourceDeps } from "./source.js";
import { validateCatalogAgentRecord } from "./kiwi-schema.js";
import {
  normalizeCatalogAgent,
  type CatalogAgentRecord,
  type KiwiCatalogSearchQuery,
} from "./kiwi-record.js";
import type { CandidateAgent } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

const KIWI_SEARCH_QUERY_KEYS: readonly string[] = [
  "q",
  "capability",
  "protocol",
  "hosting_mode",
  "verification_level",
  "freshness_state",
  "administrative_state",
  "handoff_destination_types",
  "limit",
  "cursor",
];

/**
 * 序列化富搜索查询。未知键 → invalid_input（fail-closed，不静默丢弃）。
 * handoff_destination_types 按 KTH destination_type 枚举逐值校验后以逗号连接。
 */
function buildSearchQuery(query: KiwiCatalogSearchQuery): string {
  for (const key of Object.keys(query)) {
    if (!KIWI_SEARCH_QUERY_KEYS.includes(key)) {
      throw new CatalogSourceError("invalid_input", `unknown kiwi-catalog search query key: "${key}"`);
    }
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) {
    throw new CatalogSourceError(
      "invalid_input",
      `kiwi-catalog search limit must be a positive integer (got ${query.limit})`,
    );
  }
  const entries: Array<[string, string]> = [];
  const push = (key: string, value: string | undefined): void => {
    if (value !== undefined) entries.push([key, value]);
  };
  push("q", query.q);
  push("capability", query.capability);
  push("protocol", query.protocol);
  push("hosting_mode", query.hosting_mode);
  push("verification_level", query.verification_level);
  push("freshness_state", query.freshness_state);
  push("administrative_state", query.administrative_state);
  if (query.handoff_destination_types !== undefined) {
    if (query.handoff_destination_types.length === 0) {
      throw new CatalogSourceError(
        "invalid_input",
        "handoff_destination_types must be a non-empty array of KTH destination_type values",
      );
    }
    entries.push(["handoff_destination_types", [...query.handoff_destination_types].join(",")]);
  }
  if (query.limit !== undefined) push("limit", String(query.limit));
  push("cursor", query.cursor);
  return new URLSearchParams(entries).toString();
}

export class KiwiCatalogSource {
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
          ? `kiwi-catalog request timed out after ${timeoutMs}ms: ${url}`
          : `kiwi-catalog request failed: ${url} (${detail})`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new CatalogSourceError(
        "request_failed",
        `kiwi-catalog request returned HTTP ${response.status} from ${url}`,
      );
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new CatalogSourceError(
        "response_invalid",
        `kiwi-catalog response from ${url} is not valid JSON`,
      );
    }
    return raw;
  }

  /** 搜索 record（新 API，支持三态域 + handoff 词表过滤）。 */
  async searchRecords(query: KiwiCatalogSearchQuery = {}): Promise<CatalogAgentRecord[]> {
    const qs = buildSearchQuery(query);
    const raw = await this.getJson(`/v1/agents/search${qs.length > 0 ? `?${qs}` : ""}`);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CatalogSourceError(
        "response_invalid",
        "kiwi-catalog search response must be a JSON object",
      );
    }
    const body = raw as Record<string, unknown>;
    if (!Array.isArray(body.results)) {
      throw new CatalogSourceError(
        "response_invalid",
        'kiwi-catalog search response is missing array field "results"',
      );
    }
    return body.results.map((element) => validateCatalogAgentRecord(element));
  }

  /** 按 catalog_agent_id 取单个 record。 */
  async getRecord(catalogAgentId: string): Promise<CatalogAgentRecord> {
    if (typeof catalogAgentId !== "string" || catalogAgentId.length === 0) {
      throw new CatalogSourceError("invalid_input", "catalogAgentId must be a non-empty string");
    }
    const raw = await this.getJson(`/v1/agents/${encodeURIComponent(catalogAgentId)}`);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CatalogSourceError("response_invalid", "kiwi-catalog get response must be a JSON object");
    }
    const body = raw as Record<string, unknown>;
    if (body.agent === undefined) {
      throw new CatalogSourceError("response_invalid", 'kiwi-catalog get response is missing field "agent"');
    }
    return validateCatalogAgentRecord(body.agent);
  }

  /** 搜索候选（CatalogSource 接口面：三态域折叠为 CandidateAgent 共享形状）。 */
  async searchCandidates(query: KiwiCatalogSearchQuery = {}): Promise<CandidateAgent[]> {
    const records = await this.searchRecords(query);
    return records.map((record) => normalizeCatalogAgent(record));
  }

  /** 取单个候选（CatalogSource 接口面）。 */
  async getCandidate(catalogAgentId: string): Promise<CandidateAgent> {
    const record = await this.getRecord(catalogAgentId);
    return normalizeCatalogAgent(record);
  }
}
