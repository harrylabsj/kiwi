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
 * Kiwi v1.1 Transaction Handoff — OperatorApprovalAuthorizationProvider（WP3）。
 *
 * 把 operator 审批证据桥接为 AuthorizationProvider（AP2 边界）。用户/操作员在
 * 审批面（approval face）上看到 HandoffPackage + checkout session 摘要后显式
 * 确认（recordApproval）；此后 createIntentMandate / authorizeCheckout 才能产出
 * 绑定 terms_digest + session_ref + evidence 的 PaymentAuthorization。
 *
 * 与 WriteApprovalCandidate 生命周期对齐（基线 §19 Approval 绑定语义）：
 *   - approval stale（expired / revoked / 底层 candidate 被 superseded / rejected）
 *     即授权失效——verifyIntentMandate 返回 verified:false；
 *   - 未确认 / 超时 → createIntentMandate 返回 requires_user，绝不自动授权；
 *   - §19 绑定 candidate_digest / remote_revision / policy_version 固化在审批记录里；
 *     remote_revision 变化（currentRevision 回调核对）即 stale。
 *
 * 本模块不创建订单、不处理支付凭据；它只把「人确认过这个 package + session」这一
 * 事实安全地变成完成门禁可验证的授权。
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import {
  requireDigest,
  requireIsoTimestamp,
  requireNonEmptyString,
} from "../negotiation/domain/common.js";
import { validateIdentifier } from "../negotiation/domain/identifiers.js";
import { contentDigest } from "../negotiation/jcs.js";
import {
  createPaymentAuthorization,
  createUserConfirmationEvidence,
  newAuthorizationId,
  type AuthorizeCheckoutInput,
  type AuthorizeCheckoutResult,
  type AuthorizationProvider,
  type CreateIntentMandateInput,
  type CreateIntentMandateResult,
  type UserConfirmationEvidence,
  type VerifyIntentMandateInput,
  type VerifyIntentMandateResult,
} from "./authorization.js";
import type { HandoffSession } from "./channel.js";
import { HandoffError } from "./errors.js";
import type { HandoffPackage } from "./package.js";

// ---------------------------------------------------------------------------
// 审批记录与状态
// ---------------------------------------------------------------------------

/** 审批记录自身状态（撤销是显式的；过期是时间派生的）。 */
export const OPERATOR_APPROVAL_RECORD_STATUSES = ["approved", "revoked"] as const;
export type OperatorApprovalRecordStatus = (typeof OPERATOR_APPROVAL_RECORD_STATUSES)[number];

/** 底层候选生命周期状态（WriteApprovalCandidate status，write-gate 适配）。 */
export const OPERATOR_APPROVAL_SOURCE_STATUSES = [
  "pending_approval",
  "approved",
  "executed",
  "rejected",
  "superseded",
  "expired",
] as const;
export type OperatorApprovalSourceStatus = (typeof OPERATOR_APPROVAL_SOURCE_STATUSES)[number];

/**
 * 审批面（approval face）上展示的 checkout session 摘要。operator 确认的是
 * 「这个 session + 这些 terms + 这个远端 revision」的组合，任一变化即 stale。
 */
export interface CheckoutSessionSummary {
  session_ref: string;
  current_terms_digest: string;
  /** 远端 checkout 的 revision（opaque；变化即 stale）。 */
  remote_revision: string;
  status: string;
}

/** 从 HandoffSession 构造审批面摘要；缺省 remote_revision 用 session.updated_at。 */
export function summarizeCheckoutSession(
  session: Pick<
    HandoffSession,
    "session_ref" | "current_terms_digest" | "status" | "updated_at"
  >,
  remoteRevision?: string,
): CheckoutSessionSummary {
  return {
    session_ref: session.session_ref,
    current_terms_digest: session.current_terms_digest,
    remote_revision: remoteRevision ?? session.updated_at,
    status: session.status,
  };
}

/** HandoffPackage 的紧凑身份摘要（审批面确认的对象）。 */
export function digestHandoffPackage(pkg: HandoffPackage): string {
  return contentDigest({
    agreement_id: pkg.agreement_id,
    negotiation_id: pkg.negotiation_id,
    accepted_offer_id: pkg.accepted_offer_id,
    terms_digest: pkg.terms_digest,
    package_version: pkg.package_version,
    capability_version: pkg.capability_version,
  });
}

