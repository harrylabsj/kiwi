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
 * UCP Profile resolver（基线 §25 / §43）：抓取 `/.well-known/ucp`。
 *
 * 行为表：
 *   - HTTPS only：非 https URL 直接拒绝（profile_not_https），不发起抓取；
 *   - SSRF 复用 a2a client 的 url-policy（assertSafeTargetUrl 静态校验 +
 *     assertResolvableTargetUrl 请求前 DNS 复查），拒绝 → unsafe_target（fail-closed）；
 *   - 不跟随重定向：fetch redirect:"manual"，3xx / opaqueredirect / redirected
 *     → profile_redirect；
 *   - 超时：AbortController，超时 → profile_unreachable；
 *   - Cache-Control：MUST 含 public 且 max-age>=60，否则 profile_cache_control；
 *   - 缓存：按 Cache-Control max-age 缓存（最小 TTL 60s 地板），命中缓存 cached:true，
 *     不重新抓取也不重复 SSRF/DNS 校验；
 *   - 解析/校验失败 → profile_malformed / profile_bad_status / profile_unreachable。
 *
 * 零新增依赖：Node 22 原生 fetch + AbortController。
 */

import { assertResolvableTargetUrl, assertSafeTargetUrl } from "../../a2a/client/url-policy.js";
import { readJsonBody, SafeHttpError } from "../../net/safe-http.js";
import { UcpError } from "./error.js";
import { validateUcpProfile } from "./validate.js";
import type { UcpRejectedEntry, UcpValidationResult } from "./validate.js";
import type { UcpProfile } from "./types.js";

export const WELL_KNOWN_UCP_PATH = "/.well-known/ucp";
const MIN_CACHE_TTL_MS = 60_000;

export interface UcpResolverOptions {
  fetchImpl?: typeof fetch;
  /** 抓取超时 ms（默认 10000）。 */
  timeoutMs?: number;
  /** 透传给 url-policy 的私网放行开关（默认 false，fail-closed）。 */
  allowPrivateRanges?: boolean;
  /** 跳过请求前 DNS 复查（测试用；生产应保持 false）。 */
  skipDnsCheck?: boolean;
  resolveIp?: (hostname: string) => Promise<string[]>;
  /** 注入时钟（测试用）。缺省 Date.now。 */
  now?: () => number;
}

export interface UcpResolveInput {
  domain?: string;
  profileUrl?: string;
}

export interface UcpResolveResult {
  profile: UcpProfile;
  /** 被 profile 校验丢弃的条目（按条目粒度拒绝，不影响其余条目）。 */
  rejected: UcpRejectedEntry[];
  /** `domain:<domain>` 或 `profile:<url>`。 */
  source: string;
  fetchedAt: number;
  /** 本次响应计算的缓存 TTL（≥60s 地板）。 */
  ttlMs: number;
  cached: boolean;
  /** 原始（未过滤）JSON，供 WP3 二次检查 / 调试。 */
  rawProfile: unknown;
}

export interface CacheControlParse {
  ok: boolean;
  reason?: string;
  maxAge?: number;
}

export function parseCacheControl(header: string | null): CacheControlParse {
  if (header === null || header.trim() === "") {
    return { ok: false, reason: "Cache-Control header is missing" };
  }
  const directives = header.split(",").map((d) => d.trim().toLowerCase());
  if (!directives.some((d) => d === "public")) {
    return { ok: false, reason: "Cache-Control must include the public directive" };
  }
  if (directives.some((d) => d === "private" || d === "no-store")) {
    return { ok: false, reason: "Cache-Control must not be private or no-store" };
  }
  const match = /max-age\s*=\s*"?(\d+)"?/i.exec(header);
  if (match === null) {
    return { ok: false, reason: "Cache-Control must include max-age" };
  }
  const maxAge = Number(match[1]);
  if (!Number.isInteger(maxAge) || maxAge < MIN_CACHE_TTL_MS / 1000) {
    return {
      ok: false,
      reason: `Cache-Control max-age must be >= ${MIN_CACHE_TTL_MS / 1000} (got ${maxAge})`,
    };
  }
  return { ok: true, maxAge };
}

function mapUnsafe(err: unknown): UcpError {
  const detail = err instanceof Error ? err.message : String(err);
  return new UcpError("unsafe_target", `UCP profile target rejected: ${detail}`);
}

interface CacheEntry {
  result: UcpResolveResult;
  expiresAt: number;
}

/** 缓存上限（评审项 L3 / 审查 P2-03：此前无驱逐，发现大量对端后内存永久
 * 累积；现超限即清过期 + 逐出最旧，容量严格有界）。 */
export const MAX_CACHE_ENTRIES = 512;

