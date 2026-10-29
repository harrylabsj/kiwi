/**
 * 试点计时与效率（v0.2 §21.2 / AC16/AC20）。
 */
import { describe, expect, it } from "vitest";

import {
  median,
  percentile,
  summarizeMatchedPairs,
  summarizeTiming,
  type TimingEvent,
} from "../src/merchant-core/metrics/timing.js";

const at = (h: number, m: number) => `2026-10-29T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

describe("summarizeTiming", () => {
  it("只累加主动区间；等待客户/审批不计入人时", () => {
    const events: TimingEvent[] = [
      { kind: "task_start", at: at(9, 0) },
      { kind: "active_start", at: at(9, 1) },
      { kind: "pause", at: at(9, 10) },
      { kind: "resume", at: at(9, 20) },
      { kind: "active_end", at: at(9, 30) },
      { kind: "task_complete", at: at(9, 40) },
    ];
    expect(summarizeTiming(events)).toEqual({
      active_ms: 19 * 60_000,
      duration_ms: 40 * 60_000,
      missing: [],
    });
  });

  it("缺失/重复/乱序的计时如实标记，不填 0", () => {
    const missing = summarizeTiming([
      { kind: "task_start", at: at(9, 0) },
      { kind: "active_start", at: at(9, 1) },
      { kind: "pause", at: at(9, 0) },
    ]);
    expect(missing.missing).toContain("active_end_without_start:pause");
    expect(missing.missing).toContain("active_not_ended");
    expect(missing.missing).toContain("missing_task_complete");
    expect(missing.duration_ms).toBeNull();
  });
});

describe("统计口径", () => {
  it("中位数偶数取两中值平均；P90 取升序第 ceil(0.9n) 项", () => {
    expect(median([10, 20])).toBe(15);
    expect(median([30, 10, 20])).toBe(20);
    expect(percentile([10, 20, 30, 40, 50], 90)).toBe(50);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90)).toBe(90);
    expect(percentile([], 90)).toBeNull();
  });

  it("匹配任务对：改善率中位数、P90、未完成与缺失样本单列", () => {
    const summary = summarizeMatchedPairs([
      { pair_id: "a", original_active_ms: 100, kiwi_active_ms: 50 },
      { pair_id: "b", original_active_ms: 200, kiwi_active_ms: 100 },
      { pair_id: "c", original_active_ms: 300, kiwi_active_ms: 240 },
      { pair_id: "d", original_active_ms: 400, kiwi_active_ms: 100, completed: false },
      { pair_id: "e", original_active_ms: 0, kiwi_active_ms: 10 },
    ]);
    expect(summary.sample_count).toBe(5);
    expect(summary.incomplete_count).toBe(1);
    expect(summary.missing_pairs).toBe(1);
    expect(summary.completed_count).toBe(4);
    // 三个有效改善率：50%、50%、20% → 中位数 50%
    expect(summary.median_improvement_rate).toBeCloseTo(0.5);
    expect(summary.original_median_ms).toBe(200);
    expect(summary.kiwi_median_ms).toBe(100);
    expect(summary.original_p90_ms).toBe(300);
  });
});
