// 授权写（grant create/revoke）的 operation receipt 与对账适配器
// （内部写缺口的第三批：grant/promotion/service-control 之 grant）。
//
// 授权写是 **kiwi 内部写**——没有下游服务可问，回执落在 grant store 自己的表
// （`merchant_grant_operations`）里，且与效果**同事务**（「有回执 ⟺ 效果已提交」），
// 与广播回执同一套模式。此前两个 grant 执行器都没有 `queryOutcome`，写后不确定时
// `MerchantCommandLog.reconcile` 只能返回 unknown +「no downstream operation query
// adapter」——把一次**本可自动判定**的对账变成人工升级。
//
// 本文件守三层：
//   1. store：回执与效果同事务、同 operation_id 重放不重做、异请求冲突、按商家隔离；
//   2. executor：写入带 committed decision 的 operationId；
//   3. **对账**：写后不确定时按 operation_id 查回执得出 succeeded（核心）。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import {
  contentHash,
  WriteApprovalCandidateStore,
} from "../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient } from "../src/agent/merchant/fake-merchant-client.js";
import { createVerifiedActorContext } from "../src/merchant/application/actor.js";
import { createGrantExecutors } from "../src/merchant/grant-executors.js";
import {
  GRANT_OPERATION_KINDS,
  type GrantOperation,
  MerchantGrantError,
  MerchantGrantStore,
} from "../src/merchant/grant-store.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { testProfile } from "./helpers.js";

const NOW = "2026-09-21T12:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const MERCHANT = "merchant-001";
const ACTOR = "owner:merchant-001";
const EXPIRES = "2026-10-21T12:00:00.000Z";

const owner = () =>
  createVerifiedActorContext({
    actorId: ACTOR,
    merchantId: MERCHANT,
    role: "owner",
    authMethod: "service-identity",
    generation: 1,
    requestId: "grant-receipts-test",
    expiresAt: EXPIRES,
  });

const createInput = {
  subjectId: "operator:1",
  action: "broadcast.draft" as const,
  resourceType: "merchant" as const,
  resourceSelector: "merchant" as const,
  expiresAt: EXPIRES,
};

const op = (
  operationId: string,
  operationKind: GrantOperation["operationKind"],
  hash: string,
): GrantOperation => ({ operationId, operationKind, requestHash: contentHash({ hash }) });

describe("grant store：回执与效果同事务", () => {
  it("带 operation 的 create 落回执，可按 operation_id 查回", () => {
    const db = new DatabaseSync(":memory:");
    const store = new MerchantGrantStore({ db, now: () => NOW });
    const created = store.createGrant(owner(), createInput, op("op-1", "grant_create", "a"));
    const receipt = store.getOperation(MERCHANT, "op-1");
    expect(receipt).toMatchObject({ operation_kind: "grant_create", grant_id: created.grant_id });
    expect(receipt?.response).toMatchObject({ grant_version: 1, authorization_generation: 1 });
    db.close();
  });

  it("不带 operation 的调用不产生回执（非决定路径）", () => {
    const db = new DatabaseSync(":memory:");
    const store = new MerchantGrantStore({ db, now: () => NOW });
    store.createGrant(owner(), createInput);
    expect(store.getOperation(MERCHANT, "op-absent")).toBeUndefined();
    db.close();
  });

  it("同 operation_id 同请求重放 → 回原回执，不产生第二张授权", () => {
    const db = new DatabaseSync(":memory:");
    const store = new MerchantGrantStore({ db, now: () => NOW });
    const operation = op("op-same", "grant_create", "same-request");
    const first = store.createGrant(owner(), createInput, operation);
    const replay = store.createGrant(owner(), createInput, operation);
    expect(replay).toEqual(first);
    expect(store.listGrants(MERCHANT).items).toHaveLength(1);
    db.close();
  });

  it("同 operation_id 异请求 → version_conflict（不静默复用）", () => {
    const db = new DatabaseSync(":memory:");
    const store = new MerchantGrantStore({ db, now: () => NOW });
    store.createGrant(owner(), createInput, op("op-conflict", "grant_create", "request-a"));
    expect(() =>
      store.createGrant(
        owner(),
        { ...createInput, subjectId: "operator:2" },
        op("op-conflict", "grant_create", "request-b"),
      ),
    ).toThrowError(MerchantGrantError);
    db.close();
  });

  it("getOperation 按商家隔离", () => {
    const db = new DatabaseSync(":memory:");
    const store = new MerchantGrantStore({ db, now: () => NOW });
    store.createGrant(owner(), createInput, op("op-scoped", "grant_create", "a"));
    expect(store.getOperation("merchant-002", "op-scoped")).toBeUndefined();
    db.close();
  });

  it("revoke 也落回执", () => {
    const db = new DatabaseSync(":memory:");
    const store = new MerchantGrantStore({ db, now: () => NOW });
    const created = store.createGrant(owner(), createInput);
    store.revokeGrant(owner(), created.grant_id, op("op-revoke", "grant_revoke", "a"));
    expect(store.getOperation(MERCHANT, "op-revoke")).toMatchObject({
      operation_kind: "grant_revoke",
      grant_id: created.grant_id,
    });
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
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => NOW });
  const grants = new MerchantGrantStore({ db, now: () => NOW });
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({ products: [] }),
    approvals,
    mode: () => "supervised",
    now: () => NOW,
    commandPrincipalId: PRINCIPAL,
    extraExecutors: createGrantExecutors({
      merchantId: MERCHANT,
      getStore: () => grants,
    }),
  });
  return { db, approvals, grants, core };
}

