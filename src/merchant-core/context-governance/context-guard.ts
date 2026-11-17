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
 * ContextGuard（TOP1-3 设计 v1.1 §4.3 / §17.3）。
 *
 * 读取前、每次工具调用前、每次 provider attempt 派发前和最终发布前，检查
 * 权限、grant epoch、来源可用性与版本；失败抛类型化错误，旧快照/旧游标/
 * 旧上下文一律失效（丢弃结果重算，不是删引用标记）。
 *
 * 只提供守卫，不实现业务逻辑；撤权、封存、接管共享同一份版本检查——
 * "当前版本"由 ContextVersionAuthority 提供，各域存储在后续里程碑接入。
 *
 * 检查范围 = 快照绑定的域：快照里没出现的域不查询（grant_versions 空、
 * memory_set_version 0、skill_bindings 空 …）；authority 对某域回答
 * `undefined` 视为"该对象已撤销/封存/失效"——fail-closed。
 */

import {
  ContextGovernanceError,
  type ContextGovernanceErrorCode,
} from "./types.js";
import {
  requireCapability,
  type ActorContext,
} from "./actor-context.js";
import type { ActorCapability } from "./types.js";

export type ContextCheckpoint = "read" | "tool_call" | "provider_attempt" | "publish";

/** 运行开始时固定的技能绑定（§7.1）；M1 只定义形状与校验。 */
export interface SkillBindingRef {
  readonly skill_key: string;
  readonly release_id: string;
  readonly compiled_artifact_hash: string;
  readonly generation: number;
  readonly revocation_epoch: number;
}

/**
 * 服务端签发的运行快照（§4.2）。版本号 0 / 空集合表示本次运行不使用该域；
 * 使用中的域必须在每个检查点与当前版本一致。
 */
export interface ContextSnapshot {
  readonly snapshot_id: string;
  readonly issued_at: string;
  readonly binding_epoch: number;
  /** grant_id → 签发时的 grant_epoch。 */
  readonly grant_versions: Readonly<Record<string, number>>;
  /** 数据域（erase_scope）→ 签发时的 data_scope_epoch。 */
  readonly data_scope_epochs: Readonly<Record<string, number>>;
  readonly memory_set_version: number;
  readonly conversation_revision: number;
  readonly config_version: string;
  readonly skill_bindings: readonly SkillBindingRef[];
}

/** 来源可用性检查输入；不携带正文或秘密（§4.2 SourceRef）。 */
export interface SourceRefCheck {
  readonly object_id: string;
  readonly version: number;
  readonly expires_at?: string;
  readonly erased?: boolean;
}

/** 技能当前绑定（权威值）；undefined = 已撤回/未绑定/已删除。 */
export interface CurrentSkillBinding {
  readonly release_id: string;
  /** 权威编译产物摘要（发布时冻结）；快照绑定必须与之逐值一致（§7.1）。 */
  readonly compiled_artifact_hash: string;
  readonly generation: number;
  readonly revocation_epoch: number;
}

/**
 * "当前版本"权威。实现方返回 `undefined` 表示对象已不存在（撤权、封存、
 * 接管后旧对象失效）；guard 把一切与快照的不一致折叠为 stale_context。
 */
export interface ContextVersionAuthority {
  currentGrantEpoch(merchantId: string, grantId: string): number | undefined;
  /** 主体绑定当前 epoch（§9.2）；undefined = 绑定已撤销/不存在。 */
  currentBindingEpoch(merchantId: string, actorId: string): number | undefined;
  currentDataScopeEpoch(merchantId: string, scopeKey: string): number | undefined;
  currentSkillBinding(merchantId: string, skillKey: string): CurrentSkillBinding | undefined;
  currentMemorySetVersion(merchantId: string): number | undefined;
  currentConversationRevision(merchantId: string): number | undefined;
  currentConfigVersion(): string | undefined;
  sourceAvailable(merchantId: string, ref: SourceRefCheck): boolean;
}

