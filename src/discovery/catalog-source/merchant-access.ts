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
 * MerchantAccessSource —— 经 Catalog 受控获取 WorkBuddy 分享配置（B-01/B-02）。
 *
 *   GET {baseUrl}/v1/me/merchant-access/{catalog_agent_id}   （cookie kiwi_session）
 *     → { catalog_agent_id, runtime_origin, provider, access_mode, parameter_name,
 *         secret_value, config_version, adapter_version, auth_mode,
 *         validated_at, updated_at }
 *
 * 契约来源：kiwi-catalog `api/handlers/buyer_follows.py::get_merchant_access`
 * 与 G1 契约 §2.4/§2.5。要点：
 *
 *   - **必须经 Catalog**：所有 Kiwi Buyer 通过目录发现商家，并由目录发放分享码；
 *     不走其它途径（产品决定）。
 *   - **会话认证**：与 BuyerFollowsSource 同一形态（cookie kiwi_session），
 *     服务端从会话解析主体并要求对商家有 **active follow**；匿名不发放。
 *   - **no-store**：目录对响应禁止缓存；本模块自带短 TTL 内存缓存（默认 60s），
 *     键含 `catalog_agent_id + runtime_origin + adapter_version`，单飞刷新，
 *     换码/撤销/版本变化都会让旧条目失效。
 *   - **严格校验**：未知 provider/adapter/auth_mode、缺失秘密、origin 与发现记录
 *     不一致，一律 `contract_violation`——绝不"尽力使用"。
 *   - **秘密不外泄**：分享码只在返回值里；本模块不写日志，错误信息不含它。
 */

import { isRedirectResponse, readJsonBody, SafeHttpError } from "../../net/safe-http.js";
import { PRODUCT_VERSION } from "../../product-cli.js";
import { CatalogSourceError } from "./errors.js";
import type { CatalogSourceDeps } from "./source.js";
import { validateBaseUrl } from "./source.js";

const DEFAULT_TIMEOUT_MS = 15_000;
/** 配置缓存默认 TTL（G1 §2.5.5）。 */
const DEFAULT_CACHE_TTL_MS = 60_000;

export const WORKBUDDY_ADAPTER = "workbuddy-share-v1";

export interface MerchantAccessSourceDeps extends CatalogSourceDeps {
  /** catalog 账号会话 token（作为 cookie kiwi_session 发送）。 */
  sessionToken?: string;
  /** 配置缓存 TTL（毫秒）；`0` 表示不缓存。 */
  cacheTtlMs?: number;
  /** 注入时钟（缓存 TTL 判定；默认系统时钟）。 */
  now?: () => Date;
}

/** Catalog 发放给该买家的 WorkBuddy 访问配置（含分享码，**不得落日志**）。 */
export interface MerchantAccessConfig {
  readonly catalog_agent_id: string;
  readonly runtime_origin: string;
  readonly provider: "workbuddy";
  readonly access_mode: "share_parameter";
  readonly parameter_name: "sharecode";
  /** 平台门禁凭据；只用于拼发送地址。 */
  readonly secret_value: string;
  readonly config_version: number;
  readonly adapter_version: typeof WORKBUDDY_ADAPTER;
  readonly auth_mode: "signature";
  readonly validated_at: string;
  readonly updated_at: string;
}