describe("grant 执行器：写后不确定可对账", () => {
  it("create 写后不确定 → 按 operation_id 查回执得出 succeeded（本文件的核心）", async () => {
    const { db, approvals, grants, core } = coreFixture();
    const prepared = await core.prepareGrantCreate({
      ownerActorId: ACTOR,
      subjectId: "operator:1",
      action: "broadcast.draft",
      resourceType: "merchant",
      resourceSelector: "merchant",
      expiresAt: EXPIRES,
    });
    const candidateId = prepared.candidate.candidate_id;

    // 模拟「写成功了，但结果没回到我们这里」：认领 → 直接对 store 写入 → 候选 supersede
    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    grants.createGrant(
      owner(),
      createInput,
      op("operation-uncertain-create", GRANT_OPERATION_KINDS.create, "original-request"),
    );
    approvals.supersede(candidateId);

    // 若执行器仍缺 queryOutcome，这里会返回 unknown +「no downstream operation query adapter」
    await expect(
      core.queryCommittedDecisionOutcome({
        operationId: "operation-uncertain-create",
        candidateId,
        actorId: ACTOR,
        decision: "approve",
      }),
    ).resolves.toEqual({ status: "succeeded" });
    expect(core.getCommand(candidateId)?.status).toBe("executed");
    db.close();
  });

  it("revoke 写后不确定 → 查回执得出 succeeded", async () => {
    const { db, approvals, grants, core } = coreFixture();
    const created = grants.createGrant(owner(), createInput);
    const prepared = await core.prepareGrantRevoke({
      ownerActorId: ACTOR,
      grantId: created.grant_id,
    });
    const candidateId = prepared.candidate.candidate_id;

    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    grants.revokeGrant(
      owner(),
      created.grant_id,
      op("operation-uncertain-revoke", GRANT_OPERATION_KINDS.revoke, "original-request"),
    );
    approvals.supersede(candidateId);

    await expect(
      core.queryCommittedDecisionOutcome({
        operationId: "operation-uncertain-revoke",
        candidateId,
        actorId: ACTOR,
        decision: "approve",
      }),
    ).resolves.toEqual({ status: "succeeded" });
    expect(core.getCommand(candidateId)?.status).toBe("executed");
    db.close();
  });

  it("revoke 回执对着别的 grant → 判 unknown，不当成功", async () => {
    const { db, approvals, grants, core } = coreFixture();
    const target = grants.createGrant(owner(), createInput);
    const other = grants.createGrant(owner(), { ...createInput, subjectId: "operator:2" });
    const prepared = await core.prepareGrantRevoke({
      ownerActorId: ACTOR,
      grantId: target.grant_id,
    });
    const candidateId = prepared.candidate.candidate_id;

    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    grants.revokeGrant(
      owner(),
      other.grant_id,
      op("operation-mismatch", GRANT_OPERATION_KINDS.revoke, "other-request"),
    );
    approvals.supersede(candidateId);

    const outcome = await core.queryCommittedDecisionOutcome({
      operationId: "operation-mismatch",
      candidateId,
      actorId: ACTOR,
      decision: "approve",
    });
    expect(outcome.status).toBe("unknown");
    expect(core.getCommand(candidateId)?.status).not.toBe("executed");
    db.close();
  });
});
