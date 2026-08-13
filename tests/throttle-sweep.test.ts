/**
 * K-L3 回归：限流 Map 键驱逐——windowEntries 只在再次访问该键时修剪，一次性
 * 身份轮换的键永不再次访问、永久残留（长驻服务内存无界增长）。周期 sweep
 * 全量清理已过期窗口的键。
 */
import { describe, expect, it } from "vitest";
import { A2AServerThrottle } from "../src/a2a/server/throttle.js";

describe("A2AServerThrottle sweep（K-L3 内存有界）", () => {
  it("过期身份键在 sweep 后被驱逐", () => {
    let now = 1_000_000;
    const throttle = new A2AServerThrottle({
      windowMs: 60_000,
      sweepIntervalMs: 60_000,
      now: () => now,
    });
    // 一次性身份：record 一次后永不再访问（K-L3 修复前这些键永久残留）。
    for (let i = 0; i < 10; i++) {
      const d = throttle.check({ identity: `idle-${i}` });
      expect(d.allowed).toBe(true);
    }
    expect(throttle.debugIdentityWindowSize).toBe(10);
    // 时间推进超过窗口 + 清扫周期 → 下一次 check 触发全量 sweep。
    now += 120_000;
    const d = throttle.check({ identity: "active" });
    expect(d.allowed).toBe(true);
    // idle 键已驱逐，只剩 active（内存有界于最近活跃身份）。
    expect(throttle.debugIdentityWindowSize).toBe(1);
  });

  it("活跃身份限流不受 sweep 影响", () => {
    let now = 1_000_000;
    const throttle = new A2AServerThrottle({
      windowMs: 60_000,
      sweepIntervalMs: 60_000,
      tiers: {
        T0: { identityRequestsPerWindow: 1, domainRequestsPerWindow: 10, maxConcurrentTasks: 2, malformedBudget: 3, retryAfterSeconds: 5 },
        T1: { identityRequestsPerWindow: 1, domainRequestsPerWindow: 10, maxConcurrentTasks: 2, malformedBudget: 3, retryAfterSeconds: 5 },
        T2: { identityRequestsPerWindow: 1, domainRequestsPerWindow: 10, maxConcurrentTasks: 2, malformedBudget: 3, retryAfterSeconds: 5 },
        T3: { identityRequestsPerWindow: 1, domainRequestsPerWindow: 10, maxConcurrentTasks: 2, malformedBudget: 3, retryAfterSeconds: 5 },
      },
      now: () => now,
    });
    const first = throttle.check({ identity: "busy" });
    expect(first.allowed).toBe(true);
    const second = throttle.check({ identity: "busy" });
    expect(second.allowed).toBe(false); // 限流仍生效
  });
});
