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
 * BuyerFollowsSource —— kiwi-catalog 买家关注（M4 拉取式订阅）读/写客户端。
 *
 *   PUT    {baseUrl}/v1/me/follows/{merchant_id}   → {ok, follow, created}
 *   DELETE {baseUrl}/v1/me/follows/{merchant_id}   → {ok, merchant_id, following: false}
 *   GET    {baseUrl}/v1/me/follows                 → {ok, follows: […]}
 *   GET    {baseUrl}/v1/me/follows/updates         → {ok, updates: […]}
 *
 * 契约来源：kiwi-catalog 仓 kiwi_catalog/services/buyer_follows.py 与
 * api/handlers/buyer_follows.py（schema v30，merchant-buddy 第 0 版设计 §4）。
 *
 * 与 KiwiCatalogSource / MerchantPublicationsSource 的关键差异：这四条路由走
 * catalog **账号会话**（cookie kiwi_session），不是匿名公开读——buyer_subject
 * 由服务端从会话解析（account:{account_id} 不透明字符串），客户端不传身份、
 * 不伪造身份。会话 token 由部署方显式配置（KIWI_CATALOG_SESSION /
 * --catalog-session）；HTTP 401/403 映射为 session_rejected（fail-closed），
 * 由上层转成"需要先在 Kiwi 目录登录"的可解释引导。
 *
 * 出站加固与兄弟 source 一致：不跟随重定向、超时、响应大小上限；响应手写校验
 * （merchant-publications.ts 同风格，上游暂无 vendored schema）。
 */

import { CatalogSourceError } from "./errors.js";
import { PRODUCT_VERSION } from "../../product-cli.js";
import { isRedirectResponse, readJsonBody, SafeHttpError } from "../../net/safe-http.js";
import { validateBaseUrl } from "./source.js";
import type { CatalogSourceDeps } from "./source.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface BuyerFollowsSourceDeps extends CatalogSourceDeps {
  /** catalog 账号会话 token（作为 cookie kiwi_session 发送）。 */
  sessionToken?: string;
}

/** 买家视角的关注视图（上游 follow_view；不含 buyer_subject——响应即买家本人）。 */
export interface BuyerFollowRecord {
  readonly merchant_id: string;
  readonly merchant_name?: string;
  readonly category?: string;
  readonly status: string;
  readonly consent_version?: string;
  readonly created_at?: string;
  readonly last_seen_at?: string;
}

/** 商家公开事件类型（上游 EVENT_TYPES；新增类型上游可扩，运行时按非空字符串容忍）。 */
export type MerchantPublicEventType =
  "product_added" | "product_updated" | "faq_updated" | "service_notice" | "publication_withdrawn";

/** 商家公开事件（只含公开字段；payload 即 M0 公开投影）。 */
export interface MerchantPublicEvent {
  readonly event_id: string;
  readonly event_type: MerchantPublicEventType | string;
  readonly publication_id?: string;
  readonly version?: number;
  readonly payload: Record<string, unknown>;
  readonly created_at: string;
}

/** 一个商家的增量更新分组（updates 元素；last_seen_at 为本次推进后的水位）。 */
export interface BuyerFollowUpdateGroup {
  readonly merchant_id: string;
  readonly merchant_name?: string;
  readonly events: MerchantPublicEvent[];
  readonly last_seen_at?: string;
}

