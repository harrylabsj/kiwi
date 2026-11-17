/**
 * TOP1-3 M1：后台经营预算适配（设计 §20.1 / §22.1 M1）。
 * D-M0-09 冻结参数：20 run/天、100000/12000 token、单 run 预留 5000/600、
 * 后台并发 1；准入预留、对账、释放、重启不清零、未知用量保守占额。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import {
  BACKGROUND_BUDGET_LIMITS,
  BackgroundBudgetError,
  BackgroundBudgetStore,
  backgroundBudgetDayKey,
} from "../src/merchant-core/budget/background-budget.js";

const NOW = "2026-11-17T00:00:00.000Z";
const DAY = "2026-11-17";

function expectBudgetError(fn: () => unknown, code: string, reason: string): void {
  try {
    fn();
    expect.unreachable(`应抛出 ${code}/${reason}`);
  } catch (err) {
    expect(err).toBeInstanceOf(BackgroundBudgetError);
    const e = err as BackgroundBudgetError;
    expect(e.code).toBe(code);
    expect(e.reason).toContain(reason);
  }
}

describe("后台经营预算账本", () => {
  let db: DatabaseSync;
  let clock: string;
  let store: BackgroundBudgetStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    registerGovernanceLedgers(db);
    clock = NOW;
    store = new BackgroundBudgetStore({ db, now: () => clock });
  });
  afterEach(() => db.close());

  it("记账日按商家时区：UTC 与 Asia/Shanghai 跨日不同", () => {
    expect(backgroundBudgetDayKey("2026-11-17T12:00:00.000Z", "UTC")).toBe("2026-11-17");
    // UTC 16:00 = 上海次日 00:00。
    expect(backgroundBudgetDayKey("2026-11-17T16:00:00.000Z", "Asia/Shanghai")).toBe("2026-11-18");
    expectBudgetError(
      () => backgroundBudgetDayKey("2026-11-17T16:00:00.000Z", "Not/AZone"),
      "validation",
      "timezone_invalid",
    );
  });

  it("准入预留 → 结算差值记账 → 幂等重放", () => {
    const run = store.reserveRun({ merchant_id: "m-1", run_id: "run-1", day_key: DAY });
    expect(run.state).toBe("RESERVED");
    expect(run.input_reserved).toBe(BACKGROUND_BUDGET_LIMITS.run_input_reserve);
    expect(run.output_reserved).toBe(BACKGROUND_BUDGET_LIMITS.run_output_reserve);
    expect(store.getDayUsage("m-1", DAY)).toMatchObject({ runs_used: 1, input_used: 5000, output_used: 600 });

    const settled = store.settleRun({
      merchant_id: "m-1",
      run_id: "run-1",
      input_tokens: 1200,
      output_tokens: 300,
    });
    expect(settled).toMatchObject({
      state: "SETTLED",
      input_actual: 1200,
      output_actual: 300,
      usage_state: "known",
    });
    expect(store.getDayUsage("m-1", DAY)).toMatchObject({ runs_used: 1, input_used: 1200, output_used: 300 });

    // 重复结算 no-op（不二次调整账本）。
    const replay = store.settleRun({
      merchant_id: "m-1",
      run_id: "run-1",
      input_tokens: 9999,
      output_tokens: 9999,
    });
    expect(replay).toMatchObject({ state: "SETTLED", input_actual: 1200, output_actual: 300 });
    expect(store.getDayUsage("m-1", DAY)).toMatchObject({ input_used: 1200, output_used: 300 });

    // 重复预留同 run 幂等返回原记录。
    expect(
      store.reserveRun({ merchant_id: "m-1", run_id: "run-1", day_key: DAY }).state,
    ).toBe("SETTLED");
  });

  it("未发起的预留可释放：token 与 run 计数一并归还（幂等）", () => {
    store.reserveRun({ merchant_id: "m-1", run_id: "run-1", day_key: DAY });
    const released = store.releaseRun({ merchant_id: "m-1", run_id: "run-1" });
    expect(released.state).toBe("RELEASED");
    expect(store.getDayUsage("m-1", DAY)).toMatchObject({ runs_used: 0, input_used: 0, output_used: 0 });
    // 再次释放 no-op。
    expect(store.releaseRun({ merchant_id: "m-1", run_id: "run-1" }).state).toBe("RELEASED");
    expect(store.getDayUsage("m-1", DAY).runs_used).toBe(0);
  });

  it("未知用量按预留保守占额（不记为免费），且显式 token 不被采信", () => {
    store.reserveRun({ merchant_id: "m-1", run_id: "run-1", day_key: DAY });
    const settled = store.settleRun({
      merchant_id: "m-1",
      run_id: "run-1",
      input_tokens: 0,
      output_tokens: 0,
      usage_state: "unknown",
    });
    expect(settled).toMatchObject({
      usage_state: "unknown",
      input_actual: BACKGROUND_BUDGET_LIMITS.run_input_reserve,
      output_actual: BACKGROUND_BUDGET_LIMITS.run_output_reserve,
    });
    expect(store.getDayUsage("m-1", DAY)).toMatchObject({ input_used: 5000, output_used: 600 });
  });

  it("run_id 不得跨商家/记账日复用（replay_conflict）", () => {
    store.reserveRun({ merchant_id: "m-1", run_id: "run-1", day_key: DAY });
    expectBudgetError(
      () => store.reserveRun({ merchant_id: "m-2", run_id: "run-1", day_key: DAY }),
      "replay_conflict",
      "run_replay_conflict",
    );
    expectBudgetError(
      () => store.reserveRun({ merchant_id: "m-1", run_id: "run-1", day_key: "2026-11-18" }),
      "replay_conflict",
      "run_replay_conflict",
    );
  });

  it("后台并发每商家 1：在途时拒绝，结算后可再准入", () => {
    store.reserveRun({ merchant_id: "m-1", run_id: "run-1", day_key: DAY });
    expectBudgetError(
      () => store.reserveRun({ merchant_id: "m-1", run_id: "run-2", day_key: DAY }),
      "concurrency_limit",
      "background_concurrency",
    );
    // 另一商家不受影响。
    expect(
      store.reserveRun({ merchant_id: "m-2", run_id: "run-3", day_key: DAY }).merchant_id,
    ).toBe("m-2");
    store.settleRun({ merchant_id: "m-1", run_id: "run-1", input_tokens: 0, output_tokens: 0 });
    expect(store.reserveRun({ merchant_id: "m-1", run_id: "run-2", day_key: DAY }).state).toBe(
      "RESERVED",
    );
  });

  it("每日 run 上限 20：第 21 个预算耗尽，账本不被部分写入", () => {
    for (let i = 1; i <= BACKGROUND_BUDGET_LIMITS.daily_runs; i++) {
      store.reserveRun({ merchant_id: "m-1", run_id: `run-${i}`, day_key: DAY });
      store.settleRun({
        merchant_id: "m-1",
        run_id: `run-${i}`,
        input_tokens: 10,
        output_tokens: 10,
      });
    }
    const before = store.getDayUsage("m-1", DAY);
    expect(before.runs_used).toBe(20);
    expectBudgetError(
      () => store.reserveRun({ merchant_id: "m-1", run_id: "run-21", day_key: DAY }),
      "budget_exhausted",
      "daily_runs",
    );
    expect(store.getDayUsage("m-1", DAY).runs_used).toBe(20);
    expect(store.getRun("m-1", "run-21")).toBeUndefined();
  });

  it("每日 token 硬约束：input 不足时拒绝（实际越限如实记账，不伪造成功）", () => {
    store.reserveRun({ merchant_id: "m-1", run_id: "run-1", day_key: DAY });
    // 结算实际 input 达到日上限（诚实越限记账，运行期由单次调用上限约束）。
    store.settleRun({
      merchant_id: "m-1",
      run_id: "run-1",
      input_tokens: BACKGROUND_BUDGET_LIMITS.daily_input_tokens,
      output_tokens: 100,
    });
    expect(store.getDayUsage("m-1", DAY).input_used).toBe(100000);
    expectBudgetError(
      () => store.reserveRun({ merchant_id: "m-1", run_id: "run-2", day_key: DAY }),
      "budget_exhausted",
      "daily_input_tokens",
    );
  });

  it("跨商家账本隔离：日用量与 run 查询不泄漏", () => {
    store.reserveRun({ merchant_id: "m-1", run_id: "run-1", day_key: DAY });
    expect(store.getDayUsage("m-2", DAY).runs_used).toBe(0);
    expect(store.getRun("m-2", "run-1")).toBeUndefined();
    // 另一商家可从零开始（不受 m-1 占用影响）。
    expect(store.reserveRun({ merchant_id: "m-2", run_id: "run-2", day_key: DAY }).state).toBe(
      "RESERVED",
    );
  });

  it("重启不清零：持久账本的周用量与在途预留可继续结算", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-m1-budget-"));
    const dbPath = join(dir, "state.sqlite");
    const first = new DatabaseSync(dbPath);
    registerGovernanceLedgers(first);
    const storeA = new BackgroundBudgetStore({ db: first, now: () => clock });
    storeA.reserveRun({ merchant_id: "m-1", run_id: "run-1", day_key: DAY });
    first.close();

    const second = new DatabaseSync(dbPath);
    try {
      const storeB = new BackgroundBudgetStore({ db: second, now: () => clock });
      expect(storeB.getDayUsage("m-1", DAY)).toMatchObject({ runs_used: 1, input_used: 5000 });
      const settled = storeB.settleRun({
        merchant_id: "m-1",
        run_id: "run-1",
        input_tokens: 800,
        output_tokens: 200,
      });
      expect(settled.state).toBe("SETTLED");
      expect(storeB.getDayUsage("m-1", DAY)).toMatchObject({ input_used: 800, output_used: 200 });
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
