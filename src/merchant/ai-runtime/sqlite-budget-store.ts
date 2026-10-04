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
 * ai-runtime 日预算的 **SQLite 持久 adapter**（A91）。
 *
 * 实现 A83/A87 `DailyBudgetStore` 租约契约（leaseId 三方法 +
 * `persistent: true`），供接线侧在 gate 之外接入真实持久层。本文件**自足**：
 * 不 import gate/config/status（避免环依赖，也便于独立子进程直接加载验证
 * 多进程竞态）。类型兼容由测试侧静态断言（`DailyBudgetStore` 结构性兼容）。
 *
 * 保证（多连接/多进程共享同一 DB 文件时成立，靠 `BEGIN IMMEDIATE` 写锁 +
 * busy_timeout 实现，**不靠 JSON 读写模拟原子**）：
 * - `tryReserveTokens`：dayKey+leaseId 主键幂等重放——活动租约**同金额**重复
 *   预约返回原占用、不双计；**不同金额**重放抛 `replay_conflict`（首次金额
 *   权威，绝不静默冒充更新成功）；`used + amount > limit` 原子拒；检查与
 *   占用同事务。
 * - `settleTokens`：leaseId 幂等差值对账（reserved→actual，允许 actual>
 *   reserved 的诚实越限记账）；已结算重复调用 no-op；未知租约抛
 *   `unknown_lease`（重放冲突拒绝）；事务失败整体回滚，可重试。
 * - `releaseReservation`：幂等释放；已结算/未知租约 no-op。
 * - 错误全部映射为固定错误码的 `AiBudgetStoreError`，**不含 SQL 原文、
 *   路径、凭据**等敏感细节。
 *
 * 边界：token 预算 ≠ 货币计费上限（见 docs/merchant-ai-runtime-config.md）；
 * 构造需显式注入 DB 文件路径（不读 Runtime 真实 DB / env）；schema 只在本
 * adapter 自己的库文件内创建，不做任何生产数据迁移。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 固定错误码；message 只含错误码与参数类别，不含 SQL/路径/凭据。 */
export class AiBudgetStoreError extends Error {
  readonly code: "invalid_argument" | "unknown_lease" | "replay_conflict" | "store_error";
  constructor(
    code: "invalid_argument" | "unknown_lease" | "replay_conflict" | "store_error",
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "AiBudgetStoreError";
    this.code = code;
  }
}

export interface SqliteBudgetStoreOptions {
  /** busy_timeout（毫秒），多进程竞争时持锁等待上限。默认 5000。 */
  busyTimeoutMs?: number;
  /** 是否在打开时创建 schema（默认 true；仅作用于本 adapter 自有库文件）。 */
  createSchema?: boolean;
}

