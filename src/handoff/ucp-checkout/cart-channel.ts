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
 * Kiwi v0.7.0 Transaction Handoff（WP2 补全）— UcpCartChannel：UCP Cart client +
 * cart→checkout 转换。
 *
 * Cart（UCP 2026-04-08）：
 *   - capability `dev.ucp.shopping.cart`；操作 Create/Get/Update（全量替换）/Cancel；
 *   - cart 无支付配置、无 status 生命周期、无 complete 操作；totals 是估算，
 *     平台 SHOULD 视为 estimate（本 channel 不做 checkout 级 sum 校验）；
 *   - ucp.status=success|error 判别；Get 对不存在/过期/已取消返回 not_found
 *     （client.ts 结构化判别 → cart_not_found）；
 *   - Cancel 返回删除前的 cart 状态，后续操作返回 not_found。
 *
 * cart→checkout 转换（createCheckoutFromCart）：
 *   - 前置：business profile 宣告 cart capability（cartCapabilityVerified）；
 *     本地 cart 镜像存在且未被 cancel；远端仍是活 cart（refresh，防过期/已取消）；
 *   - 委托 UcpCheckoutChannel.createSession(pkg, {cart_id})——payload 不带
 *     line_items；链接由 checkout channel 本地记录（cartCheckoutLink）；
 *   - 幂等：同 cart_id + 同 terms_digest 二次转换短接为既有会话；
 *     完成门禁不变（complete 仍需 HandoffPackage + 授权）。
 *
 * 零新增依赖；HTTP 传输复用 UcpCheckoutHttpClient（client.ts）。
 */

import { validateTermSet, type TermSet } from "../../negotiation/domain/common.js";
import { contentDigest } from "../../negotiation/jcs.js";
import type {
  AuthorizationProvider,
} from "../authorization.js";
import { HandoffError } from "../errors.js";
import type { HandoffPackage } from "../package.js";
import { verifyHandoffPackageDigest } from "../package.js";
import type { UcpProfile } from "../../discovery/ucp/types.js";
import {
  UcpCheckoutChannel,
  mapTermsToLineItems,
  type UcpCheckoutChannelOptions,
} from "./channel.js";
import type { UcpCartResult, UcpCartMessage, UcpCart, UcpCartFailureCode } from "./cart-types.js";
import { isUcpCartErrorResponse } from "./cart-parse.js";
import { decideMessages, type CheckoutDecision } from "./parse.js";
import {
  UcpCheckoutHttpClient,
  type UcpCheckoutHttpError,
} from "./client.js";
import { findCartEndpoint, profileHasCartCapability, findCheckoutEndpoint } from "./endpoint.js";
import type { UcpCheckoutResult } from "./types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UcpCartChannelOptions {
  /** cart REST service endpoint（与 profile 二选一；优先 endpoint）。 */
  endpoint?: string;
  /** UCP profile：解析 cart endpoint + checkout endpoint，并验证 cart capability。 */
  profile?: UcpProfile;
  /** 显式指定 profile 内 cart service 名（自动探测时省略）。 */
  cartServiceName?: string;
  /** 预建的 checkout channel（缺省按 profile/checkoutEndpoint 自建）。 */
  checkout?: UcpCheckoutChannel;
  /** 预建缺省时，checkout REST service endpoint（profile 缺 checkout 时用）。 */
  checkoutEndpoint?: string;
  /** 预建缺省时，显式指定 profile 内 checkout service 名。 */
  checkoutServiceName?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 透传给 url-policy 的私网放行开关（默认 false，fail-closed）。 */
  allowPrivateRanges?: boolean;
  /** 跳过请求前 DNS 复查（测试用；生产应保持 false）。 */
  skipDnsCheck?: boolean;
  resolveIp?: (hostname: string) => Promise<string[]>;
  /** buyer 的 UCP profile URI；配置时每个请求携带 `UCP-Agent` 头（§25.1）。 */
  ucpAgentProfile?: string;
  headers?: Record<string, string>;
  /** 可注入时钟（RFC 3339）；缺省 new Date().toISOString()。 */
  now?: () => string;
  /** 预建 checkout channel 时透传的授权提供方（cart 自身无 complete）。 */
  authorizationProvider?: AuthorizationProvider;
}

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------

interface LocalCart {
  cart: UcpCart;
  canceled: boolean;
}