// ── 手写响应校验（fail-closed，同 merchant-publications.ts 风格）────────────

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogSourceError("contract_violation", `${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(record: Record<string, unknown>, field: string, what: string): void {
  if (typeof record[field] !== "string" || record[field] === "") {
    throw new CatalogSourceError(
      "contract_violation",
      `${what} missing non-empty string field "${field}"`,
    );
  }
}

function optionalString(record: Record<string, unknown>, field: string, what: string): void {
  const v = record[field];
  if (v !== undefined && v !== null && typeof v !== "string") {
    throw new CatalogSourceError(
      "contract_violation",
      `${what} field "${field}" must be a string when present`,
    );
  }
}

export function validateBuyerFollow(value: unknown): BuyerFollowRecord {
  const record = requireObject(value, "BuyerFollow");
  requireNonEmptyString(record, "merchant_id", "BuyerFollow");
  requireNonEmptyString(record, "status", "BuyerFollow");
  for (const field of [
    "merchant_name",
    "category",
    "consent_version",
    "created_at",
    "last_seen_at",
  ]) {
    optionalString(record, field, "BuyerFollow");
  }
  return record as unknown as BuyerFollowRecord;
}

export function validateMerchantPublicEvent(value: unknown): MerchantPublicEvent {
  const record = requireObject(value, "MerchantPublicEvent");
  requireNonEmptyString(record, "event_id", "MerchantPublicEvent");
  requireNonEmptyString(record, "event_type", "MerchantPublicEvent");
  requireNonEmptyString(record, "created_at", "MerchantPublicEvent");
  optionalString(record, "publication_id", "MerchantPublicEvent");
  if (
    record.version !== undefined &&
    record.version !== null &&
    typeof record.version !== "number"
  ) {
    throw new CatalogSourceError(
      "contract_violation",
      'MerchantPublicEvent field "version" must be a number when present',
    );
  }
  // payload 即商家公开投影（public-only 白名单由上游写入侧保证）；必须是对象。
  requireObject(record.payload, "MerchantPublicEvent.payload");
  return record as unknown as MerchantPublicEvent;
}

export function validateFollowUpdateGroup(value: unknown): BuyerFollowUpdateGroup {
  const record = requireObject(value, "FollowUpdateGroup");
  requireNonEmptyString(record, "merchant_id", "FollowUpdateGroup");
  optionalString(record, "merchant_name", "FollowUpdateGroup");
  optionalString(record, "last_seen_at", "FollowUpdateGroup");
  if (!Array.isArray(record.events)) {
    throw new CatalogSourceError(
      "contract_violation",
      'FollowUpdateGroup missing array field "events"',
    );
  }
  const events = record.events.map(validateMerchantPublicEvent);
  return { ...(record as unknown as BuyerFollowUpdateGroup), events };
}

export class BuyerFollowsSource {
  private readonly baseUrl: string;
  private readonly deps: BuyerFollowsSourceDeps;

  constructor(deps: BuyerFollowsSourceDeps) {
    this.baseUrl = validateBaseUrl(deps.baseUrl);
    this.deps = deps;
  }

  /**
   * 核心请求：会话认证（cookie kiwi_session）；超时 / HTTP / 网络失败统一映射
   * 为 CatalogSourceError；HTTP 401/403 → session_rejected（fail-closed，不伪造
   * 身份、不静默降级为匿名）。
   */
  private async request(method: string, requestPath: string, body?: unknown): Promise<unknown> {
    const sessionToken = this.deps.sessionToken;
    if (sessionToken === undefined || sessionToken === "") {
      throw new CatalogSourceError(
        "session_rejected",
        "kiwi-catalog buyer session token is not configured",
      );
    }
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
          method,
          // 出站加固：绝不跟随重定向（3xx 目标不经过校验，且可能转发会话 cookie）。
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "user-agent": `kiwi-buyer/${PRODUCT_VERSION}`,
            cookie: `kiwi_session=${sessionToken}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...(this.deps.buyerId !== undefined ? { "x-buyer-id": this.deps.buyerId } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        const detail = err instanceof Error ? err.message : String(err);
        throw new CatalogSourceError(
          name === "AbortError" ? "request_timeout" : "request_failed",
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
      if (response.status === 401 || response.status === 403) {
        throw new CatalogSourceError(
          "session_rejected",
          `kiwi-catalog buyer session rejected (HTTP ${response.status}) from ${url}`,
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
            "request_timeout",
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

  /** 显式关注（幂等；可选 category/consent_version）。仅买家主动调用构成订阅。 */
  async follow(
    merchantId: string,
    opts?: { category?: string; consent_version?: string },
  ): Promise<{ follow: BuyerFollowRecord; created: boolean }> {
    if (typeof merchantId !== "string" || merchantId === "") {
      throw new CatalogSourceError("invalid_input", "merchantId must be a non-empty string");
    }
    const raw = await this.request("PUT", `/v1/me/follows/${encodeURIComponent(merchantId)}`, {
      ...(opts?.category !== undefined ? { category: opts.category } : {}),
      ...(opts?.consent_version !== undefined ? { consent_version: opts.consent_version } : {}),
    });
    const body = requireObject(raw, "follow response");
    if (body.follow === undefined) {
      throw new CatalogSourceError("response_invalid", 'follow response is missing field "follow"');
    }
    if (typeof body.created !== "boolean") {
      throw new CatalogSourceError(
        "response_invalid",
        'follow response field "created" must be a boolean',
      );
    }
    return { follow: validateBuyerFollow(body.follow), created: body.created };
  }

  /** 取消关注（幂等；无活跃关注同样 ok）。 */
  async unfollow(merchantId: string): Promise<{ merchant_id: string; following: false }> {
    if (typeof merchantId !== "string" || merchantId === "") {
      throw new CatalogSourceError("invalid_input", "merchantId must be a non-empty string");
    }
    const raw = await this.request("DELETE", `/v1/me/follows/${encodeURIComponent(merchantId)}`);
    const body = requireObject(raw, "unfollow response");
    if (body.following !== false) {
      throw new CatalogSourceError(
        "response_invalid",
        'unfollow response field "following" must be false',
      );
    }
    requireNonEmptyString(body, "merchant_id", "unfollow response");
    return { merchant_id: body.merchant_id as string, following: false };
  }

  /** 我的活跃关注列表（cancelled 不在其列）。 */
  async listFollows(): Promise<BuyerFollowRecord[]> {
    const raw = await this.request("GET", "/v1/me/follows");
    const body = requireObject(raw, "list follows response");
    if (!Array.isArray(body.follows)) {
      throw new CatalogSourceError(
        "response_invalid",
        'list follows response is missing array field "follows"',
      );
    }
    return body.follows.map(validateBuyerFollow);
  }

  /**
   * 主动拉取关注更新：仅响应买家主动查询。水位语义在上游（返回什么再推进
   * last_seen_at，不丢不重）；本客户端原样透传分组，不本地过滤、不缓存重放。
   */
  async getUpdates(): Promise<BuyerFollowUpdateGroup[]> {
    const raw = await this.request("GET", "/v1/me/follows/updates");
    const body = requireObject(raw, "follow updates response");
    if (!Array.isArray(body.updates)) {
      throw new CatalogSourceError(
        "response_invalid",
        'follow updates response is missing array field "updates"',
      );
    }
    return body.updates.map(validateFollowUpdateGroup);
  }
}
