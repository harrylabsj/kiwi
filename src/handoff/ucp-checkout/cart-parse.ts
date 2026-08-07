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
 * Kiwi v0.7.0 Transaction Handoff（WP2 补全）— UCP Cart 响应解析。
 *
 * 与 checkout 判别同构：`/ucp/status === success|error`。success 资源本体是
 * `UcpCart`（cart_id 取代 session_id；无 status 生命周期）；error 响应复用
 * parse.ts 的 error envelope 解析（结构完全一致）。
 *
 * 结构解析全部复用 parse.ts 的子解析器（line_items / totals / messages / links）
 * 与校验原语；任何结构问题抛 UcpCheckoutParseError（fail-closed，§4.6）。
 */

import {
  UcpCheckoutParseError,
  parseLineItems,
  parseLinks,
  parseMessages,
  parseTotals,
  parseUcpErrorEnvelope,
  preserveUnknown,
  requireIsoTimestamp,
  requireNonEmptyString,
  requireObject,
} from "./parse.js";
import type { UcpCart, UcpCartErrorResponse, UcpCartResponse } from "./cart-types.js";

function fail(path: string, message: string): never {
  throw new UcpCheckoutParseError(path, message);
}

/** 解析并校验 UCP cart 响应（success/error 判别走 /ucp/status）。 */
export function parseUcpCartResponse(raw: unknown): UcpCartResponse {
  const root = requireObject(raw, "/");
  const ucp = requireObject(root.ucp, "/ucp");
  const version = requireNonEmptyString(ucp.version, "/ucp/version");
  const status = ucp.status;
  if (status !== "success" && status !== "error") {
    fail("/ucp/status", `must be success|error (got ${String(status)})`);
  }
  if (status === "success") {
    return parseSuccessCart(root, ucp, version);
  }
  return parseUcpErrorEnvelope(root, ucp, version);
}

function parseSuccessCart(
  root: Record<string, unknown>,
  ucp: Record<string, unknown>,
  version: string,
): UcpCart {
  // 缺 id 是次要指标；fail-closed：success envelope 必须带 cart_id，否则视为畸形。
  const cart: UcpCart = {
    ucp: { ...ucp, status: "success", version } as UcpCart["ucp"],
    cart_id: requireNonEmptyString(root.cart_id, "/cart_id"),
  };
  const known = new Set(["ucp", "cart_id"]);
  if (root.expires_at !== undefined) {
    cart.expires_at = requireIsoTimestamp(root.expires_at, "/expires_at");
    known.add("expires_at");
  }
  if (root.line_items !== undefined) {
    cart.line_items = parseLineItems(root.line_items);
    known.add("line_items");
  }
  if (root.totals !== undefined) {
    cart.totals = parseTotals(root.totals);
    known.add("totals");
  }
  if (root.context !== undefined) {
    cart.context = requireObject(root.context, "/context");
    known.add("context");
  }
  if (root.buyer !== undefined) {
    cart.buyer = requireObject(root.buyer, "/buyer");
    known.add("buyer");
  }
  if (root.signals !== undefined) {
    cart.signals = requireObject(root.signals, "/signals");
    known.add("signals");
  }
  if (root.attribution !== undefined) {
    cart.attribution = requireObject(root.attribution, "/attribution");
    known.add("attribution");
  }
  if (root.messages !== undefined) {
    cart.messages = parseMessages(root.messages);
    known.add("messages");
  }
  if (root.links !== undefined) {
    cart.links = parseLinks(root.links);
    known.add("links");
  }
  if (root.continue_url !== undefined) {
    cart.continue_url = requireNonEmptyString(root.continue_url, "/continue_url");
    known.add("continue_url");
  }
  preserveUnknown(root, cart, known);
  return cart;
}

/** 判别守卫：success 响应（cart 资源本体）。 */
export function isUcpCartSuccess(value: UcpCartResponse): value is UcpCart {
  return value.ucp.status === "success";
}

/** 判别守卫：error 响应（无 cart 资源，只有 messages + continue_url）。 */
export function isUcpCartErrorResponse(value: UcpCartResponse): value is UcpCartErrorResponse {
  return value.ucp.status === "error";
}
