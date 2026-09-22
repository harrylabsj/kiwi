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
 * 管理操作权威记录（BD 设计 §10.2 幂等顺序、§11.1 OperationReceipt、§12.1 一份权威）。
 *
 * 幂等键四元组 `(merchant_id, actor_id, command_type, idempotency_key)` 唯一
 * （§10.2 建议 scope）；同键同请求摘要 → 原回执重放（重放前仍由适配层复核当前
 * 身份，幂等缓存不得变成越权读取入口），同键不同摘要 → conflict(409)。
 *
 * `OperationReceipt.status` 用管理契约五态（accepted/running/succeeded/failed/
 * unknown）：执行层异常且**无法证明「未执行」**时记 unknown——必须保留查询/
 * 对账路径，不能当作失败自动重做（§11.1）。校验/授权类失败在触达执行前会被
 * 适配层 `release()` 回滚占位，允许修正后用原键重试。
 *
 * 落盘：state.sqlite（权威存储，§12.1）里的**独立表**——不改动既有
 * `merchant_operations`（core 长任务）与命令日志的语义与 scope。
 * 非候选写命令（service.resume）的一次性确认引用也在此持久化、单次核销。
 */

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OperationReceipt } from "../../merchant/application/service.js";

const MANAGEMENT_OPERATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_management_operations (
  merchant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  operation_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('accepted','running','succeeded','failed','unknown')),
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, actor_id, command_type, idempotency_key)
);
CREATE TABLE IF NOT EXISTS merchant_management_confirmations (
  ref TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  target TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
`;

export type BeginOutcome =
  | { kind: "replay"; receipt: OperationReceipt }
  | { kind: "conflict" }
  | { kind: "execute"; operationId: string };

export interface OperationKey {
  merchantId: string;
  actorId: string;
  commandType: string;
  idempotencyKey: string;
}

/** 规范化 JSON 摘要（键排序、剔除 undefined；同语义请求 → 同摘要）。 */
export function managementRequestDigest(parts: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(parts)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

interface OperationRow {
  merchant_id: string;
  actor_id: string;
  command_type: string;
  idempotency_key: string;
  request_digest: string;
  operation_id: string;
  status: string;
  receipt_json: string;
}

export class MerchantManagementOperationStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now?: () => string }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.db.exec("pragma busy_timeout=5000");
    this.db.exec(MANAGEMENT_OPERATION_SCHEMA);
  }

  /**
   * 只读幂等探测（不建占位）：同键同摘要 → replay；同键异摘要 → conflict；
   * 未见过 → miss（后续仍需 `begin()` 建占位）。用于「幂等必须先于终态检查」
   * 的路径（如草稿已 committed 的重放仍要回原回执，UC20）。
   */
  probe(
    input: OperationKey & { requestDigest: string },
  ): { kind: "replay"; receipt: OperationReceipt } | { kind: "conflict" } | { kind: "miss" } {
    const row = this.rowByKey(input);
    if (row === undefined) return { kind: "miss" };
    const outcome = this.outcomeFromRow(row, input.requestDigest);
    if (outcome.kind === "conflict") return { kind: "conflict" };
    return { kind: "replay", receipt: outcome.receipt };
  }

  /**
   * 幂等入口：同键同摘要 → replay（原回执）；同键异摘要 → conflict；
   * 否则新建 running 占位并返回 operationId。并发同键由 UNIQUE 约束兜底。
   */
  begin(input: OperationKey & { requestDigest: string }): BeginOutcome {
    const existing = this.rowByKey(input);
    if (existing !== undefined) {
      return this.outcomeFromRow(existing, input.requestDigest);
    }
    const operationId = `mop_${randomBytes(12).toString("hex")}`;
    const stamp = this.now();
    try {
      this.db
        .prepare(
          `INSERT INTO merchant_management_operations
           (merchant_id, actor_id, command_type, idempotency_key, request_digest, operation_id, status, receipt_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
        )
        .run(
          input.merchantId,
          input.actorId,
          input.commandType,
          input.idempotencyKey,
          input.requestDigest,
          operationId,
          JSON.stringify(this.pendingReceipt(operationId, input)),
          stamp,
          stamp,
        );
      return { kind: "execute", operationId };
    } catch (err) {
      const raced = this.rowByKey(input);
      if (raced !== undefined) return this.outcomeFromRow(raced, input.requestDigest);
      throw err;
    }
  }

  /** 落终态回执（succeeded/failed/unknown；调用方保证 operationId 属本次执行）。 */
  complete(operationId: string, status: "succeeded" | "failed" | "unknown", receipt: OperationReceipt): void {
    this.db
      .prepare(
        "UPDATE merchant_management_operations SET status = ?, receipt_json = ?, updated_at = ? WHERE operation_id = ?",
      )
      .run(status, JSON.stringify(receipt), this.now(), operationId);
  }

  /**
   * 释放未触达执行的占位（校验/授权/确认失败）：删除 running 行，允许修正后
   * 用原键重试。只删 running——终态行不可被本方法触碰。
   */
  release(operationId: string): void {
    this.db
      .prepare(
        "DELETE FROM merchant_management_operations WHERE operation_id = ? AND status = 'running'",
      )
      .run(operationId);
  }

  /** 操作回执查询（GET /operations/{id}）；merchant_id 归属不符 → undefined（上层 404）。 */
  get(operationId: string, merchantId: string): OperationReceipt | undefined {
    const row = this.db
      .prepare("SELECT * FROM merchant_management_operations WHERE operation_id = ? AND merchant_id = ?")
      .get(operationId, merchantId) as unknown as OperationRow | undefined;
    return row === undefined ? undefined : (JSON.parse(row.receipt_json) as OperationReceipt);
  }

  /**
   * 签发非候选写命令的一次性确认引用（BD §7.3：绑定主体/商家/目标/摘要/有效期，
   * 单次核销）。候选审批的确认走 core 凭证存储（执行层逐项核销），不经这里。
   */
  createConfirmation(input: {
    merchantId: string;
    actorId: string;
    target: string;
    targetDigest: string;
    ttlMs: number;
  }): { ref: string; expires_at: string } {
    const ref = `mcf_${randomBytes(18).toString("base64url")}`;
    const expiresAt = new Date(Date.parse(this.now()) + input.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO merchant_management_confirmations (ref, merchant_id, actor_id, target, target_digest, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ref, input.merchantId, input.actorId, input.target, input.targetDigest, expiresAt);
    return { ref, expires_at: expiresAt };
  }

  /** 单次核销：主体/商家/目标/摘要/有效期全部命中且未消费才返回 true（原子）。 */
  consumeConfirmation(input: {
    ref: string;
    merchantId: string;
    actorId: string;
    target: string;
    targetDigest: string;
  }): boolean {
    const stamp = this.now();
    const result = this.db
      .prepare(
        `UPDATE merchant_management_confirmations SET consumed_at = ?
         WHERE ref = ? AND merchant_id = ? AND actor_id = ? AND target = ? AND target_digest = ?
           AND consumed_at IS NULL AND expires_at > ?`,
      )
      .run(stamp, input.ref, input.merchantId, input.actorId, input.target, input.targetDigest, stamp);
    return result.changes === 1;
  }

  private rowByKey(input: OperationKey): OperationRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM merchant_management_operations WHERE merchant_id = ? AND actor_id = ? AND command_type = ? AND idempotency_key = ?",
      )
      .get(input.merchantId, input.actorId, input.commandType, input.idempotencyKey) as unknown as
      | OperationRow
      | undefined;
  }

  private outcomeFromRow(
    row: OperationRow,
    requestDigest: string,
  ): { kind: "replay"; receipt: OperationReceipt } | { kind: "conflict" } {
    if (row.request_digest !== requestDigest) return { kind: "conflict" };
    return { kind: "replay", receipt: JSON.parse(row.receipt_json) as OperationReceipt };
  }

  private pendingReceipt(operationId: string, input: OperationKey): OperationReceipt {
    return {
      operation_id: operationId,
      command_type: input.commandType,
      status: "running",
      resource_ref: null,
      result_revision: null,
      created_at: this.now(),
      completed_at: null,
      support_id: `sup_${operationId.slice(-8)}`,
    };
  }
}
