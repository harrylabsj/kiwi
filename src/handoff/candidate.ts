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
 * HandoffCandidate —— KTH/0.1 §5 不可变候选（v1.1 WP-C1 / 完成定义 #9、#10）。
 *
 * 与 `HandoffPackage`（src/handoff/package.ts，v1.0 WP1 的 UCP checkout session
 * 层工件）**不是一回事**：HandoffPackage 是 UCP Checkout 适配层输入；
 * HandoffCandidate 是 KTH 候选——agreement → 策略/批准 → 重验 → 交付链的
 * 第一环。二者并存（术语对齐决策：不重命名、双轨共存）。
 *
 * 不可变性（KTH rev0.3 §5.1）：内容全部 readonly + 防御拷贝；
 * lifecycle 状态**不是**候选 JSON 内的字段——它是 Ledger 事件的
 * event-sourced 投影（见 lifecycle.ts / ledger.ts）。
 *
 * digest：candidate_digest = RFC 8785 JCS(contentDigest) 去除自身字段后
 * 的 SHA-256（复用 src/negotiation/jcs.ts，KTH rev0.3 §10.1）。
 */

import {
  requireBoolean,
  requireIsoTimestamp,
  requireNonEmptyString,
  requireObject,
  schemaError,
} from "../negotiation/domain/common.js";
import { generateId, validateIdentifier } from "../negotiation/domain/identifiers.js";
import { contentDigest } from "../negotiation/jcs.js";
import { validateDestination, type DestinationType } from "./destination.js";

/** 展示摘要（KTH §6 display_summary；完成定义 #17 用户可见目标与摘要）。 */
export interface HandoffDisplaySummary {
  readonly merchant: string;
  readonly summary: string;
}

/**
 * HandoffCandidate（KTH rev0.3 §5）。全部字段 readonly —— 类型层面不可变。
 */
export interface HandoffCandidate {
  readonly handoff_candidate_id: string;
  /** 被本候选取代的旧候选（stale 后新建候选的审计链接，§5.1）。 */
  readonly supersedes_candidate_id?: string;
  readonly agreement_id: string;
  readonly negotiation_id: string;
  readonly terms_digest: string;
  readonly buyer_identity_ref: string;
  readonly merchant_identity_ref: string;
  readonly destination_type: DestinationType;
  readonly destination_ref: string;
  /** 最小化、schema-validated、非秘密目的地载荷（KTH §11.3）。 */
  readonly destination_payload?: Readonly<Record<string, unknown>>;
  readonly display_summary: HandoffDisplaySummary;
  readonly policy_version: string;
  readonly expires_at: string;
  readonly requires_user_action: boolean;
  /** KTH/1.0 三副作用不变量：恒为 false（§16 Agreement 约束）。 */
  readonly creates_order: false;
  readonly authorizes_payment: false;
  readonly reserves_inventory: false;
  readonly candidate_digest: string;
  readonly created_at: string;
}

/** 创建输入：agreement 溯源 + 目的地 + 策略元数据。 */
export interface HandoffCandidateInput {
  /** 产生本候选的 agreement 的 id。 */
  agreement_id: string;
  /** 产生本候选的 negotiation 的 id。 */
  negotiation_id: string;
  /** 已谈妥的条款对象（用于重算 terms_digest；缺省用 terms_digest 原值）。 */
  agreed_terms?: unknown;
  /** 期望的 terms_digest；与 agreed_terms 重算值不一致 → 校验失败。 */
  terms_digest?: string;
  buyer_identity_ref?: string;
  merchant_identity_ref?: string;
  destination: { type: DestinationType; ref: string; payload?: Record<string, unknown> };
  display_summary: HandoffDisplaySummary;
  policy_version: string;
  /** RFC 3339 过期时间（KTH §10 重验的一部分）。 */
  expires_at: string;
  requires_user_action?: boolean;
  /** 取代的旧候选 id（stale 审计链接）。 */
  supersedes_candidate_id?: string;
  created_at?: string;
}

/** 类型守卫。 */
export function isHandoffCandidate(value: unknown): value is HandoffCandidate {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).handoff_candidate_id !== undefined &&
    (value as Record<string, unknown>).candidate_digest !== undefined
  );
}

/** 计算 candidate_digest：candidate 去除 candidate_digest 后 JCS+SHA-256。 */
export function computeCandidateDigest(candidate: Readonly<HandoffCandidate>): string {
  const { candidate_digest: _digest, ...rest } = candidate;
  return contentDigest(rest);
}

/** 校验 candidate_digest 与内容自洽。 */
export function verifyHandoffCandidateDigest(candidate: HandoffCandidate): boolean {
  return candidate.candidate_digest === computeCandidateDigest(candidate);
}

function freezeSummary(summary: unknown, path: string): HandoffDisplaySummary {
  const obj = requireObject(summary, path);
  return Object.freeze({
    merchant: requireNonEmptyString(obj.merchant, `${path}/merchant`),
    summary: requireNonEmptyString(obj.summary, `${path}/summary`),
  });
}

/**
 * 构造即校验（KTH §5）：agreement 绑定、terms_digest 一致性（提供
 * agreed_terms 时重算比对）、destination 校验、三 false 不变量、标识符
 * 与时间戳校验。返回不可变候选（防御拷贝）。
 */
