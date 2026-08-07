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
 * KTH/0.1 目的地 URL 安全（rev0.3 §11.2；架构 rev1.4.1 §36-26/27）。
 *
 * 检查：
 *   - scheme 白名单：https 默认；http 仅 localhost / 显式配置允许；
 *     file:/javascript:/data: 等一律拒绝（fail-closed）；
 *   - userinfo 拒绝（防钓鱼 URL 伪装 authority）；
 *   - redirect 限制：fetch redirect:"manual" 跟随 ≤ maxRedirects（默认 5），
 *     每次重定向后重新校验 scheme/host（防跳转到 unsafe scheme）；
 *   - anti-phishing / allowlist：host 必须与 merchant 声明域一致（或命中
 *     显式 allowlist）；拒绝 IP 直连（复用 a2a client 的 SSRF 策略）；
 *   - 返回最终 URL（供用户展示，完成定义 #17）。
 */

import { assertResolvableTargetUrl, assertSafeTargetUrl } from "../a2a/client/url-policy.js";
import { CommerceError } from "../commerce/data-source.js";

export interface UrlSafetyOptions {
  /** merchant 声明域（canonical host）；目的地 host 必须与之同 authority。 */
  expectedHost?: string;
  /** 显式 allowlist（host 白名单；配置了 expectedHost 时仍要求命中其一）。 */
  allowlist?: readonly string[];
  /** 允许 http（非 https）？缺省 false；localhost 始终允许 http。 */
  allowHttp?: boolean;
  /** 最大重定向次数（缺省 5；超过 → fail-closed）。 */
  maxRedirects?: number;
  /** 注入 fetch（测试）。 */
  fetchImpl?: typeof fetch;
  /** 请求超时 ms（缺省 15000）。 */
  timeoutMs?: number;
  /** SSRF DNS 复查的解析函数（缺省 node:dns lookup；受控/测试环境注入用）。 */
  resolveIp?: (hostname: string) => Promise<string[]>;
  /** 跳过 SSRF DNS 复查（仅测试/受控环境；生产缺省 false）。 */
  skipDnsCheck?: boolean;
}

export interface SafeDestinationUrl {
  /** 展示给用户的最终 URL（重定向解析后）。 */
  finalUrl: string;
  /** 重定向链（原始 → 最终）。 */
  redirects: readonly string[];
}

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

function assertScheme(url: URL, options: UrlSafetyOptions): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && (options.allowHttp === true || isLocalHost(url.hostname))) return;
  throw new CommerceError(
    "invalid_input",
    `unsafe destination scheme "${url.protocol}" (HTTPS required; http only for localhost or explicit allowHttp)`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** host 是否命中 allowlist / expectedHost（同 authority）。 */
function hostAllowed(hostname: string, options: UrlSafetyOptions): boolean {
  if (options.expectedHost !== undefined && options.expectedHost === hostname) return true;
  if (options.allowlist !== undefined && options.allowlist.includes(hostname)) return true;
  return false;
}

/**
 * 校验并解析外部目的地 URL。重定向链上的每一跳都重新过 scheme / host /
 * SSRF 检查（防跳转到 unsafe 目标）。返回最终 URL 供展示。
 */
export async function validateExternalDestinationUrl(
  value: string,
  options: UrlSafetyOptions = {},
): Promise<SafeDestinationUrl> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const redirects: string[] = [];
  let current = value;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // 首跳必须命中 expectedHost / allowlist；重定向跳转目标同规则
    // （SSRF 策略在 assertSafeTargetUrl：http(s) only / 无 userinfo /
    // 保留网段拒绝 / loopback http 例外）。
    const parsed = assertSafeTargetUrl(current);
    assertScheme(parsed, options);
    if (!hostAllowed(parsed.hostname, options)) {
      throw new CommerceError(
        "invalid_input",
        `destination host "${parsed.hostname}" is not allowed (expected ${options.expectedHost ?? "allowlist"})`,
      );
    }
    // 请求前 DNS 复查：主机名解析的每个 IP 过保留网段判定（防 rebinding）。
    // 此前只对字面 IP 生效——expectedHost 命中但解析到 169.254.169.254 等
    // 内网地址的主机名会真实发出探测。
    try {
      await assertResolvableTargetUrl(parsed, {
        skipDnsCheck: options.skipDnsCheck,
        resolveIp: options.resolveIp,
      });
    } catch (err) {
      throw new CommerceError(
        "invalid_input",
        `destination DNS rejected by safety policy: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      // HEAD 探测重定向；2xx 即终点（不 HEAD 的服务器按不可达拒绝，绝不把
      // 404/500/403 死链当"已验证目的地"交付给用户展示）。
      response = await fetchImpl(current, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      throw new CommerceError(
        "request_failed",
        name === "AbortError"
          ? `destination probe timed out after ${timeoutMs}ms: ${current}`
          : `destination probe failed: ${current} (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      clearTimeout(timer);
    }
    const location = response.headers.get("location");
    if (location === null) {
      if (response.status < 200 || response.status >= 300) {
        throw new CommerceError(
          "request_failed",
          `destination probe returned HTTP ${response.status} (not a reachable 2xx endpoint): ${current}`,
        );
      }
      return { finalUrl: current, redirects };
    }
    if (response.status < 300 || response.status >= 400) {
      throw new CommerceError(
        "request_failed",
        `destination returned a redirect Location with non-3xx status (HTTP ${response.status}): ${current}`,
      );
    }
    if (hop === maxRedirects) {
      throw new CommerceError(
        "invalid_input",
        `destination exceeded max redirects (${maxRedirects})`,
      );
    }
    redirects.push(current);
    current = new URL(location, current).href;
  }
  throw new CommerceError(
    "invalid_input",
    `destination exceeded max redirects (${maxRedirects})`,
  );
}
