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
 * 持久 Task/Approval 存储（战略 v2.5 §6.2，contracts/persistent-task/1.0）。
 *
 * 唯一权威：task / pending / approval 的唯一权威在 Kiwi Buyer Core 持久存储；
 * Plugin、MCP App、Host UI 只投影状态，不保存第二套状态机。稳定标识
 * task_id / candidate_id / approval_id / agreement_id 重启后仍可解析。
 *
 * 写操作幂等：idempotency_key 唯一索引——相同 key 的重复提交返回原任务，不产生
 * 重复写入。这是薄 facade 存储；Phase 3 抽离 buyer-core 时与 BuyerTaskStore
 * 合并为同一权威 store。
 */

import { mkdirSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { McpError } from "./errors.js";

export interface TaskApprovalStoreOptions {
  /** SQLite 文件路径；`:memory:` 用于测试。目录不存在时创建（0700）。 */
  dbPath: string;
  now?: () => string;
}

export interface StoredTask {
  task_id: string;
  task_kind: string;
  status: string;
  idempotency_key: string;
  intent_id?: string;
  delegation_policy_id?: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  resumable: boolean;
  /** 完整 task 记录（持久 Task 契约的权威 JSON）。 */
  payload: string;
}

export interface StoredApproval {
  approval_id: string;
  task_id: string;
  action: string;
  status: string;
  candidate_digest?: string;
  expires_at?: string;
  decided_at?: string;
  authorization_json?: string;
}

export interface StoredAgreement {
  agreement_id: string;
  task_id: string;
  negotiation_id?: string;
  terms_digest?: string;
  created_at: string;
  expires_at?: string;
  payload: string;
}

function utcNow(): string {
  return new Date().toISOString();
}

export class TaskApprovalStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: TaskApprovalStoreOptions) {
    const clock = options.now ?? utcNow;
    this.now = () => new Date(Date.parse(clock())).toISOString();
    if (options.dbPath === ":memory:") {
      this.db = new DatabaseSync(":memory:");
    } else {
      const dir = path.dirname(options.dbPath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(options.dbPath);
      if (existsSync(options.dbPath)) chmodSync(options.dbPath, 0o600);
    }
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tasks (
        task_id            TEXT PRIMARY KEY,
        task_kind          TEXT NOT NULL,
        status             TEXT NOT NULL,
        idempotency_key    TEXT NOT NULL UNIQUE,
        intent_id          TEXT,
        delegation_policy_id TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        expires_at         TEXT,
        resumable          INTEGER NOT NULL DEFAULT 0,
        payload            TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_candidates (
        candidate_id    TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL REFERENCES mcp_tasks(task_id) ON DELETE CASCADE,
        merchant_id     TEXT NOT NULL,
        status          TEXT NOT NULL,
        provenance_json TEXT,
        failure_json    TEXT,
        expires_at      TEXT,
        retryable       INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS mcp_approvals (
        approval_id        TEXT PRIMARY KEY,
        task_id            TEXT NOT NULL REFERENCES mcp_tasks(task_id) ON DELETE CASCADE,
        action             TEXT NOT NULL,
        status             TEXT NOT NULL,
        candidate_digest   TEXT,
        expires_at         TEXT,
        decided_at         TEXT,
        authorization_json TEXT
      );
      CREATE TABLE IF NOT EXISTS mcp_agreements (
        agreement_id   TEXT PRIMARY KEY,
        task_id        TEXT NOT NULL REFERENCES mcp_tasks(task_id) ON DELETE CASCADE,
        negotiation_id TEXT,
        terms_digest   TEXT,
        created_at     TEXT NOT NULL,
        expires_at     TEXT,
        payload        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_tasks_status ON mcp_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_mcp_tasks_idem ON mcp_tasks(idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_mcp_candidates_task ON mcp_candidates(task_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_approvals_task ON mcp_approvals(task_id);
      CREATE INDEX IF NOT EXISTS idx_mcp_agreements_task ON mcp_agreements(task_id);
    `);
  }

  /** 幂等创建任务：相同 idempotency_key 返回已有任务（不抛错、不重复写入）。 */
  createTask(task: StoredTask): { task: StoredTask; created: boolean } {
    const existing = this.db
      .prepare("SELECT task_id FROM mcp_tasks WHERE idempotency_key = ?")
      .get(task.idempotency_key) as { task_id: string } | undefined;
    if (existing !== undefined) {
      const row = this.getTask(existing.task_id);
      if (row !== undefined) return { task: row, created: false };
      return { task, created: false };
    }
    this.db
      .prepare(
        `INSERT INTO mcp_tasks
           (task_id, task_kind, status, idempotency_key, intent_id, delegation_policy_id,
            created_at, updated_at, expires_at, resumable, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.task_id,
        task.task_kind,
        task.status,
        task.idempotency_key,
        task.intent_id ?? null,
        task.delegation_policy_id ?? null,
        task.created_at,
        task.updated_at,
        task.expires_at ?? null,
        task.resumable ? 1 : 0,
        task.payload,
      );
    return { task, created: true };
  }

  getTask(taskId: string): StoredTask | undefined {
    const row = this.db
      .prepare(
        "SELECT task_id, task_kind, status, idempotency_key, intent_id, delegation_policy_id, created_at, updated_at, expires_at, resumable, payload FROM mcp_tasks WHERE task_id = ?",
      )
      .get(taskId) as
      | {
          task_id: string;
          task_kind: string;
          status: string;
          idempotency_key: string;
          intent_id: string | null;
          delegation_policy_id: string | null;
          created_at: string;
          updated_at: string;
          expires_at: string | null;
          resumable: number;
          payload: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      task_id: row.task_id,
      task_kind: row.task_kind,
      status: row.status,
      idempotency_key: row.idempotency_key,
      intent_id: row.intent_id ?? undefined,
      delegation_policy_id: row.delegation_policy_id ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at ?? undefined,
      resumable: row.resumable === 1,
      payload: row.payload,
    };
  }

  /** 按 task_id 更新任务（乐观并发：payload 整体覆盖）。 */
  updateTask(taskId: string, patch: Partial<StoredTask>): StoredTask {
    const current = this.getTask(taskId);
    if (current === undefined) {
      throw new McpError("task_not_found", `task ${taskId} not found`);
    }
    const next = { ...current, ...patch, task_id: taskId, updated_at: this.now() };
    this.db
      .prepare(
        "UPDATE mcp_tasks SET status = ?, updated_at = ?, expires_at = ?, resumable = ?, payload = ? WHERE task_id = ?",
      )
      .run(
        next.status,
        next.updated_at,
        next.expires_at ?? null,
        next.resumable ? 1 : 0,
        next.payload,
        taskId,
      );
    return next;
  }

  addCandidate(
    taskId: string,
    candidate: {
      candidate_id: string;
      merchant_id: string;
      status: string;
      provenance?: Record<string, unknown>;
      failure?: Record<string, unknown>;
      expires_at?: string;
      retryable: boolean;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO mcp_candidates
           (candidate_id, task_id, merchant_id, status, provenance_json, failure_json, expires_at, retryable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.candidate_id,
        taskId,
        candidate.merchant_id,
        candidate.status,
        candidate.provenance !== undefined ? JSON.stringify(candidate.provenance) : null,
        candidate.failure !== undefined ? JSON.stringify(candidate.failure) : null,
        candidate.expires_at ?? null,
        candidate.retryable ? 1 : 0,
      );
  }

  listCandidates(taskId: string): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        "SELECT candidate_id, merchant_id, status, provenance_json, failure_json, expires_at, retryable FROM mcp_candidates WHERE task_id = ?",
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      candidate_id: r.candidate_id,
      merchant_id: r.merchant_id,
      status: r.status,
      ...(r.provenance_json !== null ? { provenance: this.parse(r.provenance_json as string) } : {}),
      ...(r.failure_json !== null ? { failure: this.parse(r.failure_json as string) } : {}),
      ...(r.expires_at !== null ? { expires_at: r.expires_at } : {}),
      retryable: r.retryable === 1,
    }));
  }

  setApproval(taskId: string, approval: StoredApproval): void {
    this.db
      .prepare(
        `INSERT INTO mcp_approvals
           (approval_id, task_id, action, status, candidate_digest, expires_at, decided_at, authorization_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(approval_id) DO UPDATE SET
           status = excluded.status,
           decided_at = excluded.decided_at,
           authorization_json = excluded.authorization_json`,
      )
      .run(
        approval.approval_id,
        taskId,
        approval.action,
        approval.status,
        approval.candidate_digest ?? null,
        approval.expires_at ?? null,
        approval.decided_at ?? null,
        approval.authorization_json ?? null,
      );
  }

  getApproval(approvalId: string): StoredApproval | undefined {
    const row = this.db
      .prepare(
        "SELECT approval_id, task_id, action, status, candidate_digest, expires_at, decided_at, authorization_json FROM mcp_approvals WHERE approval_id = ?",
      )
      .get(approvalId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      approval_id: row.approval_id as string,
      task_id: row.task_id as string,
      action: row.action as string,
      status: row.status as string,
      candidate_digest: row.candidate_digest as string | undefined,
      expires_at: row.expires_at as string | undefined,
      decided_at: row.decided_at as string | undefined,
      authorization_json: row.authorization_json as string | undefined,
    };
  }

  listApprovalsByTask(taskId: string): StoredApproval[] {
    const rows = this.db
      .prepare(
        "SELECT approval_id, task_id, action, status, candidate_digest, expires_at, decided_at, authorization_json FROM mcp_approvals WHERE task_id = ?",
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      approval_id: row.approval_id as string,
      task_id: row.task_id as string,
      action: row.action as string,
      status: row.status as string,
      candidate_digest: row.candidate_digest as string | undefined,
      expires_at: row.expires_at as string | undefined,
      decided_at: row.decided_at as string | undefined,
      authorization_json: row.authorization_json as string | undefined,
    }));
  }

