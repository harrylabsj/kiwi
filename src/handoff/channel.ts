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
 * Kiwi v1.1 Transaction Handoff — HandoffChannel 接缝（WP1）。
 *
 * HandoffChannel 是「交易系统适配接口」：真实实现（WP2 的 UCP Checkout adapter）
 * 会在外部交易系统上创建 session / 更新 terms / 请求完成 / 取消。WP1 只定义
 * 接口与结构化结果，并提供一个 ManualHandoffChannel 参考实现：
 *
 * - 内存 Map 存 session，导出 JSON + manual:// continue_url 供展示；
 * - 不执行任何网络写入；
 * - requestCompletion 复用完成门禁（completion.ts）——未配置真实 AP2 时，
 *   默认 FailClosedAuthorizationProvider 保证一律 fail-closed，绝不伪造完成。
 *
 * 结构化结果（用公共 `status` 判别，strict TS 可可靠窄化；对应工作包语义
 * `{ok}` / `{fail_closed, reason}` / `{requires_user, continue_url, reason}`）：
 *   ok            —— 操作成功，携带 session；
 *   fail_closed   —— 明确拒绝（找不到 session / 状态不可操作 / 门禁不过）；
 *   requires_user —— 需要用户介入外部 checkout（如需要人去 UCP checkout 页面
 *                    确认时），带 continue_url。
 */

import { uuidv7 } from "../negotiation/domain/identifiers.js";
import { validateTermSet } from "../negotiation/domain/common.js";
import type { TermSet } from "../negotiation/domain/common.js";
import { contentDigest } from "../negotiation/jcs.js";
import type { PaymentAuthorization, AuthorizationProvider } from "./authorization.js";
import { FailClosedAuthorizationProvider } from "./authorization.js";
import type { HandoffPackage } from "./package.js";
import { verifyHandoffPackageDigest } from "./package.js";
import { evaluateCompletionGate } from "./completion.js";

// ---------------------------------------------------------------------------
// Session 与结果类型
// ---------------------------------------------------------------------------

export const HANDOFF_SESSION_STATUSES = ["created", "updated", "completed", "cancelled"] as const;
export type HandoffSessionStatus = (typeof HANDOFF_SESSION_STATUSES)[number];

/**
 * 交易系统上的一个 checkout session。current_terms 可被 updateSession 改变
 * （建模「下单前改购物车」）；current_terms_digest 与 current_terms 始终一致。
 * 授权与完成门禁只认 current_terms_digest —— 换 terms 后旧授权即失效。
 */
export interface HandoffSession {
  session_ref: string;
  /** 创建该 session 的交接工件（原始 agreed_terms 是商业共识来源）。 */
  package: HandoffPackage;
  current_terms: TermSet;
  current_terms_digest: string;
  status: HandoffSessionStatus;
  created_at: string;
  updated_at: string;
}

/** HandoffChannel 的结构化结果（公共 `status` 判别）。 */
export type HandoffResult =
  | { status: "ok"; session_ref: string; session: HandoffSession; continue_url?: string }
  | { status: "fail_closed"; reason: string }
  | { status: "requires_user"; continue_url?: string; reason: string };

/** 交易系统适配接缝（WP2 实现 = UCP Checkout adapter）。 */
export interface HandoffChannel {
  createSession(pkg: HandoffPackage): HandoffResult;
  getSession(ref: string): HandoffResult;
  updateSession(ref: string, terms: TermSet): HandoffResult;
  requestCompletion(ref: string, authorization: PaymentAuthorization): HandoffResult;
  cancelSession(ref: string): HandoffResult;
}

// ---------------------------------------------------------------------------
// ManualHandoffChannel（参考实现）
// ---------------------------------------------------------------------------

export interface ManualHandoffChannelOptions {
  /** 可注入时钟（RFC 3339）；缺省 new Date().toISOString()。 */
  now?: () => string;
  /** AP2 授权提供方；缺省 FailClosedAuthorizationProvider（完成一律拒绝）。 */
  authorizationProvider?: AuthorizationProvider;
}

function sessionNotActionable(session: HandoffSession): boolean {
  return session.status === "completed" || session.status === "cancelled";
}

function notFound(ref: string): HandoffResult {
  return { status: "fail_closed", reason: `session_not_found: ${ref}` };
}

function notActionable(session: HandoffSession): HandoffResult {
  return { status: "fail_closed", reason: `session_not_actionable: status ${session.status}` };
}

