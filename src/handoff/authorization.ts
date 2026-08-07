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
 * Kiwi v0.7.0 Transaction Handoff — AuthorizationProvider（AP2 边界，WP1）。
 *
 * 基线 §43 / docs/kiwi_a2a_v1.md §29 预留给 AuthorizationProvider 的 AP2 接缝：
 * Kiwi 不实现真实 AP2（外部系统），只定义适配边界，并提供一个 fail-closed 默认
 * 实现（FailClosedAuthorizationProvider）——未配置真实 AP2 时：
 *   - createIntentMandate  → requires_user（把人导向外部 checkout，绝不伪造 mandate）；
 *   - verifyIntentMandate  → verified:false（绝不认可任何 mandate）；
 *   - authorizeCheckout    → fail_closed（绝不伪造 checkout 授权）。
 *
 * PaymentAuthorization 必须绑定 terms_digest + session_ref + 用户确认证据，
 * 防止「授权被挪用到别的 terms / 别的 session」。完成门禁（completion.ts）在
 * complete 前复核这三个绑定。
 */

import {
  requireDigest,
  requireIsoTimestamp,
  requireNonEmptyString,
} from "../negotiation/domain/common.js";
import { uuidv7, validateIdentifier } from "../negotiation/domain/identifiers.js";
import { contentDigest } from "../negotiation/jcs.js";
import type { TermSet } from "../negotiation/domain/common.js";
import { HandoffError } from "./errors.js";

// ---------------------------------------------------------------------------
// 用户确认证据
// ---------------------------------------------------------------------------

/** 用户显式授权确认的证据来源。 */
export const CONFIRMATION_EVIDENCE_KINDS = ["manual", "ap2"] as const;
export type ConfirmationEvidenceKind = (typeof CONFIRMATION_EVIDENCE_KINDS)[number];

/** 用户显式授权确认的证据：authorization 必须绑定它。 */
export interface UserConfirmationEvidence {
  /** manual=操作者审批；ap2=真实 AP2 返回的确认回执。 */
  kind: ConfirmationEvidenceKind;
  /** 证据引用（如审批单号 / AP2 confirmation id），opaque。 */
  reference: string;
  /** 用户确认发生时间，RFC 3339。 */
  confirmed_at: string;
}

export interface UserConfirmationEvidenceInput {
  kind: ConfirmationEvidenceKind;
  reference: string;
  confirmed_at?: string;
}

/** 构造并校验用户确认证据（confirmed_at 缺省用 now）。 */
export function createUserConfirmationEvidence(
  input: UserConfirmationEvidenceInput,
  now: () => string = () => new Date().toISOString(),
): UserConfirmationEvidence {
  if (!(CONFIRMATION_EVIDENCE_KINDS as readonly string[]).includes(input.kind)) {
    throw new HandoffError(
      "invalid_authorization",
      `evidence.kind must be one of ${CONFIRMATION_EVIDENCE_KINDS.join("|")}`,
      "evidence.kind",
    );
  }
  const evidence: UserConfirmationEvidence = {
    kind: input.kind,
    reference: requireNonEmptyString(input.reference, "evidence.reference"),
    confirmed_at: input.confirmed_at ?? now(),
  };
  requireIsoTimestamp(evidence.confirmed_at, "evidence.confirmed_at");
  return evidence;
}

// ---------------------------------------------------------------------------
// PaymentAuthorization
// ---------------------------------------------------------------------------

/**
 * 完成门禁输入的唯一授权对象。三个绑定缺一不可：
 *   session_ref   —— 授权只对这一个 session 有效（换 session 即失效）；
 *   terms_digest  —— 授权只对这一个 terms 内容有效（换 terms 即失效）；
 *   evidence      —— 用户显式确认证据（无人确认即不是授权）。
 * intent_mandate 是 AP2 侧 mandate 引用；authorizeCheckout 前必须经 provider
 * verifyIntentMandate 复核。
 */
export interface PaymentAuthorization {
  authorization_id: string;
  session_ref: string;
  terms_digest: string;
  intent_mandate: string;
  evidence: UserConfirmationEvidence;
  approved_at: string;
  /** 授权有效期终点：过期即 stale（完成门禁第 3 步）。 */
  expires_at: string;
}

export interface PaymentAuthorizationInput {
  authorization_id: string;
  session_ref: string;
  terms_digest: string;
  intent_mandate: string;
  evidence: UserConfirmationEvidence;
  approved_at?: string;
  expires_at?: string;
  /** 缺省有效期长度（毫秒）；缺省 30 分钟。 */
  ttl_ms?: number;
}

/** 新授权 id：`authz_<uuidv7>`。 */
export function newAuthorizationId(): string {
  return `authz_${uuidv7()}`;
}

