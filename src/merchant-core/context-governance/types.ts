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
 * 共性控制的共享枚举与类型化错误（TOP1-3 设计 v1.1 §4 / §17.3）。
 *
 * 枚举为服务端固定注册表：模型/客户端只能提交业务参数，不能扩展枚举或
 * 自报可信字段。错误码沿用 §17.3 内部错误约定，不进入 KNP wire。
 */

/** 数据用途（§9.2 / §10 / D-M0 分工）：记忆、历史检索、经验提炼、通知分别授予。 */
export const DATA_USE_PURPOSES = [
  "customer_memory",
  "history_recall",
  "experience_learning",
  "notification",
] as const;
export type DataUsePurpose = (typeof DATA_USE_PURPOSES)[number];

/** DataUseGrant 生命周期状态；服务端迁移，模型不可写。 */
export const DATA_GRANT_STATUSES = ["ACTIVE", "REVOKED", "EXPIRED"] as const;
export type DataGrantStatus = (typeof DATA_GRANT_STATUSES)[number];

/** 主体绑定范围（D-M0-01）：P0 只允许 organization / agent_scope / none。 */
export const SUBJECT_BINDING_KINDS = [
  "none",
  "organization",
  "agent_scope",
  "person",
  "verified_person",
] as const;
export type SubjectBindingKind = (typeof SUBJECT_BINDING_KINDS)[number];

/** 认证强度：从弱到强；管理鉴权/A2A 验签在服务端判定后注入。 */
export const AUTH_STRENGTHS = ["anonymous", "session", "verified", "mfa"] as const;
export type AuthStrength = (typeof AUTH_STRENGTHS)[number];

/**
 * Actor 能力固定注册表。新增能力只能改这里（代码评审可见），不能由
 * 模型输出或客户端参数注入。
 */
export const ACTOR_CAPABILITIES = [
  "reception:serve",
  "learning:manage",
  "learning:review",
  "learning:publish",
  "memory:read",
  "memory:write",
  "jobs:manage",
  "customer:self",
] as const;
export type ActorCapability = (typeof ACTOR_CAPABILITIES)[number];

/**
 * D-M0-01：个人主体接入点保留但 P0 关闭——`person` / `verified_person`
 * 一律拒绝；上层接待路径捕获后可降级为匿名/组织范围继续服务。
 */
export const PERSONAL_SUBJECT_BINDINGS: ReadonlySet<SubjectBindingKind> = new Set([
  "person",
  "verified_person",
]);

/** M0 参数冻结（D-M0-09 / 收尾决议 §1.2）：policy_version，任何变化递增。 */
export const GOVERNANCE_POLICY_VERSION = "m0-pilot-1";

/** 上下文治理的 ID 约束（附录 C1：ID 不透明且有长度上限）。 */
export const GOVERNANCE_ID_MAX_LENGTH = 128;

/**
 * 类型化错误，`code` 对齐 §17.3 内部错误码：
 * access_denied / stale_context / version_conflict / source_unavailable /
 * unsupported_capability / validation。
 */
export type ContextGovernanceErrorCode =
  | "access_denied"
  | "stale_context"
  | "version_conflict"
  | "source_unavailable"
  | "unsupported_capability"
  | "validation";

export class ContextGovernanceError extends Error {
  readonly code: ContextGovernanceErrorCode;
  /** 稳定原因码（进 trace，不进对外错误文案）。 */
  readonly reason: string;

  constructor(code: ContextGovernanceErrorCode, reason: string, message?: string) {
    super(message ?? `${code}: ${reason}`);
    this.name = "ContextGovernanceError";
    this.code = code;
    this.reason = reason;
  }
}

/** ID 形状校验：非空、长度上限、无控制字符；内容不透明。 */
export function assertOpaqueId(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContextGovernanceError("validation", `${field}_empty`, `${field} 必须是非空字符串`);
  }
  if (value.length > GOVERNANCE_ID_MAX_LENGTH) {
    throw new ContextGovernanceError(
      "validation",
      `${field}_too_long`,
      `${field} 长度超过 ${GOVERNANCE_ID_MAX_LENGTH}`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ContextGovernanceError("validation", `${field}_invalid`, `${field} 含控制字符`);
  }
  return value;
}
