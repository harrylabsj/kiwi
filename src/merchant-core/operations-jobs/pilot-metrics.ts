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
 * 试点观测口径（设计 v1.1 §20.2 / M5）。
 *
 * 只从持久记录计算可复核计数与比率；不读取客户正文、密钥或底价。
 * 分母为 0 时返回 null（显示为“无数据”），不伪造 0 或 100%。
 */

import type { DatabaseSync } from "node:sqlite";

export interface PilotMetric {
  readonly numerator: number;
  readonly denominator: number;
  /** null = 无数据；不要用 0 冒充。 */
  readonly value: number | null;
  readonly note?: string;
}

export interface PilotMetricsReport {
  readonly merchant_id: string;
  readonly window_start: string | null;
  readonly window_end: string;
  readonly corrections: { readonly total: number; readonly rejected: number };
  readonly repeat_correction_rate: PilotMetric;
  readonly candidates: {
    readonly total: number;
    readonly ready_for_review: number;
    readonly evaluation_failed: number;
    readonly stale: number;
  };
  readonly skills: {
    readonly active_releases: number;
    readonly revoked_releases: number;
    readonly hard_gate_failures: number;
  };
  readonly memory: {
    readonly active: number;
    readonly candidates: number;
    readonly deleted: number;
  };
  readonly tasks: {
    readonly pending: number;
    readonly running: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly unknown: number;
    readonly budget_blocked_evaluations: number;
  };
  readonly accuracy_notes: readonly string[];
}

function ratio(numerator: number, denominator: number): PilotMetric {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
  };
}