/** 构造并校验 PaymentAuthorization。缺省 approved_at=now、expires_at=now+ttl_ms。 */
export function createPaymentAuthorization(
  input: PaymentAuthorizationInput,
  now: () => string = () => new Date().toISOString(),
): PaymentAuthorization {
  const approvedAt = input.approved_at ?? now();
  requireIsoTimestamp(approvedAt, "approved_at");
  const ttlMs = input.ttl_ms ?? 30 * 60 * 1000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new HandoffError("invalid_authorization", "ttl_ms must be a positive number", "ttl_ms");
  }
  const expiresAt = input.expires_at ?? new Date(new Date(approvedAt).getTime() + ttlMs).toISOString();
  requireIsoTimestamp(expiresAt, "expires_at");

  const authorization: PaymentAuthorization = {
    authorization_id: validateIdentifier(input.authorization_id, "authorization_id"),
    session_ref: validateIdentifier(input.session_ref, "session_ref"),
    terms_digest: requireDigest(input.terms_digest, "terms_digest"),
    intent_mandate: requireNonEmptyString(input.intent_mandate, "intent_mandate"),
    evidence: input.evidence,
    approved_at: approvedAt,
    expires_at: expiresAt,
  };
  requireIsoTimestamp(authorization.evidence.confirmed_at, "evidence.confirmed_at");
  // 数值比较（非字符串）：RFC 3339 允许带时区偏移，字符串比较跨时区会
  // fail-open（如 confirmed_at 带 -08:00 偏移时事后补签可通过）。NaN 视为非法。
  const confirmedMs = Date.parse(authorization.evidence.confirmed_at);
  const approvedMs = Date.parse(authorization.approved_at);
  if (!Number.isFinite(confirmedMs) || !Number.isFinite(approvedMs) || confirmedMs > approvedMs) {
    throw new HandoffError(
      "invalid_authorization",
      "evidence.confirmed_at MUST NOT be after approved_at (evidence must precede approval)",
      "evidence.confirmed_at",
    );
  }
  return authorization;
}

// ---------------------------------------------------------------------------
// AuthorizationProvider 接缝
// ---------------------------------------------------------------------------

export interface CreateIntentMandateInput {
  session_ref: string;
  terms_digest: string;
  terms: TermSet;
}

export type CreateIntentMandateResult =
  | { status: "ok"; intent_mandate: string }
  | { status: "fail_closed"; reason: string }
  | { status: "requires_user"; continue_url?: string; reason: string };

export interface VerifyIntentMandateInput {
  session_ref: string;
  terms_digest: string;
}

export interface VerifyIntentMandateResult {
  verified: boolean;
  reason?: string;
}

export interface AuthorizeCheckoutInput {
  session_ref: string;
  terms_digest: string;
  intent_mandate: string;
  evidence: UserConfirmationEvidence;
}

export type AuthorizeCheckoutResult =
  | { status: "ok"; authorization: PaymentAuthorization }
  | { status: "fail_closed"; reason: string };

/**
 * AP2 适配接缝（基线 §43 / docs §29）。实现方 = 外部支付/checkout 系统适配器；
 * Kiwi 侧只消费结构化结果，绝不伪造授权。
 */
export interface AuthorizationProvider {
  createIntentMandate(input: CreateIntentMandateInput): CreateIntentMandateResult;
  verifyIntentMandate(
    intent_mandate: string,
    input: VerifyIntentMandateInput,
  ): VerifyIntentMandateResult;
  authorizeCheckout(input: AuthorizeCheckoutInput): AuthorizeCheckoutResult;
}

const NO_AP2_REASON =
  "no_ap2_configured: Kiwi is not configured with a real AP2/checkout provider; refusing to fabricate any authorization";

/**
 * fail-closed 默认实现。任何真实授权动作都拒绝：
 *   createIntentMandate → requires_user（无 AP2 时只有人能继续，绝不伪造 mandate）；
 *   verifyIntentMandate → verified:false；
 *   authorizeCheckout   → fail_closed。
 */
export class FailClosedAuthorizationProvider implements AuthorizationProvider {
  createIntentMandate(_input: CreateIntentMandateInput): CreateIntentMandateResult {
    return { status: "requires_user", reason: NO_AP2_REASON };
  }
  verifyIntentMandate(
    _intent_mandate: string,
    _input: VerifyIntentMandateInput,
  ): VerifyIntentMandateResult {
    return { verified: false, reason: NO_AP2_REASON };
  }
  authorizeCheckout(_input: AuthorizeCheckoutInput): AuthorizeCheckoutResult {
    return { status: "fail_closed", reason: NO_AP2_REASON };
  }
}

/** terms 的 digest 便捷函数（构造 Authorization 时用）。 */
export function digestTerms(terms: TermSet): string {
  return contentDigest(terms);
}
