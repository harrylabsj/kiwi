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
 * 后台经营任务预算账本（TOP1-3 设计 v1.1 §20.1 / §22.1 M1「预算适配」）。
 *
 * 冻结参数（D-M0-09，收尾决议 §1.2）：
 * - 每商家每日 20 个逻辑 run（计数上限，不保证每 run 用满 token）；
 * - 每日 token：input 100000 / output 12000（硬约束，按商家记账日）；
 * - 单 run 预留 input 5000 / output 600；单 run 硬上限 input 24576 /
 *   output 3072；单次调用上限 input 8192 / output 1024（供运行期调用侧使用）；
 * - 后台并发每商家 1（前台接待优先，不占本账本）。
 *
 * 语义：
 * - `reserveRun`：准入时原子检查并占额（日 run 数 + 日 token + 并发）；
 *   额度不足抛 `budget_exhausted`，并发已占抛 `concurrency_limit`——调用方
 *   保持任务 PENDING 并展示原因（§20.1 / §13）；
 * - `settleRun`：按实际用量对账（预留 → 实际，差值记账）；未知用量按预留
 *   保守占额（`usage_state='unknown'`，不记为免费）；结算幂等；
 * - `releaseRun`：未发起的预留释放（run 数一并归还）；
 * - 账本持久化在 state.sqlite：重启不清零、不退款（§20.1「重启不退款或
 *   清零」）；
 * - 所有写入走 `BEGIN IMMEDIATE`，多连接/多进程原子。
 *
 * 边界：token ≠ 钱；本模块不做货币计费。评测预算独立，不混入经营日配额。
 */

import type { DatabaseSync } from "node:sqlite";

import { inImmediateTransaction } from "../storage/transaction.js";

/** D-M0-09 冻结参数。 */
export const BACKGROUND_BUDGET_LIMITS = Object.freeze({
  daily_runs: 20,
  daily_input_tokens: 100_000,
  daily_output_tokens: 12_000,
  run_input_reserve: 5_000,
  run_output_reserve: 600,
  run_input_hard_cap: 24_576,
  run_output_hard_cap: 3_072,
  call_input_cap: 8_192,
  call_output_cap: 1_024,
  max_concurrency: 1,
});

export type BackgroundBudgetErrorCode =
  | "validation"
  | "budget_exhausted"
  | "concurrency_limit"
  | "replay_conflict"
  | "not_found";

export class BackgroundBudgetError extends Error {
  readonly code: BackgroundBudgetErrorCode;
  /** 稳定原因码（如 daily_runs / daily_input_tokens），进日志与工作台。 */
  readonly reason: string;

  constructor(code: BackgroundBudgetErrorCode, reason: string, message: string) {
    super(message);
    this.name = "BackgroundBudgetError";
    this.code = code;
    this.reason = reason;
  }
}

export type BudgetRunState = "RESERVED" | "SETTLED" | "RELEASED";
export type BudgetUsageState = "known" | "unknown";

export interface BudgetDayUsage {
  readonly merchant_id: string;
  readonly day_key: string;
  readonly runs_used: number;
  readonly input_used: number;
  readonly output_used: number;
  readonly updated_at: string;
}

export interface BudgetRunRecord {
  readonly run_id: string;
  readonly merchant_id: string;
  readonly day_key: string;
  readonly template: string | null;
  readonly input_reserved: number;
  readonly output_reserved: number;
  readonly input_actual: number | null;
  readonly output_actual: number | null;
  readonly usage_state: BudgetUsageState | null;
  readonly state: BudgetRunState;
  readonly created_at: string;
  readonly updated_at: string;
}

interface DayRow {
  merchant_id: string;
  day_key: string;
  runs_used: number;
  input_used: number;
  output_used: number;
  updated_at: string;
}

interface RunRow {
  run_id: string;
  merchant_id: string;
  day_key: string;
  template: string | null;
  input_reserved: number;
  input_actual: number | null;
  output_reserved: number;
  output_actual: number | null;
  usage_state: BudgetUsageState | null;
  state: BudgetRunState;
  created_at: string;
  updated_at: string;
}