interface CacheEntry {
  readonly config: MerchantAccessConfig;
  readonly expiresAt: number;
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogSourceError("contract_violation", `${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string, what: string): string {
  const value = record[field];
  if (typeof value !== "string" || value === "") {
    throw new CatalogSourceError(
      "contract_violation",
      `${what} missing non-empty string field "${field}"`,
    );
  }
  return value;
}

/**
 * 校验目录下发的访问配置。`expectedOrigin` 来自发现记录：目录不得把配置
 * 指向另一个 origin（那是把分享码投递给错误部署的路径）。
 */
export function validateMerchantAccess(
  value: unknown,
  expected: { catalogAgentId: string; runtimeOrigin?: string },
): MerchantAccessConfig {
  const what = "MerchantAccess";
  const record = requireObject(value, what);
  const catalogAgentId = requireString(record, "catalog_agent_id", what);
  if (catalogAgentId !== expected.catalogAgentId) {
    throw new CatalogSourceError("contract_violation", `${what} belongs to another agent`);
  }
  const runtimeOrigin = requireString(record, "runtime_origin", what);
  if (!/^https:\/\/[^/?#]+$/.test(runtimeOrigin)) {
    throw new CatalogSourceError("contract_violation", `${what}.runtime_origin must be an https origin`);
  }
  if (expected.runtimeOrigin !== undefined && runtimeOrigin !== expected.runtimeOrigin) {
    throw new CatalogSourceError(
      "contract_violation",
      `${what}.runtime_origin does not match the discovered merchant`,
    );
  }
  if (record["provider"] !== "workbuddy") {
    throw new CatalogSourceError("contract_violation", `${what}.provider is not supported`);
  }
  if (record["access_mode"] !== "share_parameter") {
    throw new CatalogSourceError("contract_violation", `${what}.access_mode is not supported`);
  }
  if (record["parameter_name"] !== "sharecode") {
    throw new CatalogSourceError("contract_violation", `${what}.parameter_name is not supported`);
  }
  if (record["adapter_version"] !== WORKBUDDY_ADAPTER) {
    throw new CatalogSourceError("contract_violation", `${what}.adapter_version is not supported`);
  }
  if (record["auth_mode"] !== "signature") {
    throw new CatalogSourceError("contract_violation", `${what}.auth_mode is not supported`);
  }
  const configVersion = record["config_version"];
  if (typeof configVersion !== "number" || !Number.isInteger(configVersion) || configVersion < 1) {
    throw new CatalogSourceError("contract_violation", `${what}.config_version is invalid`);
  }
  const secret = requireString(record, "secret_value", what);
  return {
    catalog_agent_id: catalogAgentId,
    runtime_origin: runtimeOrigin,
    provider: "workbuddy",
    access_mode: "share_parameter",
    parameter_name: "sharecode",
    secret_value: secret,
    config_version: configVersion,
    adapter_version: WORKBUDDY_ADAPTER,
    auth_mode: "signature",
    validated_at: typeof record["validated_at"] === "string" ? record["validated_at"] : "",
    updated_at: typeof record["updated_at"] === "string" ? record["updated_at"] : "",
  };
}

export class MerchantAccessSource {
  private readonly baseUrl: string;
  private readonly deps: MerchantAccessSourceDeps;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<MerchantAccessConfig | null>>();

  constructor(deps: MerchantAccessSourceDeps) {
    this.baseUrl = validateBaseUrl(deps.baseUrl);
    this.deps = deps;
  }

  private cacheKey(catalogAgentId: string, runtimeOrigin: string | undefined): string {
    return `${catalogAgentId}|${runtimeOrigin ?? ""}|${WORKBUDDY_ADAPTER}`;
  }

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  private ttlMs(): number {
    return this.deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /** 丢弃某个商家（或全部）的缓存；换码/撤销后由调用方显式触发。 */
  invalidate(catalogAgentId?: string): void {
    if (catalogAgentId === undefined) {
      this.cache.clear();
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${catalogAgentId}|`)) this.cache.delete(key);
    }
  }

  /**
   * 取配置（带缓存与单飞）。返回 `null` 表示目录没有该商家的 active 配置
   * （404：未关注/不存在/已撤销都按同一防枚举口径处理），调用方据此 fail-closed。
   */
  async get(
    catalogAgentId: string,
    options: { runtimeOrigin?: string } = {},
  ): Promise<MerchantAccessConfig | null> {
    if (typeof catalogAgentId !== "string" || catalogAgentId === "") {
      throw new CatalogSourceError("invalid_input", "catalogAgentId must be a non-empty string");
    }
    const key = this.cacheKey(catalogAgentId, options.runtimeOrigin);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      if (cached.expiresAt > this.nowMs()) return cached.config;
      this.cache.delete(key);
    }
    const existing = this.inflight.get(key);
    if (existing !== undefined) return await existing;
    const task = (async () => {
      const config = await this.fetchAccess(catalogAgentId, options.runtimeOrigin);
      if (config !== null && this.ttlMs() > 0) {
        this.cache.set(key, { config, expiresAt: this.nowMs() + this.ttlMs() });
      }
      return config;
    })();
    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 强制回源（忽略缓存）。 */
  async refresh(
    catalogAgentId: string,
    options: { runtimeOrigin?: string } = {},
  ): Promise<MerchantAccessConfig | null> {
    this.invalidate(catalogAgentId);
    return await this.get(catalogAgentId, options);
  }

  private async fetchAccess(
    catalogAgentId: string,
    runtimeOrigin: string | undefined,
  ): Promise<MerchantAccessConfig | null> {
    const sessionToken = this.deps.sessionToken;
    if (sessionToken === undefined || sessionToken === "") {
      throw new CatalogSourceError(
        "session_rejected",
        "kiwi-catalog buyer session token is not configured",
      );
    }
    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const url = `${this.baseUrl}/v1/me/merchant-access/${encodeURIComponent(catalogAgentId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      let raw: unknown;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          // 不跟随重定向：3xx 目标不经过校验，且可能转发会话 cookie。
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "user-agent": `kiwi-buyer/${PRODUCT_VERSION}`,
            cookie: `kiwi_session=${sessionToken}`,
            ...(this.deps.buyerId !== undefined ? { "x-buyer-id": this.deps.buyerId } : {}),
          },
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        throw new CatalogSourceError(
          name === "AbortError" ? "request_timeout" : "request_failed",
          name === "AbortError"
            ? `kiwi-catalog merchant access timed out after ${timeoutMs}ms`
            : `kiwi-catalog merchant access failed (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (isRedirectResponse(response)) {
        throw new CatalogSourceError(
          "request_failed",
          `kiwi-catalog merchant access must not follow redirects (HTTP ${response.status})`,
        );
      }
      if (response.status === 404) {
        return null;
      }
      if (response.status === 401 || response.status === 403) {
        throw new CatalogSourceError(
          "session_rejected",
          `kiwi-catalog merchant access rejected (HTTP ${response.status}); sign in and follow the merchant first`,
        );
      }
      if (response.status === 429) {
        throw new CatalogSourceError(
          "request_failed",
          "kiwi-catalog merchant access rate limited (HTTP 429)",
        );
      }
      if (!response.ok) {
        throw new CatalogSourceError(
          "request_failed",
          `kiwi-catalog merchant access returned HTTP ${response.status}`,
        );
      }
      try {
        raw = await readJsonBody(response, { signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new CatalogSourceError(
            "request_timeout",
            `kiwi-catalog merchant access timed out after ${timeoutMs}ms while reading response`,
          );
        }
        throw new CatalogSourceError(
          "response_invalid",
          err instanceof SafeHttpError && err.code === "response_too_large"
            ? `kiwi-catalog merchant access response: ${err.message}`
            : "kiwi-catalog merchant access response is not valid JSON",
        );
      }
      return validateMerchantAccess(raw, {
        catalogAgentId,
        ...(runtimeOrigin !== undefined ? { runtimeOrigin } : {}),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
