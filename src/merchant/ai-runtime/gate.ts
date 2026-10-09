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
 * ai-runtime 调用前门控（U6-4，A79；A83 修复版；A87 租约 ID 唯一性/并发结算）。
 *
 * 生命周期（接线侧契约）：
 *   acquireTurnLease  → 建租约 + **原子预约日预算** + 并发软预检（deny 均发生在
 *                        任何 provider 调用之前，固定原因码）；leaseId 默认
 *                        node:crypto randomUUID（全局唯一）；注入 randomId 者
 *                        须保证跨实例唯一，空/重复 id 拒绝且不覆写租约
 *   markInFlight      → **原子并发许可申领**（检查并占用在同一步完成，超限拒
 *                        绝且不计数）+ 登记调用在途
 *   confirmCallEnded  → 接线侧确认调用已结束（成功/失败/超时回调各一次，幂等）；
 *                        并发额度在此释放——超时在途不提前释放许可
 *   settleLease       → 按实际 token 对账（leaseId 幂等）；store 写失败保持
 *                        可重试，不先置 settled 丢账；usedTokens 必须是非负
 *                        safe integer，否则拒绝且不碰账本；并发/重复 settle
 *                        由同步 settling 标志短路，最终只有一 true、记账一次
 *   releaseLease      → 仅未发起调用的租约可释放（在途租约拒绝 release，
 *                        不得跳过成本）；幂等
 *
 * 日预算（DailyBudgetStore，leaseId 原子契约）：
 * - tryReserveTokens(day, leaseId, amount, limit) 在 acquire 即原子预约；
 *   settleTokens(day, leaseId, reserved, actual) 按 leaseId 幂等对账
 *   （reserved→actual 差值）；releaseReservation(day, leaseId) 幂等释放。
 * - **持久性是 store 的能力位（persistent）**：接口不带持久实现的
 *   （含内置内存实现）一律视为未持久化——配了 daily_token_limit 时 gate 与
 *   status 一致阻断（daily_budget_not_persisted），绝不假装跨重启日预算
 *   已落实。真实持久 adapter 由接线侧（ZCode）实现，本模块不提供。
 *
 * 边界（A83 明确）：
 * - token ≠ 钱：buildModel() 的 cost 全 0 是未定价，不是真实费用 0；本模块
 *   只按 token 计数，无任何货币控制声称。
 * - 记账日界＝**acquire 所在 UTC 日**（settle 用 acquiredAtMs 的日键）。
 * - estimatedTokens 不得超过单回合输出上限；merchantId 必须非空——否则
 *   invalid_config 拒绝。
 */

import { randomUUID } from "node:crypto";

import type { AiRuntimeConfig } from "./config.js";
import type { AiRuntimeBlockReason } from "./status.js";

export type { AiRuntimeBlockReason };

/**
 * 日预算持久化接口（leaseId 原子契约）。
 *
 * 实现方负责跨进程/跨重启 durability 与并发原子性：`tryReserveTokens`
 * 的「检查并占用」必须原子（多进程共享时由实现保证，如 DB 条件更新）。
 * 未实现真实持久 adapter 前，禁止声明生产日预算已落实。
 */
export interface DailyBudgetStore {
  /** 能力位：true 才视为持久化实现；false/缺省＝内存级，不配生产日预算。 */
  readonly persistent: boolean;
  /** 原子预约：used(含在约) + amount ≤ limit 才成功。返回预约后当日占用总量。 */
  tryReserveTokens(
    dayKey: string,
    leaseId: string,
    amount: number,
    limit: number,
  ): Promise<{ ok: boolean; usedAfter: number }> | { ok: boolean; usedAfter: number };
  /** 幂等对账：把该 lease 的预约换成实际用量（差值记账）；重复调用 no-op。 */
  settleTokens(
    dayKey: string,
    leaseId: string,
    reservedAmount: number,
    actualAmount: number,
  ): Promise<void> | void;
  /** 幂等释放预约；无该 lease 的预约时 no-op。 */
  releaseReservation(dayKey: string, leaseId: string): Promise<void> | void;
}

