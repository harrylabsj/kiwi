// 服务恢复（service resume）的操作引用与对账适配器
// （内部写缺口的第三批：grant/promotion/service-control 之 service-control）。
//
// 服务恢复是 **kiwi 内部写**——没有下游服务可问。与促销同款模型：操作引用
// （`resume_operation_id` = committed decision 的 operationId）直接落在权威行上，
// 与状态迁移写进**同一个 UPDATE**（「查到引用 ⟺ 效果已提交」），不需要回执表。
// 此前 resume 执行器没有 `queryOutcome`，写后不确定时 `MerchantCommandLog.reconcile`
// 只能返回 unknown +「no downstream operation query adapter」——把一次**本可自动
// 判定**的对账变成人工升级。
//
// 已知限制（刻意，与促销同口径）：每行只保留**最近一次** resume 的引用；被后续
// 操作覆盖后查询不得匹配 → unknown（保守升级人工，不会误判）。
//
// 本文件守三层：
//   1. state：引用与状态迁移同语句落库、重启后可读回、既有库缺列自动补；
//   2. executor：committed decision 的 operationId 传进 resume；
//   3. **对账**：写后不确定时按 operationId 得出 succeeded（核心）。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient } from "../src/agent/merchant/fake-merchant-client.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import { createServiceControlExecutors } from "../src/merchant/service-control-executors.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { testProfile } from "./helpers.js";

const NOW = "2026-09-21T12:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const MERCHANT = "merchant-001";
const ACTOR = "owner:merchant-001";

describe("service state：resume 操作引用与状态迁移同语句落库", () => {
  it("带 operationId 的 resume 落引用，重启（重新 attach）后可读回", () => {
    const db = new DatabaseSync(":memory:");
    const state = new MutableServiceState("OPERATING");
    state.attachPersistence(db, MERCHANT);
    state.pause("incident");
    state.resume(true, [], "op-resume-1");
    expect(state.lastResumeOperationId).toBe("op-resume-1");

    const reloaded = new MutableServiceState("OPERATING");
    reloaded.attachPersistence(db, MERCHANT);
    expect(reloaded.state).toBe("OPERATING");
    expect(reloaded.lastResumeOperationId).toBe("op-resume-1");
    db.close();
  });

  it("不带 operationId 的 resume 不落引用（非决定路径）", () => {
    const db = new DatabaseSync(":memory:");
    const state = new MutableServiceState("OPERATING");
    state.attachPersistence(db, MERCHANT);
    state.pause("incident");
    state.resume(true, []);
    expect(state.lastResumeOperationId).toBeNull();
    db.close();
  });

  it("既有库缺 resume_operation_id 列时 attach 自动补列", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE workbench_service_control (
        merchant_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('OPERATING','PAUSED','WITHDRAWN','DEGRADED')),
        revision INTEGER NOT NULL,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.prepare(
      `INSERT INTO workbench_service_control (merchant_id, state, revision, reason, updated_at)
       VALUES (?, 'PAUSED', 7, 'paused by the operator', ?)`,
    ).run(MERCHANT, NOW);
    const state = new MutableServiceState("OPERATING");
    state.attachPersistence(db, MERCHANT);
    expect(state.state).toBe("PAUSED");
    expect(state.serviceRevision).toBe(7);
    state.resume(true, [], "op-after-migration");
    expect(state.lastResumeOperationId).toBe("op-after-migration");
    db.close();
  });
});

// ── 执行器/对账层：写后不确定时可自动判定 ─────────────────────────────
function coreFixture() {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals
     (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, NOW, NOW);
  const state = new MutableServiceState("OPERATING");
  state.attachPersistence(db, MERCHANT);
  state.pause("incident"); // → PAUSED, revision 2
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => NOW });
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient(),
    approvals,
    mode: () => "supervised",
    now: () => NOW,
    commandPrincipalId: PRINCIPAL,
    extraExecutors: createServiceControlExecutors({
      state,
      readiness: async () => ({ ready: true, checks: { storage: { ok: true } } }),
    }),
  });
  return { db, state, approvals, core };
}

describe("service resume 执行器：写后不确定可对账", () => {
  it("resume 写后不确定 → 按 operationId 查引用得出 succeeded（本文件的核心）", async () => {
    const { db, state, approvals, core } = coreFixture();
    const prepared = await core.prepareServiceResume({ expectedRevision: 2 });
    const candidateId = prepared.candidate.candidate_id;

    // 模拟「写成功了，但结果没回到我们这里」：认领 → 直接恢复 → 候选 supersede
    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    state.resume(true, [], "operation-uncertain-resume");
    approvals.supersede(candidateId);

    // 若执行器仍缺 queryOutcome，这里会返回 unknown +「no downstream operation query adapter」
    await expect(
      core.queryCommittedDecisionOutcome({
        operationId: "operation-uncertain-resume",
        candidateId,
        actorId: ACTOR,
        decision: "approve",
      }),
    ).resolves.toEqual({ status: "succeeded" });
    expect(core.getCommand(candidateId)?.status).toBe("executed");
    db.close();
  });

  it("状态是 OPERATING 但引用是别的操作 → 判 unknown，不当成功", async () => {
    const { db, state, approvals, core } = coreFixture();
    const prepared = await core.prepareServiceResume({ expectedRevision: 2 });
    const candidateId = prepared.candidate.candidate_id;

    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    state.resume(true, [], "operation-someone-else");
    approvals.supersede(candidateId);

    const outcome = await core.queryCommittedDecisionOutcome({
      operationId: "operation-uncertain-resume",
      candidateId,
      actorId: ACTOR,
      decision: "approve",
    });
    expect(outcome.status).toBe("unknown");
    expect(core.getCommand(candidateId)?.status).not.toBe("executed");
    db.close();
  });
});
