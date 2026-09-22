// 促销写的对账适配器（内部写缺口的第三批：grant/promotion/service-control 之 promotion）。
//
// 促销是 **kiwi 内部写**——没有下游服务可问。与广播的独立回执表不同：促销权威行
// 自带 `approval_ref`，publish/withdraw 在 `begin immediate` 里把它与状态迁移写进
// 同一个 UPDATE（「查到引用 ⟺ 效果已提交」），因此**不需要改 schema**，只需按它加
// 一个查询 + 执行器 `queryOutcome`。此前两个促销执行器都没有 `queryOutcome`，写后
// 不确定时 `MerchantCommandLog.reconcile` 只能返回 unknown +「no downstream
// operation query adapter」——把一次**本可自动判定**的对账变成人工升级。
//
// 已知限制（刻意，非缺陷）：每行只保留**最近一次**操作的 approval_ref；本次操作之后
// 若又有新操作覆盖了它，本次查询返回 undefined → unknown（保守升级人工，不会误判）。
//
// 本文件守三层：
//   1. store：getOperation 按 approval_ref 命中、按商家隔离、被覆盖后保守查不到；
//   2. executor：publish/withdraw 写入把 committed decision 的 operationId 落成 approval_ref；
//   3. **对账**：写后不确定时按 operationId 查回执得出 succeeded（核心）。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient } from "../src/agent/merchant/fake-merchant-client.js";
import { createPromotionExecutors } from "../src/merchant/promotion-executors.js";
import { MerchantPromotionStore } from "../src/merchant/promotion-store.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { testProfile } from "./helpers.js";

const NOW = "2026-09-21T12:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const MERCHANT = "merchant-001";
const ACTOR = "owner:merchant-001";

const draftInput = {
  skuRefs: ["sku-1"],
  rule: {
    kind: "limited_price",
    unit_price: { currency: "CNY", amount_minor: "9999" },
  },
  audience: "public" as const,
  starts: "2026-09-21T00:00:00Z",
  ends: "2026-09-22T00:00:00Z",
  timezone: "UTC",
};

