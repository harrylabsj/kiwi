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
 * A2A Server 反滥用限流（WP3，基线 §31）。零新增依赖。
 *
 * 覆盖威胁清单：
 *   - RFQ spam / price scraping  → 双维度滑动窗口限流（per-identity + per-domain）；
 *   - resource exhaustion         → task concurrency limit（单身份在途任务上限）；
 *   - malformed schema floods     → malformed-request budget（schema_invalid 超预算
 *                                  临时拒绝该来源，预算独立于正常限流，窗口滑动即恢复）；
 *   - identity cycling            → 未验签身份按 remoteAddress 计数（IP 比可轮换的
 *                                  匿名身份更难伪造），且未验签限额严格于验签身份；
 *   - capability probing / 高信任对端 → trust-based throttling：trust level 映射限流
 *                                  档位（T0 最严 / T3 最宽，档位表可配置，确定性）。
 *
 * 时钟：`now()` 返回 unix 毫秒，可注入（默认 Date.now）。所有窗口判定在 injected
 * 时钟下完全确定，窗口边界为 `entry <= now - windowMs` 即过期（半开窗口）。
 *
 * 判定顺序（全部 fail-closed，基线 §4.6）：
 *   1. malformed budget 阻断（该来源或该域预算耗尽 → rate_limited）；
 *   2. per-identity 限流（档位速率）；
 *   3. per-domain 限流（有 domain 时）；
 *   4. 并发槽（enterTask，超限 → rate_limited）。
 * 拒绝只走既有错误码表 rate_limited（errors.ts），并携带 retry_after（秒），
 * 对齐 UCP 429/503 的 backoff 语义。
 */

import {
  conservativeLevel,
  isTrustLevel,
  TRUST_LEVELS,
  type TrustLevel,
} from "../../trust/identity/trust-policy.js";

// ---------------------------------------------------------------------------
// 档位表
// ---------------------------------------------------------------------------

/** 单个 trust 档位的限流参数（全部为窗口内数值，窗口见 windowMs）。 */
export interface TrustTierLimits {
  /** 单位窗口内每身份（或未验签时每 remoteAddress）最多允许的请求数。 */
  identityRequestsPerWindow: number;
  /** 单位窗口内每域名最多允许的请求数（跨身份共享）。 */
  domainRequestsPerWindow: number;
  /** 单身份在途 A2A Task（并发处理中请求）上限。 */
  maxConcurrentTasks: number;
  /** malformed budget：窗口内 schema_invalid 达此值即临时拒绝该来源。 */
  malformedBudget: number;
  /** 拒绝时建议的 retry_after 秒数（UCP 429/503 语义）。 */
  retryAfterSeconds: number;
}

/** T0-T3 档位表：T0 最严 / T3 最宽（基线 §28 / §31）。 */
export type ThrottleTierTable = Record<TrustLevel, TrustTierLimits>;

/** 默认档位表（每 60s 窗口；部署方可覆盖任意档位）。 */
export const DEFAULT_THROTTLE_TIERS: ThrottleTierTable = {
  T0: {
    identityRequestsPerWindow: 10,
    domainRequestsPerWindow: 20,
    maxConcurrentTasks: 2,
    malformedBudget: 5,
    retryAfterSeconds: 5,
  },
  T1: {
    identityRequestsPerWindow: 30,
    domainRequestsPerWindow: 60,
    maxConcurrentTasks: 4,
    malformedBudget: 8,
    retryAfterSeconds: 2,
  },
  T2: {
    identityRequestsPerWindow: 60,
    domainRequestsPerWindow: 120,
    maxConcurrentTasks: 8,
    malformedBudget: 12,
    retryAfterSeconds: 1,
  },
  T3: {
    identityRequestsPerWindow: 120,
    domainRequestsPerWindow: 240,
    maxConcurrentTasks: 16,
    malformedBudget: 20,
    retryAfterSeconds: 1,
  },
};

export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_UNVERIFIED_SCALE = 0.5;

