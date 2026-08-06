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
 * Kiwi v1.1 Transaction Handoff（WP2）— UcpCheckoutChannel：HandoffChannel 的
 * 真实 UCP 版本（UCP 2026-04-08 checkout，REST binding）。
 *
 * 与 WP1 接缝的关系：`HandoffChannel`（src/handoff/channel.ts）是同步接缝
 * （ManualHandoffChannel 是内存参考实现，无网络写入）。真实外部交易系统适配
 * 必须走网络，因此本包定义 `AsyncHandoffChannel`——同一组操作的异步投影，
 * 返回更富的 `UcpCheckoutResult`（三形态超集，`status` 判别不变）。本类
 * `implements AsyncHandoffChannel`。
 *
 * 行为保证（对齐工作包验收）：
 *   - createSession：HandoffPackage.agreed_terms → UCP line_items（Money minor
 *     units 直传；quantity 必须为正整数，否则 fail-closed invalid_quantity）；
 *     opts.cart_id 提供 cart→checkout 转换路径——payload 只带 cart_id + reference
 *     （不重复塞 line_items），本地记录 cart→checkout 链接（cartCheckoutLink），
 *     同 cart_id + 同 terms 幂等短接；完成门禁不变（complete 仍需授权）；
 *   - getSession / updateSession（全量替换 PUT）/ cancelSession；
 *   - requestCompletion：先复用 WP1 完成门禁（completion.ts），通过后才发
 *     Complete，且只附 authorization 证据引用（不构造任何支付凭据）；
 *   - 状态映射（parse.ts decideResponse）：requires_escalation / error-requires_*
 *     → requires_user + continue_url；unrecoverable → fail_closed；
 *     incomplete+recoverable → fail_closed(retryable) 供上层改输入重试（不自动死循环）；
 *   - totals 校验（totals.ts）：sum 不符 → 拒绝完成（totals_mismatch），不修改不替代；
 *   - 网络面（client.ts）：SSRF 防护 + 超时 + 非 2xx/畸形 fail-closed +
 *     expires_at 解析与过期判定 + UCP-Agent profile 头。
 *
 * 本地 session 投影（Map）只服务完成门禁（terms/digest 绑定）；远端 checkout
 * 才是状态权威。
 */

import { validateTermSet, type TermSet } from "../../negotiation/domain/common.js";
import { contentDigest } from "../../negotiation/jcs.js";
import {
  FailClosedAuthorizationProvider,
  type AuthorizationProvider,
  type PaymentAuthorization,
} from "../authorization.js";
import type { HandoffSession } from "../channel.js";
import { evaluateCompletionGate } from "../completion.js";
import { HandoffError } from "../errors.js";
import type { HandoffPackage } from "../package.js";
import { verifyHandoffPackageDigest } from "../package.js";
import type { UcpProfile } from "../../discovery/ucp/types.js";
import type {
  UcpCheckoutLineItem,
  UcpCheckoutMessage,
  UcpCheckoutResult,
  UcpCheckoutSession,
  UcpCheckoutStatus,
} from "./types.js";
import { DEFAULT_EXPIRY_MS } from "./types.js";
import {
  decideResponse,
  isUcpCheckoutErrorResponse,
  type CheckoutDecision,
} from "./parse.js";
import { validateTotals } from "./totals.js";
import { UcpCheckoutHttpClient, type UcpCheckoutHttpError } from "./client.js";
import { findCheckoutEndpoint, profileHasCartCapability } from "./endpoint.js";
import type { UcpCheckoutFailureCode } from "./types.js";

// ---------------------------------------------------------------------------
// HandoffChannel 的异步投影（WP2 真实网络适配用）
// ---------------------------------------------------------------------------

/**
 * HandoffChannel 的异步投影：真实交易系统适配（UcpCheckoutChannel）用。
 * 操作名与 HandoffChannel 完全一致，返回 `Promise<UcpCheckoutResult>`。
 *
 * `createSession` 的 `opts.cart_id` 是 cart→checkout 转换路径（WP2 补全）：
 * 带 cart_id 时 checkout payload 不再重复塞 line_items（business 使用 cart 内容）。
 */
