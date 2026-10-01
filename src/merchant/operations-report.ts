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
 * 运营报告（WP11）：day | week | month 周期聚合 + 与上一周期对比。
 *
 * 数据来源与「不可得」纪律（任务书 WP11 §2）：
 *   - 去重买家 / 触达（询价）事件 / 磋商数 / SKU 热度 ← merchant stats-store
 *     （`<dataDir>/a2a/stats.sqlite`，与 intelligence default-backend 同源同路径）；
 *     文件不存在 → 对应指标 available=false（reason=merchant_stats_unavailable），
 *     页面显示「不可得」，不编造 0；
 *   - 达成非绑定协议数 / 进入人工处理数 ← A2A ledger 状态迁移事实；账本不可读
 *     → available=false（reason=negotiation_ledger_unavailable）；
 *   - 最近询价关键词：账本 message_received(inquiry/clarification) 的问题 code
 *     原文计数（不做 LLM 归纳——那是 WP8 的事），只统计当前窗口。
 *
 * 周期窗口一律 UTC（与 stats-store「天数一律 UTC」一致）；week 为 ISO 周
 * （周一为一周开始，与 intelligence metricBucket 同口径）。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { LedgerStore } from "../negotiation/ledger/index.js";
import { openMerchantStatsStore } from "./stats-store.js";
import { MerchantWorkbenchError } from "./workbench-service.js";