/**
 * 一条已确认的 operator 审批记录。所有字段只读——状态变化通过替换整条记录实现
 * （revokeApproval），避免原地突变。
 */
export interface OperatorApprovalRecord {
  /** 审批 id；与 WriteApprovalCandidate.candidate_id 对齐（opaque）。 */
  readonly approval_id: string;
  readonly session_ref: string;
  readonly terms_digest: string;
  /** 审批面展示的 HandoffPackage 身份摘要。 */
  readonly package_digest: string;
  /** §19：候选内容摘要（candidate_digest）。 */
  readonly candidate_digest: string;
  /** §19：确认时的远端 checkout revision。 */
  readonly remote_revision: string;
  /** §19：审批生效的 policy 版本。 */
  readonly policy_version: string;
  readonly status: OperatorApprovalRecordStatus;
  /** 用户/操作员显式确认时间（RFC 3339）。 */
  readonly confirmed_at: string;
  /** 授权有效期终点；过期即 stale（对齐 candidate expires_at）。 */
  readonly expires_at: string;
  readonly recorded_at: string;
}

export interface RecordOperatorApprovalInput {
  approval_id: string;
  /** 审批面展示的 HandoffPackage（operator 确认的对象）。 */
  package: HandoffPackage;
  /** 审批面展示的 checkout session 摘要。 */
  session: CheckoutSessionSummary;
  /** §19 candidate_digest。 */
  candidate_digest: string;
  /** §19 policy_version。 */
  policy_version: string;
  /** 可注入确认时间（RFC 3339）；缺省 now。 */
  confirmed_at?: string;
  /** 审批有效期长度（毫秒）；缺省 30 分钟。 */
  ttl_ms?: number;
}

/** 缺省审批窗口：对齐 createPaymentAuthorization 的授权 TTL（30 分钟）。 */
export const OPERATOR_APPROVAL_TTL_MS = 30 * 60 * 1000;

/**
 * 读取底层审批候选生命周期状态的接缝。真实实现由 write-gate 从
 * WriteApprovalCandidateStore 适配（writeApprovalStatusSource）；provider 只依赖
 * 这一个窄接口，不直接依赖 agent 层。
 */
export interface OperatorApprovalStatusSource {
  getApprovalState(
    candidateId: string,
  ):
    | { status: OperatorApprovalSourceStatus; expires_at: string }
    | undefined;
}

// ---------------------------------------------------------------------------
// OperatorApprovalAuthorizationProvider
// ---------------------------------------------------------------------------

export interface OperatorApprovalAuthorizationProviderOptions {
  /** 可注入时钟（RFC 3339）；缺省 new Date().toISOString()。 */
  now?: () => string;
  /** 底层候选生命周期来源（WriteApprovalCandidate 适配）；可选。 */
  statusSource?: OperatorApprovalStatusSource;
  /**
   * 返回某 session 当前的远端 revision；提供时与审批记录的 remote_revision 比对，
   * 不一致即 stale（§19 remote_revision 绑定）。
   */
  currentRevision?: (sessionRef: string) => string | undefined;
  /**
   * 可选持久化目录：提供时审批事件（record/revoke）落 JSONL（目录 0700、
   * 文件 0600），重启恢复 + §19 审计留存；缺省纯内存（进程重启即失效）。
   */
  persistDir?: string;
}

const NOT_CONFIRMED_REASON =
  "operator approval required: no confirmed approval for this session/terms (explicit user confirmation is mandatory; Kiwi never auto-authorizes)";

function isUsableSourceStatus(status: OperatorApprovalSourceStatus): boolean {
  return status === "approved" || status === "executed";
}

/**
 * 把 operator 审批证据桥接为 AuthorizationProvider：
 *   - recordApproval 记录「人在审批面确认 HandoffPackage + session 摘要」；
 *   - createIntentMandate：有有效审批 → ok（intent_mandate=approval_id）；
 *     未确认 / 超时 / 被吊销 → requires_user（绝不自动授权）；
 *   - verifyIntentMandate：审批 stale / 吊销 / 绑定变化 → verified:false；
 *   - authorizeCheckout：产出绑定 terms_digest + session_ref + evidence
 *     （confirmed_at ≤ approved_at）的 PaymentAuthorization。
 */
export class OperatorApprovalAuthorizationProvider implements AuthorizationProvider {
  private readonly records = new Map<string, OperatorApprovalRecord>();
  private readonly now: () => string;
  private readonly options: OperatorApprovalAuthorizationProviderOptions;
  private readonly journalPath?: string;