describe("promotion store：按 approval_ref 对账查询", () => {
  it("publish 后 approval_ref 可按 operationId 查回，且状态是 published", () => {
    const db = new DatabaseSync(":memory:");
    const store = new MerchantPromotionStore({ db, now: () => NOW });
    const draft = store.createDraft(MERCHANT, draftInput);
    store.publish(MERCHANT, draft.promotion_id, 1, {
      publishedBy: ACTOR,
      approvalRef: "op-publish-1",
    });
    expect(store.getOperation(MERCHANT, "op-publish-1")).toMatchObject({
      promotion_id: draft.promotion_id,
      status: "published",
      revision: 2,
    });
    db.close();
  });

  it("getOperation 按商家隔离", () => {
    const db = new DatabaseSync(":memory:");
    const store = new MerchantPromotionStore({ db, now: () => NOW });
    const draft = store.createDraft(MERCHANT, draftInput);
    store.publish(MERCHANT, draft.promotion_id, 1, {
      publishedBy: ACTOR,
      approvalRef: "op-scoped",
    });
    expect(store.getOperation("merchant-002", "op-scoped")).toBeUndefined();
    db.close();
  });

  it("withdraw 把 approval_ref 换成自己的 operationId，旧操作保守查不到", () => {
    const db = new DatabaseSync(":memory:");
    const store = new MerchantPromotionStore({ db, now: () => NOW });
    const draft = store.createDraft(MERCHANT, draftInput);
    store.publish(MERCHANT, draft.promotion_id, 1, {
      publishedBy: ACTOR,
      approvalRef: "op-publish-old",
    });
    store.withdraw(MERCHANT, draft.promotion_id, 2, {
      publishedBy: ACTOR,
      approvalRef: "op-withdraw-new",
    });
    expect(store.getOperation(MERCHANT, "op-withdraw-new")).toMatchObject({
      status: "withdrawn",
      revision: 3,
    });
    // 每行只留最近一次操作的引用：被覆盖的旧操作返回 undefined → 对账 unknown
    // （保守升级为人工，不会误判成功）。这是刻意限制，见 store.getOperation 注释。
    expect(store.getOperation(MERCHANT, "op-publish-old")).toBeUndefined();
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
  const promotions = new MerchantPromotionStore({ db, now: () => NOW });
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({ products: [] }),
    approvals,
    mode: () => "supervised",
    now: () => NOW,
    commandPrincipalId: PRINCIPAL,
    extraExecutors: createPromotionExecutors({
      merchantId: MERCHANT,
      getStore: () => promotions,
    }),
  });
  return { db, approvals, promotions, core };
}

describe("促销执行器：写后不确定可对账", () => {
  it("publish 写后不确定 → 按 operationId 查回执得出 succeeded（本文件的核心）", async () => {
    const { db, approvals, promotions, core } = coreFixture();
    const draft = promotions.createDraft(MERCHANT, draftInput);
    const prepared = await core.preparePromotionPublish({
      promotionId: draft.promotion_id,
      expectedRevision: 1,
    });
    const candidateId = prepared.candidate.candidate_id;

    // 模拟「写成功了，但结果没回到我们这里」：认领 → 直接对 store 写入 → 候选 supersede
    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    promotions.publish(MERCHANT, draft.promotion_id, 1, {
      publishedBy: ACTOR,
      approvalRef: "operation-uncertain-publish",
    });
    approvals.supersede(candidateId);

    // 若执行器仍缺 queryOutcome，这里会返回 unknown +「no downstream operation query adapter」
    await expect(
      core.queryCommittedDecisionOutcome({
        operationId: "operation-uncertain-publish",
        candidateId,
        actorId: ACTOR,
        decision: "approve",
      }),
    ).resolves.toEqual({ status: "succeeded" });
    expect(core.getCommand(candidateId)?.status).toBe("executed");
    db.close();
  });

  it("withdraw 写后不确定 → 查回执得出 succeeded", async () => {
    const { db, approvals, promotions, core } = coreFixture();
    const draft = promotions.createDraft(MERCHANT, draftInput);
    promotions.publish(MERCHANT, draft.promotion_id, 1, {
      publishedBy: ACTOR,
      approvalRef: "op-setup-publish",
    });
    const prepared = await core.preparePromotionWithdraw({
      promotionId: draft.promotion_id,
      expectedRevision: 2,
    });
    const candidateId = prepared.candidate.candidate_id;

    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    promotions.withdraw(MERCHANT, draft.promotion_id, 2, {
      publishedBy: ACTOR,
      approvalRef: "operation-uncertain-withdraw",
    });
    approvals.supersede(candidateId);

    await expect(
      core.queryCommittedDecisionOutcome({
        operationId: "operation-uncertain-withdraw",
        candidateId,
        actorId: ACTOR,
        decision: "approve",
      }),
    ).resolves.toEqual({ status: "succeeded" });
    expect(core.getCommand(candidateId)?.status).toBe("executed");
    db.close();
  });

  it("回执对着别的促销 → 判 unknown，不当成功", async () => {
    const { db, approvals, promotions, core } = coreFixture();
    const draft = promotions.createDraft(MERCHANT, draftInput);
    const other = promotions.createDraft(MERCHANT, draftInput);
    const prepared = await core.preparePromotionPublish({
      promotionId: draft.promotion_id,
      expectedRevision: 1,
    });
    const candidateId = prepared.candidate.candidate_id;

    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    promotions.publish(MERCHANT, other.promotion_id, 1, {
      publishedBy: ACTOR,
      approvalRef: "operation-mismatch",
    });
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

  it("publish 的目标态不符（回执是 withdraw 落的）→ 判 unknown", async () => {
    const { db, approvals, promotions, core } = coreFixture();
    const draft = promotions.createDraft(MERCHANT, draftInput);
    const prepared = await core.preparePromotionPublish({
      promotionId: draft.promotion_id,
      expectedRevision: 1,
    });
    const candidateId = prepared.candidate.candidate_id;

    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    // 同一 promotion_id、同一 operationId，但落的是 withdraw 的效果：
    // publish 的对账必须核对目标态，不能只看 approval_ref 命中。
    promotions.publish(MERCHANT, draft.promotion_id, 1, {
      publishedBy: ACTOR,
      approvalRef: "op-setup",
    });
    promotions.withdraw(MERCHANT, draft.promotion_id, 2, {
      publishedBy: ACTOR,
      approvalRef: "operation-wrong-kind",
    });
    approvals.supersede(candidateId);

    const outcome = await core.queryCommittedDecisionOutcome({
      operationId: "operation-wrong-kind",
      candidateId,
      actorId: ACTOR,
      decision: "approve",
    });
    expect(outcome.status).toBe("unknown");
    expect(core.getCommand(candidateId)?.status).not.toBe("executed");
    db.close();
  });
});