export interface AsyncHandoffChannel {
  createSession(pkg: HandoffPackage, opts?: { cart_id?: string }): Promise<UcpCheckoutResult>;
  getSession(ref: string): Promise<UcpCheckoutResult>;
  updateSession(ref: string, terms: TermSet): Promise<UcpCheckoutResult>;
  requestCompletion(ref: string, authorization: PaymentAuthorization): Promise<UcpCheckoutResult>;
  cancelSession(ref: string): Promise<UcpCheckoutResult>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface UcpCheckoutChannelOptions {
  /** checkout REST service endpoint（与 profile 二选一；优先 endpoint）。 */
  endpoint?: string;
  /** UCP profile（含 rest checkout service）→ findCheckoutEndpoint 解析 endpoint。 */
  profile?: UcpProfile;
  /** 显式指定 profile 内 checkout service 名（自动探测时省略）。 */
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
  /** AP2 授权提供方；缺省 FailClosedAuthorizationProvider（完成一律拒绝）。 */
  authorizationProvider?: AuthorizationProvider;
  /**
   * cart_id 可用性标记（cart→checkout 路径）。缺省：profile 提供了且宣告
   * `dev.ucp.shopping.cart` capability 时为 true；否则 false。显式传值可覆盖。
   */
  cartCapabilityVerified?: boolean;
}

// ---------------------------------------------------------------------------
// cart→checkout 链接（本地记录，供 idempotent 转换与诊断）
// ---------------------------------------------------------------------------

export interface CartCheckoutLink {
  cart_id: string;
  session_ref: string;
  checkout_status: UcpCheckoutStatus;
  /** 转换时的 terms_digest；同 cart_id + 同 digest 二次转换短接为既有会话。 */
  terms_digest: string;
  checkout: UcpCheckoutSession;
  created_at: string;
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

export type LineItemsResult = { ok: true; items: UcpCheckoutLineItem[] } | { ok: false; reason: string };

/** 把 KNP TermSet 映射为 UCP line_items：Money minor units 直传；quantity 必须为正整数。 */
export function mapTermsToLineItems(terms: TermSet): LineItemsResult {
  const items: UcpCheckoutLineItem[] = [];
  for (const item of terms.items ?? []) {
    if (!Number.isInteger(item.quantity.value) || item.quantity.value <= 0) {
      return {
        ok: false,
        reason: `invalid_quantity: sku ${item.sku} quantity must be a positive integer (got ${item.quantity.value})`,
      };
    }
    const line: UcpCheckoutLineItem = { sku: item.sku, quantity: item.quantity.value };
    if (item.unit_price !== undefined) {
      line.unit_price = {
        currency: item.unit_price.currency,
        amount_minor: item.unit_price.amount_minor,
      };
    }
    items.push(line);
  }
  return { ok: true, items };
}

function buildSessionRequestBody(
  pkg: HandoffPackage,
  items: UcpCheckoutLineItem[],
  termsDigest: string,
): Record<string, unknown> {
  return {
    line_items: items,
    reference: {
      agreement_id: pkg.agreement_id,
      negotiation_id: pkg.negotiation_id,
      terms_digest: termsDigest,
    },
  };
}

/**
 * cart→checkout 请求体：只带 cart_id + reference，不带 line_items。
 * spec：business MUST 使用 cart 内容且 MUST 忽略 checkout payload 里的重叠字段；
 * 我们不依赖对方忽略——自己就不发重叠字段。
 */
function buildCartSessionRequestBody(
  pkg: HandoffPackage,
  termsDigest: string,
  cartId: string,
): Record<string, unknown> {
  return {
    cart_id: cartId,
    reference: {
      agreement_id: pkg.agreement_id,
      negotiation_id: pkg.negotiation_id,
      terms_digest: termsDigest,
    },
  };
}

function resolveEndpoint(options: UcpCheckoutChannelOptions): string {
  if (options.endpoint !== undefined) return options.endpoint;
  if (options.profile !== undefined) {
    const found = findCheckoutEndpoint(options.profile, {
      serviceName: options.checkoutServiceName,
    });
    if (found !== undefined) return found;
    throw new HandoffError(
      "invalid_input",
      "UCP profile has no rest checkout service endpoint (transport=rest with endpoint)",
    );
  }
  throw new HandoffError("invalid_input", "UcpCheckoutChannel requires either endpoint or profile");
}

interface ResultContext {
  sessionRef?: string;
  session?: HandoffSession;
  checkout?: UcpCheckoutSession;
  checkoutStatus?: UcpCheckoutStatus;
  /** error 响应（无 checkout 资源）时携带 messages，供结构化上报。 */
  messages?: UcpCheckoutMessage[];
}

// ---------------------------------------------------------------------------
// UcpCheckoutChannel
// ---------------------------------------------------------------------------

export class UcpCheckoutChannel implements AsyncHandoffChannel {
  private readonly client: UcpCheckoutHttpClient;
  private readonly now: () => string;
  private readonly authorizationProvider: AuthorizationProvider;
  /** cart_id 可用性（cart→checkout 路径；spec：cart_id 仅在 business profile 宣告 cart capability 时可用）。 */
  private readonly cartCapabilityVerified: boolean;
  /** 本地投影：只服务完成门禁（terms/digest 绑定）；远端 checkout 是状态权威。 */
  private readonly sessions = new Map<string, HandoffSession>();
  private readonly checkouts = new Map<string, UcpCheckoutSession>();
  /** cart→checkout 链接（cart_id → 最近一次转换的 checkout 投影）。 */
  private readonly cartCheckoutLinks = new Map<string, CartCheckoutLink>();

