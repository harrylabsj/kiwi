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
 * 客户记忆域（设计 v1.1 §10 / §12 / M3-2 / M3-4 / M3-5）。
 *
 * - 从对话提取的条目先进入 candidate；只有显式确认（一次短语/卡片回执）后
 *   才进入 active；推断不能自行升级为硬约束。
 * - 纠错创建新版本并 supersede 旧版本；memory_set_version 递增使旧快照失效。
 * - 删除先登记 DeletionJob/封存 scope，再清理记忆、证据、历史索引；备份面
 *   保持 `backup_pending`，恢复前重放删除登记。
 * - purge_at = min(确认/采集+分类期限, 采集+90 天, grant 到期)，读取不延长。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { contentDigest } from "../../negotiation/jcs.js";
import type { ActorContext } from "../context-governance/actor-context.js";
import { hasCapability } from "../context-governance/actor-context.js";
import type { CustomerIdentityService } from "./identity.js";
import {
  DataUseGrantStore,
  type DataUseGrant,
} from "../context-governance/data-use-grant.js";
import {
  SourceGovernanceService,
  type DeletionJobRecord,
} from "../context-governance/source-governance.js";
import {
  GOVERNANCE_POLICY_VERSION,
  type DataUsePurpose,
} from "../context-governance/types.js";
import { inImmediateTransaction } from "../storage/transaction.js";
import {
  CustomerMemoryError,
  MEMORY_NAMESPACES,
  MEMORY_SOURCE_KINDS,
  type CustomerMemory,
  type MemoryNamespace,
  type MemorySourceKind,
  type MemoryState,
} from "./types.js";

const MAX_VALUE_CHARS = 500;
const MAX_SOURCE_REFS = 10;
const DEFAULT_PREFERENCE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function text(value: string, field: string, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new CustomerMemoryError("validation", `${field}_invalid`, `${field} 必须是 1..${max} 字符`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new CustomerMemoryError("validation", `${field}_invalid`, `${field} 含控制字符`);
  }
  return value;
}

function nowUtc(now: () => string): string {
  const ms = Date.parse(now());
  if (!Number.isFinite(ms)) {
    throw new CustomerMemoryError("validation", "now_invalid", "时钟输出必须是可解析的 RFC3339 时间");
  }
  return new Date(ms).toISOString();
}

function requireActor(
  actor: ActorContext,
  merchantId: string,
  capabilities: readonly ("memory:read" | "memory:write" | "customer:self")[],
): void {
  if (actor.merchant_id !== merchantId) {
    throw new CustomerMemoryError("access_denied", "actor_merchant_mismatch", "ActorContext 与商家作用域不一致");
  }
  if (actor.policy_version !== GOVERNANCE_POLICY_VERSION) {
    throw new CustomerMemoryError("validation", "policy_version_mismatch", "治理策略版本不一致");
  }
  if (!capabilities.some((capability) => hasCapability(actor, capability))) {
    throw new CustomerMemoryError(
      "access_denied",
      "capability_missing",
      `actor 缺少 ${capabilities.join("/")}`,
    );
  }
}

interface MemoryRow {
  memory_id: string;
  merchant_id: string;
  subject_id: string;
  resource_scope_id: string;
  namespace: MemoryNamespace;
  key: string;
  value_ref: string;
  value_type: string;
  state: MemoryState;
  source_kind: MemorySourceKind;
  source_refs_json: string;
  confidence: number | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  valid_from: string;
  expires_at: string;
  last_confirmed_at: string | null;
  policy_version: string;
  version: number;
  grant_id: string;
  grant_epoch: number;
  data_epoch: number;
  erase_scope_id: string;
  purge_at: string;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

function toMemory(row: MemoryRow): CustomerMemory {
  return {
    ...row,
    source_refs: (JSON.parse(row.source_refs_json) as string[]) ?? [],
  } as unknown as CustomerMemory;
}

export interface CustomerMemoryServiceOptions {
  db: DatabaseSync;
  now: () => string;
  /** 来源治理（删除作业/封存/来源可用性）；缺省时删除只清理本域表。 */
  sourceGovernance?: SourceGovernanceService;
  /**
   * 主体绑定查询（B04）：客户自助确认/纠错必须证明自己是该记忆的主体。
   * 缺省时客户写路径 fail-closed（管理员 memory:write 不受影响）。
   */
  identity?: CustomerIdentityService;
}

export class CustomerMemoryService {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly grants: DataUseGrantStore;
  private readonly sourceGovernance?: SourceGovernanceService;
  private readonly identity?: CustomerIdentityService;

