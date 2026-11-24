/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { nextDailyDueAt, type OperationsJobsService } from "../merchant-core/operations-jobs/service.js";

const HOUR = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

export function ownerWeekdayDigest(text: string, timezone: string, now: number) {
  const match = /^工作日(?:(上午|下午)([一二三四五六七八九十]{1,2}|\d{1,2})点(半)?|([01]\d|2[0-3]):([0-5]\d))[，,\s]*(?:把)?待回复询价(?:日报|摘要)?(?:发给我|生成日报|生成摘要)[。！!]?$/.exec(text.trim());
  if (match === null) return undefined;
  let time: string;
  if (match[1] !== undefined) {
    const hour = /^\d+$/.test(match[2] ?? "") ? Number(match[2]) : HOUR.indexOf(match[2] ?? "");
    if (hour < 1 || hour > 12) return undefined;
    time = `${String(hour % 12 + (match[1] === "下午" ? 12 : 0)).padStart(2, "0")}:${match[3] === "半" ? "30" : "00"}`;
  } else {
    time = `${match[4]}:${match[5]}`;
  }
  const prepare = {
    mode: "goal", template: "unfinished_inquiry_digest",
    trigger_spec: { kind: "daily_local", local_time: time, timezone, day_filter: "weekdays" },
    scope: { window: "last_7_days" },
    predicate_spec: { kind: "fixed_template", template: "unfinished_inquiry_digest" },
    action_type: "internal_summary", budget: { max_runs_per_day: 1 }, goal_text: "工作日待回复询价日报",
  } as const satisfies Omit<Parameters<OperationsJobsService["prepareRule"]>[0], "merchant_id">;
  return { prepare, next_due_at: nextDailyDueAt({ ...prepare.trigger_spec, now: new Date(now).toISOString() }), delivery: "workbench_only" as const };
}
