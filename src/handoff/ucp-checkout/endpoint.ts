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
 * Kiwi v1.1 Transaction Handoff（WP2 + 补全）— UCP checkout / cart service
 * endpoint 解析 + cart capability 检测。
 *
 * 从 UCP profile（src/discovery/ucp）里找出 checkout / cart REST service endpoint：
 *   - 显式 serviceName：取 `profile.ucp.services[serviceName]` 下第一个
 *     transport=rest 且有 endpoint 的条目；
 *   - 自动探测：优先 service 名最后一段为 `checkout`/`cart` 的 rest service；
 *     cart 额外优先 capability 宿主 service（capability 名末段 == cart，
 *     如 `dev.ucp.shopping.cart` → service `dev.ucp.shopping`）；
 *     回退到 spec URL 含 `checkout`/`cart` 的 rest service；
 *   - 找不到 → undefined（fail-closed：缺 endpoint 时 channel 拒绝构造）。
 *
 * cart capability 检测（profileHasCartCapability）：`dev.ucp.shopping.cart`
 * 在 `profile.ucp.capabilities` 里宣告。cart_id 仅在 business profile 宣告
 * cart capability 时可用（spec 事实）。
 *
 * 只解析 endpoint（不抓取、不 SSRF）；endpoint 的安全校验发生在 channel 构造
 * 与请求前（复用 a2a url-policy）。
 */

import {
  parseCapabilityNamespace,
  parseServiceNamespace,
} from "../../discovery/ucp/types.js";
import type { UcpProfile, UcpServiceDeclaration } from "../../discovery/ucp/types.js";
import { CART_CAPABILITY } from "./cart-types.js";

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

// ---------------------------------------------------------------------------
// Cart endpoint + capability
// ---------------------------------------------------------------------------

/**
 * business profile 是否宣告 cart capability（`dev.ucp.shopping.cart`）。
 * 判定：capability 名全名相等，或解析后 capability 末段为 `cart`（forward-compat，
 * 不同 reverse-domain 的 cart capability 也认）。
 */
export function profileHasCartCapability(profile: UcpProfile): boolean {
  const caps = profile.ucp.capabilities;
  if (caps === undefined) return false;
  for (const name of Object.keys(caps)) {
    if (name === CART_CAPABILITY) return true;
    const ns = parseCapabilityNamespace(name);
    if (ns !== undefined && ns.capability === "cart") return true;
  }
  return false;
}

/**
 * 在 profile 中解析 cart REST endpoint。与 findCheckoutEndpoint 并列；额外优先
 * capability 宿主 service（`*.cart` capability 所在 service 的 rest endpoint）。
 * 找不到返回 undefined。
 */
export function findCartEndpoint(
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

  // 1. capability 宿主 service：capability 名末段 == cart（如 dev.ucp.shopping.cart
  //    → service dev.ucp.shopping）。
  const cartCapabilityServices = new Set<string>();
  const caps = profile.ucp.capabilities;
  if (caps !== undefined) {
    for (const name of Object.keys(caps)) {
      const ns = parseCapabilityNamespace(name);
      if (ns !== undefined && ns.capability === "cart") {
        cartCapabilityServices.add(`${ns.reverseDomain}.${ns.service}`);
      }
    }
  }
  for (const [name, entries] of Object.entries(services)) {
    if (cartCapabilityServices.has(name)) {
      const hit = entries.find(isRestWithEndpoint);
      if (hit !== undefined) return hit.endpoint;
    }
  }

  // 2. 自动探测：service 名末段 == cart。
  for (const [name, entries] of Object.entries(services)) {
    const ns = parseServiceNamespace(name);
    if (ns !== undefined && ns.service === "cart") {
      const hit = entries.find(isRestWithEndpoint);
      if (hit !== undefined) return hit.endpoint;
    }
  }
  // 3. 回退：spec URL 含 "cart" 的 rest service。
  for (const entries of Object.values(services)) {
    const hit = entries.find(
      (decl): decl is UcpServiceDeclaration & { endpoint: string } =>
        isRestWithEndpoint(decl) && /cart/i.test(decl.spec),
    );
    if (hit !== undefined) return hit.endpoint;
  }
  return undefined;
}
