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
 * ActorContext（TOP1-3 设计 v1.1 §4.1 / §4.2）。
 *
 * 由管理鉴权、可信 A2A 身份或现有访问会话**在服务端创建**；模型与客户端
 * 只提交业务参数，不能提交可信的 merchant_id、subject_id、权限集合或身份
 * 验证结论。本文件是唯一构造点：入参形状来自服务端调用方（facade 注入的
 * 认证上下文），严格校验失败即抛类型化错误。
 *
 * D-M0-01：`subject_binding` 为 `person` / `verified_person` 时构造失败
 * （P0 个人主体关闭）；上层可捕获 `subject_binding_rejected` 降级为匿名。
 */

import {
  ACTOR_CAPABILITIES,
  AUTH_STRENGTHS,
  ContextGovernanceError,
  GOVERNANCE_POLICY_VERSION,
  PERSONAL_SUBJECT_BINDINGS,
  SUBJECT_BINDING_KINDS,
  assertOpaqueId,
  type ActorCapability,
  type AuthStrength,
  type SubjectBindingKind,
} from "./types.js";

export interface ActorContext {
  /** 商家域，来自认证上下文；接待/管理调用不接受正文自报。 */
  readonly merchant_id: string;
  /** 服务端身份（管理员、后台服务主体或客户主体引用），不是模型会话 ID。 */
  readonly actor_id: string;
  /** 服务端判定的认证强度。 */
  readonly auth_strength: AuthStrength;
  /** 主体绑定范围；P0 拒绝 person / verified_person（D-M0-01）。 */
  readonly subject_binding: SubjectBindingKind;
  /** 能力集合，来自固定注册表；空集合 = 只有匿名接待级权限。 */
  readonly capabilities: readonly ActorCapability[];
  /** 构造时的 policy_version（m0-pilot-1），用于 trace 与守卫比对。 */
  readonly policy_version: string;
}

export interface CreateActorContextInput {
  merchant_id: string;
  actor_id: string;
  auth_strength: AuthStrength;
  subject_binding: SubjectBindingKind;
  capabilities?: readonly string[];
}

function parseCapabilities(raw: readonly string[] | undefined): ActorCapability[] {
  if (raw === undefined) return [];
  const seen = new Set<ActorCapability>();
  for (const item of raw) {
    if (!(ACTOR_CAPABILITIES as readonly string[]).includes(item)) {
      throw new ContextGovernanceError(
        "validation",
        "capability_unknown",
        `能力 "${item}" 不在固定注册表中，枚举不可由调用方扩展`,
      );
    }
    seen.add(item as ActorCapability);
  }
  // 输出稳定排序，保证派生摘要与日志确定性。
  return ACTOR_CAPABILITIES.filter((cap) => seen.has(cap));
}

/**
 * 服务端创建 ActorContext。任何形状问题都 fail-closed；个人主体绑定在此
 * 拒绝（原因码 `subject_binding_rejected`），不是静默降级。
 */
export function createActorContext(input: CreateActorContextInput): ActorContext {
  if (!(AUTH_STRENGTHS as readonly string[]).includes(input.auth_strength)) {
    throw new ContextGovernanceError(
      "validation",
      "auth_strength_unknown",
      `auth_strength "${input.auth_strength}" 不在固定注册表中`,
    );
  }
  if (!(SUBJECT_BINDING_KINDS as readonly string[]).includes(input.subject_binding)) {
    throw new ContextGovernanceError(
      "validation",
      "subject_binding_unknown",
      `subject_binding "${input.subject_binding}" 不在固定注册表中`,
    );
  }
  if (PERSONAL_SUBJECT_BINDINGS.has(input.subject_binding)) {
    throw new ContextGovernanceError(
      "unsupported_capability",
      "subject_binding_rejected",
      `P0 不启用个人主体（D-M0-01）：${input.subject_binding} 一律拒绝，保留接入点`,
    );
  }
  if (input.subject_binding !== "none" && input.auth_strength === "anonymous") {
    throw new ContextGovernanceError(
      "validation",
      "subject_binding_without_auth",
      "匿名认证不能携带主体绑定",
    );
  }
  return {
    merchant_id: assertOpaqueId(input.merchant_id, "merchant_id"),
    actor_id: assertOpaqueId(input.actor_id, "actor_id"),
    auth_strength: input.auth_strength,
    subject_binding: input.subject_binding,
    capabilities: parseCapabilities(input.capabilities),
    policy_version: GOVERNANCE_POLICY_VERSION,
  };
}

export function hasCapability(actor: ActorContext, capability: ActorCapability): boolean {
  return actor.capabilities.includes(capability);
}

/** 要求具备某能力，否则 access_denied（不披露其他主体资源是否存在）。 */
export function requireCapability(actor: ActorContext, capability: ActorCapability): void {
  if (!hasCapability(actor, capability)) {
    throw new ContextGovernanceError(
      "access_denied",
      "capability_missing",
      `actor 缺少能力 ${capability}`,
    );
  }
}