function dayToUsage(row: DayRow): BudgetDayUsage {
  return {
    merchant_id: row.merchant_id,
    day_key: row.day_key,
    runs_used: row.runs_used,
    input_used: row.input_used,
    output_used: row.output_used,
    updated_at: row.updated_at,
  };
}

function runToRecord(row: RunRow): BudgetRunRecord {
  return {
    run_id: row.run_id,
    merchant_id: row.merchant_id,
    day_key: row.day_key,
    template: row.template,
    input_reserved: row.input_reserved,
    output_reserved: row.output_reserved,
    input_actual: row.input_actual,
    output_actual: row.output_actual,
    usage_state: row.usage_state,
    state: row.state,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function requireId(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new BackgroundBudgetError("validation", `${field}_invalid`, `${field} 必须是 1..128 字符`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new BackgroundBudgetError("validation", `${field}_invalid`, `${field} 含控制字符`);
  }
  return value;
}

function requireTokenCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BackgroundBudgetError("validation", `${field}_invalid`, `${field} 必须是非负整数`);
  }
  return value;
}

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function requireDayKey(value: string): string {
  if (typeof value !== "string" || !DAY_KEY_PATTERN.test(value)) {
    throw new BackgroundBudgetError("validation", "day_key_invalid", "day_key 必须是 YYYY-MM-DD");
  }
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new BackgroundBudgetError("validation", "day_key_invalid", "day_key 不是有效日期");
  }
  return value;
}

/**
 * 商家记账日（宿主时区）：`Intl.DateTimeFormat` 的 en-CA 日历格式为
 * YYYY-MM-DD。非法时区/时间即 validation 拒绝（启动配置错误，不静默回落）。
 */
export function backgroundBudgetDayKey(now: string, timeZone: string): string {
  const ms = Date.parse(now);
  if (!Number.isFinite(ms)) {
    throw new BackgroundBudgetError("validation", "now_invalid", "now 必须是可解析的 RFC3339 时间");
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    throw new BackgroundBudgetError("validation", "timezone_invalid", `无法识别的时区 ${timeZone}`);
  }
  const parts = formatter.formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const dayKey = `${pick("year")}-${pick("month")}-${pick("day")}`;
  if (!DAY_KEY_PATTERN.test(dayKey)) {
    throw new BackgroundBudgetError("validation", "day_key_invalid", "时区换算未得到 YYYY-MM-DD");
  }
  return dayKey;
}

export interface BackgroundBudgetOptions {
  db: DatabaseSync;
  now: () => string;
}