export interface ContextGuardCheckInput {
  readonly actor: ActorContext;
  readonly snapshot: ContextSnapshot;
  /**
   * 本检查点行使的能力。§4.3：四个检查点"分别检查权限"——全部必填，
   * 不提供无权限旁路（缺省即 validation 失败）。
   */
  readonly capability: ActorCapability;
  /** tool_call 的诊断名，进 trace 原因码，不参与判定。 */
  readonly tool?: string;
  /** 本次读取/调用要用的来源引用；每个都必须可用。 */
  readonly source_refs?: readonly SourceRefCheck[];
}

export interface ContextGuardOptions {
  readonly authority: ContextVersionAuthority;
  readonly now: () => string;
}

function fail(checkpoint: ContextCheckpoint, code: ContextGovernanceErrorCode, reason: string): never {
  throw new ContextGovernanceError(code, `${checkpoint}.${reason}`);
}

function validateSnapshotShape(snapshot: ContextSnapshot, now: string, checkpoint: ContextCheckpoint): void {
  // 审计要求：形状错误的原因码保留实际检查点（publish.validation.…），不固定为 read。
  if (typeof snapshot.snapshot_id !== "string" || snapshot.snapshot_id.length === 0) {
    fail(checkpoint, "validation", "snapshot_id_missing");
  }
  const issued = Date.parse(snapshot.issued_at);
  if (!Number.isFinite(issued)) {
    fail(checkpoint, "validation", "issued_at_invalid");
  }
  if (issued > Date.parse(now)) {
    fail(checkpoint, "validation", "issued_at_future");
  }
  if (!Number.isSafeInteger(snapshot.binding_epoch) || snapshot.binding_epoch < 0) {
    fail(checkpoint, "validation", "binding_epoch_invalid");
  }
  if (!Number.isSafeInteger(snapshot.memory_set_version) || snapshot.memory_set_version < 0) {
    fail(checkpoint, "validation", "memory_set_version_invalid");
  }
  if (!Number.isSafeInteger(snapshot.conversation_revision) || snapshot.conversation_revision < 0) {
    fail(checkpoint, "validation", "conversation_revision_invalid");
  }
  for (const [grantId, epoch] of Object.entries(snapshot.grant_versions)) {
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      fail(checkpoint, "validation", `grant_epoch_invalid:${grantId}`);
    }
  }
  for (const [scopeKey, epoch] of Object.entries(snapshot.data_scope_epochs)) {
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      fail(checkpoint, "validation", `data_scope_epoch_invalid:${scopeKey}`);
    }
  }
  for (const binding of snapshot.skill_bindings) {
    if (
      typeof binding.skill_key !== "string" ||
      binding.skill_key.length === 0 ||
      typeof binding.release_id !== "string" ||
      binding.release_id.length === 0 ||
      typeof binding.compiled_artifact_hash !== "string" ||
      binding.compiled_artifact_hash.length === 0 ||
      !Number.isSafeInteger(binding.generation) ||
      binding.generation < 1 ||
      !Number.isSafeInteger(binding.revocation_epoch) ||
      binding.revocation_epoch < 0
    ) {
      fail(checkpoint, "validation", "skill_binding_invalid");
    }
  }
}

export class ContextGuard {
  private readonly authority: ContextVersionAuthority;
  private readonly now: () => string;

  constructor(options: ContextGuardOptions) {
    this.authority = options.authority;
    this.now = options.now;
  }

  /** 读取前检查：能力（必填）+ 主体绑定 + grant/来源/版本一致性。 */
  checkRead(input: ContextGuardCheckInput): void {
    this.check("read", input);
  }

  /** 工具调用前检查：同 read；工具名进 trace。 */
  checkToolCall(input: ContextGuardCheckInput): void {
    this.check("tool_call", input);
  }

  /** provider attempt 派发前检查：重试/压缩/摘要分支同样要走（§4.3）。 */
  checkProviderAttempt(input: ContextGuardCheckInput): void {
    this.check("provider_attempt", input);
  }

  /** 发布前检查（发布临界区的版本半边）：全部域必须仍一致。 */
  checkPublish(input: ContextGuardCheckInput): void {
    this.check("publish", input);
  }

