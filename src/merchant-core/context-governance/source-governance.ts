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
 * 来源治理与可恢复删除（TOP1-3 设计 v1.1 §4.2 / §12.2 / §18.1 / §22.1 M1）。
 *
 * 本文件是 M1 共性控制中的「来源删除」基础：
 * - `SourceGovernanceService.registerSourceRef` 登记来源对象版本（正文在受控
 *   payload，`payload_ref` 只存不透明引用）；版本不可变；
 * - `requestDeletion` 先登记 DeletionJob、封存 erase_scope、递增 data_epoch
 *   并撤销相关 grant，再把来源引用标为 erased、封存派生边；具体载荷清理由
 *   各存储面异步完成并逐面记录 purged / pending / failed（失败可幂等重试）；
 * - `isAvailable` / `currentDataScopeEpoch` 供 ContextGuard 的
 *   ContextVersionAuthority 接入（见 `authority.ts` 的注入点）；
 * - 查询一律带 merchant 作用域，不提供跨商家读取。
 *
 * 明确边界：
 * - 本模块只做「立即失效」（封存/标记）与状态登记，不实现记忆、技能候选、
 *   草稿等业务对象的清理——那是 M3 的删除传播；M1 保证旧快照/旧游标在删除
 *   后立刻不可用，且删除任务可恢复（幂等重试）。
 * - 不递归推断客户身份，不复活已 erased 的来源版本。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { inImmediateTransaction } from "../storage/transaction.js";
import { ContextGovernanceError, assertOpaqueId } from "./types.js";
import type { SourceRefCheck } from "./context-guard.js";

/** 每个删除任务必须逐面登记的存储面（§12.2）。 */
export const DELETION_SURFACES = [
  "source_payloads",
  "derived_objects",
  "caches",
  "in_flight_runs",
  "pending_outbound",
  "exports",
  "backups",
] as const;
export type DeletionSurface = (typeof DELETION_SURFACES)[number];

export const DELETION_JOB_STATES = ["PENDING", "PROCESSING", "COMPLETED"] as const;
export type DeletionJobState = (typeof DELETION_JOB_STATES)[number];

export const DELETION_SURFACE_STATUSES = ["PENDING", "PURGED", "FAILED"] as const;
export type DeletionSurfaceStatus = (typeof DELETION_SURFACE_STATUSES)[number];

/** 默认可恢复/重试窗口（天）：支持在窗口内幂等重试与运维核对。 */
export const DEFAULT_DELETION_RECOVERABLE_DAYS = 7;

export interface DataScopeRecord {
  readonly merchant_id: string;
  readonly erase_scope_id: string;
  readonly data_epoch: number;
  readonly state: "ACTIVE" | "SEALED";
  readonly sealed_at: string | null;
  readonly updated_at: string;
}

export interface SourceRefRecord {
  readonly merchant_id: string;
  readonly object_id: string;
  readonly version: number;
  readonly payload_ref: string;
  readonly erase_scope_id: string;
  readonly observed_at: string;
  readonly expires_at: string | null;
  readonly erased_at: string | null;
  readonly updated_at: string;
}

export interface DeletionSurfaceRecord {
  readonly surface: DeletionSurface;
  readonly status: DeletionSurfaceStatus;
  readonly attempts: number;
  readonly receipt_ref: string | null;
  readonly last_error: string | null;
  readonly updated_at: string;
}

export interface DeletionJobRecord {
  readonly deletion_job_id: string;
  readonly merchant_id: string;
  readonly erase_scope_id: string;
  readonly requested_by: string;
  readonly reason: string;
  readonly state: DeletionJobState;
  readonly data_epoch: number;
  readonly recoverable_until: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly surfaces: readonly DeletionSurfaceRecord[];
}

interface ScopeRow {
  merchant_id: string;
  erase_scope_id: string;
  data_epoch: number;
  state: "ACTIVE" | "SEALED";
  sealed_at: string | null;
  updated_at: string;
}