/**
 * 参考实现：内存 Map + JSON 导出 + manual:// continue_url，无任何网络写入。
 * requestCompletion 先跑完成门禁，任何前置不满足 → fail_closed。
 */
export class ManualHandoffChannel implements HandoffChannel {
  private readonly sessions = new Map<string, HandoffSession>();
  private readonly now: () => string;
  private readonly authorizationProvider: AuthorizationProvider;

  constructor(options: ManualHandoffChannelOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.authorizationProvider =
      options.authorizationProvider ?? new FailClosedAuthorizationProvider();
  }

  createSession(pkg: HandoffPackage): HandoffResult {
    if (!verifyHandoffPackageDigest(pkg)) {
      return {
        status: "fail_closed",
        reason: "createSession rejected: package terms_digest verification failed",
      };
    }
    // 结构加固：agreed_terms 必须是合法 TermSet，且归一化后 digest 仍与
    // terms_digest 一致（防伪造一个 digest 自洽但结构非法的 package）。
    let currentTerms: TermSet;
    try {
      currentTerms = validateTermSet(pkg.agreed_terms, "agreed_terms");
    } catch {
      return {
        status: "fail_closed",
        reason: "createSession rejected: package agreed_terms failed structural validation",
      };
    }
    if (contentDigest(currentTerms) !== pkg.terms_digest) {
      return {
        status: "fail_closed",
        reason: "createSession rejected: package terms_digest does not match validated agreed_terms",
      };
    }
    const sessionRef = `hs_${uuidv7()}`;
    const now = this.now();
    const session: HandoffSession = {
      session_ref: sessionRef,
      package: pkg,
      current_terms: currentTerms,
      current_terms_digest: pkg.terms_digest,
      status: "created",
      created_at: now,
      updated_at: now,
    };
    this.sessions.set(sessionRef, session);
    // manual:// scheme 仅用于展示，不触发任何网络写入。
    return {
      status: "ok",
      session_ref: sessionRef,
      session,
      continue_url: `manual://checkout/${sessionRef}`,
    };
  }

  getSession(ref: string): HandoffResult {
    const session = this.sessions.get(ref);
    if (session === undefined) return notFound(ref);
    return { status: "ok", session_ref: ref, session };
  }

  updateSession(ref: string, terms: TermSet): HandoffResult {
    const session = this.sessions.get(ref);
    if (session === undefined) return notFound(ref);
    if (sessionNotActionable(session)) return notActionable(session);
    const nextTerms = validateTermSet(terms, "terms");
    session.current_terms = nextTerms;
    session.current_terms_digest = contentDigest(nextTerms);
    session.status = "updated";
    session.updated_at = this.now();
    return { status: "ok", session_ref: ref, session };
  }

  requestCompletion(ref: string, authorization: PaymentAuthorization): HandoffResult {
    const session = this.sessions.get(ref);
    if (session === undefined) return notFound(ref);
    if (sessionNotActionable(session)) return notActionable(session);
    // 完成门禁：授权验证 + terms_digest 一致 + 未 stale，任一不满足 → fail_closed。
    const gate = evaluateCompletionGate({
      authorization,
      session,
      authorizationProvider: this.authorizationProvider,
      now: this.now,
    });
    if (!gate.allowed) {
      return { status: "fail_closed", reason: gate.reason };
    }
    session.status = "completed";
    session.updated_at = this.now();
    return { status: "ok", session_ref: ref, session };
  }

  cancelSession(ref: string): HandoffResult {
    const session = this.sessions.get(ref);
    if (session === undefined) return notFound(ref);
    if (sessionNotActionable(session)) return notActionable(session);
    session.status = "cancelled";
    session.updated_at = this.now();
    return { status: "ok", session_ref: ref, session };
  }

  /** 导出 session JSON 供展示（Manual 参考实现；不执行任何网络写入）。 */
  exportSessionJson(ref: string): { status: "ok"; json: string } | { status: "fail_closed"; reason: string } {
    const session = this.sessions.get(ref);
    if (session === undefined) return { status: "fail_closed", reason: `session_not_found: ${ref}` };
    return { status: "ok", json: JSON.stringify(session, null, 2) };
  }

  /** 当前 session 数量（诊断用）。 */
  get sessionCount(): number {
    return this.sessions.size;
  }
}