export function createHandoffCandidate(input: HandoffCandidateInput): HandoffCandidate {
  const agreementId = validateIdentifier(input.agreement_id, "agreement_id");
  const negotiationId = validateIdentifier(input.negotiation_id, "negotiation_id");
  if (input.buyer_identity_ref !== undefined) {
    validateIdentifier(input.buyer_identity_ref, "buyer_identity_ref");
  }
  if (input.merchant_identity_ref !== undefined) {
    validateIdentifier(input.merchant_identity_ref, "merchant_identity_ref");
  }
  if (input.supersedes_candidate_id !== undefined) {
    validateIdentifier(input.supersedes_candidate_id, "supersedes_candidate_id");
  }

  let termsDigest = input.terms_digest;
  if (input.agreed_terms !== undefined) {
    const recomputed = contentDigest(input.agreed_terms);
    if (termsDigest !== undefined && termsDigest !== recomputed) {
      throw schemaError(
        "terms_digest",
        `terms_digest does not match recomputed digest of agreed_terms ` +
          `(expected ${termsDigest}, got ${recomputed})`,
      );
    }
    termsDigest = recomputed;
  }
  if (termsDigest === undefined) {
    throw schemaError("terms_digest", "terms_digest is required (or provide agreed_terms)");
  }
  requireNonEmptyString(termsDigest, "terms_digest");

  const destination = validateDestination(input.destination, "destination");
  const displaySummary = freezeSummary(input.display_summary, "display_summary");
  const policyVersion = requireNonEmptyString(input.policy_version, "policy_version");
  requireIsoTimestamp(input.expires_at, "expires_at");
  const createdAt = input.created_at ?? new Date().toISOString();
  requireIsoTimestamp(createdAt, "created_at");

  const candidate: HandoffCandidate = Object.freeze({
    handoff_candidate_id: generateId("handoff_candidate"),
    ...(input.supersedes_candidate_id !== undefined
      ? { supersedes_candidate_id: input.supersedes_candidate_id }
      : {}),
    agreement_id: agreementId,
    negotiation_id: negotiationId,
    terms_digest: termsDigest,
    buyer_identity_ref: input.buyer_identity_ref ?? "principal:unknown",
    merchant_identity_ref: input.merchant_identity_ref ?? "merchant:unknown",
    destination_type: destination.type,
    destination_ref: destination.ref,
    ...(destination.payload !== undefined ? { destination_payload: destination.payload } : {}),
    display_summary: displaySummary,
    policy_version: policyVersion,
    expires_at: input.expires_at,
    requires_user_action: input.requires_user_action ?? true,
    creates_order: false,
    authorizes_payment: false,
    reserves_inventory: false,
    candidate_digest: "",
    created_at: createdAt,
  }) as HandoffCandidate;

  // digest 依赖内容 → 构造完成后再计算，并整体冻结。
  return Object.freeze({ ...candidate, candidate_digest: computeCandidateDigest(candidate) });
}

/**
 * 校验并重建一个候选对象（Ledger 事件重建，§18-13）。
 *
 * 保留输入的 handoff_candidate_id 与 candidate_digest（不重新生成）：
 * 字段校验复用 createHandoffCandidate 的规则，然后以输入 id 覆盖，
 * 再核对 digest（提供 digest 时）或按内容重算（缺省时）。
 */
export function validateHandoffCandidate(value: unknown, path = "handoff_candidate"): HandoffCandidate {
  const obj = requireObject(value, path);
  if (obj.creates_order !== false || obj.authorizes_payment !== false || obj.reserves_inventory !== false) {
    throw schemaError(
      path,
      "HandoffCandidate 三副作用不变量必须全为 false（KTH/1.0 不创建订单/不授权支付/不预留库存）",
    );
  }
  requireBoolean(obj.requires_user_action, `${path}/requires_user_action`);
  const candidateId = validateIdentifier(obj.handoff_candidate_id, `${path}/handoff_candidate_id`);
  const generated = createHandoffCandidate({
    agreement_id: requireNonEmptyString(obj.agreement_id, `${path}/agreement_id`),
    negotiation_id: requireNonEmptyString(obj.negotiation_id, `${path}/negotiation_id`),
    terms_digest: requireNonEmptyString(obj.terms_digest, `${path}/terms_digest`),
    buyer_identity_ref: obj.buyer_identity_ref as string | undefined,
    merchant_identity_ref: obj.merchant_identity_ref as string | undefined,
    destination: {
      type: obj.destination_type as DestinationType,
      ref: requireNonEmptyString(obj.destination_ref, `${path}/destination_ref`),
      ...(obj.destination_payload !== undefined
        ? { payload: obj.destination_payload as Record<string, unknown> }
        : {}),
    },
    display_summary: {
      merchant: requireNonEmptyString(
        (obj.display_summary as Record<string, unknown> | undefined)?.merchant,
        `${path}/display_summary/merchant`,
      ),
      summary: requireNonEmptyString(
        (obj.display_summary as Record<string, unknown> | undefined)?.summary,
        `${path}/display_summary/summary`,
      ),
    },
    policy_version: requireNonEmptyString(obj.policy_version, `${path}/policy_version`),
    expires_at: requireNonEmptyString(obj.expires_at, `${path}/expires_at`),
    requires_user_action: obj.requires_user_action as boolean | undefined,
    ...(obj.supersedes_candidate_id !== undefined
      ? { supersedes_candidate_id: obj.supersedes_candidate_id as string }
      : {}),
    created_at: obj.created_at as string | undefined,
  });
  const withId: HandoffCandidate = { ...generated, handoff_candidate_id: candidateId };
  if (obj.candidate_digest !== undefined) {
    const withDigest: HandoffCandidate = {
      ...withId,
      candidate_digest: requireNonEmptyString(obj.candidate_digest, `${path}/candidate_digest`),
    };
    if (!verifyHandoffCandidateDigest(withDigest)) {
      throw schemaError(`${path}/candidate_digest`, "candidate_digest mismatch on rebuild");
    }
    return Object.freeze(withDigest);
  }
  return Object.freeze({ ...withId, candidate_digest: computeCandidateDigest(withId) });
}