// ---------------------------------------------------------------------------
// UcpCartChannel
// ---------------------------------------------------------------------------

export class UcpCartChannel {
  private readonly client: UcpCheckoutHttpClient;
  private readonly now: () => string;
  /** cart_id 仅在 business profile 宣告 cart capability 时可用。 */
  private readonly cartCapabilityVerified: boolean;
  private readonly checkout?: UcpCheckoutChannel;
  /** 本地 cart 镜像：只服务本地前置校验；远端 cart 是状态权威（not_found 判别）。 */
  private readonly carts = new Map<string, LocalCart>();

  constructor(options: UcpCartChannelOptions = {}) {
    const cartEndpoint =
      options.endpoint ??
      (options.profile !== undefined
        ? findCartEndpoint(options.profile, { serviceName: options.cartServiceName })
        : undefined);
    if (cartEndpoint === undefined) {
      throw new HandoffError(
        "invalid_input",
        "UcpCartChannel requires cart endpoint or a profile with a cart REST service",
      );
    }

    let client: UcpCheckoutHttpClient;
    try {
      client = new UcpCheckoutHttpClient({
        endpoint: cartEndpoint,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        allowPrivateRanges: options.allowPrivateRanges,
        skipDnsCheck: options.skipDnsCheck,
        resolveIp: options.resolveIp,
        ucpAgentProfile: options.ucpAgentProfile,
        headers: options.headers,
      });
    } catch (err) {
      throw new HandoffError(
        "invalid_input",
        `ucp cart endpoint rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.client = client;
    this.now = options.now ?? (() => new Date().toISOString());
    this.cartCapabilityVerified =
      options.profile !== undefined ? profileHasCartCapability(options.profile) : false;

    if (options.checkout !== undefined) {
      this.checkout = options.checkout;
    } else {
      const checkoutEndpoint =
        options.checkoutEndpoint ??
        (options.profile !== undefined
          ? findCheckoutEndpoint(options.profile, { serviceName: options.checkoutServiceName })
          : undefined);
      if (checkoutEndpoint !== undefined) {
        const checkoutOpts: UcpCheckoutChannelOptions = {
          endpoint: checkoutEndpoint,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          allowPrivateRanges: options.allowPrivateRanges,
          skipDnsCheck: options.skipDnsCheck,
          resolveIp: options.resolveIp,
          ucpAgentProfile: options.ucpAgentProfile,
          headers: options.headers,
          now: options.now,
          authorizationProvider: options.authorizationProvider,
        };
        if (options.profile !== undefined) checkoutOpts.profile = options.profile;
        this.checkout = new UcpCheckoutChannel(checkoutOpts);
      }
    }
  }

  // -- Cart CRUD -----------------------------------------------------------

  async createCart(pkg: HandoffPackage): Promise<UcpCartResult> {
    const guard = this.validatePackage(pkg, "createCart");
    if (!guard.ok) return this.failWith(guard.reason, guard.code);
    const mapped = mapTermsToLineItems(guard.terms);
    if (!mapped.ok) {
      return this.failWith(`createCart rejected: ${mapped.reason}`, "invalid_quantity");
    }

    const http = await this.client.createCart({ line_items: mapped.items });
    if (http.kind === "error") return this.mapHttpError(http);
    if (http.kind === "not_found") {
      return this.failWith(`cart_not_found: create cart returned not_found`, "cart_not_found");
    }
    if (isUcpCartErrorResponse(http.response)) {
      return this.cartDecision(decideMessages(http.response.messages, http.response.continue_url), {
        messages: http.response.messages,
        continue_url: http.response.continue_url,
      });
    }
    const cart = http.response;
    this.carts.set(cart.cart_id, { cart, canceled: false });
    return { status: "ok", cart_ref: cart.cart_id, cart };
  }

  async getCart(cartId: string): Promise<UcpCartResult> {
    const http = await this.client.getCart(cartId);
    if (http.kind === "error") return this.mapHttpError(http);
    if (http.kind === "not_found") {
      return this.failWith(`cart_not_found: ${cartId}`, "cart_not_found");
    }
    if (isUcpCartErrorResponse(http.response)) {
      return this.cartDecision(decideMessages(http.response.messages, http.response.continue_url), {
        messages: http.response.messages,
        continue_url: http.response.continue_url,
      });
    }
    const cart = http.response;
    this.carts.set(cartId, { cart, canceled: false });
    return { status: "ok", cart_ref: cartId, cart };
  }

  /** Update 全量替换语义：远端确认存活后 PUT 完整 cart 表示。 */
  async updateCart(cartId: string, terms: TermSet): Promise<UcpCartResult> {
    const mirror = this.carts.get(cartId);
    if (mirror === undefined) {
      return this.failWith(`cart_not_found: ${cartId}`, "cart_not_found");
    }
    if (mirror.canceled) {
      return this.failWith(`cart_not_actionable: canceled ${cartId}`, "cart_not_actionable");
    }
    const live = await this.confirmLive(cartId);
    if (live.status !== "ok") return live;

    let nextTerms: TermSet;
    try {
      nextTerms = validateTermSet(terms, "terms");
    } catch (err) {
      return this.failWith(
        `updateCart rejected: ${err instanceof Error ? err.message : String(err)}`,
        "invalid_terms",
      );
    }
    const mapped = mapTermsToLineItems(nextTerms);
    if (!mapped.ok) {
      return this.failWith(`updateCart rejected: ${mapped.reason}`, "invalid_quantity");
    }

    const put = await this.client.updateCart(cartId, { line_items: mapped.items });
    if (put.kind === "error") return this.mapHttpError(put);
    if (put.kind === "not_found") {
      return this.failWith(`cart_not_found: ${cartId}`, "cart_not_found");
    }
    if (isUcpCartErrorResponse(put.response)) {
      return this.cartDecision(decideMessages(put.response.messages, put.response.continue_url), {
        messages: put.response.messages,
        continue_url: put.response.continue_url,
      });
    }
    const cart = put.response;
    this.carts.set(cartId, { cart, canceled: false });
    return { status: "ok", cart_ref: cartId, cart };
  }

  /**
   * Cancel：返回删除前的 cart 状态（记录为本地 canceled 快照）；后续操作
   * （get/update/cancel）远端返回 not_found → cart_not_found / cart_not_actionable。
   */
  async cancelCart(cartId: string): Promise<UcpCartResult> {
    const mirror = this.carts.get(cartId);
    if (mirror === undefined) {
      return this.failWith(`cart_not_found: ${cartId}`, "cart_not_found");
    }
    if (mirror.canceled) {
      return this.failWith(`cart_not_actionable: already canceled ${cartId}`, "cart_not_actionable");
    }
    const live = await this.confirmLive(cartId);
    if (live.status !== "ok") return live;

    const cancel = await this.client.cancelCart(cartId);
    if (cancel.kind === "error") return this.mapHttpError(cancel);
    if (cancel.kind === "not_found") {
      return this.failWith(`cart_not_found: ${cartId}`, "cart_not_found");
    }
    if (isUcpCartErrorResponse(cancel.response)) {
      return this.cartDecision(decideMessages(cancel.response.messages, cancel.response.continue_url), {
        messages: cancel.response.messages,
        continue_url: cancel.response.continue_url,
      });
    }
    // 成功：返回的是删除前的 cart 状态。
    const cart = cancel.response;
    this.carts.set(cartId, { cart, canceled: true });
    return { status: "ok", cart_ref: cartId, cart, canceled: true };
  }

  // -- cart→checkout 转换 ---------------------------------------------------

  /**
   * 把已存在的 cart 转成 checkout 会话。
   *
   * 前置（spec 事实）：
   *   - business profile 宣告 cart capability（否则 cart_capability_unavailable）；
   *   - 本地镜像存在且未 cancel；
   *   - refresh 远端确认 cart 仍是活的（过期/已取消 → not_found → cart_not_found）。
   * 委托 checkout channel.createSession(pkg, {cart_id})——payload 不带 line_items；
   * 链接由 checkout channel 本地记录；幂等语义见 UcpCheckoutChannel。
   */
  async createCheckoutFromCart(cartId: string, pkg: HandoffPackage): Promise<UcpCheckoutResult> {
    if (!this.cartCapabilityVerified) {
      return {
        status: "fail_closed",
        reason:
          "cart_id unavailable: business profile does not declare dev.ucp.shopping.cart",
        code: "cart_capability_unavailable",
        messages: [],
      };
    }
    if (this.checkout === undefined) {
      return {
        status: "fail_closed",
        reason: "no checkout channel configured for cart→checkout conversion",
        code: "cart_capability_unavailable",
        messages: [],
      };
    }
    const mirror = this.carts.get(cartId);
    if (mirror === undefined) {
      return { status: "fail_closed", reason: `cart_not_found: ${cartId}`, code: "cart_not_found", messages: [] };
    }
    if (mirror.canceled) {
      return {
        status: "fail_closed",
        reason: "cart_not_actionable: canceled",
        code: "cart_not_actionable",
        messages: [],
      };
    }

    // Refresh：远端仍是活 cart（过期/已取消 → not_found）。
    const fresh = await this.getCart(cartId);
    if (fresh.status !== "ok") {
      return {
        status: "fail_closed",
        reason: fresh.status === "fail_closed" ? fresh.reason : "cart refresh failed",
        code: fresh.status === "fail_closed" ? fresh.code ?? "network" : "network",
        messages: fresh.status === "fail_closed" ? fresh.messages : [],
      };
    }

    return this.checkout.createSession(pkg, { cart_id: cartId });
  }

  /** 当前本地 cart 镜像数量（诊断用）。 */
  get cartCount(): number {
    return this.carts.size;
  }

  // -- 内部辅助 ---------------------------------------------------------------

  private validatePackage(
    pkg: HandoffPackage,
    op: string,
  ): { ok: true; terms: TermSet } | { ok: false; reason: string; code: UcpCartFailureCode } {
    if (!verifyHandoffPackageDigest(pkg)) {
      return { ok: false, reason: `${op} rejected: package terms_digest verification failed`, code: "invalid_package" };
    }
    let terms: TermSet;
    try {
      terms = validateTermSet(pkg.agreed_terms, "agreed_terms");
    } catch (err) {
      return {
        ok: false,
        reason: `${op} rejected: ${err instanceof Error ? err.message : String(err)}`,
        code: "invalid_terms",
      };
    }
    if (contentDigest(terms) !== pkg.terms_digest) {
      return {
        ok: false,
        reason: `${op} rejected: package terms_digest does not match validated agreed_terms`,
        code: "invalid_package",
      };
    }
    return { ok: true, terms };
  }

  /** 远端确认 cart 仍是活的：not_found → cart_not_found；error envelope → 消息算法。 */
  private async confirmLive(cartId: string): Promise<UcpCartResult> {
    const http = await this.client.getCart(cartId);
    if (http.kind === "error") return this.mapHttpError(http);
    if (http.kind === "not_found") {
      return this.failWith(`cart_not_found: ${cartId}`, "cart_not_found");
    }
    if (isUcpCartErrorResponse(http.response)) {
      return this.cartDecision(decideMessages(http.response.messages, http.response.continue_url), {
        messages: http.response.messages,
        continue_url: http.response.continue_url,
      });
    }
    this.carts.set(cartId, { cart: http.response, canceled: false });
    return { status: "ok", cart_ref: cartId, cart: http.response };
  }

  private failWith(reason: string, code: UcpCartFailureCode): UcpCartResult {
    return { status: "fail_closed", reason, code, messages: [] };
  }

  private mapHttpError(err: UcpCheckoutHttpError): UcpCartResult {
    return {
      status: "fail_closed",
      reason: `ucp_cart_${err.code}: ${err.reason}`,
      code: err.code,
      messages: [],
    };
  }

  /** error envelope → 三形态结果（error 响应绝不 ok）。 */
  private cartDecision(
    decision: CheckoutDecision,
    ctx: { messages: UcpCartMessage[]; continue_url?: string },
  ): UcpCartResult {
    switch (decision.action) {
      case "ok":
        return {
          status: "fail_closed",
          reason: "ucp error response without actionable messages",
          code: "unrecoverable",
          messages: ctx.messages,
        };
      case "requires_user":
        return {
          status: "requires_user",
          reason: decision.reason ?? "requires user",
          continue_url: decision.continue_url ?? ctx.continue_url,
          messages: ctx.messages,
        };
      case "retryable":
        return {
          status: "fail_closed",
          reason: decision.reason ?? "recoverable",
          code: "recoverable",
          messages: ctx.messages,
          retryable: true,
        };
      case "fail_closed":
        return {
          status: "fail_closed",
          reason: decision.reason ?? "fail closed",
          code: "unrecoverable",
          messages: ctx.messages,
        };
    }
  }
}