export const REPORT_PERIODS = ["day", "week", "month"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** 单指标：available=false 时页面显示「不可得」，绝不给编造数值。 */
export interface ReportMetric {
  available: boolean;
  value?: number;
  previous?: number;
  delta?: number;
  /** previous=0 时为 null（无法计算百分比）；previous 不可得时省略。 */
  change_pct?: number | null;
  reason?: "merchant_stats_unavailable" | "negotiation_ledger_unavailable";
}

export interface ReportWindow {
  /** 窗口起（含），UTC `YYYY-MM-DD`。 */
  since: string;
  /** 窗口止（不含），UTC `YYYY-MM-DD`。 */
  until_exclusive: string;
}

export interface MerchantOperationsReport {
  period: ReportPeriod;
  window: ReportWindow & { basis: "UTC" };
  previous_window: ReportWindow;
  generated_at: string;
  metrics: {
    distinct_buyers: ReportMetric;
    contact_events: ReportMetric;
    negotiations: ReportMetric;
    agreements_reached: ReportMetric;
    human_escalations: ReportMetric;
  };
  top_skus: Array<{
    sku: string;
    contact_events: number;
    distinct_buyers: number;
    negotiations: number;
  }>;
  /** 最近询价中出现的问题 code 原文计数（降序，前 20）。 */
  recent_inquiry_terms: Array<{ token: string; count: number }>;
  /** 日粒度触达序列（窗口内零填充；供页面画简单趋势）。 */
  series: Array<{ day: string; contact_events: number; negotiations: number }>;
}

export interface OperationsReportBuilder {
  build(period: ReportPeriod): MerchantOperationsReport;
}

export interface OperationsReportOptions {
  dataDir: string;
  now?: () => Date;
}

const TOP_SKU_LIMIT = 10;
const TOP_TERM_LIMIT = 20;
const DAY_MS = 86_400_000;

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function addDays(day: string, delta: number): string {
  return new Date(parseDay(day).getTime() + delta * DAY_MS).toISOString().slice(0, 10);
}

/**
 * day/week/month 周期窗口（UTC）。
 * - day：今天 00:00Z 起 1 天；
 * - week：本周周一 00:00Z 起 7 天（周日归上一周，ISO 口径）；
 * - month：本月 1 号 00:00Z 起到下月 1 号（1 月的上一周期跨年到上一年 12 月）。
 */
export function reportWindow(period: ReportPeriod, now: Date): { current: ReportWindow; previous: ReportWindow } {
  const today = utcDay(now);
  if (period === "day") {
    return {
      current: { since: today, until_exclusive: addDays(today, 1) },
      previous: { since: addDays(today, -1), until_exclusive: today },
    };
  }
  if (period === "week") {
    const weekday = parseDay(today).getUTCDay(); // 0=周日
    const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
    const monday = addDays(today, mondayOffset);
    return {
      current: { since: monday, until_exclusive: addDays(monday, 7) },
      previous: { since: addDays(monday, -7), until_exclusive: monday },
    };
  }
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const monthFirst = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;
  const nextMonth = month === 11 ? `${year + 1}-01-01` : `${year}-${String(month + 2).padStart(2, "0")}-01`;
  const prevMonthFirst =
    month === 0 ? `${year - 1}-12-01` : `${year}-${String(month).padStart(2, "0")}-01`;
  return {
    current: { since: monthFirst, until_exclusive: nextMonth },
    previous: { since: prevMonthFirst, until_exclusive: monthFirst },
  };
}

function daysBetween(window: ReportWindow): string[] {
  const days: string[] = [];
  for (let day = window.since; day < window.until_exclusive; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/** 有界窗口聚合（stats-store 的 windowTotals：SQL 内一次去重）。 */
function statsWindowTotals(
  store: ReturnType<typeof openMerchantStatsStore>,
  window: ReportWindow,
): { distinct_buyers: number; contact_events: number; negotiations: number } {
  return store.windowTotals(window.since, window.until_exclusive);
}

interface LedgerWindowCounts {
  agreements_reached: number;
  human_escalations: number;
  inquiryTokens: Map<string, number>;
}

/** 账本窗口计数（UTC 日落在 [since, until_exclusive) 内）。 */
function ledgerWindowCounts(ledgerDir: string, window: ReportWindow): LedgerWindowCounts {
  const ledger = new LedgerStore({ dir: ledgerDir });
  const agreements = new Set<string>();
  const escalations = new Set<string>();
  const inquiryTokens = new Map<string, number>();
  for (const negotiationId of ledger.listNegotiations()) {
    for (const event of ledger.events(negotiationId).map((item) => ledger.resolvePayload(item))) {
      const day = event.recorded_at.slice(0, 10);
      if (day < window.since || day >= window.until_exclusive) continue;
      if (event.state_transition?.to_phase === "AGREEMENT_REACHED") agreements.add(negotiationId);
      if (
        event.state_transition?.to_phase === "AWAITING_CLARIFICATION" ||
        event.event_kind === "handoff_candidate_created"
      ) {
        escalations.add(negotiationId);
      }
      if (event.event_kind === "message_received") {
        // 账本 wire_payload 是 KNP 扁平 payload（与 negotiation-observer 同形状，
        // A40-1）：inquiry/clarification 的问题直接在 payload.questions。
        const wire = event.wire_payload as
          | {
              action?: string;
              payload?: {
                questions?: Array<{ code?: string; field?: string }>;
              };
            }
          | undefined;
        const questions = wire?.payload?.questions;
        if (questions !== undefined && (wire?.action === "inquiry" || wire?.action === "clarification")) {
          for (const question of questions) {
            // inquiry 用 code，clarification 用 field；均为外部内容原文。
            const token = question?.code ?? question?.field;
            if (typeof token === "string" && token !== "") {
              inquiryTokens.set(token, (inquiryTokens.get(token) ?? 0) + 1);
            }
          }
        }
      }
    }
  }
  return {
    agreements_reached: agreements.size,
    human_escalations: escalations.size,
    inquiryTokens,
  };
}

function metric(
  current: number,
  previous: number,
): ReportMetric {
  return {
    available: true,
    value: current,
    previous,
    delta: current - previous,
    change_pct: previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10,
  };
}

function unavailableMetric(reason: ReportMetric["reason"]): ReportMetric {
  return { available: false, reason };
}

export function createOperationsReportBuilder(options: OperationsReportOptions): OperationsReportBuilder {
  const dataDir = options.dataDir;
  const now = options.now ?? (() => new Date());
  return {
    build(period: ReportPeriod): MerchantOperationsReport {
      const at = now();
      const { current, previous } = reportWindow(period, at);
      const statsPath = path.join(dataDir, "a2a", "stats.sqlite");
      const ledgerDir = path.join(dataDir, "a2a");
      let statsCurrent: ReturnType<typeof statsWindowTotals> | undefined;
      let statsPrevious: ReturnType<typeof statsWindowTotals> | undefined;
      let series: MerchantOperationsReport["series"] = [];
      let topSkus: MerchantOperationsReport["top_skus"] = [];
      if (existsSync(statsPath)) {
        const store = openMerchantStatsStore({ dbPath: statsPath });
        try {
          statsCurrent = statsWindowTotals(store, current);
          statsPrevious = statsWindowTotals(store, previous);
          const daily = new Map(store.dailySince(current.since).map((bucket) => [bucket.day, bucket]));
          series = daysBetween(current).map((day) => {
            const bucket = daily.get(day);
            return {
              day,
              contact_events: bucket?.contact_events ?? 0,
              negotiations: bucket?.negotiations ?? 0,
            };
          });
          topSkus = store.topSkus(current.since, TOP_SKU_LIMIT);
        } finally {
          store.close();
        }
      }
      let ledgerCounts: LedgerWindowCounts | undefined;
      let ledgerPrevious: LedgerWindowCounts | undefined;
      try {
        ledgerCounts = ledgerWindowCounts(ledgerDir, current);
        ledgerPrevious = ledgerWindowCounts(ledgerDir, previous);
      } catch {
        ledgerCounts = undefined;
        ledgerPrevious = undefined;
      }
      return {
        period,
        window: { ...current, basis: "UTC" },
        previous_window: previous,
        generated_at: at.toISOString(),
        metrics: {
          distinct_buyers:
            statsCurrent !== undefined && statsPrevious !== undefined
              ? metric(statsCurrent.distinct_buyers, statsPrevious.distinct_buyers)
              : unavailableMetric("merchant_stats_unavailable"),
          contact_events:
            statsCurrent !== undefined && statsPrevious !== undefined
              ? metric(statsCurrent.contact_events, statsPrevious.contact_events)
              : unavailableMetric("merchant_stats_unavailable"),
          negotiations:
            statsCurrent !== undefined && statsPrevious !== undefined
              ? metric(statsCurrent.negotiations, statsPrevious.negotiations)
              : unavailableMetric("merchant_stats_unavailable"),
          agreements_reached:
            ledgerCounts !== undefined && ledgerPrevious !== undefined
              ? metric(ledgerCounts.agreements_reached, ledgerPrevious.agreements_reached)
              : unavailableMetric("negotiation_ledger_unavailable"),
          human_escalations:
            ledgerCounts !== undefined && ledgerPrevious !== undefined
              ? metric(ledgerCounts.human_escalations, ledgerPrevious.human_escalations)
              : unavailableMetric("negotiation_ledger_unavailable"),
        },
        top_skus: topSkus,
        recent_inquiry_terms:
          ledgerCounts === undefined
            ? []
            : [...ledgerCounts.inquiryTokens.entries()]
                .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0])))
                .slice(0, TOP_TERM_LIMIT)
                .map(([token, count]) => ({ token, count })),
        series,
      };
    },
  };
}

/** 解析 period 查询参数；非法值抛 validation（由 API 层映射 400）。 */
export function parseReportPeriod(value: string | null): ReportPeriod {
  if (value === null || value === "") return "day";
  if ((REPORT_PERIODS as readonly string[]).includes(value)) return value as ReportPeriod;
  throw new MerchantWorkbenchError("validation", "period 必须是 day、week 或 month");
}