  private check(checkpoint: ContextCheckpoint, input: ContextGuardCheckInput): void {
    const now = this.now();
    validateSnapshotShape(input.snapshot, now, checkpoint);
    // §4.3：四个检查点"分别检查权限"——capability 必填，无旁路。
    if (input.capability === undefined) {
      fail(checkpoint, "validation", "capability_required");
    }
    try {
      requireCapability(input.actor, input.capability!);
    } catch (err) {
      if (err instanceof ContextGovernanceError && err.code === "access_denied") {
        fail(checkpoint, "access_denied", `capability_missing:${input.capability}`);
      }
      throw err;
    }

    const merchantId = input.actor.merchant_id;
    const snapshot = input.snapshot;

    // 主体绑定一致性（§9.1/§9.2）：绑定态 actor 必须在快照中携带 binding_epoch，
    // 匿名 actor 不能携带；否则快照可绕过绑定撤销失效检查。
    if ((input.actor.subject_binding === "none") !== (snapshot.binding_epoch === 0)) {
      fail(checkpoint, "validation", "binding_state_inconsistent");
    }
    if (snapshot.binding_epoch > 0) {
      const current = this.authority.currentBindingEpoch(merchantId, input.actor.actor_id);
      // 撤销绑定递增 binding_epoch（§9.2）：旧快照在此统一失效。
      if (current === undefined) {
        fail(checkpoint, "stale_context", "binding_gone");
      }
      if (current !== snapshot.binding_epoch) {
        fail(checkpoint, "stale_context", "binding_epoch_changed");
      }
    }

    for (const [grantId, boundEpoch] of Object.entries(snapshot.grant_versions)) {
      const current = this.authority.currentGrantEpoch(merchantId, grantId);
      if (current === undefined) {
        fail(checkpoint, "stale_context", `grant_gone:${grantId}`);
      }
      if (current !== boundEpoch) {
        fail(checkpoint, "stale_context", `grant_epoch_changed:${grantId}`);
      }
    }

    for (const [scopeKey, boundEpoch] of Object.entries(snapshot.data_scope_epochs)) {
      const current = this.authority.currentDataScopeEpoch(merchantId, scopeKey);
      if (current === undefined) {
        fail(checkpoint, "stale_context", `data_scope_gone:${scopeKey}`);
      }
      if (current !== boundEpoch) {
        fail(checkpoint, "stale_context", `data_scope_epoch_changed:${scopeKey}`);
      }
    }

    if (snapshot.memory_set_version > 0) {
      const current = this.authority.currentMemorySetVersion(merchantId);
      if (current === undefined || current !== snapshot.memory_set_version) {
        fail(checkpoint, "stale_context", "memory_set_version_changed");
      }
    }

    if (snapshot.conversation_revision > 0) {
      const current = this.authority.currentConversationRevision(merchantId);
      if (current === undefined || current !== snapshot.conversation_revision) {
        fail(checkpoint, "stale_context", "conversation_revision_changed");
      }
    }

    const currentConfig = this.authority.currentConfigVersion();
    if (snapshot.config_version !== "" && currentConfig !== snapshot.config_version) {
      fail(checkpoint, "stale_context", "config_version_changed");
    }

    for (const binding of snapshot.skill_bindings) {
      const current = this.authority.currentSkillBinding(merchantId, binding.skill_key);
      if (current === undefined) {
        fail(checkpoint, "stale_context", `skill_unbound:${binding.skill_key}`);
      }
      if (
        current.release_id !== binding.release_id ||
        current.generation !== binding.generation ||
        current.revocation_epoch !== binding.revocation_epoch
      ) {
        fail(checkpoint, "stale_context", `skill_version_changed:${binding.skill_key}`);
      }
      // 冻结产物必须与权威值逐值一致（§7.1"快照中的确切产物"）：同 release
      // 不同 hash 的绑定在此拒绝，防止旧产物借新版本号通过。
      if (current.compiled_artifact_hash !== binding.compiled_artifact_hash) {
        fail(checkpoint, "stale_context", `skill_artifact_changed:${binding.skill_key}`);
      }
    }

    for (const ref of input.source_refs ?? []) {
      if (!this.authority.sourceAvailable(merchantId, ref)) {
        fail(checkpoint, "source_unavailable", `source:${ref.object_id}`);
      }
    }
  }
}
