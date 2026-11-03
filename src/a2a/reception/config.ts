/**
 * 接待 P0a 的 M0 冻结配置（设计 §18 / §21.1 / D07、D08、D10）。
 *
 * 这里集中承载试点初值，避免预算、期限、留存散落在各模块常量里。
 * 环境变量只能覆盖数值，不能改变业务边界（语言、货币、动作权限）。
 */

export type ReceptionMode = "off" | "advisory" | "active";
export type ReceptionRuntimeKind = "deterministic" | "pi";

export interface ReceptionConfig {
  mode: ReceptionMode;
  /** M2：确定性解释器或 Pi 工具循环；默认确定性。 */
  runtime: ReceptionRuntimeKind;
  /** D05：P0a 仅 zh-CN / CNY。 */
  locale: "zh-CN";
  currency: "CNY";
  /** D07/§18：每商家每日 output token 上限。 */
  dailyOutputTokenLimit: number;
  /** §18：每次 provider attempt 的输出预约额（未知用量按此保留）。 */
  attemptReserveTokens: number;
  /** D07：单次 run 硬截止（毫秒）。 */
  runDeadlineMs: number;
  /** D07：单 run 最多逻辑模型回合。 */
  maxModelTurns: number;
  /** D07：单 run 最多工具尝试。 */
  maxToolAttempts: number;
  /** D08/§17.1：审批等待期限（秒）。 */
  approvalTtlSeconds: number;
  /** D10：会话原文/需求保留天数。 */
  retentionDays: number;
  /** D10：联系字段保留天数（P0a 尚未单独收集联系字段，先冻结口径）。 */
  contactRetentionDays: number;
  /** D10：用量记录保留天数。 */
  usageRetentionDays: number;
}

export const RECEPTION_CONFIG_DEFAULTS: Readonly<ReceptionConfig> = Object.freeze({
  mode: "off",
  runtime: "deterministic",
  locale: "zh-CN",
  currency: "CNY",
  dailyOutputTokenLimit: 200_000,
  attemptReserveTokens: 2_048,
  runDeadlineMs: 30_000,
  maxModelTurns: 6,
  maxToolAttempts: 12,
  approvalTtlSeconds: 900,
  retentionDays: 30,
  contactRetentionDays: 7,
  usageRetentionDays: 90,
});

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    process.stderr.write(`⚠️ [kiwi] ${name}=${raw} 不是正整数，使用默认值 ${fallback}\n`);
    return fallback;
  }
  return value;
}

function modeOf(raw: string | undefined): ReceptionMode {
  return raw === "active" || raw === "advisory" ? raw : "off";
}

/** 读取 M0 配置；非法数值回退默认值并告警（不静默改变业务边界）。 */
export function loadReceptionConfig(
  env: Record<string, string | undefined> = process.env,
): ReceptionConfig {
  const d = RECEPTION_CONFIG_DEFAULTS;
  return {
    ...d,
    mode: modeOf(env.KIWI_MERCHANT_RECEPTION),
    runtime: env.KIWI_RECEPTION_RUNTIME === "pi" ? "pi" : "deterministic",
    dailyOutputTokenLimit: positiveInt(
      env.KIWI_RECEPTION_DAILY_TOKEN_LIMIT,
      d.dailyOutputTokenLimit,
      "KIWI_RECEPTION_DAILY_TOKEN_LIMIT",
    ),
    runDeadlineMs: positiveInt(
      env.KIWI_RECEPTION_DEADLINE_MS,
      d.runDeadlineMs,
      "KIWI_RECEPTION_DEADLINE_MS",
    ),
    maxModelTurns: positiveInt(
      env.KIWI_RECEPTION_MAX_MODEL_TURNS,
      d.maxModelTurns,
      "KIWI_RECEPTION_MAX_MODEL_TURNS",
    ),
    maxToolAttempts: positiveInt(
      env.KIWI_RECEPTION_MAX_TOOL_ATTEMPTS,
      d.maxToolAttempts,
      "KIWI_RECEPTION_MAX_TOOL_ATTEMPTS",
    ),
    approvalTtlSeconds: positiveInt(
      env.KIWI_RECEPTION_APPROVAL_TTL_SECONDS,
      d.approvalTtlSeconds,
      "KIWI_RECEPTION_APPROVAL_TTL_SECONDS",
    ),
    retentionDays: positiveInt(
      env.KIWI_RECEPTION_RETENTION_DAYS,
      d.retentionDays,
      "KIWI_RECEPTION_RETENTION_DAYS",
    ),
  };
}
