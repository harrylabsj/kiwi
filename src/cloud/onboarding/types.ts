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
 * 开通记录与平台适配器契约（设计 v0.1.2 §7.1 / §7.2 / §7.3；M4）。
 *
 * 这一层存在的理由只有一条：**"看起来开通了"不等于"开通了"**。
 *
 *   - 适配器返回值、LLM 的一句"已部署"、聊天里粘贴的文本 applicationId——全部只是
 *     **待核查证据**（`PendingEvidence`），永远不能推进数据库状态（§7.2 末句、T029）；
 *   - 只有**平台实际查询回执**（`AuthoritativeEvidence`）能让记录进入关键状态；
 *   - 每次写操作经 Idempotency-Key + 请求摘要 + 商家身份三绑定：同 key 同摘要返回
 *     原结果，同 key 不同摘要冲突（§7.2、T008）；
 *   - 记录用 revision 做 CAS，**并发写不会互相覆盖**（§7.2）；
 *   - 中途退出不是回滚：重开向导读的是**服务端记录**，不是会话记忆（§7.2、T010）。
 */

/** 开通记录的 12 个状态（设计 §7.1 的表，逐条对齐）。 */
export const ONBOARDING_STATUSES = [
  "DRAFT",
  "AWAITING_PLATFORM_CONSENT",
  "ACTIVATED",
  "DEPLOYING",
  "DEPLOYED_UNBOUND",
  "BOUND",
  "VERIFYING",
  "READY_TO_PUBLISH",
  "PUBLISHED",
  "FAILED_RETRYABLE",
  "BLOCKED",
  "CANCELLED",
] as const;

export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

/**
 * 允许的状态迁移（§7.1 的进入条件）。
 *
 * `CANCELLED` 是终态（商家撤销意图；**不自动删已有云资源**）。
 * `BLOCKED` 只能回到它**被阻断前**的邻接状态——解除原因后重试，而不是任意跳转。
 */
export const ONBOARDING_TRANSITIONS: Readonly<Record<OnboardingStatus, readonly OnboardingStatus[]>> = {
  DRAFT: ["AWAITING_PLATFORM_CONSENT", "FAILED_RETRYABLE", "BLOCKED", "CANCELLED"],
  AWAITING_PLATFORM_CONSENT: ["ACTIVATED", "CANCELLED", "FAILED_RETRYABLE", "BLOCKED"],
  ACTIVATED: ["DEPLOYING", "FAILED_RETRYABLE", "BLOCKED", "CANCELLED"],
  DEPLOYING: ["DEPLOYED_UNBOUND", "FAILED_RETRYABLE", "BLOCKED", "CANCELLED"],
  DEPLOYED_UNBOUND: ["BOUND", "FAILED_RETRYABLE", "BLOCKED", "CANCELLED"],
  BOUND: ["VERIFYING", "FAILED_RETRYABLE", "BLOCKED", "CANCELLED"],
  VERIFYING: ["READY_TO_PUBLISH", "FAILED_RETRYABLE", "BLOCKED", "CANCELLED"],
  READY_TO_PUBLISH: ["PUBLISHED", "FAILED_RETRYABLE", "BLOCKED", "CANCELLED"],
  PUBLISHED: ["BLOCKED", "CANCELLED"],
  // 可重试失败：回到失败前的状态由调用方显式给出（只能回到"曾经到达过"的状态）
  FAILED_RETRYABLE: [
    "DRAFT",
    "AWAITING_PLATFORM_CONSENT",
    "ACTIVATED",
    "DEPLOYING",
    "DEPLOYED_UNBOUND",
    "BOUND",
    "VERIFYING",
    "READY_TO_PUBLISH",
    "BLOCKED",
    "CANCELLED",
  ],
  BLOCKED: ["CANCELLED"],
  CANCELLED: [],
};

/**
 * 证据来源。**只有 `platform_query` 是权威的**——其余都是"待核查"。
 *
 * 这不是命名洁癖：把 `adapter_return` 当权威，就等于让适配器（或伪造它的调用方）
 * 直接改数据库状态，T029 要挡的正是这件事。
 */
