/**
 * 接待运行预算（D07/§18）：每商家每日 output token 配额。
 *
 * 复用 ai-runtime 的 SqliteDailyBudgetStore（lease 契约：幂等预约、差值
 * 结算、不双记）。口径：
 *  - 每次模型 attempt 预约 RECEPTION_ATTEMPT_RESERVE_TOKENS（§18 每 attempt
 *    输出上限 2048）；
 *  - provider 上报用量按实际结算；未上报/请求失败按预约全额保留——
 *    未知用量不记零（§18 用量与费用）；
 *  - 额度用尽或预算存储不可用：准入拒绝，调用方降级规则路径，并记录
 *    降级事件提示商家（D07「超出后降级规则路径并提示商家」）。
 *
 * 日键按 UTC 日期（服务端权威时钟注入）。用量 90 天留存（D10）：sqlite
 * 记录不自动清理，P0a 单商家数据量小，清理由 P0b 的留存任务统一执行。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AttemptBudgetHooks } from "../server/inquiry-interpreter.js";
import type { SqliteDailyBudgetStore } from "../../merchant/ai-runtime/sqlite-budget-store.js";

/** §18：每 attempt 输出上限（token），也是未知用量的保留额。 */
export const RECEPTION_ATTEMPT_RESERVE_TOKENS = 2_048;
/** D07：每商家每日 output token 上限（试点初值）。 */
export const RECEPTION_DAILY_OUTPUT_TOKEN_LIMIT = 200_000;

export interface ReceptionBudgetOptions {
  store: SqliteDailyBudgetStore;
  now: () => string;
  dailyOutputTokenLimit?: number;
  /** 降级事件记录文件（ops 可见；缺省只内存记录）。 */
  degradationFile?: string;
}

export interface DegradationEvent {
  at: string;
  merchantId: string;
  reason: "merchant_quota_exhausted" | "budget_store_unavailable";
}

export class ReceptionBudget {
  private readonly store: SqliteDailyBudgetStore;
  private readonly now: () => string;
  private readonly limit: number;
  private readonly degradationFile?: string;
  private readonly events: DegradationEvent[] = [];

  constructor(options: ReceptionBudgetOptions) {
    this.store = options.store;
    this.now = options.now;
    this.limit = options.dailyOutputTokenLimit ?? RECEPTION_DAILY_OUTPUT_TOKEN_LIMIT;
    if (options.degradationFile !== undefined) this.degradationFile = options.degradationFile;
  }

  /** 当日键：merchant + UTC 日期（按注入的服务端时钟）。 */
  dayKey(merchantId: string): string {
    return `${merchantId}@${this.now().slice(0, 10)}`;
  }

  /** 当日已记账 output token（含活动预约额）。 */
  usedToday(merchantId: string): number {
    return this.store.usedTokens(this.dayKey(merchantId));
  }

  /** 为某商家的解释器签发预算钩子（每次 attempt 独立 lease 配对）。 */
  createAttemptHooks(merchantId: string): AttemptBudgetHooks {
    return {
      begin: () => {
        const leaseId = `att_${randomUUID()}`;
        try {
          const result = this.store.tryReserveTokens(
            this.dayKey(merchantId),
            leaseId,
            RECEPTION_ATTEMPT_RESERVE_TOKENS,
            this.limit,
          );
          return result.ok ? { leaseId } : { rejected: "merchant_quota_exhausted" };
        } catch {
          // 预算存储不可用：fail-closed，不让模型脱离计量运行。
          return { rejected: "budget_store_unavailable" };
        }
      },
      settle: (leaseId, actual) => {
        try {
          this.store.settleTokens(
            this.dayKey(merchantId),
            leaseId,
            RECEPTION_ATTEMPT_RESERVE_TOKENS,
            actual ?? RECEPTION_ATTEMPT_RESERVE_TOKENS,
          );
        } catch {
          // 对账失败保留预约额（不记零）；下一日键自然翻篇。
        }
      },
      onRejected: (reason) => {
        this.recordDegradation(merchantId, reason as DegradationEvent["reason"]);
      },
    };
  }

  /** 降级事件（ops 查询「提示商家」通道）。 */
  degradations(merchantId?: string): DegradationEvent[] {
    const all = this.degradationFile !== undefined ? this.readDegradations() : [...this.events];
    return merchantId === undefined ? all : all.filter((event) => event.merchantId === merchantId);
  }

  private recordDegradation(merchantId: string, reason: DegradationEvent["reason"]): void {
    const event: DegradationEvent = { at: this.now(), merchantId, reason };
    if (this.degradationFile === undefined) {
      this.events.push(event);
      return;
    }
    const all = [...this.readDegradations(), event];
    mkdirSync(dirname(this.degradationFile), { recursive: true });
    const tmp = `${this.degradationFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, events: all })}\n`, { mode: 0o600 });
    renameSync(tmp, this.degradationFile);
  }

  private readDegradations(): DegradationEvent[] {
    if (this.degradationFile === undefined) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.degradationFile, "utf8")) as {
        events?: DegradationEvent[];
      };
      return Array.isArray(parsed.events) ? parsed.events : [];
    } catch {
      return [];
    }
  }
}