export function computePilotMetrics(input: {
  db: DatabaseSync;
  merchantId: string;
  since?: string;
  until?: string;
}): PilotMetricsReport {
  const { db, merchantId } = input;
  const until = input.until ?? new Date().toISOString();
  const since = input.since ?? null;
  const timeFilter = (column: string): { sql: string; params: string[] } =>
    since === null
      ? { sql: `${column} <= ?`, params: [until] }
      : { sql: `${column} >= ? AND ${column} <= ?`, params: [since, until] };

  const count = (sql: string, params: Array<string | number>): number =>
    Number((db.prepare(sql).get(...params) as { n: number } | undefined)?.n ?? 0);

  const correctionWindow = timeFilter("created_at");
  const correctionsTotal = count(
    `SELECT COUNT(*) AS n FROM learning_corrections WHERE merchant_id = ? AND ${correctionWindow.sql}`,
    [merchantId, ...correctionWindow.params],
  );
  const rejections = count(
    `SELECT COUNT(*) AS n FROM learning_rejections WHERE merchant_id = ? AND ${correctionWindow.sql}`,
    [merchantId, ...correctionWindow.params],
  );
  // 重复纠错：同一 issue tag 在窗口内出现在多个纠正中；分子为“再次出现”
  // 的纠正数。tag 由商家选择，分类口径固定版本；沉默不视为正确。
  const repeatedRows = db
    .prepare(
      `SELECT COUNT(*) AS n FROM learning_corrections c
        WHERE c.merchant_id = ? AND ${correctionWindow.sql.replaceAll("created_at", "c.created_at")}
          AND EXISTS (
            SELECT 1 FROM learning_corrections prev, json_each(c.issue_tags_json) tag
             WHERE prev.merchant_id = c.merchant_id AND prev.correction_id != c.correction_id
               AND prev.created_at < c.created_at
               AND EXISTS (SELECT 1 FROM json_each(prev.issue_tags_json) ptag WHERE ptag.value = tag.value))`,
    )
    .get(merchantId, ...correctionWindow.params) as { n: number } | undefined;
  const correctionsWithTags = count(
    `SELECT COUNT(*) AS n FROM learning_corrections
      WHERE merchant_id = ? AND json_array_length(issue_tags_json) > 0
        AND ${correctionWindow.sql}`,
    [merchantId, ...correctionWindow.params],
  );

  const candidates = {
    total: count("SELECT COUNT(*) AS n FROM learning_candidates WHERE merchant_id = ?", [merchantId]),
    ready_for_review: count(
      "SELECT COUNT(*) AS n FROM learning_candidates WHERE merchant_id = ? AND state = 'READY_FOR_REVIEW'",
      [merchantId],
    ),
    evaluation_failed: count(
      "SELECT COUNT(*) AS n FROM learning_candidates WHERE merchant_id = ? AND state = 'EVALUATION_FAILED'",
      [merchantId],
    ),
    stale: count(
      "SELECT COUNT(*) AS n FROM learning_candidates WHERE merchant_id = ? AND state = 'STALE'",
      [merchantId],
    ),
  };

  const hardGateRows = db
    .prepare(
      "SELECT report_json FROM learning_evaluations WHERE merchant_id = ? AND report_json IS NOT NULL",
    )
    .all(merchantId) as unknown as Array<{ report_json: string }>;
  let hardGateFailures = 0;
  for (const row of hardGateRows) {
    const report = JSON.parse(row.report_json) as { hard_gate_failures?: number };
    hardGateFailures += Number(report.hard_gate_failures ?? 0);
  }

  const memory = {
    active: count(
      `SELECT COUNT(*) AS n FROM customer_memories WHERE merchant_id = ? AND state = 'active'
         AND expires_at > ?`,
      [merchantId, until],
    ),
    candidates: count(
      "SELECT COUNT(*) AS n FROM customer_memories WHERE merchant_id = ? AND state = 'candidate'",
      [merchantId],
    ),
    deleted: count(
      "SELECT COUNT(*) AS n FROM customer_memories WHERE merchant_id = ? AND state = 'deleted'",
      [merchantId],
    ),
  };

  const tasks = {
    pending: count(
      "SELECT COUNT(*) AS n FROM followup_tasks WHERE merchant_id = ? AND status IN ('PENDING','READY')",
      [merchantId],
    ),
    running: count(
      "SELECT COUNT(*) AS n FROM followup_tasks WHERE merchant_id = ? AND status = 'RUNNING'",
      [merchantId],
    ),
    succeeded: count(
      "SELECT COUNT(*) AS n FROM followup_tasks WHERE merchant_id = ? AND status = 'SUCCEEDED'",
      [merchantId],
    ),
    failed: count(
      "SELECT COUNT(*) AS n FROM followup_tasks WHERE merchant_id = ? AND status = 'FAILED'",
      [merchantId],
    ),
    unknown: count(
      "SELECT COUNT(*) AS n FROM followup_tasks WHERE merchant_id = ? AND status = 'UNKNOWN'",
      [merchantId],
    ),
    budget_blocked_evaluations: count(
      "SELECT COUNT(*) AS n FROM rule_evaluations WHERE merchant_id = ? AND reason_code LIKE 'budget:%'",
      [merchantId],
    ),
  };

  return {
    merchant_id: merchantId,
    window_start: since,
    window_end: until,
    corrections: { total: correctionsTotal, rejected: rejections },
    repeat_correction_rate: ratio(Number(repeatedRows?.n ?? 0), correctionsWithTags),
    candidates,
    skills: {
      active_releases: count(
        "SELECT COUNT(*) AS n FROM skill_releases WHERE merchant_id = ? AND state = 'ACTIVE'",
        [merchantId],
      ),
      revoked_releases: count(
        "SELECT COUNT(*) AS n FROM skill_releases WHERE merchant_id = ? AND state = 'REVOKED'",
        [merchantId],
      ),
      hard_gate_failures: hardGateFailures,
    },
    memory,
    tasks,
    accuracy_notes: [
      "重复纠错率按 issue_tags 再次出现近似计算；固定分类版本，沉默不视为正确。",
      "记忆有效续接率/无效追问率需要接待运行 trace 抽样，当前报告只给可用计数。",
      "任务成本按实际 usage 记录；usage_state=unknown 单独保留，不记为免费。",
      "日报按时率需要按 due_at/截至窗口分组，当前给 PENDING/RUNNING/SUCCEEDED 计数。",
    ],
  };
}
