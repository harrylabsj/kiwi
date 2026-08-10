// 现实单调时钟（审查 BUG-01）：生产路径必须跟随墙钟、同进程严格单调。
import { describe, expect, it } from "vitest";
import { createMonotonicClock } from "../src/a2a/clock.js";

describe("createMonotonicClock（BUG-01）", () => {
  it("默认使用墙钟：返回时间接近现实时间，不是固定历史基准", () => {
    const clock = createMonotonicClock();
    const before = Date.now();
    const value = clock();
    const after = Date.now();
    const t = Date.parse(value);
    expect(Number.isFinite(t)).toBe(true);
    // 必须落在调用前后窗口内（修复前是 2026-08-07，远在窗口外）
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(after + 1000);
  });

  it("同一毫秒的多个事件仍严格递增（ledger 去重依赖）", () => {
    // 注入固定时间源：模拟同一毫秒内大量调用
    const clock = createMonotonicClock(() => Date.parse("2026-08-10T10:00:00.500Z"));
    const values: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      values.push(Date.parse(clock()));
    }
    let previous = values[0]!;
    for (let i = 1; i < values.length; i += 1) {
      const current = values[i]!;
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
    // 首个值 = 注入时刻（墙钟跟随，而非固定基准）
    expect(values[0]).toBe(Date.parse("2026-08-10T10:00:00.500Z"));
  });

  it("时间前进时跟随墙钟（不落后于现实时间）", () => {
    let t = Date.parse("2026-08-10T10:00:00.000Z");
    const clock = createMonotonicClock(() => t);
    expect(Date.parse(clock())).toBe(t);
    t = Date.parse("2026-08-10T11:00:00.000Z"); // 一小时后的墙钟
    expect(Date.parse(clock())).toBe(t);
  });

  it("重启（新实例）从墙钟重新起步，不回退到历史起点", () => {
    // 第一次运行的最后一个时间戳
    const first = createMonotonicClock(() => Date.parse("2026-08-10T10:00:00.000Z"));
    first();
    // "重启"后墙钟已到 11:00
    const second = createMonotonicClock(() => Date.parse("2026-08-10T11:00:00.000Z"));
    expect(Date.parse(second())).toBe(Date.parse("2026-08-10T11:00:00.000Z"));
  });
});