export class UcpResolver {
  private readonly deps: UcpResolverOptions;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(deps: UcpResolverOptions = {}) {
    this.deps = deps;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** 缓存条目数（诊断/测试用）。 */
  cacheSize(): number {
    return this.cache.size;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private profileUrlFor(input: UcpResolveInput): string {
    if (input.domain !== undefined && input.profileUrl !== undefined) {
      throw new UcpError(
        "invalid_input",
        "UcpResolveInput must provide exactly one of domain or profileUrl",
      );
    }
    if (input.profileUrl !== undefined) return input.profileUrl;
    if (input.domain !== undefined) {
      try {
        const url = new URL(`https://${input.domain}${WELL_KNOWN_UCP_PATH}`);
        if (url.hostname.length === 0 || url.username !== "" || url.password !== "") {
          throw new Error("invalid host");
        }
        return url.href;
      } catch {
        throw new UcpError("invalid_input", `domain is not a valid host: "${input.domain}"`);
      }
    }
    throw new UcpError("invalid_input", "UcpResolveInput must provide domain or profileUrl");
  }

  async resolve(input: UcpResolveInput): Promise<UcpResolveResult> {
    const url = this.profileUrlFor(input);

    const now = this.now();
    const hit = this.cache.get(url);
    if (hit !== undefined && hit.expiresAt > now) {
      return { ...hit.result, cached: true };
    }
    if (hit !== undefined) this.cache.delete(url); // 过期条目立即移除（此前滞留到同 URL 再次访问）

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new UcpError("invalid_input", `invalid profile URL: ${url}`);
    }
    if (parsed.protocol !== "https:") {
      throw new UcpError(
        "profile_not_https",
        `UCP profile must be fetched over HTTPS (got ${parsed.protocol})`,
      );
    }

    let safeUrl: URL;
    try {
      safeUrl = assertSafeTargetUrl(url, { allowPrivateRanges: this.deps.allowPrivateRanges });
    } catch (err) {
      throw mapUnsafe(err);
    }
    try {
      await assertResolvableTargetUrl(safeUrl, {
        allowPrivateRanges: this.deps.allowPrivateRanges,
        skipDnsCheck: this.deps.skipDnsCheck,
        resolveIp: this.deps.resolveIp,
      });
    } catch (err) {
      throw mapUnsafe(err);
    }

    const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.deps.timeoutMs ?? 10_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    let cacheControl: CacheControlParse;
    let raw: unknown;
    try {
      try {
        response = await fetchImpl(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new UcpError("profile_unreachable", `UCP profile fetch timed out after ${timeoutMs}ms`);
        }
        throw new UcpError(
          "profile_unreachable",
          `UCP profile fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (
        response.redirected ||
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400)
      ) {
        throw new UcpError(
          "profile_redirect",
          `UCP profile fetch must not follow redirects (HTTP ${response.status})`,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw new UcpError("profile_bad_status", `UCP profile fetch returned HTTP ${response.status}`);
      }

      cacheControl = parseCacheControl(response.headers.get("cache-control"));
      if (!cacheControl.ok) {
        throw new UcpError("profile_cache_control", cacheControl.reason ?? "invalid Cache-Control");
      }

      try {
        // 响应体读取在超时覆盖内 + 大小上限（出站加固）。
        raw = await readJsonBody(response, { signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new UcpError("profile_unreachable", `UCP profile fetch timed out after ${timeoutMs}ms`);
        }
        throw new UcpError(
          "profile_malformed",
          err instanceof SafeHttpError && err.code === "response_too_large"
            ? err.message
            : "UCP profile response is not valid JSON",
        );
      }
    } finally {
      // 审查 P2-02：所有路径（fetch 拒绝 / redirect / 非 2xx / Cache-Control
      // 非法 / body 读失败）都清理超时 timer——此前只有 body 读的 finally 清理。
      clearTimeout(timer);
    }

    let validation: UcpValidationResult;
    try {
      validation = validateUcpProfile(raw);
    } catch (err) {
      if (err instanceof UcpError) throw err;
      throw new UcpError(
        "profile_malformed",
        `UCP profile failed validation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const fetchedAt = this.now();
    const ttlMs = Math.max(cacheControl.maxAge ?? 60, 60) * 1000;
    const result: UcpResolveResult = {
      profile: validation.profile,
      rejected: validation.rejected,
      source: input.domain !== undefined ? `domain:${input.domain}` : `profile:${url}`,
      fetchedAt,
      ttlMs,
      cached: false,
      rawProfile: raw,
    };
    // 防无界增长（审查 P2-03）：容量严格有界——超限时先清除全部过期条目，
    // 仍超限则逐出最早过期（近似 LRU 的最旧条目）腾位。此前只清过期条目，
    // 全为有效条目时新 URL 仍会写入 → 缓存可无限增长。发现大量对端后内存
    // 不再永久累积。
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const nowMs = this.now();
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt <= nowMs) this.cache.delete(key);
      }
      while (this.cache.size >= MAX_CACHE_ENTRIES) {
        let oldestKey: string | undefined;
        let oldestExpires = Number.POSITIVE_INFINITY;
        for (const [key, entry] of this.cache) {
          if (entry.expiresAt < oldestExpires) {
            oldestExpires = entry.expiresAt;
            oldestKey = key;
          }
        }
        if (oldestKey === undefined) break;
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(url, { result, expiresAt: fetchedAt + ttlMs });
    return result;
  }
}