/**
 * 测试/单机内存实现。**persistent=false**：不配 daily_token_limit 或
 * 仅测试使用；生产日预算必须换持久 adapter。
 */
export function createInMemoryDailyBudgetStore(): DailyBudgetStore {
  const used = new Map<string, number>();
  const reserved = new Map<string, { dayKey: string; amount: number }>();
  const settledLeases = new Set<string>();
  const key = (dayKey: string, leaseId: string) => {
    if (typeof dayKey !== "string" || dayKey.trim() === "" || typeof leaseId !== "string" || leaseId.trim() === "") {
      throw Object.assign(new Error("dayKey and leaseId must be non-empty strings"), { code: "invalid_argument" });
    }
    return JSON.stringify([dayKey, leaseId]);
  };
  const assertAmount = (amount: number, positive = false) => {
    if (!Number.isSafeInteger(amount) || amount < 0 || (positive && amount === 0)) {
      throw Object.assign(new Error("invalid token amount"), { code: "invalid_argument" });
    }
  };

  return {
    persistent: false,
    tryReserveTokens: (dayKey, leaseId, amount, limit) => {
      const k = key(dayKey, leaseId);
      assertAmount(amount);
      assertAmount(limit, true);
      if (settledLeases.has(k)) throw Object.assign(new Error("lease is already settled"), { code: "replay_conflict" });
      const previous = reserved.get(k);
      if (previous !== undefined) {
        if (previous.amount !== amount) throw Object.assign(new Error("active lease amount conflict"), { code: "replay_conflict" });
        return { ok: true, usedAfter: used.get(dayKey) ?? 0 };
      }
      const cur = used.get(dayKey) ?? 0;
      if (cur + amount > limit) return { ok: false, usedAfter: cur };
      used.set(dayKey, cur + amount);
      reserved.set(k, { dayKey, amount });
      return { ok: true, usedAfter: cur + amount };
    },
    settleTokens: (dayKey, leaseId, _reservedAmount, actualAmount) => {
      const k = key(dayKey, leaseId);
      assertAmount(_reservedAmount);
      assertAmount(actualAmount);
      if (settledLeases.has(k)) return;
      const rec = reserved.get(k);
      if (rec === undefined) throw Object.assign(new Error("no reservation for lease"), { code: "unknown_lease" });
      const reservedForLease = rec.amount;
      const cur = used.get(dayKey) ?? 0;
      used.set(dayKey, cur - reservedForLease + actualAmount);
      reserved.delete(k);
      settledLeases.add(k);
    },
    releaseReservation: (dayKey, leaseId) => {
      const k = key(dayKey, leaseId);
      const rec = reserved.get(k);
      if (!rec) return;
      const cur = used.get(rec.dayKey) ?? 0;
      used.set(rec.dayKey, cur - rec.amount);
      reserved.delete(k);
    },
  };
}

export interface TurnLease {
  leaseId: string;
  merchantId: string;
  /** 预约的 token 额度（≤ 单回合输出上限）。 */
  reservedTokens: number;
  acquiredAtMs: number;
  deadlineMs: number;
}

export type LeaseDecision =
  | { ok: true; lease: TurnLease }
  | { ok: false; reason: AiRuntimeBlockReason; detail: string };

export interface GateAcquireInput {
  merchantId: string;
  /** 预估输出 token（通常 = config.turn.max_output_tokens，不得超过它）。 */
  estimatedTokens: number;
  /** 注入时钟（覆盖 now()）。 */
  nowMs?: number;
}

export interface LeaseSettleResult {
  /** 本次是否真正完成结算（重复结算/非法输入/store 未写成为 false）。 */
  settled: boolean;
  lease: TurnLease;
  /** 输入非法时的固定错误码（不碰账本、不置 settled）。 */
  error?: "invalid_used_tokens" | "budget_settle_failed";
}