function isSafeIntNonNeg(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function assertDayKey(dayKey: unknown): asserts dayKey is string {
  if (typeof dayKey !== "string" || dayKey.trim().length === 0) {
    throw new AiBudgetStoreError("invalid_argument", "dayKey must be a non-empty string");
  }
}

function assertLeaseId(leaseId: unknown): asserts leaseId is string {
  if (typeof leaseId !== "string" || leaseId.trim().length === 0) {
    throw new AiBudgetStoreError("invalid_argument", "leaseId must be a non-empty string");
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ai_budget_day (
  day_key TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0)
);
CREATE TABLE IF NOT EXISTS ai_budget_lease (
  day_key TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  settled INTEGER NOT NULL DEFAULT 0,
  actual INTEGER,
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (day_key, lease_id)
);
`;

export class SqliteDailyBudgetStore {
  /** DailyBudgetStore 能力位：真实持久实现。 */
  readonly persistent = true;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string, options: SqliteBudgetStoreOptions = {}) {
    if (typeof dbPath !== "string" || dbPath.length === 0 || dbPath.trim().length === 0) {
      throw new AiBudgetStoreError("invalid_argument", "dbPath must be a non-empty string");
    }
    // 注意：只拒「纯空白」路径，**不 trim** 实际路径——合法文件名可以含空格。
    let opened: DatabaseSync | null = null;
    try {
      if (dbPath !== ":memory:") {
        mkdirSync(dirname(dbPath), { recursive: true });
      }
      opened = new DatabaseSync(dbPath);
      this.db = opened;
      this.initialize(options);
      return;
    } catch (err) {
      // 尽力关闭已打开的 DB；关闭失败不得 mask 固定错误码。
      if (opened !== null) {
        try {
          opened.close();
        } catch {
          /* 关闭失败无追加动作 */
        }
      }
      if (err instanceof AiBudgetStoreError) throw err;
      // mkdirSync / DatabaseSync / 其它运行时错误统一映射为固定码，不含路径/SQL。
      throw new AiBudgetStoreError("store_error", "failed to initialize budget database");
    }
  }

  /**
   * WAL pragma + schema 初始化。多进程同时首启同库时可能遇瞬态 BUSY——短
   * 重试后仍失败才 fail-closed，避免把启动竞态误判为库损坏。
   */
  private initialize(options: SqliteBudgetStoreOptions): void {
    let initOk = false;
    for (let attempt = 0; attempt < 5 && !initOk; attempt++) {
      try {
        if (attempt > 0) {
          const waitMs = 25 * 2 ** attempt;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
        }
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 5000)};`);
        if (options.createSchema !== false) {
          this.db.exec(SCHEMA_SQL);
        }
        initOk = true;
      } catch {
        /* 下一轮重试；循环结束仍失败则走下方 fail-closed */
      }
    }
    if (!initOk) {
      throw new AiBudgetStoreError("store_error", "failed to initialize budget database");
    }
  }

  /**
   * 原子预约：检查与占用在同一 IMMEDIATE 事务。重复预约活动租约幂等返回
   * 当前占用；超 limit 原子拒绝；已结算租约重预约抛 replay_conflict。
   */
  tryReserveTokens(
    dayKey: string,
    leaseId: string,
    amount: number,
    limit: number,
  ): { ok: boolean; usedAfter: number } {
    this.assertOpen();
    assertDayKey(dayKey);
    assertLeaseId(leaseId);
    if (!isSafeIntNonNeg(amount)) {
      throw new AiBudgetStoreError("invalid_argument", "amount must be a non-negative safe integer");
    }
    if (!isSafeIntNonNeg(limit) || limit === 0) {
      throw new AiBudgetStoreError("invalid_argument", "limit must be a positive safe integer");
    }
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        const existing = this.db
          .prepare("SELECT amount, settled FROM ai_budget_lease WHERE day_key = ? AND lease_id = ?")
          .get(dayKey, leaseId) as { amount: number; settled: number } | undefined;
        const used = this.dayUsedLocked(dayKey);
        if (existing) {
          if (existing.settled === 1) {
            throw new AiBudgetStoreError("replay_conflict", "lease is already settled");
          }
          // 活跃租约重放：同金额幂等 no-op（不双计）；不同金额是契约违反
          // （调用方在复用 leaseId），固定 replay_conflict 拒绝——绝不静默按
          // 首次金额"成功"，也不更新金额（首次金额权威）。
          if (existing.amount !== amount) {
            throw new AiBudgetStoreError(
              "replay_conflict",
              "active lease re-reserve with different amount",
            );
          }
          this.db.exec("COMMIT;");
          return { ok: true, usedAfter: used };
        }
        if (used + amount > limit) {
          this.db.exec("ROLLBACK;");
          return { ok: false, usedAfter: used };
        }
        this.db
          .prepare(
            "INSERT INTO ai_budget_lease (day_key, lease_id, amount, settled, actual, created_ms) " +
              "VALUES (?, ?, ?, 0, NULL, ?)",
          )
          .run(dayKey, leaseId, amount, Date.now());
        this.bumpDayLocked(dayKey, amount);
        const usedAfter = used + amount;
        this.db.exec("COMMIT;");
        return { ok: true, usedAfter };
      } catch (err) {
        this.rollbackIfActive();
        throw err;
      }
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /**
   * 幂等差值对账：reserved→actual；允许 actual>reserved 的诚实越限记账
   * （当日记账可超日限，后续 acquire 由 gate 阻断，见接口文档）。
   * 已结算 no-op——**首次结算权威**：重复结算即使 actual 不同也不更新、
   * 不报错（调用方契约：同一租约只结算一次）；未知租约抛 unknown_lease；
   * 事务失败整体回滚，重试不丢账不双记。
   */
  settleTokens(
    dayKey: string,
    leaseId: string,
    reservedAmount: number,
    actualAmount: number,
  ): void {
    this.assertOpen();
    assertDayKey(dayKey);
    assertLeaseId(leaseId);
    if (!isSafeIntNonNeg(reservedAmount)) {
      throw new AiBudgetStoreError("invalid_argument", "reservedAmount must be a non-negative safe integer");
    }
    if (!isSafeIntNonNeg(actualAmount)) {
      throw new AiBudgetStoreError("invalid_argument", "actualAmount must be a non-negative safe integer");
    }
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        const row = this.db
          .prepare("SELECT amount, settled FROM ai_budget_lease WHERE day_key = ? AND lease_id = ?")
          .get(dayKey, leaseId) as { amount: number; settled: number } | undefined;
        if (!row) {
          throw new AiBudgetStoreError("unknown_lease", "no reservation for lease");
        }
        if (row.settled === 1) {
          this.db.exec("COMMIT;");
          return;
        }
        const delta = actualAmount - row.amount;
        this.bumpDayLocked(dayKey, delta);
        this.db
          .prepare("UPDATE ai_budget_lease SET settled = 1, actual = ? WHERE day_key = ? AND lease_id = ?")
          .run(actualAmount, dayKey, leaseId);
        this.db.exec("COMMIT;");
      } catch (err) {
        this.rollbackIfActive();
        throw err;
      }
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** 幂等释放预约；未知/已结算租约 no-op。 */
  releaseReservation(dayKey: string, leaseId: string): void {
    this.assertOpen();
    assertDayKey(dayKey);
    assertLeaseId(leaseId);
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        const row = this.db
          .prepare("SELECT amount, settled FROM ai_budget_lease WHERE day_key = ? AND lease_id = ?")
          .get(dayKey, leaseId) as { amount: number; settled: number } | undefined;
        if (!row || row.settled === 1) {
          this.db.exec("COMMIT;");
          return;
        }
        this.bumpDayLocked(dayKey, -row.amount);
        this.db
          .prepare("DELETE FROM ai_budget_lease WHERE day_key = ? AND lease_id = ?")
          .run(dayKey, leaseId);
        this.db.exec("COMMIT;");
      } catch (err) {
        this.rollbackIfActive();
        throw err;
      }
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** 当日已记账 token（含活动预约额；观测/测试用）。 */
  usedTokens(dayKey: string): number {
    this.assertOpen();
    assertDayKey(dayKey);
    try {
      return this.dayUsedLocked(dayKey);
    } catch (err) {
      throw this.mapError(err);
    }
  }

  /** 幂等关闭。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      /* 已关闭/损坏连接上的 close 错误无追加动作 */
    }
  }

  /** 事务内读当日用量（无独立事务，调用方需已持有 IMMEDIATE 锁）。 */
  private dayUsedLocked(dayKey: string): number {
    this.db.prepare("INSERT OR IGNORE INTO ai_budget_day (day_key, used) VALUES (?, 0)").run(dayKey);
    const row = this.db
      .prepare("SELECT used FROM ai_budget_day WHERE day_key = ?")
      .get(dayKey) as { used: number };
    return row.used;
  }

  private bumpDayLocked(dayKey: string, delta: number): void {
    this.db
      .prepare("UPDATE ai_budget_day SET used = used + ? WHERE day_key = ?")
      .run(delta, dayKey);
  }

  private rollbackIfActive(): void {
    try {
      this.db.exec("ROLLBACK;");
    } catch {
      /* 无活动事务时 ROLLBACK 报错可忽略 */
    }
  }

  private mapError(err: unknown): AiBudgetStoreError {
    if (err instanceof AiBudgetStoreError) return err;
    return new AiBudgetStoreError("store_error", "budget database operation failed");
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AiBudgetStoreError("store_error", "store is closed");
    }
  }
}

/** 构造入口：显式 DB 路径注入（不读 env / Runtime 真实库）。 */
export function createSqliteDailyBudgetStore(
  dbPath: string,
  options: SqliteBudgetStoreOptions = {},
): SqliteDailyBudgetStore {
  return new SqliteDailyBudgetStore(dbPath, options);
}