  constructor(options: CustomerMemoryServiceOptions) {
    this.db = options.db;
    this.now = options.now;
    this.grants = new DataUseGrantStore({ db: options.db, now: options.now });
    this.sourceGovernance = options.sourceGovernance;
    this.identity = options.identity;
  }

  /**
   * B04：客户自助写路径必须绑定到目标主体。商家管理员（memory:write 且
   * organization/agent_scope）可跨主体管理；匿名/未绑定会话一律拒绝。
   */
  private assertActorOwnsSubject(actor: ActorContext, subjectId: string): void {
    if (hasCapability(actor, "memory:write") && actor.subject_binding !== "none") {
      return;
    }
    const bound = this.identity?.currentSubjectForActor(actor.merchant_id, actor.actor_id);
    if (bound === undefined || bound.subject_id !== subjectId) {
      throw new CustomerMemoryError(
        "access_denied",
        "subject_not_bound",
        "当前会话未绑定到该记忆主体",
      );
    }
  }

  private requireActiveGrant(input: {
    merchantId: string;
    subjectId: string;
    scopeId: string;
    purpose: DataUsePurpose;
  }): DataUseGrant {
    const grant = this.grants.getActiveGrant({
      merchant_id: input.merchantId,
      subject_id: input.subjectId,
      purpose: input.purpose,
      resource_scope_id: input.scopeId,
    });
    if (grant === undefined) {
      throw new CustomerMemoryError(
        "grant_unavailable",
        "grant_not_active",
        "缺少有效数据用途授权或已撤销/过期",
      );
    }
    return grant;
  }

  private subjectActive(merchantId: string, subjectId: string): void {
    const row = this.db
      .prepare(
        "SELECT status FROM customer_subjects WHERE merchant_id = ? AND subject_id = ?",
      )
      .get(merchantId, subjectId) as { status: string } | undefined;
    if (row === undefined || row.status !== "ACTIVE") {
      throw new CustomerMemoryError("not_found", "subject_not_found", "主体不存在或不可见");
    }
  }