export interface GateOptions {
  config: AiRuntimeConfig;
  /** 配置 daily_token_limit 时必填且必须 persistent=true；否则预算阻断。 */
  budgetStore?: DailyBudgetStore;
  /** 注入时钟。 */
  now?: () => number;
  /** 注入 id 源（leaseId）。契约：每次调用返回**非空**且在共享同一 budget
   * store 的多个 gate 实例间**唯一**的 id——持久 store 的幂等/预约键就是
   * dayKey/leaseId，碰撞会静默吞掉预约。违反契约（空 id 或本实例内重复）
   * 时 acquire 拒绝 invalid_config，绝不覆写既有租约。缺省用 node:crypto
   * randomUUID()（全局唯一，不新增依赖）。 */
  randomId?: () => string;
}

interface LeaseRecord {
  lease: TurnLease;
  state: "active" | "settled" | "released";
  /** provider 调用是否在途（confirmCallEnded 前为 true）。 */
  inFlight: boolean;
  /** 并发许可是否已申领（markInFlight 原子申领，confirmCallEnded 释放）。 */
  counted: boolean;
  /** 日预算是否已预约（acquire 原子预约，settle/release 对账）。 */
  budgetReserved: boolean;
  /** 结算是否正在进行（同步短路并发 settle，保证最终只有一 true）。 */
  settling: boolean;
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function isValidUsedTokens(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0;
}

/** review 2-11：租约表上限——超过即裁剪最老终态记录（active 永不裁）。 */
const AI_RUNTIME_LEASE_TABLE_LIMIT = 512;

export class AiRuntimeGate {
  private readonly config: AiRuntimeConfig;
  private readonly budgetStore: DailyBudgetStore | null;
  private readonly now: () => number;
  private readonly randomId: () => string;

  private readonly leases = new Map<string, LeaseRecord>();
  private readonly inflightPerMerchant = new Map<string, number>();
  private inflightGlobal = 0;

  constructor(options: GateOptions) {
    this.config = options.config;
    this.budgetStore = options.config.budget !== null ? (options.budgetStore ?? null) : null;
    this.now = options.now ?? Date.now;
    // 默认全局唯一：实例级计数器在多实例下都从 1 开始，碰撞会静默吞掉
    // 共享持久 store 的预约（A86 M2）。randomUUID 无此问题。
    this.randomId = options.randomId ?? (() => randomUUID());
  }

  /** 日预算可用性：配了预算就必须有 persistent=true 的 store（能力位判定）。 */
  private budgetUsable(): boolean {
    return (
      this.config.budget !== null &&
      this.budgetStore !== null &&
      this.budgetStore.persistent === true &&
      typeof this.budgetStore.tryReserveTokens === "function"
    );
  }