interface SourceRow {
  merchant_id: string;
  object_id: string;
  version: number;
  payload_ref: string;
  erase_scope_id: string;
  observed_at: string;
  expires_at: string | null;
  erased_at: string | null;
  updated_at: string;
}

interface JobRow {
  deletion_job_id: string;
  merchant_id: string;
  erase_scope_id: string;
  requested_by: string;
  reason: string;
  state: DeletionJobState;
  data_epoch: number;
  recoverable_until: string;
  created_at: string;
  updated_at: string;
}

interface SurfaceRow {
  deletion_job_id: string;
  surface: DeletionSurface;
  status: DeletionSurfaceStatus;
  attempts: number;
  receipt_ref: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface SourceGovernanceOptions {
  db: DatabaseSync;
  now: () => string;
}

function scopeToRecord(row: ScopeRow): DataScopeRecord {
  return {
    merchant_id: row.merchant_id,
    erase_scope_id: row.erase_scope_id,
    data_epoch: row.data_epoch,
    state: row.state,
    sealed_at: row.sealed_at,
    updated_at: row.updated_at,
  };
}

function sourceToRecord(row: SourceRow): SourceRefRecord {
  return {
    merchant_id: row.merchant_id,
    object_id: row.object_id,
    version: row.version,
    payload_ref: row.payload_ref,
    erase_scope_id: row.erase_scope_id,
    observed_at: row.observed_at,
    expires_at: row.expires_at,
    erased_at: row.erased_at,
    updated_at: row.updated_at,
  };
}

function surfaceToRecord(row: SurfaceRow): DeletionSurfaceRecord {
  return {
    surface: row.surface,
    status: row.status,
    attempts: row.attempts,
    receipt_ref: row.receipt_ref,
    last_error: row.last_error,
    updated_at: row.updated_at,
  };
}

function jobToRecord(row: JobRow, surfaces: SurfaceRow[]): DeletionJobRecord {
  return {
    deletion_job_id: row.deletion_job_id,
    merchant_id: row.merchant_id,
    erase_scope_id: row.erase_scope_id,
    requested_by: row.requested_by,
    reason: row.reason,
    state: row.state,
    data_epoch: row.data_epoch,
    recoverable_until: row.recoverable_until,
    created_at: row.created_at,
    updated_at: row.updated_at,
    surfaces: surfaces.map(surfaceToRecord),
  };
}

/** 时间列统一 UTC RFC3339（Z 结尾）；存储前规范化为 toISOString 定宽形式。 */
function normalizeUtc(value: string, field: string): string {
  if (!value.endsWith("Z")) {
    throw new ContextGovernanceError(
      "validation",
      `${field}_not_utc`,
      `${field} 必须是 UTC RFC3339（Z 结尾），收到 ${value}`,
    );
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new ContextGovernanceError("validation", `${field}_invalid`, `${field} 必须是 RFC3339 时间`);
  }
  return new Date(ms).toISOString();
}

function requirePositiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContextGovernanceError("validation", `${field}_invalid`, `${field} 必须是正整数`);
  }
  return value;
}

function requireSurface(value: string): DeletionSurface {
  if (!(DELETION_SURFACES as readonly string[]).includes(value)) {
    throw new ContextGovernanceError(
      "validation",
      "surface_unknown",
      `surface "${value}" 不在固定存储面注册表中`,
    );
  }
  return value as DeletionSurface;
}

