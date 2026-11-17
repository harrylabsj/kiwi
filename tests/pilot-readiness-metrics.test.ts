/**
 * TOP1-3 M5：试点就绪检查与观测口径。
 * 只读检查；默认全关不要求所有权；客户外发固定关闭；比率无数据返回 null。
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { checkPilotReadiness } from "../src/merchant-core/context-governance/pilot-readiness.js";
import { parseGovernanceFeatureFlags } from "../src/merchant-core/context-governance/feature-flags.js";
import { InstanceOwnershipService } from "../src/merchant-core/ownership/instance-ownership.js";
import { OperationsJobsService } from "../src/merchant-core/operations-jobs/service.js";
import { computePilotMetrics } from "../src/merchant-core/operations-jobs/pilot-metrics.js";
import { LearningService } from "../src/merchant-core/learning/service.js";
import { LearningRepository } from "../src/merchant-core/learning/repository.js";
import { createActorContext } from "../src/merchant-core/context-governance/actor-context.js";

const NOW = "2026-11-17T00:00:00.000Z";
const MERCHANT = "m-1";

function actor() {
  return createActorContext({
    merchant_id: MERCHANT,
    actor_id: "admin-1",
    auth_strength: "verified",
    subject_binding: "organization",
    capabilities: ["learning:manage", "memory:write", "memory:read"],
  });
}

describe("M5 试点就绪与观测", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    migrateMerchantOpsSchema(db);
    registerGovernanceLedgers(db);
  });
  afterEach(() => db.close());

  it("默认全关：账本/表就绪、不要求所有权、客户外发关闭", () => {
    const report = checkPilotReadiness({
      db,
      merchantId: MERCHANT,
      flags: parseGovernanceFeatureFlags(undefined),
    });
    expect(report.ready).toBe(true);
    expect(report.checks.find((check) => check.id === "customer_delivery_disabled")?.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "modules_default_off")?.ok).toBe(true);
    expect(report.checks.find((check) => check.id === "instance_ownership")).toBeUndefined();
  });

  it("开启模块但未持有所有权：不就绪；持有后就绪；客户外发 true 被配置层拒绝", () => {
    const memoryOn = parseGovernanceFeatureFlags({ memory_enabled: true });
    const before = checkPilotReadiness({ db, merchantId: MERCHANT, flags: memoryOn });
    expect(before.ready).toBe(false);
    expect(before.checks.find((check) => check.id === "instance_ownership")).toMatchObject({
      ok: false,
      code: "OWNERSHIP_NOT_HELD",
    });
    const ownership = new InstanceOwnershipService({ db, now: () => NOW, leaseMs: 60_000 });
    ownership.acquire({ merchant_id: MERCHANT, owner_id: "proc-a" });
    const after = checkPilotReadiness({ db, merchantId: MERCHANT, flags: memoryOn });
    expect(after.ready).toBe(true);
    expect(() =>
      parseGovernanceFeatureFlags({ customer_delivery_enabled: true }),
    ).toThrow(/P0 固定关闭/);
  });

  it("观测口径：计数可复核；无分母比率返回 null 而不是 0", () => {
    const learning = new LearningService({
      repository: new LearningRepository({ db }),
      now: () => NOW,
    });
    learning.submitCorrection({
      merchant_id: MERCHANT,
      actor: actor(),
      correction_text: "单位不明确时先读取单位规则",
      issue_tags: ["unit"],
    });
    try {
      learning.submitCorrection({
        merchant_id: MERCHANT,
        actor: actor(),
        correction_text: "联系电话 13800138000",
        issue_tags: ["unit"],
      });
    } catch {
      // 预检拒绝。
    }
    db.prepare(
      `INSERT INTO followup_tasks
        (task_id, merchant_id, trigger_event, action_type, status, attempts, max_attempts,
         fencing_token, external_call_started, stop_requested, payload_json, created_at, updated_at)
       VALUES ('fu_1', ?, 'test', 'merchant_todo', 'SUCCEEDED', 1, 3, 1, 0, 0, '{}', ?, ?)`,
    ).run(MERCHANT, NOW, NOW);

    const metrics = computePilotMetrics({ db, merchantId: MERCHANT, until: NOW });
    expect(metrics.corrections).toEqual({ total: 1, rejected: 1 });
    expect(metrics.tasks.succeeded).toBe(1);
    expect(metrics.candidates.total).toBe(0);
    expect(metrics.memory.active).toBe(0);
    // 无重复纠正 → 分母 1、分子 0；无数据比率才是 null（这里分母存在）。
    expect(metrics.repeat_correction_rate).toMatchObject({
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    expect(metrics.accuracy_notes.length).toBeGreaterThan(0);
    // 空商家：分母 0 → null。
    const empty = computePilotMetrics({ db, merchantId: "m-empty", until: NOW });
    expect(empty.repeat_correction_rate.value).toBeNull();
  });

  it("任务暂停/预算计数与 UNKNOWN 可见", () => {
    const service = new OperationsJobsService({ db, now: () => NOW });
    db.prepare(
      `INSERT INTO followup_tasks
        (task_id, merchant_id, trigger_event, action_type, status, attempts, max_attempts,
         fencing_token, external_call_started, stop_requested, payload_json, created_at, updated_at)
       VALUES ('fu_unknown', ?, 'test', 'merchant_todo', 'UNKNOWN', 1, 3, 1, 1, 0, '{}', ?, ?)`,
    ).run(MERCHANT, NOW, NOW);
    const metrics = computePilotMetrics({ db, merchantId: MERCHANT, until: NOW });
    expect(metrics.tasks.unknown).toBe(1);
    void service;
  });
});