  /** memory_set_version 递增：任何 active 集合变化都使旧快照失效。 */
  private bumpSetVersion(merchantId: string, subjectId: string, now: string): number {
    this.db
      .prepare(
        `INSERT INTO memory_set_versions (merchant_id, subject_id, version, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(merchant_id, subject_id) DO UPDATE SET
           version = memory_set_versions.version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(merchantId, subjectId, now);
    return this.currentMemorySetVersion(merchantId, subjectId) ?? 1;
  }

  currentMemorySetVersion(merchantId: string, subjectId: string): number | undefined {
    const row = this.db
      .prepare(
        "SELECT version FROM memory_set_versions WHERE merchant_id = ? AND subject_id = ?",
      )
      .get(merchantId, subjectId) as { version: number } | undefined;
    return row?.version;
  }

  /**
   * 写入候选记忆：必须有 customer_memory 用途授权；value_ref 为受控引用，
   * 不内联精确地址/手机号；来源引用只做形状校验与数量上限。
   */
  proposeMemory(input: {
    merchant_id: string;
    actor: ActorContext;
    subject_id: string;
    resource_scope_id: string;
    namespace: MemoryNamespace;
    key: string;
    value_ref: string;
    value_type: string;
    source_kind: MemorySourceKind;
    source_refs?: readonly string[];
    confidence?: number;
    expires_at?: string;
  }): CustomerMemory {
    const merchantId = text(input.merchant_id, "merchant_id");
    requireActor(input.actor, merchantId, ["memory:write"]);
    const subjectId = text(input.subject_id, "subject_id");
    this.subjectActive(merchantId, subjectId);
    const scopeId = text(input.resource_scope_id, "resource_scope_id");
    if (!(MEMORY_NAMESPACES as readonly string[]).includes(input.namespace)) {
      throw new CustomerMemoryError("validation", "namespace_unknown", "未知记忆 namespace");
    }
    if (!(MEMORY_SOURCE_KINDS as readonly string[]).includes(input.source_kind)) {
      throw new CustomerMemoryError("validation", "source_kind_unknown", "未知来源类别");
    }
    const key = text(input.key, "key", 64);
    const valueRef = text(input.value_ref, "value_ref", MAX_VALUE_CHARS);
    const valueType = text(input.value_type, "value_type", 32);
    const sourceRefs = [...new Set(input.source_refs ?? [])];
    if (sourceRefs.length > MAX_SOURCE_REFS) {
      throw new CustomerMemoryError("validation", "source_refs_too_many", "证据引用最多 10 条");
    }
    for (const ref of sourceRefs) text(ref, "source_ref");
    if (
      input.confidence !== undefined &&
      (typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 1)
    ) {
      throw new CustomerMemoryError("validation", "confidence_invalid", "confidence 必须在 0..1");
    }
    const grant = this.requireActiveGrant({
      merchantId,
      subjectId,
      scopeId,
      purpose: "customer_memory",
    });
    const stamp = nowUtc(this.now);
    const expiresAt =
      input.expires_at ??
      new Date(Math.min(
        Date.parse(stamp) + DEFAULT_PREFERENCE_TTL_MS,
        Date.parse(grant.expires_at),
      )).toISOString();
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(stamp)) {
      throw new CustomerMemoryError("validation", "expires_at_invalid", "expires_at 必须晚于当前时间");
    }
    const purgeAt = new Date(Math.min(
      Date.parse(expiresAt),
      Date.parse(grant.expires_at),
      Date.parse(stamp) + DEFAULT_PREFERENCE_TTL_MS,
    )).toISOString();
    const dataEpoch =
      this.sourceGovernance?.getDataScope(merchantId, scopeId)?.data_epoch ?? 1;
    const state: MemoryState =
      input.source_kind === "inferred" ? "needs_review" : "candidate";
    return inImmediateTransaction(this.db, () => {
      const memory: CustomerMemory = {
        memory_id: `mem_${randomUUID()}`,
        merchant_id: merchantId,
        subject_id: subjectId,
        resource_scope_id: scopeId,
        namespace: input.namespace,
        key,
        value_ref: valueRef,
        value_type: valueType,
        state,
        source_kind: input.source_kind,
        source_refs: sourceRefs,
        confidence: input.confidence ?? null,
        confirmed_by: null,
        confirmed_at: null,
        last_confirmed_at: null,
        valid_from: stamp,
        expires_at: expiresAt,
        policy_version: GOVERNANCE_POLICY_VERSION,
        version: 1,
        grant_id: grant.grant_id,
        grant_epoch: grant.grant_epoch,
        data_epoch: dataEpoch,
        erase_scope_id: scopeId,
        purge_at: purgeAt,
        superseded_by: null,
        created_at: stamp,
        updated_at: stamp,
      };
      this.insertMemory(memory);
      this.insertEvidence(memory.memory_id, merchantId, sourceRefs, input.source_kind, stamp);
      this.appendEvent(memory, "memory_candidate", { state }, stamp);
      return memory;
    });
  }

  /** 客户确认：candidate/needs_review → active；版本递增并刷新 memory_set_version。 */
  confirmMemory(input: {
    merchant_id: string;
    actor: ActorContext;
    memory_id: string;
    expected_version: number;
  }): CustomerMemory {
    const merchantId = text(input.merchant_id, "merchant_id");
    requireActor(input.actor, merchantId, ["customer:self"]);
    const memoryId = text(input.memory_id, "memory_id");
    return inImmediateTransaction(this.db, () => {
      const memory = this.requireMemory(merchantId, memoryId);
      this.assertActorOwnsSubject(input.actor, memory.subject_id);
      if (memory.state !== "candidate" && memory.state !== "needs_review") {
        throw new CustomerMemoryError("version_conflict", "memory_state_invalid", `状态 ${memory.state} 不能确认`);
      }
      if (memory.version !== input.expected_version) {
        throw new CustomerMemoryError("version_conflict", "memory_version_mismatch", "记忆版本已变化");
      }
      const grant = this.requireActiveGrant({
        merchantId,
        subjectId: memory.subject_id,
        scopeId: memory.resource_scope_id,
        purpose: "customer_memory",
      });
      const stamp = nowUtc(this.now);
      this.assertWithinRetention(memory, stamp);
      const updated: CustomerMemory = {
        ...memory,
        state: "active",
        version: memory.version + 1,
        confirmed_by: input.actor.actor_id,
        confirmed_at: stamp,
        grant_epoch: grant.grant_epoch,
        updated_at: stamp,
      };
      this.updateMemory(updated);
      this.bumpSetVersion(merchantId, memory.subject_id, stamp);
      this.appendEvent(updated, "memory_confirmed", { version: updated.version }, stamp);
      return updated;
    });
  }

  /** 纠错：新版本 active 并 supersede 旧版本；旧快照因 set version 失效。 */
  correctMemory(input: {
    merchant_id: string;
    actor: ActorContext;
    memory_id: string;
    expected_version: number;
    value_ref: string;
    source_refs?: readonly string[];
  }): CustomerMemory {
    const merchantId = text(input.merchant_id, "merchant_id");
    requireActor(input.actor, merchantId, ["customer:self", "memory:write"]);
    const memoryId = text(input.memory_id, "memory_id");
    const valueRef = text(input.value_ref, "value_ref", MAX_VALUE_CHARS);
    const sourceRefs = [...new Set(input.source_refs ?? [])];
    if (sourceRefs.length > MAX_SOURCE_REFS) {
      throw new CustomerMemoryError("validation", "source_refs_too_many", "证据引用最多 10 条");
    }
    return inImmediateTransaction(this.db, () => {
      const old = this.requireMemory(merchantId, memoryId);
      this.assertActorOwnsSubject(input.actor, old.subject_id);
      if (old.state !== "active" && old.state !== "needs_review") {
        throw new CustomerMemoryError("version_conflict", "memory_state_invalid", `状态 ${old.state} 不能纠错`);
      }
      if (old.version !== input.expected_version) {
        throw new CustomerMemoryError("version_conflict", "memory_version_mismatch", "记忆版本已变化");
      }
      const grant = this.requireActiveGrant({
        merchantId,
        subjectId: old.subject_id,
        scopeId: old.resource_scope_id,
        purpose: "customer_memory",
      });
      const stamp = nowUtc(this.now);
      this.assertWithinRetention(old, stamp);
      const next: CustomerMemory = {
        ...old,
        memory_id: `mem_${randomUUID()}`,
        value_ref: valueRef,
        source_kind: "explicit",
        source_refs: sourceRefs,
        state: "active",
        version: old.version + 1,
        confirmed_by: input.actor.actor_id,
        confirmed_at: stamp,
        last_confirmed_at: stamp,
        grant_epoch: grant.grant_epoch,
        superseded_by: null,
        created_at: stamp,
        updated_at: stamp,
      };
      this.insertMemory(next);
      this.insertEvidence(next.memory_id, merchantId, sourceRefs, "explicit", stamp);
      this.updateMemory({ ...old, state: "superseded", superseded_by: next.memory_id, updated_at: stamp });
      this.bumpSetVersion(merchantId, old.subject_id, stamp);
      this.appendEvent(next, "memory_corrected", { superseded: old.memory_id }, stamp);
      return next;
    });
  }

  /**
   * 删除：先登记 DeletionJob/封存 scope/撤权（source governance），再清理
   * 记忆与历史索引；备份面保持 pending（backup_pending）。
   */
  requestDeletion(input: {
    merchant_id: string;
    actor: ActorContext;
    erase_scope_id: string;
    requested_by: string;
    reason: string;
  }): DeletionJobRecord | undefined {
    const merchantId = text(input.merchant_id, "merchant_id");
    requireActor(input.actor, merchantId, ["customer:self", "memory:write"]);
    const scopeId = text(input.erase_scope_id, "erase_scope_id");
    const stamp = nowUtc(this.now);
    return inImmediateTransaction(this.db, () => {
      const subjects = this.db
        .prepare(
          `SELECT DISTINCT subject_id FROM customer_memories
            WHERE merchant_id = ? AND erase_scope_id = ? AND state <> 'deleted'`,
        )
        .all(merchantId, scopeId) as unknown as Array<{ subject_id: string }>;
      const job = this.sourceGovernance?.requestDeletion({
        merchant_id: merchantId,
        erase_scope_id: scopeId,
        requested_by: text(input.requested_by, "requested_by"),
        reason: text(input.reason, "reason", 500),
      });
      this.db
        .prepare(
          `DELETE FROM customer_memory_evidence
            WHERE merchant_id = ? AND memory_id IN (
              SELECT memory_id FROM customer_memories WHERE merchant_id = ? AND erase_scope_id = ?)`,
        )
        .run(merchantId, merchantId, scopeId);
      this.db
        .prepare(
          `UPDATE customer_memories
              SET state = 'deleted', key = '', value_ref = '', source_refs_json = '[]',
                  confidence = NULL, confirmed_by = NULL, updated_at = ?
            WHERE merchant_id = ? AND erase_scope_id = ? AND
              (state <> 'deleted' OR key <> '' OR value_ref <> '' OR source_refs_json <> '[]'
                OR confidence IS NOT NULL OR confirmed_by IS NOT NULL)`,
        )
        .run(stamp, merchantId, scopeId);
      this.db
        .prepare(
          `DELETE FROM history_fts WHERE merchant_id = ? AND document_id IN (
            SELECT document_id FROM history_index WHERE merchant_id = ? AND erase_scope_id = ?)`,
        )
        .run(merchantId, merchantId, scopeId);
      this.db
        .prepare("DELETE FROM history_index WHERE merchant_id = ? AND erase_scope_id = ?")
        .run(merchantId, scopeId);
      for (const subject of subjects) {
        this.bumpSetVersion(merchantId, subject.subject_id, stamp);
      }
      // 此处只清理记忆与历史索引；跨模块存储面由对应清理方回执。
      return job;
    });
  }

  /** 到期/超过 purge_at 的记忆失效；历史索引超期删除。 */
  expireDue(): { memories: number; history: number } {
    const stamp = nowUtc(this.now);
    return inImmediateTransaction(this.db, () => {
      const subjects = this.db
        .prepare(
          `SELECT DISTINCT merchant_id, subject_id FROM customer_memories
            WHERE state IN ('active','candidate','needs_review')
              AND (expires_at <= ? OR purge_at <= ?)`,
        )
        .all(stamp, stamp) as unknown as Array<{ merchant_id: string; subject_id: string }>;
      const memories = this.db
        .prepare(
          `UPDATE customer_memories SET state = 'expired', updated_at = ?
            WHERE state IN ('active','candidate','needs_review')
              AND (expires_at <= ? OR purge_at <= ?)`,
        )
        .run(stamp, stamp, stamp);
      this.db
        .prepare(
          `DELETE FROM customer_memory_evidence
            WHERE EXISTS (SELECT 1 FROM customer_memories AS memory
               WHERE memory.merchant_id = customer_memory_evidence.merchant_id
                 AND memory.memory_id = customer_memory_evidence.memory_id
                 AND memory.purge_at <= ?)`,
        )
        .run(stamp);
      this.db
        .prepare(
          `UPDATE customer_memories
              SET key = '', value_ref = '', source_refs_json = '[]',
                  confidence = NULL, confirmed_by = NULL, updated_at = ?
            WHERE purge_at <= ? AND (key <> '' OR value_ref <> '' OR source_refs_json <> '[]'
              OR confidence IS NOT NULL OR confirmed_by IS NOT NULL)`,
        )
        .run(stamp, stamp);
      for (const subject of subjects) {
        this.bumpSetVersion(subject.merchant_id, subject.subject_id, stamp);
      }
      const expiredDocs = this.db
        .prepare("SELECT document_id FROM history_index WHERE purge_at <= ?")
        .all(stamp) as unknown as Array<{ document_id: string }>;
      const deleteFts = this.db.prepare("DELETE FROM history_fts WHERE document_id = ?");
      for (const doc of expiredDocs) deleteFts.run(doc.document_id);
      const history = this.db
        .prepare("DELETE FROM history_index WHERE purge_at <= ?")
        .run(stamp);
      return { memories: Number(memories.changes), history: Number(history.changes) };
    });
  }

  getMemory(merchantId: string, memoryId: string): CustomerMemory | undefined {
    const row = this.db
      .prepare("SELECT * FROM customer_memories WHERE merchant_id = ? AND memory_id = ?")
      .get(text(merchantId, "merchant_id"), text(memoryId, "memory_id")) as unknown as
      | MemoryRow
      | undefined;
    return row === undefined ? undefined : toMemory(row);
  }

  /** 当前主体有效记忆的最小字段（客户自助；不返回其他主体）。 */
  listMine(merchantId: string, subjectId: string): Array<{
    memory_id: string;
    namespace: MemoryNamespace;
    key: string;
    value_ref: string;
    value_type: string;
    confirmed_at: string | null;
    expires_at: string;
    version: number;
  }> {
    const stamp = nowUtc(this.now);
    return this.db
      .prepare(
        `SELECT memory_id, namespace, key, value_ref, value_type, confirmed_at, expires_at, version
           FROM customer_memories
          WHERE merchant_id = ? AND subject_id = ? AND state = 'active'
            AND expires_at > ? AND purge_at > ? ORDER BY updated_at DESC LIMIT 100`,
      )
      .all(text(merchantId, "merchant_id"), text(subjectId, "subject_id"), stamp, stamp) as never;
  }

  /** 当前主体 active 记忆（接待 recall 工具用；最小字段）。 */
  listActiveForRecall(merchantId: string, subjectId: string): CustomerMemory[] {
    const stamp = nowUtc(this.now);
    const rows = this.db
      .prepare(
        `SELECT * FROM customer_memories
          WHERE merchant_id = ? AND subject_id = ? AND state = 'active'
            AND expires_at > ? AND purge_at > ? ORDER BY updated_at DESC LIMIT 20`,
      )
      .all(text(merchantId, "merchant_id"), text(subjectId, "subject_id"), stamp, stamp) as unknown as MemoryRow[];
    return rows.map(toMemory);
  }

  private assertWithinRetention(memory: CustomerMemory, stamp: string): void {
    if (Date.parse(memory.expires_at) <= Date.parse(stamp) || memory.purge_at <= stamp) {
      throw new CustomerMemoryError("version_conflict", "memory_expired", "记忆已过留存期限");
    }
  }

  private requireMemory(merchantId: string, memoryId: string): CustomerMemory {
    const memory = this.getMemory(merchantId, memoryId);
    if (memory === undefined) {
      throw new CustomerMemoryError("not_found", "memory_not_found", "记忆不存在或不可见");
    }
    return memory;
  }

  private insertMemory(memory: CustomerMemory): void {
    this.db
      .prepare(
        `INSERT INTO customer_memories
          (memory_id, merchant_id, subject_id, resource_scope_id, namespace, key,
           value_ref, value_type, state, source_kind, source_refs_json, confidence,
           confirmed_by, confirmed_at, valid_from, expires_at, last_confirmed_at,
           policy_version, version, grant_id, grant_epoch, data_epoch, erase_scope_id,
           purge_at, superseded_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.memory_id,
        memory.merchant_id,
        memory.subject_id,
        memory.resource_scope_id,
        memory.namespace,
        memory.key,
        memory.value_ref,
        memory.value_type,
        memory.state,
        memory.source_kind,
        JSON.stringify(memory.source_refs),
        memory.confidence,
        memory.confirmed_by,
        memory.confirmed_at,
        memory.valid_from,
        memory.expires_at,
        null,
        memory.policy_version,
        memory.version,
        memory.grant_id,
        memory.grant_epoch,
        memory.data_epoch,
        memory.erase_scope_id,
        memory.purge_at,
        memory.superseded_by,
        memory.created_at,
        memory.updated_at,
      );
  }

  private updateMemory(memory: CustomerMemory): void {
    this.db
      .prepare(
        `UPDATE customer_memories
            SET state = ?, source_refs_json = ?, confidence = ?, confirmed_by = ?,
                confirmed_at = ?, expires_at = ?, last_confirmed_at = ?, version = ?,
                grant_epoch = ?, superseded_by = ?, updated_at = ?
          WHERE merchant_id = ? AND memory_id = ?`,
      )
      .run(
        memory.state,
        JSON.stringify(memory.source_refs),
        memory.confidence,
        memory.confirmed_by,
        memory.confirmed_at,
        memory.expires_at,
        memory.confirmed_at,
        memory.version,
        memory.grant_epoch,
        memory.superseded_by,
        memory.updated_at,
        memory.merchant_id,
        memory.memory_id,
      );
  }

  private insertEvidence(
    memoryId: string,
    merchantId: string,
    refs: readonly string[],
    sourceKind: string,
    stamp: string,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO customer_memory_evidence
        (merchant_id, memory_id, source_ref, source_kind, observed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const ref of refs) insert.run(merchantId, memoryId, ref, sourceKind, stamp, stamp);
  }

  private appendEvent(
    memory: CustomerMemory,
    event: string,
    detail: Record<string, unknown>,
    stamp: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO customer_memory_events
          (merchant_id, subject_id, memory_id, event, detail_json, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.merchant_id,
        memory.subject_id,
        memory.memory_id,
        event,
        JSON.stringify({ ...detail, digest: contentDigest({ memory: memory.memory_id, event }) }),
        memory.version,
        stamp,
      );
  }
}