export interface ThrottleOptions {
  /** 滑动窗口（毫秒，默认 60_000）。 */
  windowMs?: number;
  /** 档位表覆盖（部分档位即可，其余用默认）。 */
  tiers?: Partial<ThrottleTierTable>;
  /**
   * 未验签来源的 identity/concurrency 限流缩窄系数 (0,1]。
   * 默认 0.5 —— 匿名来源限额严格于验签身份（§31 identity cycling 缓解）。
   */
  unverifiedIdentityScale?: number;
  /** 时钟（unix 毫秒）；可注入便于确定性测试。默认 Date.now。 */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// 请求上下文
// ---------------------------------------------------------------------------

export interface ThrottleRequest {
  /** 认证身份（验签身份或回落值）。 */
  identity: string;
  /** 对端域名（per-domain 维度；由 UCP-Agent profile host 派生，缺省跳过该维度）。 */
  domain?: string;
  /** 对端 socket 地址；未验签时作为 per-identity 主键。 */
  remoteAddress?: string;
  /** 身份是否经过验签（false/缺省 = 匿名/回落 → 按 remoteAddress 且限额更严）。 */
  identityVerified?: boolean;
  /** 对端 trust level（T0-T3）；缺省 T0（最严，fail-closed）。 */
  trustLevel?: TrustLevel;
  /** WP1 指纹变更短期降档信号：生效期间档位封顶 T1。 */
  fingerprintChanged?: boolean;
}

export type ThrottleDecision =
  { allowed: true } | { allowed: false; retryAfterSeconds: number; reason: string };

export type TaskSlotResult =
  { ok: true } | { ok: false; retryAfterSeconds: number; reason: string };

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 从对端 UCP-Agent 头声明的 platform profile URI 派生 domain（host）。 */
export function domainFromUcpProfile(profileUrl?: string): string | undefined {
  if (profileUrl === undefined || profileUrl === "") return undefined;
  let url: URL;
  try {
    url = new URL(profileUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase();
  return host.length > 0 ? host : undefined;
}

function assertValidTier(level: TrustLevel, tier: TrustTierLimits): void {
  const fields: Array<[string, number]> = [
    ["identityRequestsPerWindow", tier.identityRequestsPerWindow],
    ["domainRequestsPerWindow", tier.domainRequestsPerWindow],
    ["maxConcurrentTasks", tier.maxConcurrentTasks],
    ["malformedBudget", tier.malformedBudget],
    ["retryAfterSeconds", tier.retryAfterSeconds],
  ];
  for (const [name, value] of fields) {
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(
        `A2AServerThrottle: tier ${level} ${name} must be a non-negative integer (got ${value})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// A2AServerThrottle
// ---------------------------------------------------------------------------

/**
 * 反滥用限流引擎。每个维度各自独立的滑动窗口计数器；malformed budget 独立于
 * 正常限流（独立 map、独立判定），窗口滑动后自动恢复。
 *
 * 线程/并发模型：所有计数在单事件循环内同步访问（node 单线程），无需锁。
 */
export class A2AServerThrottle {
  private readonly windowMs: number;
  private readonly tiers: ThrottleTierTable;
  private readonly unverifiedScale: number;
  private readonly now: () => number;

  /** per-identity 主键（或未验签时的 remoteAddress 主键）→ 已放行时间戳。 */
  private readonly identityWindow = new Map<string, number[]>();
  /** domain 主键 → 已放行时间戳。 */
  private readonly domainWindow = new Map<string, number[]>();
  /** 来源主键（identity/addr + domain）→ schema_invalid 时间戳（malformed budget）。 */
  private readonly malformedWindow = new Map<string, number[]>();
  /** per-identity 主键 → 当前在途任务数。 */
  private readonly inflight = new Map<string, number>();

  constructor(options: ThrottleOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    if (!Number.isFinite(this.windowMs) || this.windowMs <= 0) {
      throw new TypeError("A2AServerThrottle: windowMs must be a positive number");
    }
    this.unverifiedScale = options.unverifiedIdentityScale ?? DEFAULT_UNVERIFIED_SCALE;
    if (
      !Number.isFinite(this.unverifiedScale) ||
      this.unverifiedScale <= 0 ||
      this.unverifiedScale > 1
    ) {
      throw new TypeError("A2AServerThrottle: unverifiedIdentityScale must be in (0, 1]");
    }
    this.tiers = { ...DEFAULT_THROTTLE_TIERS, ...options.tiers };
    for (const level of TRUST_LEVELS) assertValidTier(level, this.tiers[level]);
    this.now = options.now ?? (() => Date.now());
  }

  // -- 键派生 ----------------------------------------------------------------

  /**
   * per-identity 主键：验签身份用 identity；未验签用 remoteAddress（identity
   * cycling 缓解 —— 换匿名身份逃不掉同一 IP 的限额）。无 remoteAddress 时回落
   * identity（此时 identity 即来源标识）。
   */
  private identityKeyOf(req: ThrottleRequest): string {
    if (req.identityVerified === true) return `id:${req.identity}`;
    return `addr:${req.remoteAddress ?? req.identity}`;
  }

  private domainKeyOf(domain: string): string {
    return `dom:${domain}`;
  }

  /**
   * 解析请求生效档位。trust level 缺省 T0（最严，fail-closed）；WP1 指纹变更
   * 短期降档（封顶 T1）；未验签来源缩窄 identity/concurrency 限流。
   */
  private resolveTier(req: ThrottleRequest): TrustTierLimits {
    const level =
      req.trustLevel !== undefined && isTrustLevel(req.trustLevel) ? req.trustLevel : "T0";
    const effective = req.fingerprintChanged === true ? conservativeLevel(level, "T1") : level;
    let tier = this.tiers[effective];
    if (req.identityVerified !== true) {
      const scale = this.unverifiedScale;
      tier = {
        ...tier,
        identityRequestsPerWindow: Math.max(1, Math.floor(tier.identityRequestsPerWindow * scale)),
        maxConcurrentTasks: Math.max(1, Math.floor(tier.maxConcurrentTasks * scale)),
      };
    }
    return tier;
  }

  // -- 滑动窗口原语 ----------------------------------------------------------

  /** 取窗口内条目并就地修剪过期项（`entry <= now - windowMs` 即过期，半开窗口）。 */
  private windowEntries(map: Map<string, number[]>, key: string, now: number): number[] {
    const raw = map.get(key);
    if (raw === undefined || raw.length === 0) return [];
    const cutoff = now - this.windowMs;
    let start = 0;
    while (start < raw.length && raw[start]! <= cutoff) start += 1;
    if (start === 0) return raw;
    const kept = raw.slice(start);
    if (kept.length === 0) map.delete(key);
    else map.set(key, kept);
    return kept;
  }

  private exceedsLimit(
    map: Map<string, number[]>,
    key: string,
    limit: number,
    now: number,
  ): boolean {
    return this.windowEntries(map, key, now).length >= limit;
  }

  private record(map: Map<string, number[]>, key: string, now: number): void {
    const arr = this.windowEntries(map, key, now);
    arr.push(now);
    map.set(key, arr);
  }

  // -- 公开判定 --------------------------------------------------------------

  /**
   * 限流判定（consume：允许的请求计入各自窗口）。判定顺序：malformed budget 阻断 →
   * per-identity → per-domain。拒绝携带档位 retry_after。
   */
  check(req: ThrottleRequest): ThrottleDecision {
    const tier = this.resolveTier(req);
    const now = this.now();
    const idKey = this.identityKeyOf(req);

    if (this.isMalformedBlocked(idKey, tier.malformedBudget, now)) {
      return {
        allowed: false,
        retryAfterSeconds: tier.retryAfterSeconds,
        reason: "malformed request budget exhausted for source",
      };
    }
    if (
      req.domain !== undefined &&
      this.isMalformedBlocked(this.domainKeyOf(req.domain), tier.malformedBudget, now)
    ) {
      return {
        allowed: false,
        retryAfterSeconds: tier.retryAfterSeconds,
        reason: `malformed request budget exhausted for domain "${req.domain}"`,
      };
    }
    if (this.exceedsLimit(this.identityWindow, idKey, tier.identityRequestsPerWindow, now)) {
      return {
        allowed: false,
        retryAfterSeconds: tier.retryAfterSeconds,
        reason: "per-identity rate limit exceeded",
      };
    }
    if (
      req.domain !== undefined &&
      this.exceedsLimit(
        this.domainWindow,
        this.domainKeyOf(req.domain),
        tier.domainRequestsPerWindow,
        now,
      )
    ) {
      return {
        allowed: false,
        retryAfterSeconds: tier.retryAfterSeconds,
        reason: `per-domain rate limit exceeded for domain "${req.domain}"`,
      };
    }
    this.record(this.identityWindow, idKey, now);
    if (req.domain !== undefined) this.record(this.domainWindow, this.domainKeyOf(req.domain), now);
    return { allowed: true };
  }

  /**
   * malformed-request budget：记录一次 schema_invalid（该来源 + 该域）。
   * 与正常限流独立（独立计数器），由 pipeline 在 schema 拒绝时喂入。
   */
  recordMalformed(req: ThrottleRequest): void {
    const now = this.now();
    this.record(this.malformedWindow, this.identityKeyOf(req), now);
    if (req.domain !== undefined) {
      this.record(this.malformedWindow, this.domainKeyOf(req.domain), now);
    }
  }

  /** 单身份在途任务槽：超限返回拒绝（rate_limited）。 */
  enterTask(req: ThrottleRequest): TaskSlotResult {
    const tier = this.resolveTier(req);
    const key = this.identityKeyOf(req);
    const current = this.inflight.get(key) ?? 0;
    if (current >= tier.maxConcurrentTasks) {
      return {
        ok: false,
        retryAfterSeconds: tier.retryAfterSeconds,
        reason: "task concurrency limit exceeded",
      };
    }
    this.inflight.set(key, current + 1);
    return { ok: true };
  }

  /** 释放在途任务槽（请求处理结束时由 pipeline 调用，幂等）。 */
  leaveTask(req: ThrottleRequest): void {
    const key = this.identityKeyOf(req);
    const current = this.inflight.get(key);
    if (current === undefined || current <= 0) return;
    if (current === 1) this.inflight.delete(key);
    else this.inflight.set(key, current - 1);
  }

  private isMalformedBlocked(key: string, budget: number, now: number): boolean {
    return this.windowEntries(this.malformedWindow, key, now).length >= budget;
  }
}