export class BackgroundBudgetStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: BackgroundBudgetOptions) {
    this.db = options.db;
    this.now = options.now;
  }

  private nowUtc(): string {
    const ms = Date.parse(this.now());
    if (!Number.isFinite(ms)) {
      throw new BackgroundBudgetError("validation", "now_invalid", "时钟输出必须是可解析的 RFC3339 时间");
    }
    return new Date(ms).toISOString();
  }

  /**
   * 准入预留：原子检查并发、日 run 数、日 input/output token 并占额。
   * 同 run_id 重复预留：内容一致幂等返回；不一致 replay_conflict。
   */
  reserveRun(input: {
    merchant_id: string;
    run_id: string;
    day_key: string;
    template?: string;
  }): BudgetRunRecord {
    const merchantId = requireId(input.merchant_id, "merchant_id");
    const runId = requireId(input.run_id, "run_id");
    const dayKey = requireDayKey(input.day_key);
    const template =
      input.template === undefined ? null : requireId(input.template, "template");
    return inImmediateTransaction(this.db, () => {
      const existing = this.readRunRow(runId);
      if (existing !== undefined) {
        if (existing.merchant_id !== merchantId || existing.day_key !== dayKey) {
          throw new BackgroundBudgetError(
            "replay_conflict",
            "run_replay_conflict",
            `run ${runId} 已用于其他商家/记账日；不得复用`,
          );
        }
        return runToRecord(existing);
      }
      const now = this.nowUtc();
      this.ensureDayRow(merchantId, dayKey, now);
      const day = this.readDayRow(merchantId, dayKey)!;
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM background_budget_reservations
            WHERE merchant_id = ? AND state = 'RESERVED'`,
        )
        .get(merchantId) as { n: number };
      if (Number(active.n) >= BACKGROUND_BUDGET_LIMITS.max_concurrency) {
        throw new BackgroundBudgetError(
          "concurrency_limit",
          "background_concurrency",
          `商家 ${merchantId} 已有后台 run 在途（并发上限 ${BACKGROUND_BUDGET_LIMITS.max_concurrency}）`,
        );
      }
      if (day.runs_used + 1 > BACKGROUND_BUDGET_LIMITS.daily_runs) {
        throw new BackgroundBudgetError(
          "budget_exhausted",
          "daily_runs",
          `商家 ${merchantId} 当日 run 已达上限 ${BACKGROUND_BUDGET_LIMITS.daily_runs}`,
        );
      }
      if (
        day.input_used + BACKGROUND_BUDGET_LIMITS.run_input_reserve >
        BACKGROUND_BUDGET_LIMITS.daily_input_tokens
      ) {
        throw new BackgroundBudgetError(
          "budget_exhausted",
          "daily_input_tokens",
          `商家 ${merchantId} 当日 input token 不足（预留 ${BACKGROUND_BUDGET_LIMITS.run_input_reserve}）`,
        );
      }
      if (
        day.output_used + BACKGROUND_BUDGET_LIMITS.run_output_reserve >
        BACKGROUND_BUDGET_LIMITS.daily_output_tokens
      ) {
        throw new BackgroundBudgetError(
          "budget_exhausted",
          "daily_output_tokens",
          `商家 ${merchantId} 当日 output token 不足（预留 ${BACKGROUND_BUDGET_LIMITS.run_output_reserve}）`,
        );
      }
      this.db
        .prepare(
          `INSERT INTO background_budget_reservations
            (run_id, merchant_id, day_key, template, input_reserved, output_reserved,
             input_actual, output_actual, usage_state, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'RESERVED', ?, ?)`,
        )
        .run(
          runId,
          merchantId,
          dayKey,
          template,
          BACKGROUND_BUDGET_LIMITS.run_input_reserve,
          BACKGROUND_BUDGET_LIMITS.run_output_reserve,
          now,
          now,
        );
      this.db
        .prepare(
          `UPDATE background_budget_days
              SET runs_used = runs_used + 1,
                  input_used = input_used + ?,
                  output_used = output_used + ?,
                  updated_at = ?
            WHERE merchant_id = ? AND day_key = ?`,
        )
        .run(
          BACKGROUND_BUDGET_LIMITS.run_input_reserve,
          BACKGROUND_BUDGET_LIMITS.run_output_reserve,
          now,
          merchantId,
          dayKey,
        );
      return runToRecord(this.readRunRow(runId)!);
    });
  }

  /**
   * 结算：预留换成实际用量。同 run 重复结算为 no-op（返回当前记录）。
   * `usage_state='unknown'`（provider 未返回用量）按预留值保守占额。
   */
  settleRun(input: {
    merchant_id: string;
    run_id: string;
    input_tokens: number;
    output_tokens: number;
    usage_state?: BudgetUsageState;
  }): BudgetRunRecord {
    const merchantId = requireId(input.merchant_id, "merchant_id");
    const runId = requireId(input.run_id, "run_id");
    const usageState = input.usage_state ?? "known";
    if (usageState !== "known" && usageState !== "unknown") {
      throw new BackgroundBudgetError("validation", "usage_state_invalid", "usage_state 只能是 known/unknown");
    }
    return inImmediateTransaction(this.db, () => {
      const row = this.readRunRow(runId);
      if (row === undefined || row.merchant_id !== merchantId) {
        throw new BackgroundBudgetError("not_found", "run_not_found", `run ${runId} 不存在或不可见`);
      }
      if (row.state !== "RESERVED") return runToRecord(row);
      const inputActual =
        usageState === "unknown"
          ? row.input_reserved
          : requireTokenCount(input.input_tokens, "input_tokens");
      const outputActual =
        usageState === "unknown"
          ? row.output_reserved
          : requireTokenCount(input.output_tokens, "output_tokens");
      const now = this.nowUtc();
      this.db
        .prepare(
          `UPDATE background_budget_reservations
              SET state = 'SETTLED', input_actual = ?, output_actual = ?,
                  usage_state = ?, updated_at = ?
            WHERE run_id = ? AND state = 'RESERVED'`,
        )
        .run(inputActual, outputActual, usageState, now, runId);
      this.db
        .prepare(
          `UPDATE background_budget_days
              SET input_used = input_used - ? + ?,
                  output_used = output_used - ? + ?,
                  updated_at = ?
            WHERE merchant_id = ? AND day_key = ?`,
        )
        .run(
          row.input_reserved,
          inputActual,
          row.output_reserved,
          outputActual,
          now,
          row.merchant_id,
          row.day_key,
        );
      return runToRecord(this.readRunRow(runId)!);
    });
  }

  /** 释放未发起的预留（幂等）：归还 token 与 run 计数。 */
  releaseRun(input: { merchant_id: string; run_id: string }): BudgetRunRecord {
    const merchantId = requireId(input.merchant_id, "merchant_id");
    const runId = requireId(input.run_id, "run_id");
    return inImmediateTransaction(this.db, () => {
      const row = this.readRunRow(runId);
      if (row === undefined || row.merchant_id !== merchantId) {
        throw new BackgroundBudgetError("not_found", "run_not_found", `run ${runId} 不存在或不可见`);
      }
      if (row.state !== "RESERVED") return runToRecord(row);
      const now = this.nowUtc();
      this.db
        .prepare(
          `UPDATE background_budget_reservations
              SET state = 'RELEASED', updated_at = ?
            WHERE run_id = ? AND state = 'RESERVED'`,
        )
        .run(now, runId);
      this.db
        .prepare(
          `UPDATE background_budget_days
              SET runs_used = runs_used - 1,
                  input_used = input_used - ?,
                  output_used = output_used - ?,
                  updated_at = ?
            WHERE merchant_id = ? AND day_key = ?`,
        )
        .run(row.input_reserved, row.output_reserved, now, row.merchant_id, row.day_key);
      return runToRecord(this.readRunRow(runId)!);
    });
  }

  getRun(merchantId: string, runId: string): BudgetRunRecord | undefined {
    const row = this.readRunRow(requireId(runId, "run_id"));
    if (row === undefined || row.merchant_id !== requireId(merchantId, "merchant_id")) {
      return undefined;
    }
    return runToRecord(row);
  }

  /** 当日已用量（含在途预留）；行不存在时返回零值（不写库）。 */
  getDayUsage(merchantId: string, dayKey: string): BudgetDayUsage {
    const merchant = requireId(merchantId, "merchant_id");
    const day = requireDayKey(dayKey);
    const row = this.readDayRow(merchant, day);
    if (row === undefined) {
      return {
        merchant_id: merchant,
        day_key: day,
        runs_used: 0,
        input_used: 0,
        output_used: 0,
        updated_at: "",
      };
    }
    return dayToUsage(row);
  }

  private ensureDayRow(merchantId: string, dayKey: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO background_budget_days
          (merchant_id, day_key, runs_used, input_used, output_used, updated_at)
         VALUES (?, ?, 0, 0, 0, ?)
         ON CONFLICT(merchant_id, day_key) DO NOTHING`,
      )
      .run(merchantId, dayKey, now);
  }

  private readDayRow(merchantId: string, dayKey: string): DayRow | undefined {
    return this.db
      .prepare("SELECT * FROM background_budget_days WHERE merchant_id = ? AND day_key = ?")
      .get(merchantId, dayKey) as unknown as DayRow | undefined;
  }

  private readRunRow(runId: string): RunRow | undefined {
    return this.db
      .prepare("SELECT * FROM background_budget_reservations WHERE run_id = ?")
      .get(runId) as unknown as RunRow | undefined;
  }
}
