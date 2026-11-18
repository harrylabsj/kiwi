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
 * 经营任务投影（设计 §15.2）。
 *
 * 把固定模板映射到本机持久数据，输出 no_change / eligible / data_incomplete。
 * 只读、无模型调用；查询失败或必需表缺失时 data_incomplete，绝不伪造
 * no_change。evidence_refs 只包含真实存在的机会/选项引用。
 */

import type { DatabaseSync } from "node:sqlite";
import type { AutomationRule, PrefilterResult } from "./service.js";

const OPEN_STATUSES = [
  "NEW",
  "NEEDS_INFO",
  "READY_FOR_PROPOSAL",
  "PENDING_APPROVAL",
  "WAITING_CUSTOMER",
  "RESULT_UNVERIFIED",
] as const;

const REQUIRED_TABLES = [
  "sales_opportunities",
  "opportunity_events",
  "proposal_options",
  "proposal_sets",
] as const;

export interface OperationsProjectionOptions {
  readonly db: DatabaseSync;
  readonly now: () => string;
  /** 每类最多投影的候选数（超出标记 truncated）。 */
  readonly max_candidates?: number;
}

export class OperationsProjection {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly limit: number;

  constructor(options: OperationsProjectionOptions) {
    this.db = options.db;
    this.now = options.now;
    this.limit = options.max_candidates ?? 20;
  }

  private missingTables(): string[] {
    try {
      const rows = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const names = new Set(rows.map((row) => row.name));
      return REQUIRED_TABLES.filter((table) => !names.has(table));
    } catch {
      return [...REQUIRED_TABLES];
    }
  }

  private window(rule: AutomationRule): { start: string; end: string } {
    const end = Date.parse(rule.next_due_at ?? this.now());
    const days = rule.scope.window === "last_7_days" ? 7 : 1;
    return {
      start: new Date(end - days * 86_400_000).toISOString(),
      end: new Date(end).toISOString(),
    };
  }

  prefilter(rule: AutomationRule): PrefilterResult {
    const missing = this.missingTables();
    if (missing.length > 0) {
      return {
        result: "data_incomplete",
        reason_code: "projection_unavailable",
        detail: { missing_tables: missing, template: rule.template },
      };
    }
    const window = this.window(rule);
    try {
      if (rule.template === "data_availability_check") {
        return {
          result: "no_change",
          detail: { template: rule.template, tables_ready: REQUIRED_TABLES.length },
        };
      }
      if (rule.template === "missing_info_draft") {
        return this.byStatuses(rule, ["NEEDS_INFO"], window);
      }
      if (rule.template === "quote_expiry_review") {
        return this.expiringQuotes(rule, window);
      }
      return this.byStatuses(rule, [...OPEN_STATUSES], window);
    } catch (err) {
      return {
        result: "data_incomplete",
        reason_code: "projection_read_failed",
        detail: {
          template: rule.template,
          error: err instanceof Error ? err.message.slice(0, 200) : "projection_error",
        },
      };
    }
  }

  private byStatuses(
    rule: AutomationRule,
    statuses: readonly string[],
    window: { start: string; end: string },
  ): PrefilterResult {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT opportunity_id, status, updated_at FROM sales_opportunities
          WHERE merchant_id = ? AND status IN (${placeholders})
          ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(rule.merchant_id, ...statuses, this.limit + 1) as Array<{
      opportunity_id: string;
      status: string;
      updated_at: string;
    }>;
    if (rows.length === 0) {
      return {
        result: "no_change",
        window_start: window.start,
        window_end: window.end,
        detail: { template: rule.template, candidates: 0 },
      };
    }
    const truncated = rows.length > this.limit;
    const visible = rows.slice(0, this.limit);
    return {
      result: "eligible",
      window_start: window.start,
      window_end: window.end,
      detail: {
        template: rule.template,
        candidates: rows.length,
        ...(truncated ? { truncated: true } : {}),
        candidate_refs: visible.map((row) => `opportunity:${row.opportunity_id}`),
        evidence_refs: visible.map((row) => `opportunity:${row.opportunity_id}`),
        statuses: visible.map((row) => ({ ref: row.opportunity_id, status: row.status })),
      },
    };
  }

  private expiringQuotes(
    rule: AutomationRule,
    window: { start: string; end: string },
  ): PrefilterResult {
    const horizon = new Date(Date.parse(window.end) + 72 * 3_600_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT o.set_id, o.option_id, o.valid_until FROM proposal_options o
          JOIN proposal_sets s ON s.set_id = o.set_id AND s.merchant_id = ?
          WHERE o.valid_until IS NOT NULL AND o.valid_until > ? AND o.valid_until <= ?
          ORDER BY o.valid_until ASC LIMIT ?`,
      )
      .all(rule.merchant_id, window.end, horizon, this.limit + 1) as Array<{
      set_id: string;
      option_id: string;
      valid_until: string;
    }>;
    if (rows.length === 0) {
      return {
        result: "no_change",
        window_start: window.start,
        window_end: window.end,
        detail: { template: rule.template, candidates: 0 },
      };
    }
    const visible = rows.slice(0, this.limit);
    return {
      result: "eligible",
      window_start: window.start,
      window_end: window.end,
      detail: {
        template: rule.template,
        candidates: rows.length,
        ...(rows.length > this.limit ? { truncated: true } : {}),
        candidate_refs: visible.map((row) => `proposal:${row.set_id}:${row.option_id}`),
        evidence_refs: visible.map((row) => `proposal:${row.set_id}:${row.option_id}`),
        expiring: visible,
      },
    };
  }
}
