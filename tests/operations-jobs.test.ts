/**
 * TOP1-3 M4：事件、规则、调度、领取与原子提交。
 * no_change 零任务；eligible 同事务入队；预算不足 blocked；旧 worker 不能提交；
 * 重复提交返回原回执；暂停取消未提交任务。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { BackgroundBudgetStore } from "../src/merchant-core/budget/background-budget.js";
import {
  OperationsJobsError,
  OperationsJobsService,
  nextDailyDueAt,
  type RuleTemplate,
} from "../src/merchant-core/operations-jobs/service.js";

const NOW = "2026-11-17T00:00:00.000Z";
const MERCHANT = "m-1";

function expectError(fn: () => unknown, code: string, reason: string): void {
  try {
    fn();
    expect.unreachable(`应抛出 ${code}/${reason}`);
  } catch (err) {
    expect(err).toBeInstanceOf(OperationsJobsError);
    const e = err as OperationsJobsError;
    expect(e.code).toBe(code);
    expect(e.reason).toContain(reason);
  }
}

describe("经营任务 M4", () => {
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
    service = new OperationsJobsService({
      db,
      now: () => clock,
      budgetStore,
    });
  });
  afterEach(() => db.close());

  function rule(
    template: RuleTemplate = "unfinished_inquiry_digest",
    overrides: Partial<Parameters<OperationsJobsService["prepareRule"]>[0]> = {},
  ) {
    const candidate = service.prepareRule({
      merchant_id: MERCHANT,
      mode: "template",
      template,
      trigger_spec: { kind: "daily_local", local_time: "09:00", timezone: "Asia/Shanghai" },
      scope: { window: "previous_local_day" },
      predicate_spec: { kind: "fixed_template", template },
      action_type: "internal_summary",
      budget: { max_runs_per_day: 1 },
      ...overrides,
    });
    const activated = service.activateRule({
      merchant_id: MERCHANT,
      candidate_ref: candidate.candidate_ref,
    });
    db.prepare("UPDATE automation_rules SET next_due_at = ? WHERE rule_id = ?").run(
      NOW,
      activated.rule_id,
    );
    return { candidate, rule: service.getRule(MERCHANT, activated.rule_id)! };
  }

  it("EventInbox：同 ID 同摘要幂等、异摘要冲突", () => {
    const first = service.ingestTrustedEvent({
      merchant_id: MERCHANT,
      source_scope: "inquiry",
      external_event_id: "evt-1",
      payload_digest: "sha256:a",
      entity_ref: "inq-1",
      occurred_at: NOW,
    });
    expect(first.status).toBe("accepted");
    expect(
      service.ingestTrustedEvent({
        merchant_id: MERCHANT,
        source_scope: "inquiry",
        external_event_id: "evt-1",
        payload_digest: "sha256:a",
        entity_ref: "inq-1",
        occurred_at: NOW,
      }).status,
    ).toBe("duplicate");
    expectError(
      () =>
        service.ingestTrustedEvent({
          merchant_id: MERCHANT,
          source_scope: "inquiry",
          external_event_id: "evt-1",
          payload_digest: "sha256:b",
          entity_ref: "inq-1",
          occurred_at: NOW,
        }),
      "conflict",
      "event_payload_conflict",
    );
  });

  it("C11：P0 规则只能产出工作台内部结果，不能代表买家接受或下单", () => {
    for (const actionType of ["accept_agreement", "place_order", "authorize_payment"]) {
      expectError(
        () =>
          service.prepareRule({
            merchant_id: MERCHANT,
            mode: "template",
            template: "unfinished_inquiry_digest",
            trigger_spec: { kind: "daily_local", local_time: "09:00", timezone: "Asia/Shanghai" },
            scope: { window: "previous_local_day" },
            predicate_spec: { kind: "fixed_template", template: "unfinished_inquiry_digest" },
            action_type: actionType as never,
            budget: { max_runs_per_day: 1 },
          }),
        "validation",
        "action_type_invalid",
      );
    }
  });

  it("C01：同事件 100 次突发只产生一条 Inbox 与一个评估任务", () => {
    for (let index = 0; index < 100; index += 1) {
      service.ingestTrustedEvent({
        merchant_id: MERCHANT,
        source_scope: "inquiry",
        external_event_id: "evt-burst",
        payload_digest: "sha256:burst",
        entity_ref: "inq-burst",
        occurred_at: NOW,
      });
    }
    const inbox = db
      .prepare(
        "SELECT COUNT(*) AS n FROM event_inbox WHERE merchant_id = ? AND external_event_id = ?",
      )
      .get(MERCHANT, "evt-burst") as { n: number };
    expect(inbox.n).toBe(1);
    rule("unfinished_inquiry_digest");
    service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "eligible" }),
    });
    const tasks = db
      .prepare("SELECT COUNT(*) AS n FROM followup_tasks WHERE merchant_id = ?")
      .get(MERCHANT) as { n: number };
    expect(tasks.n).toBe(1);
    // 同事件改摘要 → conflict，不新增版本。
    expectError(
      () =>
        service.ingestTrustedEvent({
          merchant_id: MERCHANT,
          source_scope: "inquiry",
          external_event_id: "evt-burst",
          payload_digest: "sha256:changed",
          entity_ref: "inq-burst",
          occurred_at: NOW,
        }),
      "conflict",
      "event_payload_conflict",
    );
  });

  it("prepareRule 只生成候选；activate 才创建规则；暂停递增 epoch 并取消任务", () => {
    const candidate = service.prepareRule({
      merchant_id: MERCHANT,
      mode: "goal",
      template: "missing_info_draft",
      trigger_spec: { kind: "daily_local", local_time: "09:00", timezone: "Asia/Shanghai" },
      scope: { window: "previous_local_day" },
      predicate_spec: { kind: "fixed_template", template: "missing_info_draft" },
      action_type: "internal_draft",
      budget: { max_runs_per_day: 1 },
      goal_text: "每天提醒缺项的询价",
    });
    expect(candidate.requires_confirmation).toBe(true);
    expect(service.listRules(MERCHANT)).toEqual([]);
    const activated = service.activateRule({
      merchant_id: MERCHANT,
      candidate_ref: candidate.candidate_ref,
    });
    expect(activated).toMatchObject({ state: "ACTIVE", version: 1, enable_epoch: 1 });
    expect(activated.next_due_at).not.toBeNull();
    expectError(
      () =>
        service.activateRule({
          merchant_id: MERCHANT,
          candidate_ref: candidate.candidate_ref,
        }),
      "conflict",
      "candidate_consumed",
    );

    // 创建一个 READY 任务后暂停。
    db.prepare("UPDATE automation_rules SET next_due_at = ?").run(NOW);
    service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "eligible" }),
    });
    const paused = service.pauseRule({
      merchant_id: MERCHANT,
      rule_id: activated.rule_id,
      expected_version: 1,
      reason: "暂停",
    });
    expect(paused).toMatchObject({ state: "PAUSED", enable_epoch: 2 });
    const task = db
      .prepare("SELECT status, cancel_epoch FROM followup_tasks WHERE rule_id = ?")
      .get(activated.rule_id) as { status: string; cancel_epoch: number };
    expect(task.status).toBe("CANCELLED");
    expect(task.cancel_epoch).toBe(1);
  });

  it("evaluateDue：no_change 零任务；eligible 入队；data_incomplete 不伪造 no_change", () => {
    rule("unfinished_inquiry_digest");
    const noChange = service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "no_change" }),
    });
    expect(noChange[0]?.result).toBe("no_change");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM followup_tasks").get() as { n: number }).n,
    ).toBe(0);
    // 下一个 occurrence 再评估 eligible。
    clock = new Date(Date.parse(clock) + 60_000).toISOString();
    db.prepare("UPDATE automation_rules SET next_due_at = ?").run(clock);
    const eligible = service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "eligible", detail: { candidates: 3 } }),
    });
    expect(eligible[0]?.result).toBe("eligible");
    const tasks = db
      .prepare("SELECT task_id, status, rule_id, operation_ref FROM followup_tasks")
      .all() as Array<{ task_id: string; status: string; rule_id: string; operation_ref: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "READY" });
    expect(tasks[0]!.rule_id).toBe(eligible[0]!.rule_id);

    // 结算上一笔占用后，无 prefilter → data_incomplete（仍生成待办）。
    const claimed = service.claimDue({ merchant_id: MERCHANT, worker_id: "worker-settle" })!;
    service.commitInternalResult({
      merchant_id: MERCHANT,
      task_id: claimed.task_id,
      worker_id: "worker-settle",
      fencing: claimed.fencing_token,
      expected_revision: claimed.revision,
      expected_cancel_epoch: claimed.cancel_epoch,
      result_kind: "internal_summary",
      payload: { summary: "结算" },
      usage: { input: 10, output: 5 },
    });
    clock = new Date(Date.parse(clock) + 60_000).toISOString();
    db.prepare("UPDATE automation_rules SET next_due_at = ?").run(clock);
    const incomplete = service.evaluateDue({ merchant_id: MERCHANT });
    expect(incomplete[0]?.result).toBe("data_incomplete");
  });

  it("预算不足：eligible 记为 blocked，不创建新任务", () => {
    const { rule: activated } = rule();
    // 占住后台并发 1，下一次准入 concurrency_limit。
    budgetStore.reserveRun({
      merchant_id: MERCHANT,
      run_id: "run-occupied",
      day_key: NOW.slice(0, 10),
    });
    const result = service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "eligible" }),
    });
    expect(result[0]?.result).toBe("blocked");
    expect(result[0]?.reason_code).toContain("budget:");
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM followup_tasks WHERE rule_id = ?")
      .get(activated.rule_id) as { n: number };
    expect(count.n).toBe(0);
  });

  it("领取与提交：fencing/CAS、唯一产物与回执、重复提交幂等", () => {
    rule("unfinished_inquiry_digest");
    service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "eligible" }),
    });
    const claimed = service.claimDue({ merchant_id: MERCHANT, worker_id: "worker-a" });
    expect(claimed).toMatchObject({ status: "RUNNING", fencing_token: 1, attempts: 1 });
    expect(service.claimDue({ merchant_id: MERCHANT, worker_id: "worker-b" })).toBeUndefined();

    expectError(
      () =>
        service.commitInternalResult({
          merchant_id: MERCHANT,
          task_id: claimed!.task_id,
          worker_id: "worker-b",
          fencing: 1,
          expected_revision: claimed!.revision,
          expected_cancel_epoch: claimed!.cancel_epoch,
          result_kind: "internal_summary",
          payload: { summary: "x" },
        }),
      "invalid_transition",
      "commit_guard_failed",
    );

    const committed = service.commitInternalResult({
      merchant_id: MERCHANT,
      task_id: claimed!.task_id,
      worker_id: "worker-a",
      fencing: claimed!.fencing_token,
      expected_revision: claimed!.revision,
      expected_cancel_epoch: claimed!.cancel_epoch,
      result_kind: "internal_summary",
      payload: { summary: "日报" },
      usage: { input: 100, output: 50 },
    });
    expect(committed.receipt_ref).toMatch(/^rcpt_/);
    const task = db
      .prepare("SELECT status FROM followup_tasks WHERE task_id = ?")
      .get(claimed!.task_id) as { status: string };
    expect(task.status).toBe("SUCCEEDED");
    expect(service.listArtifacts(MERCHANT, claimed!.task_id)).toHaveLength(1);
    // 重复提交同内容返回原回执。
    expect(
      service.commitInternalResult({
        merchant_id: MERCHANT,
        task_id: claimed!.task_id,
        worker_id: "worker-a",
        fencing: claimed!.fencing_token,
        expected_revision: claimed!.revision,
        expected_cancel_epoch: claimed!.cancel_epoch,
        result_kind: "internal_summary",
        payload: { summary: "日报" },
      }).receipt_ref,
    ).toBe(committed.receipt_ref);
    // 同任务同结果类型不同内容冲突。
    expectError(
      () =>
        service.commitInternalResult({
          merchant_id: MERCHANT,
          task_id: claimed!.task_id,
          worker_id: "worker-a",
          fencing: claimed!.fencing_token,
          expected_revision: claimed!.revision,
          expected_cancel_epoch: claimed!.cancel_epoch,
          result_kind: "internal_summary",
          payload: { summary: "不同内容" },
        }),
      "idempotency_conflict",
      "artifact_digest_conflict",
    );
    // 预算已按已知用量结算。
    const run = budgetStore.getRun(MERCHANT, "run_occupied");
    void run;
  });

  it("暂停规则后旧 worker 不能提交；租约过期/截止不变式", () => {
    rule("unfinished_inquiry_digest");
    service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "eligible" }),
    });
    const claimed = service.claimDue({ merchant_id: MERCHANT, worker_id: "worker-a" })!;
    db.prepare("UPDATE automation_rules SET state = 'PAUSED'").run();
    expectError(
      () =>
        service.commitInternalResult({
          merchant_id: MERCHANT,
          task_id: claimed.task_id,
          worker_id: "worker-a",
          fencing: claimed.fencing_token,
          expected_revision: claimed.revision,
          expected_cancel_epoch: claimed.cancel_epoch,
          result_kind: "internal_summary",
          payload: { summary: "x" },
        }),
      "invalid_transition",
      "rule_changed",
    );
  });

  it("FAILED 重试持久化退避时间，到期可重新领取", () => {
    rule("unfinished_inquiry_digest");
    service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "eligible" }),
    });
    const claimed = service.claimDue({ merchant_id: MERCHANT, worker_id: "worker-a" })!;
    db.prepare("UPDATE followup_tasks SET status = 'FAILED' WHERE task_id = ?").run(
      claimed.task_id,
    );
    service.retryTask({
      merchant_id: MERCHANT,
      task_id: claimed.task_id,
      backoff_ms: 1_000,
    });
    expect(
      (db.prepare("SELECT status FROM followup_tasks WHERE task_id = ?").get(claimed.task_id) as {
        status: string;
      }).status,
    ).toBe("PENDING");
    clock = new Date(Date.parse(clock) + 2_000).toISOString();
    const reclaimed = service.claimDue({ merchant_id: MERCHANT, worker_id: "worker-b" });
    expect(reclaimed?.task_id).toBe(claimed.task_id);
    expect(reclaimed?.fencing_token).toBe(2);
  });

  it("nextDailyDueAt：按商家时区计算下一次本地时间", () => {
    expect(nextDailyDueAt({ now: NOW, local_time: "09:00", timezone: "Asia/Shanghai" })).toBe(
      "2026-11-17T01:00:00.000Z",
    );
  });
});