  /**
   * 申请一回合调用许可：日预算原子预约 + 并发软预检。全部拒绝发生在任何
   * provider 调用之前，固定原因码供规则回退。并发许可的最终原子申领在
   * markInFlight（见该类注释的生命周期）。
   */
  async acquireTurnLease(input: GateAcquireInput): Promise<LeaseDecision> {
    const cfg = this.config;
    if (!cfg.enabled) {
      return this.deny("ai_runtime_disabled", "ai-runtime is not enabled; rule fallback applies");
    }
    if (
      typeof input.merchantId !== "string" ||
      input.merchantId.trim().length === 0
    ) {
      return this.deny("invalid_config", "merchantId must be a non-empty string");
    }
    if (!Number.isSafeInteger(input.estimatedTokens) || input.estimatedTokens <= 0) {
      return this.deny("invalid_config", "estimatedTokens must be a positive safe integer");
    }
    if (input.estimatedTokens > cfg.turn.max_output_tokens) {
      return this.deny(
        "invalid_config",
        `estimatedTokens (${input.estimatedTokens}) exceeds turn max_output_tokens (${cfg.turn.max_output_tokens})`,
      );
    }

    const conc = cfg.concurrency;
    if (this.inflightGlobal >= conc.max_inflight_global) {
      return this.deny("concurrency_limit", "global inflight limit reached (before provider call)");
    }
    const perMerchant = this.inflightPerMerchant.get(input.merchantId) ?? 0;
    if (perMerchant >= conc.max_inflight_per_merchant) {
      return this.deny(
        "concurrency_limit",
        "per-merchant inflight limit reached (before provider call)",
      );
    }

    const leaseId = this.randomId();
    // 注入 id 源契约守卫：空 id 或本实例内重复 id 一律拒绝，绝不覆写既有租约
    // （持久 store 的幂等/预约键是 dayKey/leaseId，覆写/碰撞会静默吞账）。
    if (typeof leaseId !== "string" || leaseId.length === 0 || this.leases.has(leaseId)) {
      return this.deny(
        "invalid_config",
        "randomId contract violated: leaseId must be non-empty and unique per instance",
      );
    }
    let budgetReserved = false;
    if (cfg.budget !== null) {
      if (!this.budgetUsable()) {
        return this.deny(
          "daily_budget_not_persisted",
          "daily_token_limit requires a persistent DailyBudgetStore (persistent=true); " +
            "in-memory or missing store must not be presented as restart-durable",
        );
      }
      const dayKey = utcDayKey(input.nowMs ?? this.now());
      const r = await this.budgetStore!.tryReserveTokens(
        dayKey,
        leaseId,
        input.estimatedTokens,
        cfg.budget.daily_token_limit,
      );
      if (!r.ok) {
        return this.deny(
          "daily_budget_exhausted",
          `daily token budget would be exceeded (usedAfter=${r.usedAfter})`,
        );
      }
      budgetReserved = true;
    }

    const lease: TurnLease = {
      leaseId,
      merchantId: input.merchantId,
      reservedTokens: input.estimatedTokens,
      acquiredAtMs: input.nowMs ?? this.now(),
      deadlineMs: cfg.turn.deadline_ms,
    };
    // review 2-11：租约表有界——超限时裁剪最老的终态（非 active）记录。
    // 此前只增不删，长驻 runtime 内存无界增长；stats() 只数 active，终态
    // 留存仅为 settle/release 幂等重试语义服务，保留最近一窗即足。
    if (this.leases.size >= AI_RUNTIME_LEASE_TABLE_LIMIT) {
      for (const [id, r] of this.leases) {
        if (this.leases.size < AI_RUNTIME_LEASE_TABLE_LIMIT) break;
        // review 2-11（A316 校准）：只裁「终态且并发已确认结束」的记录——
        // inFlight 未 confirmCallEnded 的 rec 被裁会永久卡 inflightGlobal。
        if (r.state !== "active" && !r.inFlight) this.leases.delete(id);
      }
    }
    this.leases.set(leaseId, {
      lease,
      state: "active",
      inFlight: false,
      counted: false,
      budgetReserved,
      settling: false,
    });
    return { ok: true, lease };
  }

  /**
   * 原子并发许可申领 + 在途登记：检查与占用在同一步完成（单实例内同步
   * 原子；多实例/多进程由接线侧保证 gate 单例）。超限拒绝并返回 false，
   * **不计数**——批量/并发 acquire 后统一 mark 无法绕过上限。幂等。
   */
  markInFlight(leaseId: string): boolean {
    const rec = this.leases.get(leaseId);
    if (!rec || rec.state !== "active") return false;
    if (rec.counted) {
      rec.inFlight = true;
      return true;
    }
    const conc = this.config.concurrency;
    if (this.inflightGlobal >= conc.max_inflight_global) return false;
    const m = rec.lease.merchantId;
    if ((this.inflightPerMerchant.get(m) ?? 0) >= conc.max_inflight_per_merchant) return false;
    rec.counted = true;
    rec.inFlight = true;
    this.inflightGlobal += 1;
    this.inflightPerMerchant.set(m, (this.inflightPerMerchant.get(m) ?? 0) + 1);
    return true;
  }

