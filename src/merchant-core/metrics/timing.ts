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
 * 试点计时与效率指标（v0.2 §21.2 / AC20）。
 *
 * 纯函数：主动人工人时只累加 active_start→pause/active_end 区间；等待客户/
 * 审批不算主动人时。改善率中位数、P90 与错误率均按冻结口径计算，不以平均
 * 值替代。缺失计时标缺失，不填 0。
 */

export type TimingEventKind =
  | "task_start"
  | "active_start"
  | "pause"
  | "resume"
  | "active_end"
  | "task_complete";

export interface TimingEvent {
  kind: TimingEventKind;
  at: string;
  actor?: string;
  task_id?: string;
  reason?: string;
}

export interface TimingSummary {
  active_ms: number;
  duration_ms: number | null;
  missing: string[];
}

function parseTime(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 计算主动人时与端到端历时。事件必须按时间排序；乱序/缺开始时间时
 * 返回 missing 原因，不猜测。
 */
export function summarizeTiming(events: readonly TimingEvent[]): TimingSummary {
  let activeStart: number | null = null;
  let taskStart: number | null = null;
  let taskEnd: number | null = null;
  let activeMs = 0;
  const missing: string[] = [];

  const sorted = [...events].sort((a, b) => (parseTime(a.at) ?? 0) - (parseTime(b.at) ?? 0));
  for (const event of sorted) {
    const at = parseTime(event.at);
    if (at === null) {
      missing.push(`invalid_time:${event.kind}`);
      continue;
    }
    switch (event.kind) {
      case "task_start":
        taskStart = at;
        break;
      case "active_start":
      case "resume":
        if (activeStart !== null) missing.push(`duplicate_active_start:${event.kind}`);
        activeStart = at;
        break;
      case "pause":
      case "active_end":
        if (activeStart === null) {
          missing.push(`active_end_without_start:${event.kind}`);
        } else if (at < activeStart) {
          missing.push(`active_end_before_start:${event.kind}`);
        } else {
          activeMs += at - activeStart;
          activeStart = null;
        }
        break;
      case "task_complete":
        taskEnd = at;
        break;
    }
  }
  if (activeStart !== null) missing.push("active_not_ended");
  if (taskStart === null) missing.push("missing_task_start");
  if (taskEnd === null) missing.push("missing_task_complete");

  return {
    active_ms: activeMs,
    duration_ms:
      taskStart !== null && taskEnd !== null && taskEnd >= taskStart ? taskEnd - taskStart : null,
    missing,
  };
}

/** 升序第 ceil(p/100 × n) 项；空数组返回 null。p 在 (0,100]。 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!Number.isFinite(p) || p <= 0 || p > 100) throw new Error("percentile p must be in (0,100]");
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))]!;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export interface MatchedTaskPair {
  pair_id: string;
  original_active_ms: number;
  kiwi_active_ms: number;
  /** 未完成样本单列，不伪作完成。 */
  completed?: boolean;
}

export interface ImprovementSummary {
  sample_count: number;
  completed_count: number;
  incomplete_count: number;
  median_improvement_rate: number | null;
  original_median_ms: number | null;
  kiwi_median_ms: number | null;
  original_p90_ms: number | null;
  kiwi_p90_ms: number | null;
  missing_pairs: number;
}

/** 改善率 r = (T原 − T新) / T原；T原必须 > 0；中位数按 §21.2 口径。 */
export function summarizeMatchedPairs(pairs: readonly MatchedTaskPair[]): ImprovementSummary {
  const completed = pairs.filter((pair) => pair.completed !== false);
  const rates: number[] = [];
  const originals: number[] = [];
  const kiwi: number[] = [];
  let missing = 0;
  for (const pair of completed) {
    if (
      !Number.isFinite(pair.original_active_ms) ||
      !Number.isFinite(pair.kiwi_active_ms) ||
      pair.original_active_ms <= 0 ||
      pair.kiwi_active_ms < 0
    ) {
      missing += 1;
      continue;
    }
    rates.push((pair.original_active_ms - pair.kiwi_active_ms) / pair.original_active_ms);
    originals.push(pair.original_active_ms);
    kiwi.push(pair.kiwi_active_ms);
  }
  return {
    sample_count: pairs.length,
    completed_count: completed.length,
    incomplete_count: pairs.length - completed.length,
    median_improvement_rate: median(rates),
    original_median_ms: median(originals),
    kiwi_median_ms: median(kiwi),
    original_p90_ms: percentile(originals, 90),
    kiwi_p90_ms: percentile(kiwi, 90),
    missing_pairs: missing,
  };
}
