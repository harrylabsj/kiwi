/**
 * 经营任务运行时调度：所有权门、领取/提交、证据校验、失败退避与补额。
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { BackgroundBudgetStore } from "../src/merchant-core/budget/background-budget.js";
import { OperationsJobsService } from "../src/merchant-core/operations-jobs/service.js";
import {
  OperationsScheduler,
  invalidEvidenceRefs,
} from "../src/merchant-core/operations-jobs/scheduler.js";
import type { OperationAdviceRun } from "../src/merchant-core/operations-jobs/advice-runner.js";
import { OperationsProjection } from "../src/merchant-core/operations-jobs/projection.js";

const NOW = "2026-11-18T00:00:00.000Z";
const MERCHANT = "m-1";

function advice(evidence: string[] = []): OperationAdviceRun {
  return {
    advice: {
      kind: "internal_summary",
      summary: "昨日有 2 条未完成询价。",
      evidence_refs: evidence,
      next_action: "merchant_review",
    },
    usage: { input: 100, output: 40, total: 140, steps: 1, toolCalls: {} },
    trace: { at: NOW },
  };
}

describe("经营任务运行时调度", () => {
  let db: DatabaseSync;
  let clock: string;
  let service: OperationsJobsService;
  let budgetStore: BackgroundBudgetStore;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    migrateMerchantOpsSchema(db);
    registerGovernanceLedgers(db);
    clock = NOW;
    budgetStore = new BackgroundBudgetStore({ db, now: () => clock });
    service = new OperationsJobsService({ db, now: () => clock, budgetStore });
  });

  function dueRule() {
    const candidate = service.prepareRule({
      merchant_id: MERCHANT,
      mode: "template",
      template: "unfinished_inquiry_digest",
      trigger_spec: { kind: "daily_local", local_time: "09:00", timezone: "Asia/Shanghai" },
      scope: { window: "previous_local_day" },
      predicate_spec: { kind: "fixed_template", template: "unfinished_inquiry_digest" },
      action_type: "internal_summary",
      budget: { max_runs_per_day: 1 },
    });
    const activated = service.activateRule({
      merchant_id: MERCHANT,
      candidate_ref: candidate.candidate_ref,
    });
    db.prepare("UPDATE automation_rules SET next_due_at = ? WHERE rule_id = ?").run(
      NOW,
      activated.rule_id,
    );
    return activated.rule_id;
  }

  function scheduler(
    runner: (input: never) => Promise<OperationAdviceRun>,
    overrides: {
      assertOwner?: () => void;
      prefilter?: () => { result: "eligible" };
      write?: <T>(work: () => T) => T;
    } = {},
  ) {
    return new OperationsScheduler({
      service,
      merchant_id: MERCHANT,
      assertOwner: overrides.assertOwner ?? (() => undefined),
      ...(overrides.write !== undefined ? { write: overrides.write } : {}),
      runner: runner as never,
      now: () => clock,
      worker_id: "scheduler-1",
      execution_timeout_ms: 1_000,
      prefilter: overrides.prefilter ?? (() => ({ result: "eligible" })),
    });
  }

  it("评估→领取→模型建议→原子提交；预算结算", async () => {
    const ruleId = dueRule();
    let writes = 0;
    const result = await scheduler(async () => advice(), {
      write: (work) => {
        writes += 1;
        return work();
      },
    }).tick();
    expect(result).toMatchObject({ evaluations: 1, claimed: 1, committed: 1, failed: 0 });
    expect(writes).toBeGreaterThanOrEqual(3);
    const task = db
      .prepare("SELECT status FROM followup_tasks WHERE rule_id = ?")
      .get(ruleId) as { status: string };
    expect(task.status).toBe("SUCCEEDED");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM operation_artifacts").get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare("SELECT runs_used FROM background_budget_days").get() as { runs_used: number })
        .runs_used,
    ).toBe(1);
  });

  it("证据引用不在任务快照内 → 转 data_issue，不落错误证据", async () => {
    dueRule();
    const result = await scheduler(async () => advice(["inquiry:missing"])).tick();
    expect(result.committed).toBe(1);
    const artifact = db
      .prepare("SELECT result_kind, payload_json FROM operation_artifacts")
      .get() as { result_kind: string; payload_json: string };
    expect(artifact.result_kind).toBe("data_issue");
    expect(JSON.parse(artifact.payload_json)).toMatchObject({
      reason_code: "invalid_evidence_refs",
    });
    expect(invalidEvidenceRefs(["inquiry:missing"], { candidate_ref: "inquiry:1" })).toEqual([
      "inquiry:missing",
    ]);
  });

  it("执行失败 → FAILED + 退避，到期后重试成功", async () => {
    const ruleId = dueRule();
    let fail = true;
    const runner = async (): Promise<OperationAdviceRun> => {
      if (fail) throw new Error("model_failed");
      return advice();
    };
    const first = await scheduler(runner).tick();
    expect(first.failed).toBe(1);
    const failed = db
      .prepare("SELECT status, attempts, due_at FROM followup_tasks WHERE rule_id = ?")
      .get(ruleId) as { status: string; attempts: number; due_at: string };
    expect(failed.status).toBe("PENDING");
    expect(failed.attempts).toBe(1);
    clock = new Date(Date.parse(failed.due_at) + 1_000).toISOString();
    fail = false;
    const second = await scheduler(runner).tick();
    expect(second.committed).toBe(1);
    expect(
      (db.prepare("SELECT status, attempts FROM followup_tasks WHERE rule_id = ?").get(ruleId) as {
        status: string;
        attempts: number;
      }).attempts,
    ).toBe(2);
  });

  it("失权立即停止，不提交任何结果", async () => {
    dueRule();
    const result = await scheduler(async () => advice(), {
      assertOwner: () => {
        throw Object.assign(new Error("lost"), { code: "not_acquired" });
      },
    }).tick();
    expect(result.stopped).toBe(true);
    expect(result.evaluations).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM operation_artifacts").get() as { n: number }).n,
    ).toBe(0);
  });

  it("暂停规则不再产生评估/任务", async () => {
    const ruleId = dueRule();
    service.pauseRule({
      merchant_id: MERCHANT,
      rule_id: ruleId,
      expected_version: 1,
      reason: "暂停",
    });
    const result = await scheduler(async () => advice()).tick();
    expect(result.evaluations).toBe(0);
    expect(result.claimed).toBe(0);
  });

  it("投影 → 调度 → 模型建议引用真实机会 → 原子提交", async () => {
    db.prepare(
      `INSERT INTO sales_opportunities
        (opportunity_id, merchant_id, status, owner, revision, created_at, updated_at)
       VALUES ('opp-1', ?, 'NEW', 'admin-1', 1, ?, ?)`,
    ).run(MERCHANT, NOW, NOW);
    dueRule();
    const projection = new OperationsProjection({ db, now: () => clock });
    const result = await scheduler(
      async () => advice(["opportunity:opp-1"]),
      { prefilter: (rule) => projection.prefilter(rule) },
    ).tick();
    expect(result).toMatchObject({ evaluations: 1, claimed: 1, committed: 1 });
    const artifact = db
      .prepare("SELECT result_kind, payload_json FROM operation_artifacts")
      .get() as { result_kind: string; payload_json: string };
    expect(artifact.result_kind).toBe("internal_summary");
    expect(JSON.parse(artifact.payload_json)).toMatchObject({
      advice: { evidence_refs: ["opportunity:opp-1"] },
    });
  });
});
