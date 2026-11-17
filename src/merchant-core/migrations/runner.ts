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
 * 模块级独立迁移账本（TOP1-3 设计 v1.1 §18.1 / D-M0-05）。
 *
 * learning / customer-memory / operations-jobs 三个模块各自持有账本表
 * （`*_schema_migrations`），不复用 `merchant_ops_schema_migrations` 的版本
 * 序列；账本记录 `version`、`applied_at`、`checksum`。
 *
 * 语义：
 * - 幂等：重复执行只校验已应用版本的 checksum，不重放 DDL；
 * - checksum 冲突：同版本号下 SQL 摘要变化 → fail-closed 拒绝打开（说明
 *   二进制与库的历史不一致，不能靠"再跑一遍"蒙混）；
 * - fail-closed：每条迁移在单个 `BEGIN IMMEDIATE` 事务内执行，失败即整体
 *   回滚——SQLite DDL 可事务化，不部分应用；
 * - 新库旧二进制：账本版本高于本构建 targetVersion 时拒绝打开（与
 *   `merchant_ops_schema_migrations` 的既有行为一致）。
 */

import type { DatabaseSync } from "node:sqlite";

import { inImmediateTransaction } from "../storage/transaction.js";
import { sha256Hex } from "../../negotiation/jcs.js";

export interface ModuleLedgerSpec {
  /** 模块名，仅用于错误信息定位（learning / customer-memory / operations-jobs）。 */
  readonly module: string;
  /** 账本表名，如 `learning_schema_migrations`。 */
  readonly ledgerTable: string;
  /** 版本号 → 迁移 SQL；版本号必须从 1 连续递增。 */
  readonly migrations: Readonly<Record<number, string>>;
}

export type MigrationLedgerErrorKind =
  | "checksum_conflict"
  | "missing_migration"
  | "newer_than_build"
  | "ledger_gap"
  | "applied_failed";

/** 迁移账本错误；`kind` 用于测试与上层映射稳定原因码。 */
export class MigrationLedgerError extends Error {
  readonly kind: MigrationLedgerErrorKind;

  constructor(kind: MigrationLedgerErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "MigrationLedgerError";
    this.kind = kind;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** 规范化迁移 SQL 后取 SHA256：忽略首尾与连续空白差异，语义等价即同摘要。 */
export function migrationChecksum(sql: string): string {
  return sha256Hex(sql.trim().replace(/\s+/g, " "));
}

interface LedgerRow {
  version: number;
  applied_at: string;
  checksum: string;
}

function readLedger(db: DatabaseSync, ledgerTable: string): Map<number, LedgerRow> {
  const rows = db
    .prepare(`SELECT version, applied_at, checksum FROM ${ledgerTable} ORDER BY version ASC`)
    .all() as unknown as LedgerRow[];
  return new Map(rows.map((row) => [row.version, row]));
}

/**
 * 在 `db` 上执行模块迁移账本到 targetVersion（默认该账本最新版本）。
 *
 * 账本表自身用 `CREATE TABLE IF NOT EXISTS` 幂等创建；其余 DDL 全部走事务。
 * 可在同一 `state.sqlite` 上反复调用（启动路径每进程一次）。
 */
export function migrateModuleSchema(
  db: DatabaseSync,
  spec: ModuleLedgerSpec,
  targetVersion?: number,
): void {
  const versions = Object.keys(spec.migrations)
    .map(Number)
    .sort((a, b) => a - b);
  for (let i = 0; i < versions.length; i++) {
    if (versions[i] !== i + 1) {
      throw new MigrationLedgerError(
        "missing_migration",
        `${spec.module} 迁移版本必须从 1 连续递增；在 ${versions[i]} 处断裂`,
      );
    }
  }
  const latest = versions.length > 0 ? versions[versions.length - 1]! : 0;
  const target = targetVersion ?? latest;
  if (!Number.isSafeInteger(target) || target < 0 || target > latest) {
    throw new MigrationLedgerError(
      "missing_migration",
      `${spec.module} targetVersion ${target} 不是本账本内的合法版本`,
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${spec.ledgerTable} (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    )
  `);
  const applied = readLedger(db, spec.ledgerTable);

  // 已应用版本逐条校验 checksum：同版本异内容是账本损坏或二进制错配。
  for (const [version, row] of applied) {
    const expected = spec.migrations[version];
    if (expected === undefined) {
      throw new MigrationLedgerError(
        "newer_than_build",
        `${spec.module} 账本版本 ${version} 高于本构建（${latest}）；拒绝打开`,
      );
    }
    const digest = migrationChecksum(expected);
    if (row.checksum !== digest) {
      throw new MigrationLedgerError(
        "checksum_conflict",
        `${spec.module} 迁移 ${version} checksum 冲突：账本 ${row.checksum} ≠ 构建 ${digest}`,
      );
    }
  }
  const current = applied.size > 0 ? Math.max(...applied.keys()) : 0;
  // 已应用集合必须是 1..current 连续：出现空洞（如 1、3 而缺 2）说明账本
  // 被破坏或历史被手工改动——max 已"应用"但中间迁移从未执行，schema 状态
  // 不可信。fail-closed 拒绝打开，不接受"跳过缺失版本继续跑"。
  if (applied.size !== current) {
    const listed = [...applied.keys()].sort((a, b) => a - b).join(",");
    throw new MigrationLedgerError(
      "ledger_gap",
      `${spec.module} 账本版本不连续（已应用 ${listed}，最高 ${current}）；拒绝打开`,
    );
  }
  if (current > target) {
    throw new MigrationLedgerError(
      "newer_than_build",
      `${spec.module} 账本版本 ${current} 高于目标 ${target}；拒绝打开`,
    );
  }

  for (let v = current + 1; v <= target; v++) {
    const sql = spec.migrations[v];
    if (sql === undefined) {
      throw new MigrationLedgerError("missing_migration", `${spec.module} 缺少迁移 ${v}`);
    }
    try {
      inImmediateTransaction(db, () => {
        db.exec(sql);
        db.prepare(
          `INSERT INTO ${spec.ledgerTable} (version, applied_at, checksum) VALUES (?, ?, ?)`,
        ).run(v, new Date().toISOString(), migrationChecksum(sql));
      });
    } catch (err) {
      // inImmediateTransaction 已回滚：账本与 DDL 均未推进（不部分应用）。
      throw new MigrationLedgerError(
        "applied_failed",
        `${spec.module} 迁移到版本 ${v} 失败：${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
}
