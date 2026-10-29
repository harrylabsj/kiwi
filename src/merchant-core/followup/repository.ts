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
 * 跟进任务持久化（v0.2 §8 / §18）。
 *
 * 租约领取用条件 UPDATE（status=READY + 租约已过期）原子占位；fencing token
 * 每次领取递增。RUNNING 状态的提交必须带当前 token；过期执行者即使重放
 * 也会因 token/状态不匹配被拒绝。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { contentDigest } from "../../negotiation/jcs.js";
import { FollowUpError, type FollowUpStatus } from "./types.js";

export interface FollowUpTask {
  task_id: string;
  merchant_id: string;
  opportunity_id: string | null;
  trigger_event: string;
  action_type: string;
  target_version: string | null;
  status: FollowUpStatus;
  due_at: string | null;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  external_call_started: boolean;
  stop_requested: boolean;
  payload: Record<string, unknown>;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  task_id: string;
  merchant_id: string;
  opportunity_id: string | null;
  trigger_event: string;
  action_type: string;
  target_version: string | null;
  status: FollowUpStatus;
  due_at: string | null;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  external_call_started: number;
  stop_requested: number;
  payload_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): FollowUpTask {
  return {
    task_id: row.task_id,
    merchant_id: row.merchant_id,
    opportunity_id: row.opportunity_id,
    trigger_event: row.trigger_event,
    action_type: row.action_type,
    target_version: row.target_version,
    status: row.status,
    due_at: row.due_at,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at,
    fencing_token: row.fencing_token,
    external_call_started: row.external_call_started === 1,
    stop_requested: row.stop_requested === 1,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface FollowUpRepositoryOptions {
  db: DatabaseSync;
  now: () => string;
}

export class FollowUpRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private inTx = false;

  constructor(options: FollowUpRepositoryOptions) {
    this.db = options.db;
    this.now = options.now;
  }

  transaction<T>(work: () => T): T {
    if (this.inTx) return work();
    this.inTx = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  createTask(input: {
    merchantId: string;
    opportunityId?: string;
    triggerEvent: string;
    actionType: string;
    targetVersion?: string;
    dueAt?: string;
    maxAttempts: number;
    idempotencyKey?: string;
    payload: Record<string, unknown>;
  }): { task: FollowUpTask; reused: boolean } {
    if (input.idempotencyKey !== undefined) {
      const existing = this.findByKey(input.merchantId, input.idempotencyKey);
      if (existing !== undefined) {
        const expectedDigest = contentDigest({
          trigger_event: input.triggerEvent,
          action_type: input.actionType,
          target_version: input.targetVersion ?? null,
          payload: input.payload,
        });
        const storedDigest = contentDigest({
          trigger_event: existing.trigger_event,
          action_type: existing.action_type,
          target_version: existing.target_version,
          payload: existing.payload,
        });
        if (expectedDigest !== storedDigest) {
          throw new FollowUpError("validation", "同一幂等键已用于不同任务内容");
        }
        return { task: existing, reused: true };
      }
    }
    const taskId = `fu_${randomUUID()}`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO followup_tasks
          (task_id, merchant_id, opportunity_id, trigger_event, action_type, target_version,
           status, due_at, attempts, max_attempts, fencing_token, external_call_started,
           stop_requested, idempotency_key, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, 0, ?, 0, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        input.merchantId,
        input.opportunityId ?? null,
        input.triggerEvent,
        input.actionType,
        input.targetVersion ?? null,
        input.dueAt ?? null,
        input.maxAttempts,
        input.idempotencyKey ?? null,
        JSON.stringify(input.payload),
        now,
        now,
      );
    return { task: this.getTask(input.merchantId, taskId)!, reused: false };
  }

  findByKey(merchantId: string, key: string): FollowUpTask | undefined {
    const row = this.db
      .prepare("SELECT * FROM followup_tasks WHERE merchant_id = ? AND idempotency_key = ?")
      .get(merchantId, key) as unknown as TaskRow | undefined;
    return row === undefined ? undefined : rowToTask(row);
  }

  getTask(merchantId: string, taskId: string): FollowUpTask | undefined {
    const row = this.db
      .prepare("SELECT * FROM followup_tasks WHERE merchant_id = ? AND task_id = ?")
      .get(merchantId, taskId) as unknown as TaskRow | undefined;
    return row === undefined ? undefined : rowToTask(row);
  }

  listTasks(merchantId: string, filter: { status?: FollowUpStatus; opportunityId?: string } = {}): FollowUpTask[] {
    const where = ["merchant_id = ?"];
    const params: string[] = [merchantId];
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.opportunityId !== undefined) {
      where.push("opportunity_id = ?");
      params.push(filter.opportunityId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM followup_tasks WHERE ${where.join(" AND ")} ORDER BY created_at DESC`)
      .all(...params) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  listDue(merchantId: string, at: string, limit = 50): FollowUpTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM followup_tasks
          WHERE merchant_id = ? AND status = 'PENDING'
            AND due_at IS NOT NULL AND due_at <= ?
          ORDER BY due_at ASC LIMIT ?`,
      )
      .all(merchantId, at, limit) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  /** READY → RUNNING；租约原子占位，fencing token +1，attempts +1。 */
  claim(input: {
    merchantId: string;
    taskId: string;
    workerId: string;
    leaseMs: number;
    now: string;
  }): FollowUpTask | undefined {
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      throw new FollowUpError("validation", "leaseMs 必须是正整数");
    }
    const expires = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE followup_tasks
            SET status = 'RUNNING', lease_owner = ?, lease_expires_at = ?,
                fencing_token = fencing_token + 1, attempts = attempts + 1, updated_at = ?
          WHERE merchant_id = ? AND task_id = ? AND status = 'READY'
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(
        input.workerId,
        expires,
        input.now,
        input.merchantId,
        input.taskId,
        input.now,
      );
    return Number(result.changes) === 1 ? this.getTask(input.merchantId, input.taskId) : undefined;
  }

  markExternalStarted(merchantId: string, taskId: string, fencingToken: number): void {
    const result = this.db
      .prepare(
        `UPDATE followup_tasks
            SET external_call_started = 1, updated_at = ?
          WHERE merchant_id = ? AND task_id = ? AND status = 'RUNNING' AND fencing_token = ?`,
      )
      .run(this.now(), merchantId, taskId, fencingToken);
    if (Number(result.changes) !== 1) {
      throw new FollowUpError("invalid_transition", "旧 fencing token 不能标记外部调用");
    }
  }

  /** 状态迁移 CAS；FROM RUNNING 时必须提供当前 fencing token。 */
  applyTransition(input: {
    merchantId: string;
    taskId: string;
    from: FollowUpStatus;
    to: FollowUpStatus;
    fencingToken?: number;
    lastError?: string | null;
    stopRequested?: boolean;
  }): FollowUpTask {
    const conditions = ["merchant_id = ?", "task_id = ?", "status = ?"];
    const params: Array<string | number> = [input.merchantId, input.taskId, input.from];
    if (input.from === "RUNNING") {
      if (input.fencingToken === undefined) {
        throw new FollowUpError("validation", "RUNNING 状态迁移必须提供 fencing token");
      }
      conditions.push("fencing_token = ?");
      params.push(input.fencingToken);
    }
    const sets = [
      "status = ?",
      "updated_at = ?",
      "lease_owner = NULL",
      "lease_expires_at = NULL",
    ];
    const setParams: Array<string | number | null> = [input.to, this.now()];
    if (input.lastError !== undefined) {
      sets.push("last_error = ?");
      setParams.push(input.lastError);
    }
    if (input.stopRequested !== undefined) {
      sets.push("stop_requested = ?");
      setParams.push(input.stopRequested ? 1 : 0);
    }
    const result = this.db
      .prepare(
        `UPDATE followup_tasks SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`,
      )
      .run(...setParams, ...params);
    if (Number(result.changes) !== 1) {
      throw new FollowUpError("invalid_transition", "任务状态或 fencing token 已变化");
    }
    return this.getTask(input.merchantId, input.taskId)!;
  }

  /** 完成一次已领取的尝试（不新增 attempt_no，避免同一尝试重复计数）。 */
  finishAttempt(input: {
    merchantId: string;
    taskId: string;
    attemptNo: number;
    status: string;
    endedAt: string;
    externalRequestId?: string;
    receipt?: Record<string, unknown>;
    errorCode?: string;
  }): void {
    const result = this.db
      .prepare(
        `UPDATE followup_attempts
            SET status = ?, ended_at = ?, external_request_id = ?, receipt_json = ?, error_code = ?
          WHERE merchant_id = ? AND task_id = ? AND attempt_no = ?`,
      )
      .run(
        input.status,
        input.endedAt,
        input.externalRequestId ?? null,
        input.receipt !== undefined ? JSON.stringify(input.receipt) : null,
        input.errorCode ?? null,
        input.merchantId,
        input.taskId,
        input.attemptNo,
      );
    if (Number(result.changes) !== 1) {
      throw new FollowUpError("invalid_transition", "attempt 记录不存在");
    }
  }

  recordAttempt(input: {
    merchantId: string;
    taskId: string;
    attemptNo: number;
    status: string;
    startedAt: string;
    endedAt?: string;
    externalRequestId?: string;
    receipt?: Record<string, unknown>;
    errorCode?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO followup_attempts
          (attempt_id, task_id, merchant_id, attempt_no, status, started_at, ended_at,
           external_request_id, receipt_json, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `att_${randomUUID()}`,
        input.taskId,
        input.merchantId,
        input.attemptNo,
        input.status,
        input.startedAt,
        input.endedAt ?? null,
        input.externalRequestId ?? null,
        input.receipt !== undefined ? JSON.stringify(input.receipt) : null,
        input.errorCode ?? null,
      );
  }

  enqueueOutbox(input: {
    merchantId: string;
    taskId: string;
    attemptId?: string;
    payload: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO followup_outbox
          (outbox_id, task_id, merchant_id, attempt_id, payload_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(
        `out_${randomUUID()}`,
        input.taskId,
        input.merchantId,
        input.attemptId ?? null,
        JSON.stringify(input.payload),
        this.now(),
        this.now(),
      );
  }

  markOutbox(input: {
    merchantId: string;
    outboxId: string;
    status: "SENT" | "UNKNOWN";
    providerRequestId?: string;
    receipt?: Record<string, unknown>;
  }): void {
    const result = this.db
      .prepare(
        `UPDATE followup_outbox
            SET status = ?, provider_request_id = ?, receipt_json = ?, updated_at = ?
          WHERE merchant_id = ? AND outbox_id = ? AND status = 'PENDING'`,
      )
      .run(
        input.status,
        input.providerRequestId ?? null,
        input.receipt !== undefined ? JSON.stringify(input.receipt) : null,
        this.now(),
        input.merchantId,
        input.outboxId,
      );
    if (Number(result.changes) !== 1) {
      throw new FollowUpError("invalid_transition", "outbox 记录不存在或已处理");
    }
  }

  /**
   * 恢复过期租约：只有持久记录证明未进入外部调用才回 READY；否则 UNKNOWN。
   * 旧执行者之后任何提交都会因 fencing token/状态不匹配失败。
   */
  recoverExpiredLeases(merchantId: string, at: string): FollowUpTask[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM followup_tasks
          WHERE merchant_id = ? AND status = 'RUNNING'
            AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .all(merchantId, at) as unknown as TaskRow[];
    const recovered: FollowUpTask[] = [];
    for (const row of rows) {
      const task = rowToTask(row);
      const to = task.external_call_started ? "UNKNOWN" : "READY";
      recovered.push(
        this.applyTransition({
          merchantId,
          taskId: task.task_id,
          from: "RUNNING",
          to,
          fencingToken: task.fencing_token,
        }),
      );
    }
    return recovered;
  }

  readIdempotent(merchantId: string, key: string): { operation: string; requestDigest: string; result: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT operation, request_digest, result_json FROM merchant_command_idempotency WHERE merchant_id = ? AND idempotency_key = ?",
      )
      .get(merchantId, key) as { operation: string; request_digest: string; result_json: string } | undefined;
    return row === undefined
      ? undefined
      : { operation: row.operation, requestDigest: row.request_digest, result: row.result_json };
  }

  saveIdempotent(input: {
    merchantId: string;
    key: string;
    operation: string;
    request: unknown;
    result: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO merchant_command_idempotency
          (merchant_id, idempotency_key, operation, request_digest, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.merchantId,
        input.key,
        input.operation,
        contentDigest({ operation: input.operation, request: input.request }),
        JSON.stringify(input.result),
        this.now(),
      );
  }
}