export const EVIDENCE_KINDS = [
  /** 平台侧实际查询回执（权威）。 */
  "platform_query",
  /** 适配器调用返回值（待核查：连它自己都只是"可能是真的"）。 */
  "adapter_return",
  /** 用户在平台确认框的授权回执（原生授权，由平台下发）。 */
  "user_consent_receipt",
  /** 文本声明：粘贴的 applicationId、聊天消息、LLM 的"已完成"。一律非权威。 */
  "text_claim",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** 权威证据：能推进状态的那种。 */
export interface AuthoritativeEvidence {
  kind: "platform_query";
  /** 平台查询回执里报告的 applicationId（必须与记录里持久化的那一个一致）。 */
  applicationId: string;
  /** 平台侧报告的 generation / 部署代次。 */
  generation: number;
  /** 回执观测时间（ISO）。 */
  observedAt: string;
  /**
   * 回执来源标识（平台工具名/查询句柄）。空 = 无法追溯 → 不构成权威证据。
   */
  source: string;
}

/** 待核查证据：可以记录，但**不能**推进状态。 */
export interface PendingEvidence {
  kind: Exclude<EvidenceKind, "platform_query">;
  /** 证据原文摘要（脱敏后）。绝不作为状态迁移依据。 */
  summary: string;
  observedAt: string;
}

export type Evidence = AuthoritativeEvidence | PendingEvidence;

export function isAuthoritative(evidence: Evidence): evidence is AuthoritativeEvidence {
  if (evidence.kind !== "platform_query") return false;
  // 权威证据本身也要自洽：没有来源标识 / 没有回执时间 / applicationId 为空的
  // "查询回执"追溯不到任何东西，不能当作权威。
  return (
    typeof evidence.source === "string" &&
    evidence.source.trim() !== "" &&
    typeof evidence.observedAt === "string" &&
    evidence.observedAt.trim() !== "" &&
    typeof evidence.applicationId === "string" &&
    evidence.applicationId.trim() !== "" &&
    Number.isInteger(evidence.generation)
  );
}

/** 开通记录（§7.1 的字段清单）。 */
export interface OnboardingRecord {
  /** 记录 id（内部主键）。 */
  readonly recordId: string;
  /** 开通意图（商家一次"我要开通"的意图；重复点击复用同一个）。 */
  readonly intentId: string;
  readonly merchantId: string;
  readonly environment: "production";
  readonly agentSlot: "primary";
  /** 部署代次：换版本/重建环境必须显式新建代次（§7.1）。 */
  readonly generation: number;
  /** 创建意图时**预留**的目录身份与稳定名片地址（此时不可搜索、不可营业）。 */
  readonly catalogAgentId: string;
  readonly cardUrl: string;
  /** 制品版本摘要（锁定的精确版本，不跟随漂移的 dev 版本）。 */
  readonly versionDigest: string;
  /** 平台 applicationId：**只有在权威证据确认后才写入**。 */
  readonly applicationId: string | null;
  /** 实际 runtime origin 的 hostname 写回兼容目录记录用（确定后才有）。 */
  readonly runtimeOriginHost: string | null;
  readonly status: OnboardingStatus;
  /** CAS 版本号：每次成功写 +1。 */
  readonly revision: number;
  /** 最后一个**成功**的步骤名（断点续办用）。 */
  readonly lastSuccessfulStep: string | null;
  /** 已脱敏的错误信息（不含密钥/令牌/个人数据）。 */
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 记录是否处于"对外可营业"状态：只有 PUBLISHED 可以（§7.1 表最后一列）。 */
export function isPublishable(status: OnboardingStatus): boolean {
  return status === "PUBLISHED";
}

/**
 * 平台能力契约（§7.3）。**只定义能力，不定义实现**。
 *
 * 未映射到实际工具的能力必须抛 `PLATFORM_CAPABILITY_UNAVAILABLE`——
 * **禁止成功空实现**：一个返回 `{ok:true}` 的假适配器比没有适配器更危险。
 */
export const PLATFORM_CAPABILITIES = [
  "inspectOwnedApplication",
  "activateWithUserConsent",
  "deployPinnedArtifact",
  "getDeploymentStatus",
  "readVerifiedPublicConfig",
  "getRuntimePublicOrigin",
  "requestStop",
  "requestDelete",
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

export class PlatformCapabilityUnavailableError extends Error {
  readonly code = "PLATFORM_CAPABILITY_UNAVAILABLE";
  readonly capability: PlatformCapability;
  constructor(capability: PlatformCapability) {
    super(`platform capability is not mapped: ${capability}`);
    this.name = "PlatformCapabilityUnavailableError";
    this.capability = capability;
  }
}

/** 开通流程的错误码（供调用方分流，不靠字符串匹配）。 */
export const ONBOARDING_ERROR_CODES = [
  "invalid_input",
  "conflict",
  "stale_revision",
  "illegal_transition",
  "evidence_not_authoritative",
  "application_id_mismatch",
  "record_not_found",
] as const;

export type OnboardingErrorCode = (typeof ONBOARDING_ERROR_CODES)[number];

export class OnboardingError extends Error {
  readonly code: OnboardingErrorCode;
  constructor(code: OnboardingErrorCode, message: string) {
    super(message);
    this.name = "OnboardingError";
    this.code = code;
  }
}
