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
 * 长任务 operation 机制（V2 阶段四：src/merchant-core/operations.ts）。
 *
 * 状态机：queued → running → succeeded / partially_failed / failed。
 * 幂等：相同 idempotency_key 返回同一 operation，不重复执行
 * （先记录执行意图；远端返回不确定时先对账，不盲目重发）。
 * 落盘：与命令记录同一 state.sqlite（单 owner 写），表操作幂等建表。
 */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const OPERATION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "partially_failed",
  "failed",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export interface MerchantOperation {
  operation_id: string;
  kind: string;
  idempotency_key: string;
  status: OperationStatus;
  /** 逐项回执（部分成功：哪行/哪项成功失败及原因）。 */
  receipts: Array<{ item: string; ok: boolean; detail?: string }>;
  error?: string;
  created_at: string;
  updated_at: string;
}

const OPERATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_operations (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partially_failed','failed')),
  receipts_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_operations_idem
  ON merchant_operations (kind, idempotency_key);
`;

export class MerchantOperationStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now?: () => string }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.db.exec(OPERATION_SCHEMA);
  }

  /** 幂等创建：同 (kind, idempotency_key) 返回既有 operation（created=false）。 */
  createOrGet(input: { kind: string; idempotencyKey: string }): {
    operation: MerchantOperation;
    created: boolean;
  } {
    const existing = this.db
      .prepare("SELECT * FROM merchant_operations WHERE kind = ? AND idempotency_key = ?")
      .get(input.kind, input.idempotencyKey) as unknown as OperationRow | undefined;
    if (existing !== undefined) return { operation: rowToOperation(existing), created: false };
    const now = this.now();
    const id = `op_${randomBytes(12).toString("hex")}`;
    this.db
      .prepare(
        `INSERT INTO merchant_operations (operation_id, kind, idempotency_key, status, receipts_json, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', '[]', ?, ?)`,
      )
      .run(id, input.kind, input.idempotencyKey, now, now);
    return { operation: this.get(id) as MerchantOperation, created: true };
  }

  get(operationId: string): MerchantOperation | undefined {
    const row = this.db
      .prepare("SELECT * FROM merchant_operations WHERE operation_id = ?")
      .get(operationId) as unknown as OperationRow | undefined;
    return row === undefined ? undefined : rowToOperation(row);
  }

  private set(
    operationId: string,
    status: OperationStatus,
    receipts: Array<{ item: string; ok: boolean; detail?: string }>,
    error?: string,
  ): MerchantOperation {
    this.db
      .prepare(
        "UPDATE merchant_operations SET status = ?, receipts_json = ?, error = ?, updated_at = ? WHERE operation_id = ?",
      )
      .run(status, JSON.stringify(receipts), error ?? null, this.now(), operationId);
    return this.get(operationId) as MerchantOperation;
  }

  markRunning(operationId: string): MerchantOperation {
    const op = this.get(operationId);
    return this.set(operationId, "running", op?.receipts ?? []);
  }

  /** 终态：receipts 全 ok → succeeded；有成功有失败 → partially_failed；全失败/异常 → failed。 */
  finish(
    operationId: string,
    receipts: Array<{ item: string; ok: boolean; detail?: string }>,
    error?: string,
  ): MerchantOperation {
    let status: OperationStatus;
    if (error !== undefined) {
      status = "failed";
    } else if (receipts.length === 0) {
      status = "succeeded";
    } else if (receipts.every((r) => r.ok)) {
      status = "succeeded";
    } else if (receipts.some((r) => r.ok)) {
      status = "partially_failed";
    } else {
      status = "failed";
    }
    return this.set(operationId, status, receipts, error);
  }
}

interface OperationRow {
  operation_id: string;
  kind: string;
  idempotency_key: string;
  status: string;
  receipts_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToOperation(row: OperationRow): MerchantOperation {
  return {
    operation_id: row.operation_id,
    kind: row.kind,
    idempotency_key: row.idempotency_key,
    status: row.status as OperationStatus,
    receipts: JSON.parse(row.receipts_json) as MerchantOperation["receipts"],
    ...(row.error !== null ? { error: row.error } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
