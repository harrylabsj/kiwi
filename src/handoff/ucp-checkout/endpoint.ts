/**
 * Kiwi v1.1 Transaction Handoff（WP2）— UCP checkout service endpoint 解析。
 *
 * 从 UCP profile（src/discovery/ucp）里找出 checkout REST service endpoint：
 *   - 显式 serviceName：取 `profile.ucp.services[serviceName]` 下第一个
 *     transport=rest 且有 endpoint 的条目；
 *   - 自动探测：优先 service 名最后一段为 `checkout` 的 rest service；
 *     回退到 spec URL 含 `checkout` 的 rest service；
 *   - 找不到 → undefined（fail-closed：缺 endpoint 时 UcpCheckoutChannel 拒绝构造）。
 *
 * 只解析 endpoint（不抓取、不 SSRF）；endpoint 的安全校验发生在 channel 构造
 * 与请求前（复用 a2a url-policy）。
 */

import { parseServiceNamespace } from "../../discovery/ucp/types.js";
import type { UcpProfile, UcpServiceDeclaration } from "../../discovery/ucp/types.js";

export interface FindCheckoutEndpointOptions {
  /** 显式指定 checkout service 名（如 `com.example.checkout`）。 */
  serviceName?: string;
}

function isRestWithEndpoint(decl: UcpServiceDeclaration): decl is UcpServiceDeclaration & { endpoint: string } {
  return decl.transport === "rest" && typeof decl.endpoint === "string" && decl.endpoint.length > 0;
}

/**
 * 在 profile 中解析 checkout REST endpoint。找不到返回 undefined。
 */
export function findCheckoutEndpoint(
  profile: UcpProfile,
  opts: FindCheckoutEndpointOptions = {},
): string | undefined {
  const services = profile.ucp.services;
  if (services === undefined) return undefined;

  if (opts.serviceName !== undefined) {
    const entries = services[opts.serviceName];
    if (entries === undefined) return undefined;
    const hit = entries.find(isRestWithEndpoint);
    return hit?.endpoint;
  }

  // 自动探测：优先 service 名末段 == checkout。
  for (const [name, entries] of Object.entries(services)) {
    const ns = parseServiceNamespace(name);
    if (ns !== undefined && ns.service === "checkout") {
      const hit = entries.find(isRestWithEndpoint);
      if (hit !== undefined) return hit.endpoint;
    }
  }
  // 回退：spec URL 含 "checkout" 的 rest service。
  for (const entries of Object.values(services)) {
    const hit = entries.find(
      (decl): decl is UcpServiceDeclaration & { endpoint: string } =>
        isRestWithEndpoint(decl) && /checkout/i.test(decl.spec),
    );
    if (hit !== undefined) return hit.endpoint;
  }
  return undefined;
}