  /**
   * 结算租约：usedTokens 必须是非负 safe integer（否则拒绝且不碰账本）；
   * 按 leaseId 幂等对账；store 写失败保持租约可重试（不先置 settled 丢账）。
   * 并发/重复 settle 由同步 `settling` 标志短路：同一租约最终只有一个调用
   * 返回 settled=true，其余返回 settled=false，账本只记一次。预算对账日在
   * acquire 的 UTC 日。
   */
  async settleLease(leaseId: string, outcome: { usedTokens: number }): Promise<LeaseSettleResult> {
    const rec = this.leases.get(leaseId);
    if (!rec) throw new Error(`ai-runtime gate: unknown lease ${leaseId}`);
    if (rec.state === "settled") return { settled: false, lease: rec.lease };
    if (!isValidUsedTokens(outcome.usedTokens)) {
      return { settled: false, lease: rec.lease, error: "invalid_used_tokens" };
    }
    // 同步短路：检查+占用在同一步，并发第二个 settle 在此返回 false（N2）。
    if (rec.settling) return { settled: false, lease: rec.lease };
    rec.settling = true;
    if (this.config.budget !== null && rec.budgetReserved && this.budgetStore !== null) {
      const dayKey = utcDayKey(rec.lease.acquiredAtMs);
      try {
        await this.budgetStore.settleTokens(
          dayKey,
          leaseId,
          rec.lease.reservedTokens,
          outcome.usedTokens,
        );
      } catch {
        // 保持 active 可重试（settling 复位，store 以 leaseId 幂等防重复入账）。
        rec.settling = false;
        return { settled: false, lease: rec.lease, error: "budget_settle_failed" };
      }
      rec.budgetReserved = false;
    }
    rec.state = "settled";
    rec.settling = false;
    return { settled: true, lease: rec.lease };
  }

  /**
   * 释放未用租约（provider 调用未发起即取消）。**在途租约拒绝释放**——
   * 在途调用不得跳过成本，须待 confirmCallEnded 后按实际用量 settle。
   * 幂等；预算预约随之释放（best-effort，store 幂等兜底）。
   */
  releaseLease(leaseId: string): boolean {
    const rec = this.leases.get(leaseId);
    if (!rec || rec.state !== "active") return false;
    if (rec.inFlight) return false;
    rec.state = "released";
    if (this.config.budget !== null && rec.budgetReserved && this.budgetStore !== null) {
      rec.budgetReserved = false;
      const dayKey = utcDayKey(rec.lease.acquiredAtMs);
      void Promise.resolve(this.budgetStore.releaseReservation(dayKey, leaseId)).catch(() => {});
    }
    return true;
  }

  /**
   * 接线侧确认 provider 调用已结束（成功/失败/超时回调各调一次，幂等）。
   * 并发许可在此释放——超时路径不提前释放仍在途的许可。
   */
  confirmCallEnded(leaseId: string): boolean {
    const rec = this.leases.get(leaseId);
    if (!rec || !rec.inFlight) return false;
    rec.inFlight = false;
    this.releaseConcurrency(rec);
    return true;
  }

  /** 当前在途/租约统计（status/观测用，不含任何敏感信息）。 */
  stats(): {
    inflightGlobal: number;
    inflightPerMerchant: Record<string, number>;
    activeLeases: number;
  } {
    return {
      inflightGlobal: this.inflightGlobal,
      inflightPerMerchant: Object.fromEntries(this.inflightPerMerchant),
      activeLeases: [...this.leases.values()].filter((r) => r.state === "active").length,
    };
  }

  private releaseConcurrency(rec: LeaseRecord): void {
    if (!rec.counted) return;
    rec.counted = false;
    if (this.inflightGlobal > 0) this.inflightGlobal -= 1;
    const m = rec.lease.merchantId;
    const cur = this.inflightPerMerchant.get(m) ?? 0;
    if (cur <= 1) this.inflightPerMerchant.delete(m);
    else this.inflightPerMerchant.set(m, cur - 1);
  }

  private deny(reason: AiRuntimeBlockReason, detail: string): LeaseDecision {
    return { ok: false, reason, detail };
  }
}