  constructor(options: UcpCheckoutChannelOptions = {}) {
    const endpoint = resolveEndpoint(options);
    let client: UcpCheckoutHttpClient;
    try {
      client = new UcpCheckoutHttpClient({
        endpoint,
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
        `ucp checkout endpoint rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.client = client;
    this.now = options.now ?? (() => new Date().toISOString());
    this.authorizationProvider =
      options.authorizationProvider ?? new FailClosedAuthorizationProvider();
    this.cartCapabilityVerified =
      options.cartCapabilityVerified ??
      (options.profile !== undefined ? profileHasCartCapability(options.profile) : false);
  }

  /** 当前本地投影 session 数量（诊断用）。 */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** cart_id → checkout 链接（cart→checkout 转换的本地记录；诊断/幂等用）。 */
  cartCheckoutLink(cartId: string): CartCheckoutLink | undefined {
    return this.cartCheckoutLinks.get(cartId);
  }

  // -- HandoffChannel 异步投影 -------------------------------------------------

  async createSession(
    pkg: HandoffPackage,
    opts: { cart_id?: string } = {},
  ): Promise<UcpCheckoutResult> {
    if (!verifyHandoffPackageDigest(pkg)) {
      return this.failWith(
        "createSession rejected: package terms_digest verification failed",
        "invalid_package",
      );
    }
    let terms: TermSet;
    try {
      terms = validateTermSet(pkg.agreed_terms, "agreed_terms");
    } catch (err) {
      return this.failWith(
        `createSession rejected: ${err instanceof Error ? err.message : String(err)}`,
        "invalid_terms",
      );
    }
    if (contentDigest(terms) !== pkg.terms_digest) {
      return this.failWith(
        "createSession rejected: package terms_digest does not match validated agreed_terms",
        "invalid_package",
      );
    }

    // cart→checkout 路径：payload 不再重复塞 line_items（business 使用 cart 内容）。
    if (opts.cart_id !== undefined) {
      return this.createSessionFromCart(pkg, terms, opts.cart_id);
    }

    const mapped = mapTermsToLineItems(terms);
    if (!mapped.ok) {
      return this.failWith(`createSession rejected: ${mapped.reason}`, "invalid_quantity");
    }

    const http = await this.client.createSession(
      buildSessionRequestBody(pkg, mapped.items, pkg.terms_digest),
    );
    if (http.kind === "error") return this.mapHttpError(http);

    if (isUcpCheckoutErrorResponse(http.response)) {
      // error 响应：session 未创建，无 session_ref；messages 随结果结构化上报。
      return this.resultForDecision(decideResponse(http.response), {
        messages: http.response.messages,
      });
    }
    const checkout = this.withEffectiveExpiry(http.response, this.now());
    const session = this.storeSession(checkout, pkg, terms, pkg.terms_digest, "created");
    const ctx: ResultContext = {
      sessionRef: checkout.session_id,
      session,
      checkout,
      checkoutStatus: checkout.status,
    };
    return this.resultForDecision(decideResponse(checkout), ctx);
  }

  /**
   * cart→checkout 转换（idempotent，spec 事实）：
   *   - cart_id 仅在 business profile 宣告 cart capability 时可用（构造期已验）；
   *   - 同一 cart_id + 同一 terms_digest 已转换 → 短接返回既有本地会话（不重复网络写）；
   *   - 否则发 Create Checkout（body = {cart_id, reference}，无 line_items）；
   *     business 若已有 incomplete checkout 会返回既有会话而非新建——我们按成功处理
   *     并记录 cart→checkout 链接（本地记录，不依赖 business 通知）。
   * 完成门禁不变：requestCompletion 仍要求 HandoffPackage + 授权，cart 路径不产生绕过。
   */
  private async createSessionFromCart(
    pkg: HandoffPackage,
    terms: TermSet,
    cartId: string,
  ): Promise<UcpCheckoutResult> {
    const existing = this.cartCheckoutLinks.get(cartId);
    if (existing !== undefined && existing.terms_digest === pkg.terms_digest) {
      const mirror = this.sessions.get(existing.session_ref);
      if (mirror !== undefined) {
        return {
          status: "ok",
          session_ref: existing.session_ref,
          session: mirror,
          continue_url: existing.checkout.continue_url,
          checkout: existing.checkout,
          checkout_status: existing.checkout.status,
        };
      }
    }

    if (!this.cartCapabilityVerified) {
      return this.failWith(
        "cart_id unavailable: business profile does not declare dev.ucp.shopping.cart",
        "cart_capability_unavailable",
      );
    }

    const http = await this.client.createSession(
      buildCartSessionRequestBody(pkg, pkg.terms_digest, cartId),
    );
    if (http.kind === "error") return this.mapHttpError(http);
    if (isUcpCheckoutErrorResponse(http.response)) {
      return this.resultForDecision(decideResponse(http.response), {
        messages: http.response.messages,
      });
    }

    const checkout = this.withEffectiveExpiry(http.response, this.now());
    const session = this.storeSession(checkout, pkg, terms, pkg.terms_digest, "created");
    this.recordCartCheckoutLink(cartId, checkout, pkg.terms_digest);
    const ctx: ResultContext = {
      sessionRef: checkout.session_id,
      session,
      checkout,
      checkoutStatus: checkout.status,
    };
    return this.resultForDecision(decideResponse(checkout), ctx);
  }

  async getSession(ref: string): Promise<UcpCheckoutResult> {
    const mirror = this.sessions.get(ref);
    if (mirror === undefined) return this.failWith(`session_not_found: ${ref}`, "session_not_found");

    const http = await this.client.getSession(ref);
    if (http.kind === "error") return this.mapHttpError(http);
    const response = http.response;
    if (isUcpCheckoutErrorResponse(response)) {
      return this.resultForDecision(decideResponse(response), {
        sessionRef: ref,
        messages: response.messages,
      });
    }

    const checkout = this.withEffectiveExpiry(response, this.now());
    this.checkouts.set(ref, checkout);
    if (
      checkout.status !== "completed" &&
      checkout.status !== "canceled" &&
      this.isExpired(checkout, this.now())
    ) {
      return this.failWith(
        `session_expired: ${ref} (expires_at ${checkout.expires_at ?? "n/a"})`,
        "session_expired",
      );
    }

    const session = this.projectTerminalState(ref, mirror, checkout);
    const ctx: ResultContext = {
      sessionRef: ref,
      session,
      checkout,
      checkoutStatus: checkout.status,
    };
    return this.resultForDecision(decideResponse(checkout), ctx);
  }

  async updateSession(ref: string, terms: TermSet): Promise<UcpCheckoutResult> {
    const mirror = this.sessions.get(ref);
    if (mirror === undefined) return this.failWith(`session_not_found: ${ref}`, "session_not_found");

    // 远端先取：确认非终态 + 过期判定（本地投影可能滞后于远端）。
    const http = await this.client.getSession(ref);
    if (http.kind === "error") return this.mapHttpError(http);
    const response = http.response;
    if (isUcpCheckoutErrorResponse(response)) {
      return this.resultForDecision(decideResponse(response), {
        sessionRef: ref,
        messages: response.messages,
      });
    }
    const checkout = this.withEffectiveExpiry(response, this.now());
    if (checkout.status === "completed" || checkout.status === "canceled") {
      return this.failWith(`session_not_actionable: status ${checkout.status}`, "session_not_actionable");
    }
    if (this.isExpired(checkout, this.now())) {
      return this.failWith(`session_expired: ${ref}`, "session_expired");
    }

    let nextTerms: TermSet;
    try {
      nextTerms = validateTermSet(terms, "terms");
    } catch (err) {
      return this.failWith(
        `updateSession rejected: ${err instanceof Error ? err.message : String(err)}`,
        "invalid_terms",
      );
    }
    const nextDigest = contentDigest(nextTerms);
    const mapped = mapTermsToLineItems(nextTerms);
    if (!mapped.ok) {
      return this.failWith(`updateSession rejected: ${mapped.reason}`, "invalid_quantity");
    }

    // Update 是全量替换语义：PUT 完整 session 表示。
    const put = await this.client.updateSession(
      ref,
      buildSessionRequestBody(mirror.package, mapped.items, nextDigest),
    );
    if (put.kind === "error") return this.mapHttpError(put);
    if (isUcpCheckoutErrorResponse(put.response)) {
      return this.resultForDecision(decideResponse(put.response), {
        sessionRef: ref,
        messages: put.response.messages,
      });
    }

    const updatedCheckout = this.withEffectiveExpiry(put.response, this.now());
    this.checkouts.set(ref, updatedCheckout);
    const session = this.applyUpdate(mirror, nextTerms, nextDigest);
    const ctx: ResultContext = {
      sessionRef: ref,
      session,
      checkout: updatedCheckout,
      checkoutStatus: updatedCheckout.status,
    };
    return this.resultForDecision(decideResponse(updatedCheckout), ctx);
  }

  async requestCompletion(
    ref: string,
    authorization: PaymentAuthorization,
  ): Promise<UcpCheckoutResult> {
    const mirror = this.sessions.get(ref);
    if (mirror === undefined) return this.failWith(`session_not_found: ${ref}`, "session_not_found");

    // 1. 远端当前状态。
    const http = await this.client.getSession(ref);
    if (http.kind === "error") return this.mapHttpError(http);
    const response = http.response;
    if (isUcpCheckoutErrorResponse(response)) {
      return this.resultForDecision(decideResponse(response), {
        sessionRef: ref,
        messages: response.messages,
      });
    }
    const checkout = this.withEffectiveExpiry(response, this.now());
    this.checkouts.set(ref, checkout);

    // 2. 状态映射（终态优先）。
    if (checkout.status === "completed") {
      const session = this.markCompleted(mirror);
      return { status: "ok", session_ref: ref, session, checkout, checkout_status: "completed" };
    }
    if (checkout.status === "canceled") {
      return this.failWith("session_not_actionable: canceled", "session_not_actionable");
    }
    if (checkout.status === "requires_escalation") {
      const ctx: ResultContext = { sessionRef: ref, checkout, checkoutStatus: checkout.status };
      return this.resultForDecision(decideResponse(checkout), ctx);
    }
    if (checkout.status === "complete_in_progress") {
      return this.failWith(
        "session_not_actionable: complete already in progress",
        "session_not_actionable",
      );
    }
    if (checkout.status === "incomplete") {
      const decision = decideResponse(checkout);
      if (decision.action === "ok") {
        return this.failWith("session_not_ready_for_complete: checkout is incomplete", "not_ready");
      }
      const ctx: ResultContext = { sessionRef: ref, checkout, checkoutStatus: checkout.status };
      return this.resultForDecision(decision, ctx);
    }

    // 3. ready_for_complete：过期 + totals + 完成门禁，全过才允许 Complete。
    if (this.isExpired(checkout, this.now())) {
      return this.failWith(`session_expired: ${ref}`, "session_expired");
    }
    const totalsCheck = validateTotals(checkout.totals);
    if (totalsCheck !== undefined && !totalsCheck.ok) {
      return {
        status: "fail_closed",
        reason:
          `totals_mismatch: sum of non-total fields ${totalsCheck.computed} != declared total ${totalsCheck.expected}`,
        code: "totals_mismatch",
        messages: checkout.messages ?? [],
        checkout_status: checkout.status,
        checkout,
      };
    }
    const gate = evaluateCompletionGate({
      authorization,
      session: mirror,
      authorizationProvider: this.authorizationProvider,
      now: this.now,
    });
    if (!gate.allowed) {
      return this.failWith(`completion gate denied: ${gate.reason}`, "gate_denied");
    }

    // 4. 只传 authorization 证据引用（不构造任何支付凭据；支付在 continue_url 可信 UI 完成）。
    const complete = await this.client.completeSession(ref, {
      authorization_reference: authorization.evidence.reference,
    });
    if (complete.kind === "error") return this.mapHttpError(complete);
    if (isUcpCheckoutErrorResponse(complete.response)) {
      return this.resultForDecision(decideResponse(complete.response), {
        sessionRef: ref,
        messages: complete.response.messages,
      });
    }

    const completedCheckout = this.withEffectiveExpiry(complete.response, this.now());
    this.checkouts.set(ref, completedCheckout);
    if (completedCheckout.status === "completed") {
      const session = this.markCompleted(mirror);
      return {
        status: "ok",
        session_ref: ref,
        session,
        checkout: completedCheckout,
        checkout_status: "completed",
      };
    }
    if (completedCheckout.status === "complete_in_progress") {
      // 完成已受理（异步终局）：ok，但不标记本地 completed。
      return {
        status: "ok",
        session_ref: ref,
        session: mirror,
        checkout: completedCheckout,
        checkout_status: "complete_in_progress",
      };
    }
    const ctx: ResultContext = {
      sessionRef: ref,
      session: this.sessions.get(ref),
      checkout: completedCheckout,
      checkoutStatus: completedCheckout.status,
    };
    return this.resultForDecision(decideResponse(completedCheckout), ctx);
  }

  async cancelSession(ref: string): Promise<UcpCheckoutResult> {
    const mirror = this.sessions.get(ref);
    if (mirror === undefined) return this.failWith(`session_not_found: ${ref}`, "session_not_found");

    const http = await this.client.getSession(ref);
    if (http.kind === "error") return this.mapHttpError(http);
    const response = http.response;
    if (isUcpCheckoutErrorResponse(response)) {
      return this.resultForDecision(decideResponse(response), {
        sessionRef: ref,
        messages: response.messages,
      });
    }
    const checkout = this.withEffectiveExpiry(response, this.now());
    if (checkout.status === "completed" || checkout.status === "canceled") {
      return this.failWith(`session_not_actionable: status ${checkout.status}`, "session_not_actionable");
    }
    if (this.isExpired(checkout, this.now())) {
      return this.failWith(`session_expired: ${ref}`, "session_expired");
    }

    const cancel = await this.client.cancelSession(ref, {});
    if (cancel.kind === "error") return this.mapHttpError(cancel);
    if (isUcpCheckoutErrorResponse(cancel.response)) {
      return this.resultForDecision(decideResponse(cancel.response), {
        sessionRef: ref,
        messages: cancel.response.messages,
      });
    }

    const canceledCheckout = this.withEffectiveExpiry(cancel.response, this.now());
    this.checkouts.set(ref, canceledCheckout);
    if (canceledCheckout.status === "canceled") {
      const session = this.markCancelled(mirror);
      return {
        status: "ok",
        session_ref: ref,
        session,
        checkout: canceledCheckout,
        checkout_status: "canceled",
      };
    }
    const ctx: ResultContext = {
      sessionRef: ref,
      session: this.sessions.get(ref),
      checkout: canceledCheckout,
      checkoutStatus: canceledCheckout.status,
    };
    return this.resultForDecision(decideResponse(canceledCheckout), ctx);
  }

  // -- 内部辅助 ---------------------------------------------------------------

  private failWith(reason: string, code: UcpCheckoutFailureCode): UcpCheckoutResult {
    return { status: "fail_closed", reason, code, messages: [] };
  }

  /** 记录 cart→checkout 链接（幂等：同 cart_id 覆盖为最近一次转换）。 */
  private recordCartCheckoutLink(
    cartId: string,
    checkout: UcpCheckoutSession,
    termsDigest: string,
  ): void {
    this.cartCheckoutLinks.set(cartId, {
      cart_id: cartId,
      session_ref: checkout.session_id,
      checkout_status: checkout.status,
      terms_digest: termsDigest,
      checkout,
      created_at: this.now(),
    });
  }

  private mapHttpError(err: UcpCheckoutHttpError): UcpCheckoutResult {
    return {
      status: "fail_closed",
      reason: `ucp_checkout_${err.code}: ${err.reason}`,
      code: err.code,
      messages: [],
    };
  }

  /** 把 parse.ts 的决策动作转成三形态结果（ok 需要 session + checkout）。 */
  private resultForDecision(decision: CheckoutDecision, ctx: ResultContext): UcpCheckoutResult {
    const messages = ctx.messages ?? ctx.checkout?.messages ?? [];
    switch (decision.action) {
      case "ok": {
        if (ctx.session === undefined || ctx.checkout === undefined) {
          return this.failWith("internal: ok decision without session/checkout", "invalid_terms");
        }
        return {
          status: "ok",
          session_ref: ctx.session.session_ref,
          session: ctx.session,
          continue_url: ctx.checkout.continue_url,
          checkout: ctx.checkout,
          checkout_status: ctx.checkout.status,
        };
      }
      case "requires_user":
        return {
          status: "requires_user",
          continue_url: decision.continue_url ?? ctx.checkout?.continue_url,
          reason: decision.reason ?? "requires user",
          messages,
          checkout_status: ctx.checkoutStatus,
          session_ref: ctx.sessionRef,
          checkout: ctx.checkout,
        };
      case "retryable":
        return {
          status: "fail_closed",
          reason: decision.reason ?? "recoverable",
          messages,
          code: "recoverable",
          retryable: true,
          checkout_status: ctx.checkoutStatus,
          session_ref: ctx.sessionRef,
          checkout: ctx.checkout,
        };
      case "fail_closed":
        return {
          status: "fail_closed",
          reason: decision.reason ?? "fail closed",
          messages,
          code: "unrecoverable",
          checkout_status: ctx.checkoutStatus,
          session_ref: ctx.sessionRef,
          checkout: ctx.checkout,
        };
    }
  }

  private withEffectiveExpiry(checkout: UcpCheckoutSession, nowIso: string): UcpCheckoutSession {
    if (checkout.expires_at !== undefined) return checkout;
    const expires = new Date(Date.parse(nowIso) + DEFAULT_EXPIRY_MS).toISOString();
    return { ...checkout, expires_at: expires };
  }

  /** 过期判定：无法解析时间戳 → fail-closed 视为过期。终态不在调用方判。 */
  private isExpired(checkout: UcpCheckoutSession, nowIso: string): boolean {
    if (checkout.expires_at === undefined) return false;
    const expires = Date.parse(checkout.expires_at);
    const now = Date.parse(nowIso);
    if (!Number.isFinite(expires) || !Number.isFinite(now)) return true;
    return now > expires;
  }

  private storeSession(
    checkout: UcpCheckoutSession,
    pkg: HandoffPackage,
    terms: TermSet,
    digest: string,
    status: "created",
  ): HandoffSession {
    const now = this.now();
    const session: HandoffSession = {
      session_ref: checkout.session_id,
      package: pkg,
      current_terms: terms,
      current_terms_digest: digest,
      status,
      created_at: now,
      updated_at: now,
    };
    this.sessions.set(checkout.session_id, session);
    this.checkouts.set(checkout.session_id, checkout);
    return session;
  }

  private applyUpdate(
    mirror: HandoffSession,
    terms: TermSet,
    digest: string,
  ): HandoffSession {
    const updated: HandoffSession = {
      ...mirror,
      current_terms: terms,
      current_terms_digest: digest,
      status: "updated",
      updated_at: this.now(),
    };
    this.sessions.set(mirror.session_ref, updated);
    return updated;
  }

  /** 远端进入终态时同步本地投影状态（仅终态同步；created/updated 由本地操作决定）。 */
  private projectTerminalState(
    ref: string,
    mirror: HandoffSession,
    checkout: UcpCheckoutSession,
  ): HandoffSession {
    if (checkout.status === "completed" && mirror.status !== "completed") {
      return this.markCompleted(mirror);
    }
    if (checkout.status === "canceled" && mirror.status !== "cancelled") {
      return this.markCancelled(mirror);
    }
    return mirror;
  }

  private markCompleted(mirror: HandoffSession): HandoffSession {
    const updated: HandoffSession = {
      ...mirror,
      status: "completed",
      updated_at: this.now(),
    };
    this.sessions.set(mirror.session_ref, updated);
    return updated;
  }

  private markCancelled(mirror: HandoffSession): HandoffSession {
    const updated: HandoffSession = {
      ...mirror,
      status: "cancelled",
      updated_at: this.now(),
    };
    this.sessions.set(mirror.session_ref, updated);
    return updated;
  }
}