/** 删除原因/操作者是运维字段：非空、有界、无控制字符（可含中文）。 */
function requireFreeText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContextGovernanceError("validation", `${field}_empty`, `${field} 必须是非空字符串`);
  }
  if (value.length > maxLength) {
    throw new ContextGovernanceError("validation", `${field}_too_long`, `${field} 长度超过 ${maxLength}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ContextGovernanceError("validation", `${field}_invalid`, `${field} 含控制字符`);
  }
  return value;
}

export class SourceGovernanceService {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: SourceGovernanceOptions) {
    this.db = options.db;
    this.now = options.now;
  }

  /** 服务器时钟统一为定宽 UTC；不可解析即 fail-closed。 */
  private nowUtc(): string {
    const ms = Date.parse(this.now());
    if (!Number.isFinite(ms)) {
      throw new ContextGovernanceError("validation", "now_invalid", "时钟输出必须是可解析的 RFC3339 时间");
    }
    return new Date(ms).toISOString();
  }

  /** 当前数据域 epoch：仅 ACTIVE 返回（封存/不存在 = 旧快照失效）。 */
  currentDataScopeEpoch(merchantId: string, eraseScopeId: string): number | undefined {
    const row = this.readScope(merchantId, eraseScopeId);
    return row !== undefined && row.state === "ACTIVE" ? row.data_epoch : undefined;
  }

  getDataScope(merchantId: string, eraseScopeId: string): DataScopeRecord | undefined {
    const row = this.readScope(merchantId, eraseScopeId);
    return row === undefined ? undefined : scopeToRecord(row);
  }

  /**
   * 登记来源对象版本。版本不可变：同 (object_id, version) 内容一致幂等；
   * 内容不一致 version_conflict；已 erased 的版本不得复活（source_unavailable）。
   * 首次登记会为 erase_scope 建立 ACTIVE data_scope（epoch 1）。
   */
  registerSourceRef(input: {
    merchant_id: string;
    object_id: string;
    version: number;
    payload_ref: string;
    erase_scope_id: string;
    observed_at: string;
    expires_at?: string;
  }): SourceRefRecord {
    const merchantId = assertOpaqueId(input.merchant_id, "merchant_id");
    const objectId = assertOpaqueId(input.object_id, "object_id");
    const version = requirePositiveInt(input.version, "version");
    const payloadRef = assertOpaqueId(input.payload_ref, "payload_ref");
    const eraseScopeId = assertOpaqueId(input.erase_scope_id, "erase_scope_id");
    const observedAt = normalizeUtc(input.observed_at, "observed_at");
    const expiresAt =
      input.expires_at === undefined ? null : normalizeUtc(input.expires_at, "expires_at");
    return inImmediateTransaction(this.db, () => {
      const scope = this.readScope(merchantId, eraseScopeId);
      if (scope === undefined) {
        this.db
          .prepare(
            `INSERT INTO data_scopes
              (merchant_id, erase_scope_id, data_epoch, state, sealed_at, updated_at)
             VALUES (?, ?, 1, 'ACTIVE', NULL, ?)`,
          )
          .run(merchantId, eraseScopeId, this.nowUtc());
      } else if (scope.state === "SEALED") {
        throw new ContextGovernanceError(
          "source_unavailable",
          "erase_scope_sealed",
          `erase_scope ${eraseScopeId} 已封存（删除已登记）；不得再登记来源`,
        );
      }
      const existing = this.readSourceRow(merchantId, objectId, version);
      if (existing !== undefined) {
        if (existing.erased_at !== null) {
          throw new ContextGovernanceError(
            "source_unavailable",
            "source_ref_erased",
            "来源版本已删除，不能复活；请登记新版本",
          );
        }
        if (
          existing.payload_ref !== payloadRef ||
          existing.erase_scope_id !== eraseScopeId ||
          existing.observed_at !== observedAt ||
          existing.expires_at !== expiresAt
        ) {
          throw new ContextGovernanceError(
            "version_conflict",
            "source_ref_immutable",
            `来源 ${objectId}@${version} 内容不一致；版本不可变`,
          );
        }
        return sourceToRecord(existing);
      }
      const stamp = this.nowUtc();
      this.db
        .prepare(
          `INSERT INTO source_refs
            (merchant_id, object_id, version, payload_ref, erase_scope_id,
             observed_at, expires_at, erased_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(merchantId, objectId, version, payloadRef, eraseScopeId, observedAt, expiresAt, stamp);
      return sourceToRecord(this.readSourceRow(merchantId, objectId, version)!);
    });
  }

  getSourceRef(merchantId: string, objectId: string, version: number): SourceRefRecord | undefined {
    const row = this.readSourceRow(
      assertOpaqueId(merchantId, "merchant_id"),
      assertOpaqueId(objectId, "object_id"),
      requirePositiveInt(version, "version"),
    );
    return row === undefined ? undefined : sourceToRecord(row);
  }

  /**
   * 来源可用性（ContextGuard `sourceAvailable`）：权威值来自本库。
   * 调用方提示（erased / expires_at）只用于提前拒绝，不用于放行：
   * 存在且未 erased、未过期、版本匹配才可用。
   */
  isAvailable(merchantId: string, ref: SourceRefCheck): boolean {
    if (ref.erased === true) return false;
    const now = this.nowUtc();
    if (ref.expires_at !== undefined) {
      const expiresMs = Date.parse(ref.expires_at);
      if (!Number.isFinite(expiresMs) || expiresMs <= Date.parse(now)) return false;
    }
    if (!Number.isSafeInteger(ref.version) || ref.version < 1) return false;
    const row = this.readSourceRow(merchantId, ref.object_id, ref.version);
    if (row === undefined || row.erased_at !== null) return false;
    if (row.expires_at !== null && row.expires_at <= now) return false;
    return true;
  }

  /**
   * 记录派生边（parent 来源版本 → child 业务对象）。parent 必须已登记且未删除；
   * 边唯一（同边重复登记幂等，同边异 child_kind 为 version_conflict）。
   */
  recordDerivationEdge(input: {
    merchant_id: string;
    parent_object_id: string;
    parent_version: number;
    child_object_id: string;
    child_kind: string;
  }): void {
    const merchantId = assertOpaqueId(input.merchant_id, "merchant_id");
    const parentId = assertOpaqueId(input.parent_object_id, "parent_object_id");
    const parentVersion = requirePositiveInt(input.parent_version, "parent_version");
    const childId = assertOpaqueId(input.child_object_id, "child_object_id");
    const childKind = requireFreeText(input.child_kind, "child_kind", 64);
    inImmediateTransaction(this.db, () => {
      const parent = this.readSourceRow(merchantId, parentId, parentVersion);
      if (parent === undefined || parent.erased_at !== null) {
        throw new ContextGovernanceError(
          "source_unavailable",
          "parent_source_unavailable",
          "派生边的父来源不存在或已删除；拒绝登记迟到派生",
        );
      }
      const existing = this.db
        .prepare(
          `SELECT child_kind FROM derivation_edges
            WHERE merchant_id = ? AND parent_object_id = ? AND parent_version = ?
              AND child_object_id = ?`,
        )
        .get(merchantId, parentId, parentVersion, childId) as { child_kind: string } | undefined;
      if (existing !== undefined) {
        // 边唯一且不可变：同边异 kind 视为内容冲突，不静默覆盖。
        if (existing.child_kind !== childKind) {
          throw new ContextGovernanceError(
            "version_conflict",
            "derivation_edge_immutable",
            "派生边已存在且 child_kind 不一致；边不可变",
          );
        }
        return;
      }
      this.db
        .prepare(
          `INSERT INTO derivation_edges
            (merchant_id, parent_object_id, parent_version, child_object_id,
             child_kind, created_at, sealed_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(merchantId, parentId, parentVersion, childId, childKind, this.nowUtc());
    });
  }

  /**
   * 登记可恢复删除：先 DeletionJob → 封存 erase_scope（data_epoch+1）→
   * 撤销该 scope 的 ACTIVE grant → 标记 source_refs.erased_at → 封存派生边
   * → 建 PENDING 的各存储面。重复请求（同 scope 有开放任务）幂等返回原任务，
   * 不重复递增 epoch。
   */
  requestDeletion(input: {
    merchant_id: string;
    erase_scope_id: string;
    requested_by: string;
    reason: string;
    expected_data_epoch?: number;
    recoverable_days?: number;
  }): DeletionJobRecord {
    const merchantId = assertOpaqueId(input.merchant_id, "merchant_id");
    const eraseScopeId = assertOpaqueId(input.erase_scope_id, "erase_scope_id");
    const requestedBy = assertOpaqueId(input.requested_by, "requested_by");
    const reason = requireFreeText(input.reason, "reason", 500);
    const recoverableDays = input.recoverable_days ?? DEFAULT_DELETION_RECOVERABLE_DAYS;
    if (!Number.isSafeInteger(recoverableDays) || recoverableDays < 0 || recoverableDays > 180) {
      throw new ContextGovernanceError(
        "validation",
        "recoverable_days_invalid",
        "recoverable_days 必须是 0..180 的整数",
      );
    }
    return inImmediateTransaction(this.db, () => {
      const open = this.readOpenJob(merchantId, eraseScopeId);
      if (open !== undefined) {
        // 幂等：同一 scope 已有开放任务（PENDING/PROCESSING）直接返回。
        return this.readJob(open.deletion_job_id)!;
      }
      const scope = this.readScope(merchantId, eraseScopeId);
      if (
        input.expected_data_epoch !== undefined &&
        (scope?.data_epoch ?? 0) !== input.expected_data_epoch
      ) {
        throw new ContextGovernanceError(
          "version_conflict",
          "data_epoch_mismatch",
          `erase_scope ${eraseScopeId} 的 data_epoch 已变化；回读后重试`,
        );
      }
      const now = this.nowUtc();
      const newEpoch = scope === undefined ? 1 : scope.data_epoch + 1;
      if (scope === undefined) {
        this.db
          .prepare(
            `INSERT INTO data_scopes
              (merchant_id, erase_scope_id, data_epoch, state, sealed_at, updated_at)
             VALUES (?, ?, ?, 'SEALED', ?, ?)`,
          )
          .run(merchantId, eraseScopeId, newEpoch, now, now);
      } else {
        this.db
          .prepare(
            `UPDATE data_scopes
                SET data_epoch = ?, state = 'SEALED', sealed_at = ?, updated_at = ?
              WHERE merchant_id = ? AND erase_scope_id = ?`,
          )
          .run(newEpoch, now, now, merchantId, eraseScopeId);
      }

      // 撤销该 scope 的 ACTIVE 授权：逐条递增 grant_epoch（同 key 多行时
      // 每次取当前最大值 +1，避免唯一索引冲突），状态置 REVOKED。
      const activeGrants = this.db
        .prepare(
          `SELECT grant_id, subject_id, purpose
             FROM data_grants
            WHERE merchant_id = ? AND resource_scope_id = ? AND status = 'ACTIVE'
            ORDER BY grant_epoch ASC`,
        )
        .all(merchantId, eraseScopeId) as unknown as Array<{
        grant_id: string;
        subject_id: string;
        purpose: string;
      }>;
      for (const grant of activeGrants) {
        this.db
          .prepare(
            `UPDATE data_grants
                SET status = 'REVOKED', updated_at = ?,
                    grant_epoch = (SELECT COALESCE(MAX(grant_epoch), 0) + 1
                                     FROM data_grants
                                    WHERE merchant_id = ? AND subject_id = ? AND purpose = ?
                                      AND resource_scope_id = ?)
              WHERE merchant_id = ? AND grant_id = ? AND status = 'ACTIVE'`,
          )
          .run(
            now,
            merchantId,
            grant.subject_id,
            grant.purpose,
            eraseScopeId,
            merchantId,
            grant.grant_id,
          );
      }

      // 来源立即不可读（旧索引/旧快照失效），载荷清理交给各存储面。
      this.db
        .prepare(
          `UPDATE source_refs SET erased_at = ?, updated_at = ?
            WHERE merchant_id = ? AND erase_scope_id = ? AND erased_at IS NULL`,
        )
        .run(now, now, merchantId, eraseScopeId);

      // 封存受影响的派生边：由这些边定位的记忆/候选/草稿由 M3 清理。
      this.db
        .prepare(
          `UPDATE derivation_edges SET sealed_at = ?
            WHERE merchant_id = ? AND sealed_at IS NULL
              AND parent_object_id IN (
                SELECT object_id FROM source_refs
                 WHERE merchant_id = ? AND erase_scope_id = ?)`,
        )
        .run(now, merchantId, merchantId, eraseScopeId);

      const jobId = `dlj_${randomUUID()}`;
      const recoverableUntil = new Date(
        Date.parse(now) + recoverableDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      this.db
        .prepare(
          `INSERT INTO deletion_jobs
            (deletion_job_id, merchant_id, erase_scope_id, requested_by, reason,
             state, data_epoch, recoverable_until, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
        )
        .run(
          jobId,
          merchantId,
          eraseScopeId,
          requestedBy,
          reason,
          newEpoch,
          recoverableUntil,
          now,
          now,
        );
      const insertSurface = this.db.prepare(
        `INSERT INTO deletion_job_surfaces
          (deletion_job_id, surface, status, attempts, receipt_ref, last_error, updated_at)
         VALUES (?, ?, 'PENDING', 0, NULL, NULL, ?)`,
      );
      for (const surface of DELETION_SURFACES) {
        insertSurface.run(jobId, surface, now);
      }
      return this.readJob(jobId)!;
    });
  }

  /** 存储面清理成功（幂等）。全部 PURGED 后任务 COMPLETED。 */
  completeSurface(input: {
    merchant_id: string;
    deletion_job_id: string;
    surface: string;
    receipt_ref?: string;
  }): DeletionJobRecord {
    const merchantId = assertOpaqueId(input.merchant_id, "merchant_id");
    const jobId = assertOpaqueId(input.deletion_job_id, "deletion_job_id");
    const surface = requireSurface(input.surface);
    const receiptRef =
      input.receipt_ref === undefined ? null : assertOpaqueId(input.receipt_ref, "receipt_ref");
    return inImmediateTransaction(this.db, () => {
      const job = this.requireJob(merchantId, jobId);
      if (job.state === "COMPLETED") return this.readJob(jobId)!;
      const current = this.readSurface(jobId, surface);
      if (current === undefined) {
        throw new ContextGovernanceError("validation", "surface_missing", "删除任务缺少该存储面");
      }
      if (current.status !== "PURGED") {
        this.db
          .prepare(
            `UPDATE deletion_job_surfaces
                SET status = 'PURGED', receipt_ref = ?, last_error = NULL, updated_at = ?
              WHERE deletion_job_id = ? AND surface = ?`,
          )
          .run(receiptRef, this.nowUtc(), jobId, surface);
      }
      return this.refreshJobState(merchantId, jobId);
    });
  }

  /** 存储面清理失败：记录原因并递增 attempts；任务保持可重试。 */
  failSurface(input: {
    merchant_id: string;
    deletion_job_id: string;
    surface: string;
    reason: string;
  }): DeletionJobRecord {
    const merchantId = assertOpaqueId(input.merchant_id, "merchant_id");
    const jobId = assertOpaqueId(input.deletion_job_id, "deletion_job_id");
    const surface = requireSurface(input.surface);
    const reason = requireFreeText(input.reason, "reason", 300);
    return inImmediateTransaction(this.db, () => {
      const job = this.requireJob(merchantId, jobId);
      if (job.state === "COMPLETED") return this.readJob(jobId)!;
      this.db
        .prepare(
          `UPDATE deletion_job_surfaces
              SET status = 'FAILED', attempts = attempts + 1, last_error = ?, updated_at = ?
            WHERE deletion_job_id = ? AND surface = ?`,
        )
        .run(reason, this.nowUtc(), jobId, surface);
      return this.refreshJobState(merchantId, jobId);
    });
  }

  /** 失败存储面重新排队（幂等；PENDING/PURGED 不变）。 */
  retrySurface(input: {
    merchant_id: string;
    deletion_job_id: string;
    surface: string;
  }): DeletionJobRecord {
    const merchantId = assertOpaqueId(input.merchant_id, "merchant_id");
    const jobId = assertOpaqueId(input.deletion_job_id, "deletion_job_id");
    const surface = requireSurface(input.surface);
    return inImmediateTransaction(this.db, () => {
      const job = this.requireJob(merchantId, jobId);
      if (job.state === "COMPLETED") return this.readJob(jobId)!;
      this.db
        .prepare(
          `UPDATE deletion_job_surfaces
              SET status = 'PENDING', updated_at = ?
            WHERE deletion_job_id = ? AND surface = ? AND status = 'FAILED'`,
        )
        .run(this.nowUtc(), jobId, surface);
      return this.refreshJobState(merchantId, jobId);
    });
  }

  getDeletionJob(merchantId: string, jobId: string): DeletionJobRecord | undefined {
    return this.readJob(jobId, assertOpaqueId(merchantId, "merchant_id"));
  }

  /** 开放任务（PENDING/PROCESSING）——工作台/运维核对入口。 */
  listOpenDeletionJobs(merchantId: string): DeletionJobRecord[] {
    const merchant = assertOpaqueId(merchantId, "merchant_id");
    const rows = this.db
      .prepare(
        `SELECT * FROM deletion_jobs
          WHERE merchant_id = ? AND state IN ('PENDING','PROCESSING')
          ORDER BY created_at ASC`,
      )
      .all(merchant) as unknown as JobRow[];
    return rows.map((row) => jobToRecord(row, this.readSurfaces(row.deletion_job_id)));
  }

  private refreshJobState(merchantId: string, jobId: string): DeletionJobRecord {
    const surfaces = this.readSurfaces(jobId);
    const state: DeletionJobState = surfaces.every((surface) => surface.status === "PURGED")
      ? "COMPLETED"
      : "PROCESSING";
    this.db
      .prepare("UPDATE deletion_jobs SET state = ?, updated_at = ? WHERE deletion_job_id = ? AND merchant_id = ?")
      .run(state, this.nowUtc(), jobId, merchantId);
    return this.readJob(jobId)!;
  }

  private requireJob(merchantId: string, jobId: string): JobRow {
    const row = this.db
      .prepare("SELECT * FROM deletion_jobs WHERE merchant_id = ? AND deletion_job_id = ?")
      .get(merchantId, jobId) as unknown as JobRow | undefined;
    if (row === undefined) {
      throw new ContextGovernanceError("access_denied", "deletion_job_not_found", "删除任务不存在或不可见");
    }
    return row;
  }

  private readJob(jobId: string, merchantId?: string): DeletionJobRecord | undefined {
    const row = (
      merchantId === undefined
        ? this.db.prepare("SELECT * FROM deletion_jobs WHERE deletion_job_id = ?").get(jobId)
        : this.db
            .prepare("SELECT * FROM deletion_jobs WHERE deletion_job_id = ? AND merchant_id = ?")
            .get(jobId, merchantId)
    ) as unknown as JobRow | undefined;
    if (row === undefined) return undefined;
    return jobToRecord(row, this.readSurfaces(row.deletion_job_id));
  }

  private readOpenJob(merchantId: string, eraseScopeId: string): JobRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM deletion_jobs
          WHERE merchant_id = ? AND erase_scope_id = ? AND state IN ('PENDING','PROCESSING')
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(merchantId, eraseScopeId) as unknown as JobRow | undefined;
  }

  private readSurfaces(jobId: string): SurfaceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM deletion_job_surfaces
          WHERE deletion_job_id = ? ORDER BY surface ASC`,
      )
      .all(jobId) as unknown as SurfaceRow[];
  }

  private readSurface(jobId: string, surface: DeletionSurface): SurfaceRow | undefined {
    return this.db
      .prepare("SELECT * FROM deletion_job_surfaces WHERE deletion_job_id = ? AND surface = ?")
      .get(jobId, surface) as unknown as SurfaceRow | undefined;
  }

  private readScope(merchantId: string, eraseScopeId: string): ScopeRow | undefined {
    return this.db
      .prepare("SELECT * FROM data_scopes WHERE merchant_id = ? AND erase_scope_id = ?")
      .get(merchantId, eraseScopeId) as unknown as ScopeRow | undefined;
  }

  private readSourceRow(
    merchantId: string,
    objectId: string,
    version: number,
  ): SourceRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM source_refs WHERE merchant_id = ? AND object_id = ? AND version = ?",
      )
      .get(merchantId, objectId, version) as unknown as SourceRow | undefined;
  }
}