  createAgreement(agreement: StoredAgreement): void {
    this.db
      .prepare(
        `INSERT INTO mcp_agreements
           (agreement_id, task_id, negotiation_id, terms_digest, created_at, expires_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agreement.agreement_id,
        agreement.task_id,
        agreement.negotiation_id ?? null,
        agreement.terms_digest ?? null,
        agreement.created_at,
        agreement.expires_at ?? null,
        agreement.payload,
      );
  }

  getAgreement(agreementId: string): StoredAgreement | undefined {
    const row = this.db
      .prepare(
        "SELECT agreement_id, task_id, negotiation_id, terms_digest, created_at, expires_at, payload FROM mcp_agreements WHERE agreement_id = ?",
      )
      .get(agreementId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      agreement_id: row.agreement_id as string,
      task_id: row.task_id as string,
      negotiation_id: row.negotiation_id as string | undefined,
      terms_digest: row.terms_digest as string | undefined,
      created_at: row.created_at as string,
      expires_at: row.expires_at as string | undefined,
      payload: row.payload as string,
    };
  }

  close(): void {
    this.db.close();
  }

  private parse<T>(json: string): T {
    try {
      return JSON.parse(json) as T;
    } catch {
      throw new McpError("store_corrupted", "stored JSON is not parseable");
    }
  }
}