  constructor(options: OperatorApprovalAuthorizationProviderOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.options = options;
    if (options.persistDir !== undefined) {
      mkdirSync(options.persistDir, { recursive: true, mode: 0o700 });
      chmodSync(options.persistDir, 0o700);
      this.journalPath = path.join(options.persistDir, "operator-approvals.jsonl");
      this.replayJournal();
    }
  }

  /** 从 JSONL 重放审批事件（同 approval_id 后事件胜出；撕裂行容忍跳过）。 */
  private replayJournal(): void {
    if (this.journalPath === undefined || !existsSync(this.journalPath)) return;
    const raw = readFileSync(this.journalPath, "utf-8");
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      try {
        const event = JSON.parse(line) as {
          type: string;
          approval?: OperatorApprovalRecord;
          approval_id?: string;
        };
        if (event.type === "record" && event.approval?.approval_id !== undefined) {
          this.records.set(event.approval.approval_id, event.approval);
        } else if (event.type === "revoke" && typeof event.approval_id === "string") {
          const existing = this.records.get(event.approval_id);
          if (existing !== undefined) {
            this.records.set(event.approval_id, { ...existing, status: "revoked" });
          }
        }
      } catch {
        // 撕裂行跳过（审计由事件流本身承载；审批重放容忍最后一行撕裂）。
      }
    }
  }

  /** 追加一条审批事件（单行 append，原子）。 */
  private journalAppend(event: Record<string, unknown>): void {
    if (this.journalPath === undefined) return;
    appendFileSync(this.journalPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  // -- 审批证据写入（审批面） ------------------------------------------------

  /** 记录一次显式确认。返回固化后的只读审批记录。 */
  recordApproval(input: RecordOperatorApprovalInput): OperatorApprovalRecord {
    const now = this.now();
    const confirmedAt = input.confirmed_at ?? now;
    requireIsoTimestamp(confirmedAt, "confirmed_at");
    const ttlMs = input.ttl_ms ?? OPERATOR_APPROVAL_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new HandoffError("invalid_authorization", "ttl_ms must be a positive number", "ttl_ms");
    }
    const expiresAt = new Date(Date.parse(confirmedAt) + ttlMs).toISOString();
    requireIsoTimestamp(expiresAt, "expires_at");

    const approval: OperatorApprovalRecord = {
      approval_id: validateIdentifier(input.approval_id, "approval_id"),
      session_ref: validateIdentifier(input.session.session_ref, "session_ref"),
      terms_digest: requireDigest(input.session.current_terms_digest, "terms_digest"),
      package_digest: digestHandoffPackage(input.package),
      candidate_digest: requireDigest(input.candidate_digest, "candidate_digest"),
      remote_revision: requireNonEmptyString(input.session.remote_revision, "remote_revision"),
      policy_version: requireNonEmptyString(input.policy_version, "policy_version"),
      status: "approved",
      confirmed_at: confirmedAt,
      expires_at: expiresAt,
      recorded_at: now,
    };
    this.records.set(approval.approval_id, approval);
    this.journalAppend({ type: "record", approval });
    return approval;
  }

  /** 显式撤销一条审批（对齐 WriteApprovalCandidate.reject/supersede）。 */
  revokeApproval(approvalId: string): OperatorApprovalRecord {
    const existing = this.records.get(approvalId);
    if (existing === undefined) {
      throw new HandoffError("invalid_authorization", `no recorded approval ${approvalId}`);
    }
    const revoked: OperatorApprovalRecord = { ...existing, status: "revoked" };
    this.records.set(approvalId, revoked);
    this.journalAppend({ type: "revoke", approval_id: approvalId });
    return revoked;
  }

  /** 只读取回一条审批记录。 */
  getApproval(approvalId: string): OperatorApprovalRecord | undefined {
    return this.records.get(approvalId);
  }

  /** 当前审批记录数量（诊断用）。 */
  get approvalCount(): number {
    return this.records.size;
  }

  // -- AuthorizationProvider -------------------------------------------------

  createIntentMandate(input: CreateIntentMandateInput): CreateIntentMandateResult {
    const approval = this.findUsableApproval(input.session_ref, input.terms_digest);
    if (approval === undefined) {
      return { status: "requires_user", reason: NOT_CONFIRMED_REASON };
    }
    return { status: "ok", intent_mandate: approval.approval_id };
  }

  verifyIntentMandate(
    intent_mandate: string,
    input: VerifyIntentMandateInput,
  ): VerifyIntentMandateResult {
    const approval = this.records.get(intent_mandate);
    if (approval === undefined) {
      return { verified: false, reason: `unknown approval: ${intent_mandate}` };
    }
    const failure = this.invalidReason(approval, input.session_ref, input.terms_digest);
    if (failure !== undefined) return { verified: false, reason: failure };
    return { verified: true };
  }

  authorizeCheckout(input: AuthorizeCheckoutInput): AuthorizeCheckoutResult {
    const approval = this.records.get(input.intent_mandate);
    if (approval === undefined) {
      return { status: "fail_closed", reason: `unknown approval: ${input.intent_mandate}` };
    }
    const failure = this.invalidReason(approval, input.session_ref, input.terms_digest);
    if (failure !== undefined) {
      return { status: "fail_closed", reason: failure };
    }
    // 调用方传入的证据必须引用这条已确认的 operator 审批（防挪用它人证据）。
    if (input.evidence.kind !== "manual" || input.evidence.reference !== approval.approval_id) {
      return {
        status: "fail_closed",
        reason: "evidence does not reference the recorded operator approval",
      };
    }
    const approvedAt = this.now();
    // 数值比较（非字符串）：跨时区偏移的 confirmed_at 字符串比较可 fail-open。
    const confirmedMs = Date.parse(approval.confirmed_at);
    const approvedMs = Date.parse(approvedAt);
    if (!Number.isFinite(confirmedMs) || !Number.isFinite(approvedMs) || confirmedMs > approvedMs) {
      return {
        status: "fail_closed",
        reason: "confirmed_at MUST NOT be after approved_at",
      };
    }
    const authorization = createPaymentAuthorization(
      {
        authorization_id: newAuthorizationId(),
        session_ref: approval.session_ref,
        terms_digest: approval.terms_digest,
        intent_mandate: approval.approval_id,
        evidence: createUserConfirmationEvidence(
          { kind: "manual", reference: approval.approval_id, confirmed_at: approval.confirmed_at },
          this.now,
        ),
        approved_at: approvedAt,
        expires_at: approval.expires_at,
      },
      this.now,
    );
    return { status: "ok", authorization };
  }

  // -- 内部辅助 ---------------------------------------------------------------

  private findUsableApproval(
    sessionRef: string,
    termsDigest: string,
  ): OperatorApprovalRecord | undefined {
    for (const approval of this.records.values()) {
      if (approval.session_ref !== sessionRef) continue;
      if (approval.terms_digest !== termsDigest) continue;
      if (this.invalidReason(approval, sessionRef, termsDigest) === undefined) return approval;
    }
    return undefined;
  }

  /** 返回审批不可用的原因；可用时返回 undefined。判定顺序固定，便于审计。 */
  private invalidReason(
    approval: OperatorApprovalRecord,
    sessionRef: string,
    termsDigest: string,
  ): string | undefined {
    if (approval.status !== "approved") return "approval revoked";
    if (approval.session_ref !== sessionRef) {
      return "approval bound to a different session_ref (stale)";
    }
    if (approval.terms_digest !== termsDigest) {
      return "approval bound to different terms_digest (stale)";
    }
    const nowMs = Date.parse(this.now());
    const expiresMs = Date.parse(approval.expires_at);
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs) || nowMs > expiresMs) {
      return "approval expired (stale)";
    }
    if (this.options.currentRevision !== undefined) {
      const current = this.options.currentRevision(sessionRef);
      if (current !== undefined && current !== approval.remote_revision) {
        return "remote revision changed; approval stale";
      }
    }
    if (this.options.statusSource !== undefined) {
      const state = this.options.statusSource.getApprovalState(approval.approval_id);
      if (state === undefined) return "underlying candidate unknown; approval not usable";
      if (!isUsableSourceStatus(state.status)) {
        return `underlying candidate status ${state.status}; approval not usable`;
      }
    }
    return undefined;
  }
}

/** 从审批记录构造 UserConfirmationEvidence（供上层在调用 authorizeCheckout 前展示）。 */
export function operatorConfirmationEvidence(
  approval: OperatorApprovalRecord,
  now: () => string = () => new Date().toISOString(),
): UserConfirmationEvidence {
  return createUserConfirmationEvidence(
    { kind: "manual", reference: approval.approval_id, confirmed_at: approval.confirmed_at },
    now,
  );
}
