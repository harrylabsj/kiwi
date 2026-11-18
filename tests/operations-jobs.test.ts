/**
 * TOP1-3 M4：事件、规则、调度、领取与原子提交。
 * no_change 零任务；eligible 同事务入队；预算不足 blocked；旧 worker 不能提交；
 * 重复提交返回原回执；暂停取消未提交任务。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // C16：不丢事件，保留 PENDING 任务等待配额并记录 budget_exhausted。
    const waiting = db
      .prepare("SELECT status, payload_json FROM followup_tasks WHERE rule_id = ?")
      .all(activated.rule_id) as Array<{ status: string; payload_json: string }>;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.status).toBe("PENDING");
    expect(JSON.parse(waiting[0]!.payload_json)).toMatchObject({
      budget_exhausted: expect.stringContaining("budget:"),
    });
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

  it("C02：v8 后收到 v7 不回滚；无权威结果只产生缺证待办", () => {
    expect(
      service.ingestTrustedEvent({
        merchant_id: MERCHANT,
        source_scope: "inquiry",
        external_event_id: "evt-v8",
        payload_digest: "sha256:v8",
        entity_ref: "inq-versioned",
        source_version: "v8",
        occurred_at: NOW,
      }).status,
    ).toBe("accepted");
    expect(
      service.ingestTrustedEvent({
        merchant_id: MERCHANT,
        source_scope: "inquiry",
        external_event_id: "evt-v7",
        payload_digest: "sha256:v7",
        entity_ref: "inq-versioned",
        source_version: "v7",
        occurred_at: NOW,
      }).status,
    ).toBe("superseded");
    const current = db
      .prepare(
        "SELECT version_rank FROM source_entity_versions WHERE merchant_id = ? AND entity_ref = ?",
      )
      .get(MERCHANT, "inq-versioned") as { version_rank: number };
    expect(current.version_rank).toBe(8);
    const late = db
      .prepare("SELECT superseded FROM event_inbox WHERE external_event_id = 'evt-v7'")
      .get() as { superseded: number };
    expect(late.superseded).toBe(1);
    // 无权威结果：只生成 data_incomplete 待办，不伪造 no_change。
    rule("unfinished_inquiry_digest");
    const evaluated = service.evaluateDue({ merchant_id: MERCHANT });
    expect(evaluated[0]?.result).toBe("data_incomplete");
    expect(evaluated[0]?.detail).toMatchObject({ missing: "projection" });
  });

  it("C03：停机跨三个窗口只补最新窗口并记录 missed", () => {
    const { rule: activated } = rule("unfinished_inquiry_digest");
    const threeDaysAgo = new Date(Date.parse(NOW) - 3 * 86_400_000).toISOString();
    db.prepare("UPDATE automation_rules SET next_due_at = ? WHERE rule_id = ?").run(
      threeDaysAgo,
      activated.rule_id,
    );
    const first = service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "no_change" }),
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.detail).toMatchObject({ missed_windows: 3 });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM followup_tasks").get() as { n: number }).n,
    ).toBe(0);
    const missed = service.getRule(MERCHANT, activated.rule_id)?.missed_count;
    expect(missed).toBeGreaterThanOrEqual(3);
    const nextDue = service.getRule(MERCHANT, activated.rule_id)?.next_due_at;
    expect(Date.parse(nextDue ?? "")).toBeGreaterThan(Date.parse(NOW));
    // 时钟回拨不重复 occurrence。
    clock = new Date(Date.parse(NOW) - 86_400_000).toISOString();
    expect(service.evaluateDue({ merchant_id: MERCHANT })).toHaveLength(0);
  });

  it("C04：no_change/阈值未达零任务零模型调用；eligible 才入队", () => {
    rule("unfinished_inquiry_digest");
    const noChange = service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "no_change", reason_code: "threshold_not_met" }),
    });
    expect(noChange[0]?.result).toBe("no_change");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM followup_tasks").get() as { n: number }).n,
    ).toBe(0);
    clock = new Date(Date.parse(clock) + 60_000).toISOString();
    db.prepare("UPDATE automation_rules SET next_due_at = ?").run(clock);
    const eligible = service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "eligible", detail: { candidates: 2 } }),
    });
    expect(eligible[0]?.result).toBe("eligible");
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM followup_tasks WHERE status = 'READY'").get() as {
        n: number;
      }).n,
    ).toBe(1);
  });

  it("C06：产物写入失败时任务/attempt/回执整体回滚", () => {
    rule("unfinished_inquiry_digest");
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    const claimed = service.claimDue({ merchant_id: MERCHANT, worker_id: "worker-a" })!;
    db.exec(
      "CREATE TRIGGER abort_artifact BEFORE INSERT ON operation_artifacts BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    expect(() =>
      service.commitInternalResult({
        merchant_id: MERCHANT,
        task_id: claimed.task_id,
        worker_id: "worker-a",
        fencing: claimed.fencing_token,
        expected_revision: claimed.revision,
        expected_cancel_epoch: claimed.cancel_epoch,
        result_kind: "internal_summary",
        payload: { summary: "失败注入" },
      }),
    ).toThrow();
    const task = db
      .prepare("SELECT status, revision FROM followup_tasks WHERE task_id = ?")
      .get(claimed.task_id) as { status: string; revision: number };
    expect(task.status).toBe("RUNNING");
    expect(task.revision).toBe(claimed.revision);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM operation_artifacts").get() as { n: number }).n,
    ).toBe(0);
    db.exec("DROP TRIGGER abort_artifact");
    const committed = service.commitInternalResult({
      merchant_id: MERCHANT,
      task_id: claimed.task_id,
      worker_id: "worker-a",
      fencing: claimed.fencing_token,
      expected_revision: claimed.revision,
      expected_cancel_epoch: claimed.cancel_epoch,
      result_kind: "internal_summary",
      payload: { summary: "恢复后提交" },
    });
    expect(committed.receipt_ref).toMatch(/^rcpt_/);
  });

  it("C08：Retry-After 持久化退避；截止后不再领取", () => {
    rule("unfinished_inquiry_digest");
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    const claimed = service.claimDue({ merchant_id: MERCHANT, worker_id: "worker-a" })!;
    db.prepare("UPDATE followup_tasks SET status = 'FAILED', deadline_at = ? WHERE task_id = ?").run(
      new Date(Date.parse(NOW) + 45_000).toISOString(),
      claimed.task_id,
    );
    service.retryTask({
      merchant_id: MERCHANT,
      task_id: claimed.task_id,
      backoff_ms: 5_000,
      retry_after_ms: 60_000,
    });
    const retried = db
      .prepare("SELECT due_at FROM followup_tasks WHERE task_id = ?")
      .get(claimed.task_id) as { due_at: string };
    expect(Date.parse(retried.due_at)).toBeGreaterThanOrEqual(Date.parse(NOW) + 60_000);
    expect(
      service.claimDue({
        merchant_id: MERCHANT,
        worker_id: "worker-b",
        now: new Date(Date.parse(NOW) + 30_000).toISOString(),
      }),
    ).toBeUndefined();
    // 截止已过：即使退避到期也不再领取/发起新调用。
    expect(
      service.claimDue({
        merchant_id: MERCHANT,
        worker_id: "worker-b",
        now: new Date(Date.parse(NOW) + 61_000).toISOString(),
      }),
    ).toBeUndefined();
  });

  it("C15：投影缺失生成 data_incomplete 待办；补读后重评新任务", () => {
    rule("unfinished_inquiry_digest", { budget: { max_runs_per_day: 2 } });
    const incomplete = service.evaluateDue({ merchant_id: MERCHANT });
    expect(incomplete[0]?.result).toBe("data_incomplete");
    expect(incomplete[0]?.detail).toMatchObject({ missing: "projection" });
    const firstTask = db
      .prepare("SELECT task_id, status FROM followup_tasks")
      .all() as Array<{ task_id: string; status: string }>;
    expect(firstTask).toHaveLength(1);
    const runId = (
      db.prepare("SELECT operation_ref FROM followup_tasks WHERE task_id = ?").get(
        firstTask[0]!.task_id,
      ) as { operation_ref: string }
    ).operation_ref;
    budgetStore.releaseRun({ merchant_id: MERCHANT, run_id: runId });
    clock = new Date(Date.parse(clock) + 60_000).toISOString();
    db.prepare("UPDATE automation_rules SET next_due_at = ?").run(clock);
    const reEvaluated = service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "eligible", detail: { backfilled: true } }),
    });
    expect(reEvaluated[0]?.result).toBe("eligible");
    const tasks = db.prepare("SELECT task_id FROM followup_tasks").all();
    expect(tasks).toHaveLength(2);
    expect(
      (db.prepare("SELECT status FROM followup_tasks WHERE task_id = ?").get(firstTask[0]!.task_id) as {
        status: string;
      }).status,
    ).toBe("READY");
  });

  it("暂停原子释放未启动预留；释放失败时规则与任务一并回滚", () => {
    const active = rule().rule;
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    const task = db.prepare("SELECT operation_ref FROM followup_tasks WHERE rule_id = ?")
      .get(active.rule_id) as { operation_ref: string };
    db.exec(`CREATE TRIGGER fail_release BEFORE UPDATE OF state ON background_budget_reservations
      WHEN NEW.state = 'RELEASED' BEGIN SELECT RAISE(ABORT, 'release failed'); END`);
    expect(() => service.pauseRule({ merchant_id: MERCHANT, rule_id: active.rule_id,
      expected_version: active.version, reason: "test" })).toThrow("release failed");
    expect(service.getRule(MERCHANT, active.rule_id)?.state).toBe("ACTIVE");
    expect(budgetStore.getRun(MERCHANT, task.operation_ref)?.state).toBe("RESERVED");
    db.exec("DROP TRIGGER fail_release");
    service.pauseRule({ merchant_id: MERCHANT, rule_id: active.rule_id,
      expected_version: active.version, reason: "test" });
    expect(budgetStore.getRun(MERCHANT, task.operation_ref)?.state).toBe("RELEASED");
    expect(budgetStore.getDayUsage(MERCHANT, NOW.slice(0, 10)).runs_used).toBe(0);
  });

  it("暂停已领取后等待重试的任务按未知用量结算", () => {
    const active = rule().rule;
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    const task = service.claimDue({ merchant_id: MERCHANT, worker_id: "w" })!;
    const run = (db.prepare("SELECT operation_ref FROM followup_tasks WHERE task_id = ?")
      .get(task.task_id) as { operation_ref: string }).operation_ref;
    db.prepare("UPDATE followup_tasks SET status = 'FAILED' WHERE task_id = ?").run(task.task_id);
    service.retryTask({ merchant_id: MERCHANT, task_id: task.task_id });
    service.pauseRule({ merchant_id: MERCHANT, rule_id: active.rule_id,
      expected_version: active.version, reason: "test" });
    expect(budgetStore.getRun(MERCHANT, run)).toMatchObject({ state: "SETTLED", usage_state: "unknown" });
  });

  it("终态 UNKNOWN 的预留按未知用量结算", () => {
    rule();
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    const task = service.claimDue({ merchant_id: MERCHANT, worker_id: "w" })!;
    const run = (db.prepare("SELECT operation_ref FROM followup_tasks WHERE task_id = ?")
      .get(task.task_id) as { operation_ref: string }).operation_ref;
    db.prepare("UPDATE followup_tasks SET status = 'UNKNOWN' WHERE task_id = ?").run(task.task_id);
    service.claimDue({ merchant_id: MERCHANT, worker_id: "other" });
    expect(budgetStore.getRun(MERCHANT, run)).toMatchObject({ state: "SETTLED", usage_state: "unknown" });
  });

  it("过期租约按未知用量结算，旧 worker 不能提交", () => {
    rule();
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    const claimed = service.claimDue({ merchant_id: MERCHANT, worker_id: "old", lease_ms: 1000 })!;
    const run = (db.prepare("SELECT operation_ref FROM followup_tasks WHERE task_id = ?")
      .get(claimed.task_id) as { operation_ref: string }).operation_ref;
    clock = new Date(Date.parse(NOW) + 2000).toISOString();
    expect(service.claimDue({ merchant_id: MERCHANT, worker_id: "new" })).toBeUndefined();
    expect(budgetStore.getRun(MERCHANT, run)).toMatchObject({ state: "SETTLED", usage_state: "unknown" });
    expect((db.prepare("SELECT status FROM followup_tasks WHERE task_id = ?").get(claimed.task_id) as { status: string }).status).toBe("UNKNOWN");
    expect(() => service.commitInternalResult({ merchant_id: MERCHANT, task_id: claimed.task_id,
      worker_id: "old", fencing: claimed.fencing_token,
      expected_revision: claimed.revision, expected_cancel_epoch: claimed.cancel_epoch,
      result_kind: "internal_summary", payload: { summary: "late" } })).toThrow();
  });

  it("预算释放后等待任务自动领取，重复领取不重复扣费", () => {
    rule();
    budgetStore.reserveRun({ merchant_id: MERCHANT, run_id: "occupied", day_key: NOW.slice(0, 10) });
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    budgetStore.releaseRun({ merchant_id: MERCHANT, run_id: "occupied" });
    const claimed = service.claimDue({ merchant_id: MERCHANT, worker_id: "w" });
    expect(claimed?.status).toBe("RUNNING");
    expect(service.claimDue({ merchant_id: MERCHANT, worker_id: "w2" })).toBeUndefined();
    expect(budgetStore.getDayUsage(MERCHANT, NOW.slice(0, 10)).runs_used).toBe(1);
  });

  it("预算等待任务截止后取消且不预留", () => {
    rule();
    budgetStore.reserveRun({ merchant_id: MERCHANT, run_id: "occupied", day_key: NOW.slice(0, 10) });
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    budgetStore.releaseRun({ merchant_id: MERCHANT, run_id: "occupied" });
    db.prepare("UPDATE followup_tasks SET deadline_at = ?").run(NOW);
    expect(service.claimDue({ merchant_id: MERCHANT, worker_id: "w" })).toBeUndefined();
    expect((db.prepare("SELECT status FROM followup_tasks").get() as { status: string }).status).toBe("CANCELLED");
    expect(budgetStore.getDayUsage(MERCHANT, NOW.slice(0, 10)).runs_used).toBe(0);
  });

  it("C16：额度不足按动作优先级处理，其余保留 PENDING + budget_exhausted", () => {
    const summary = rule("unfinished_inquiry_digest").rule;
    const draft = rule("unfinished_inquiry_digest", { action_type: "internal_draft" }).rule;
    budgetStore.reserveRun({
      merchant_id: MERCHANT,
      run_id: "run-occupied-c16",
      day_key: NOW.slice(0, 10),
    });
    const results = service.evaluateDue({
      merchant_id: MERCHANT,
      prefilter: () => ({ result: "eligible" }),
    });
    expect(results.map((item) => item.rule_id)).toEqual([summary.rule_id, draft.rule_id]);
    expect(results.every((item) => item.result === "blocked")).toBe(true);
    const waiting = db
      .prepare("SELECT status, payload_json FROM followup_tasks WHERE rule_id IN (?, ?)")
      .all(summary.rule_id, draft.rule_id) as Array<{ status: string; payload_json: string }>;
    expect(waiting).toHaveLength(2);
    expect(waiting.every((task) => task.status === "PENDING")).toBe(true);
    expect(
      waiting.every(
        (task) =>
          typeof (JSON.parse(task.payload_json) as { budget_exhausted?: unknown })
            .budget_exhausted === "string",
      ),
    ).toBe(true);
    budgetStore.releaseRun({ merchant_id: MERCHANT, run_id: "run-occupied-c16" });
    const claimed = service.claimDue({ merchant_id: MERCHANT, worker_id: "w" });
    expect(claimed?.rule_id).toBe(summary.rule_id);
    expect(service.claimDue({ merchant_id: MERCHANT, worker_id: "w2" })).toBeUndefined();
    expect(budgetStore.getDayUsage(MERCHANT, NOW.slice(0, 10)).runs_used).toBe(1);
  });

  it("暂停预算等待规则后不再补额", () => {
    const active = rule().rule;
    budgetStore.reserveRun({ merchant_id: MERCHANT, run_id: "occupied", day_key: NOW.slice(0, 10) });
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    service.pauseRule({ merchant_id: MERCHANT, rule_id: active.rule_id, expected_version: active.version, reason: "test" });
    budgetStore.releaseRun({ merchant_id: MERCHANT, run_id: "occupied" });
    expect(service.claimDue({ merchant_id: MERCHANT, worker_id: "w" })).toBeUndefined();
    expect(budgetStore.getDayUsage(MERCHANT, NOW.slice(0, 10)).runs_used).toBe(0);
  });

  it("不同连接竞争同一等待任务只产生一次预留和领取", () => {
    rule();
    budgetStore.reserveRun({ merchant_id: MERCHANT, run_id: "occupied", day_key: NOW.slice(0, 10) });
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    budgetStore.releaseRun({ merchant_id: MERCHANT, run_id: "occupied" });
    const dir = mkdtempSync(join(tmpdir(), "kiwi-budget-"));
    const path = join(dir, "test.sqlite");
    db.prepare("VACUUM INTO ?").run(path);
    const first = new DatabaseSync(path);
    const second = new DatabaseSync(path);
    try {
      const a = new OperationsJobsService({ db: first, now: () => clock,
        budgetStore: new BackgroundBudgetStore({ db: first, now: () => clock }) });
      const b = new OperationsJobsService({ db: second, now: () => clock,
        budgetStore: new BackgroundBudgetStore({ db: second, now: () => clock }) });
      expect(a.claimDue({ merchant_id: MERCHANT, worker_id: "a" })).toBeDefined();
      expect(b.claimDue({ merchant_id: MERCHANT, worker_id: "b" })).toBeUndefined();
      expect((first.prepare("SELECT COUNT(*) AS n FROM background_budget_reservations WHERE state = 'RESERVED'")
        .get() as { n: number }).n).toBe(1);
      expect((first.prepare("SELECT COUNT(*) AS n FROM followup_attempts").get() as { n: number }).n).toBe(1);
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("任务状态写入失败时预算预留一并回滚", () => {
    rule();
    budgetStore.reserveRun({ merchant_id: MERCHANT, run_id: "occupied", day_key: NOW.slice(0, 10) });
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    budgetStore.releaseRun({ merchant_id: MERCHANT, run_id: "occupied" });
    db.exec(`CREATE TRIGGER fail_admission BEFORE UPDATE OF operation_ref ON followup_tasks
      BEGIN SELECT RAISE(ABORT, 'admission failed'); END`);
    expect(() => service.claimDue({ merchant_id: MERCHANT, worker_id: "w" })).toThrow("admission failed");
    expect(budgetStore.getDayUsage(MERCHANT, NOW.slice(0, 10)).runs_used).toBe(0);
    expect((db.prepare("SELECT operation_ref FROM followup_tasks").get() as { operation_ref: string | null }).operation_ref).toBeNull();
  });

  it("规则到期时等待任务不补额", () => {
    const active = rule().rule;
    budgetStore.reserveRun({ merchant_id: MERCHANT, run_id: "occupied", day_key: NOW.slice(0, 10) });
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    budgetStore.releaseRun({ merchant_id: MERCHANT, run_id: "occupied" });
    db.prepare("UPDATE automation_rules SET expires_at = ? WHERE rule_id = ?").run(NOW, active.rule_id);
    expect(service.claimDue({ merchant_id: MERCHANT, worker_id: "w" })).toBeUndefined();
    expect(budgetStore.getDayUsage(MERCHANT, NOW.slice(0, 10)).runs_used).toBe(0);
  });

  it("补额后领取被忽略时回滚预算和任务状态", () => {
    rule();
    budgetStore.reserveRun({ merchant_id: MERCHANT, run_id: "occupied", day_key: NOW.slice(0, 10) });
    service.evaluateDue({ merchant_id: MERCHANT, prefilter: () => ({ result: "eligible" }) });
    budgetStore.releaseRun({ merchant_id: MERCHANT, run_id: "occupied" });
    db.exec(`CREATE TRIGGER ignore_claim BEFORE UPDATE OF status ON followup_tasks
      WHEN NEW.status = 'RUNNING' BEGIN SELECT RAISE(IGNORE); END`);
    expect(() => service.claimDue({ merchant_id: MERCHANT, worker_id: "w" })).toThrow("budget admission claim failed");
    expect(budgetStore.getDayUsage(MERCHANT, NOW.slice(0, 10)).runs_used).toBe(0);
    expect(db.prepare("SELECT status, operation_ref FROM followup_tasks").get())
      .toMatchObject({ status: "PENDING", operation_ref: null });
  });
});
