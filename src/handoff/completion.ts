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
 * Kiwi v1.1 Transaction Handoff — 完成门禁（WP1 交付 4）。
 *
 * requestCompletion 的调用前置条件（基线 §19 Approval Pipeline 绑定语义的
 * 交接域投影；§4.6 fail closed）。任一不满足即拒绝完成，绝不静默放行：
 *
 *   1. authorization 经 AuthorizationProvider 验证
 *      （verifyIntentMandate 必须 verified=true；authorization 结构必须先合法）；
 *   2. terms_digest 与 session 当前 terms 一致
 *      （session.current_terms 重算 digest 必须等于 current_terms_digest ——
 *      防会话被篡改；且 authorization.terms_digest 必须等于该 digest ——
 *      防授权被挪用到别的 terms）；
 *   3. approval 未 stale
 *      （authorization.session_ref 必须等于当前 session —— 换 session 即失效；
 *      且未超过 expires_at —— 过期即 stale）。
 *
 * 判定顺序固定，便于审计：先验授权，再验 terms 绑定，最后验 stale。每个失败
 * 都返回结构化 {allowed:false, code, reason}，由调用方决定如何转成
 * HandoffResult（ManualHandoffChannel 把它映射为 {fail_closed, reason}）。
 */

import { contentDigest } from "../negotiation/jcs.js";
import type { AuthorizationProvider, PaymentAuthorization } from "./authorization.js";
import type { HandoffSession } from "./channel.js";

export const COMPLETION_GATE_FAILURE_CODES = [
  "authorization_not_verified",
  "terms_digest_mismatch",
  "approval_stale",
] as const;
export type CompletionGateFailureCode = (typeof COMPLETION_GATE_FAILURE_CODES)[number];

export type CompletionGateDecision =
  | { allowed: true }
  | { allowed: false; code: CompletionGateFailureCode; reason: string };

export interface CompletionGateContext {
  authorization: PaymentAuthorization;
  /** 待完成的 session（其 current_terms / current_terms_digest 是门禁输入）。 */
  session: HandoffSession;
  authorizationProvider: AuthorizationProvider;
  /** 可注入时钟（RFC 3339）；缺省 new Date().toISOString()。 */
  now?: () => string;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * authorization 结构守卫：门禁绝不能信任一个字段缺失/格式错误的授权对象。
 * 结构合法 ≠ 授权有效 —— 有效性由第 1 步 provider 验证与第 2/3 步绑定复核决定。
 */
export function isStructurallyValidAuthorization(value: unknown): value is PaymentAuthorization {
  if (value === null || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  const evidence = a.evidence as Record<string, unknown> | undefined;
  return (
    isNonEmptyString(a.authorization_id) &&
    isNonEmptyString(a.session_ref) &&
    typeof a.terms_digest === "string" &&
    DIGEST_RE.test(a.terms_digest) &&
    isNonEmptyString(a.intent_mandate) &&
    typeof a.approved_at === "string" &&
    TIMESTAMP_RE.test(a.approved_at) &&
    typeof a.expires_at === "string" &&
    TIMESTAMP_RE.test(a.expires_at) &&
    evidence !== undefined &&
    typeof evidence === "object" &&
    (evidence.kind === "manual" || evidence.kind === "ap2") &&
    isNonEmptyString(evidence.reference) &&
    typeof evidence.confirmed_at === "string" &&
    TIMESTAMP_RE.test(evidence.confirmed_at)
  );
}

/**
 * 完成门禁判定（纯函数）。判定顺序固定（验授权 → 验 terms 绑定 → 验 stale），
 * 任一失败 fail-closed。
 */
export function evaluateCompletionGate(ctx: CompletionGateContext): CompletionGateDecision {
  const { authorization, session, authorizationProvider } = ctx;
  const now = ctx.now ?? (() => new Date().toISOString());

  // 第 1 步：authorization 结构 + provider 验证。
  if (!isStructurallyValidAuthorization(authorization)) {
    return {
      allowed: false,
      code: "authorization_not_verified",
      reason: "authorization is malformed; refusing to trust it",
    };
  }
  const verification = authorizationProvider.verifyIntentMandate(authorization.intent_mandate, {
    session_ref: authorization.session_ref,
    terms_digest: authorization.terms_digest,
  });
  if (!verification.verified) {
    return {
      allowed: false,
      code: "authorization_not_verified",
      reason: verification.reason ?? "intent mandate verification failed",
    };
  }

  // 第 2 步：terms_digest 与 session 当前 terms 一致。
  const sessionCurrentDigest = contentDigest(session.current_terms);
  if (sessionCurrentDigest !== session.current_terms_digest) {
    return {
      allowed: false,
      code: "terms_digest_mismatch",
      reason:
        "session.current_terms tampered: recomputed digest does not match current_terms_digest",
    };
  }
  if (authorization.terms_digest !== session.current_terms_digest) {
    return {
      allowed: false,
      code: "terms_digest_mismatch",
      reason: "authorization is bound to different terms than session current terms",
    };
  }

  // 第 3 步：approval 未 stale（§19 绑定语义 + 有效期）。
  if (authorization.session_ref !== session.session_ref) {
    return {
      allowed: false,
      code: "approval_stale",
      reason: "authorization is bound to a different session_ref",
    };
  }
  const expiresMs = Date.parse(authorization.expires_at);
  const nowMs = Date.parse(now());
  if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) {
    return {
      allowed: false,
      code: "approval_stale",
      reason: "invalid timestamp on authorization expires_at / clock",
    };
  }
  if (nowMs > expiresMs) {
    return { allowed: false, code: "approval_stale", reason: "authorization has expired" };
  }

  return { allowed: true };
}
