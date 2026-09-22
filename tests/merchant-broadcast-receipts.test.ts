// 广播写的 operation receipt（B 线：kiwi 内部写的对账适配器）。
//
// 广播是 **kiwi 内部写**——没有下游服务可问，回执就落在 feed store 自己的表里，
// 且与效果**同事务**。此前三个广播执行器（publish/revise/withdraw）都没有
// `queryOutcome`，于是写后不确定时 `MerchantCommandLog.reconcile` 只能返回
// unknown +「no downstream operation query adapter」——把一次**本可自动判定**的
// 对账变成人工升级。
//
// 本文件守三层：
//   1. store：回执与效果同事务、同 operation_id 重放不重做、异请求冲突、按商家隔离；
//   2. executor：写入带 committed decision 的 operationId；
//   3. **对账**：写后不确定时按 operation_id 查回执得出 succeeded（核心）。
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import {
  contentHash,
  WriteApprovalCandidateStore,
} from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { createBroadcastExecutors } from "../src/merchant/feed-executors.js";
import {
  BROADCAST_OPERATION_KINDS,
  type FeedOperation,
  MerchantFeedError,
  MerchantFeedStore,
} from "../src/merchant/feed-store.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { testProfile } from "./helpers.js";

const NOW = "2026-09-21T12:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const MERCHANT = "merchant-001";

function storeFixture() {
  const db = new DatabaseSync(":memory:");
  const store = new MerchantFeedStore({ db, cursorKey: randomBytes(32), now: () => NOW });
  return { db, store };
}

function input(title = "New product") {
  return {
    kind: "product_added",
    title,
    body: "Plain text update",
    skuRefs: ["sku-1"],
    audience: "public" as const,
  };
}

const op = (operationId: string, title: string): FeedOperation => ({
  operationId,
  operationKind: BROADCAST_OPERATION_KINDS.publish,
  requestHash: contentHash({ operation_kind: "broadcast_publish", title }),
});

describe("feed store：回执与效果同事务", () => {
  it("带 operation 写入后回执可按 operation_id 查回", () => {
    const { store } = storeFixture();
    const published = store.publishWithId("m1", "bct_aaaaaaaaaaaaaaaa", input(), op("op-1", "A"));
    expect(published).toMatchObject({ revision: 1 });
    expect(store.getOperation("m1", "op-1")).toMatchObject({
      operation_kind: "broadcast_publish",
      broadcast_id: "bct_aaaaaaaaaaaaaaaa",
      revision: 1,
    });
  });

  it("不带 operation 的便捷路径不产生回执（非决定路径）", () => {
    const { store } = storeFixture();
    const published = store.publish("m1", input());
    expect(store.getOperation("m1", `op-${published.broadcast_id}`)).toBeUndefined();
  });

  it("同 operation_id 同请求重放 → 回原回执，不产生第二次效果", () => {
    const { store } = storeFixture();
    const first = store.publishWithId("m1", "bct_bbbbbbbbbbbbbbbb", input("A"), op("op-same", "A"));
    const replay = store.publishWithId(
      "m1",
      "bct_bbbbbbbbbbbbbbbb",
      input("A"),
      op("op-same", "A"),
    );
    expect(replay).toEqual(first);
    // revision 没有前进 = 没有第二次效果
    expect(store.getBroadcast("m1", "bct_bbbbbbbbbbbbbbbb")?.revision).toBe(1);
  });

  it("同 operation_id 异请求 → 冲突（不静默复用）", () => {
    const { store } = storeFixture();
    store.publishWithId("m1", "bct_cccccccccccccccc", input("A"), op("op-conflict", "A"));
    expect(() =>
      store.publishWithId("m1", "bct_cccccccccccccccc", input("B"), op("op-conflict", "B")),
    ).toThrow(MerchantFeedError);
  });

  it("getOperation 按商家隔离", () => {
    const { store } = storeFixture();
    store.publishWithId("m1", "bct_dddddddddddddddd", input(), op("op-scoped", "A"));
    expect(store.getOperation("m2", "op-scoped")).toBeUndefined();
  });

  it("withdraw 也落回执", () => {
    const { store } = storeFixture();
    store.publishWithId("m1", "bct_eeeeeeeeeeeeeeee", input(), op("op-pub", "A"));
    store.withdraw("m1", "bct_eeeeeeeeeeeeeeee", 1, {
      operationId: "op-withdraw",
      operationKind: BROADCAST_OPERATION_KINDS.withdraw,
      requestHash: contentHash({ operation_kind: "broadcast_withdraw" }),
    });
    expect(store.getOperation("m1", "op-withdraw")).toMatchObject({
      operation_kind: "broadcast_withdraw",
      revision: 2,
    });
  });
});

// ── 执行器层：走完整决定链路 ────────────────────────────────────────
function coreFixture() {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals
     (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, NOW, NOW);
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => NOW });
  const feed = new MerchantFeedStore({ db, cursorKey: randomBytes(32), now: () => NOW });
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
    approvals,
    mode: () => "supervised",
    now: () => NOW,
    commandPrincipalId: PRINCIPAL,
    extraExecutors: createBroadcastExecutors({
      merchantId: MERCHANT,
      getStore: () => feed,
    }),
  });
  return { db, feed, core, approvals };
}

const content = (title: string) => ({
  kind: "service_notice",
  title,
  body: "Plain text announcement",
  audience: "public",
  sku_refs: ["sku-001"],
});

describe("广播执行器：写入带 operationId，且写后不确定可对账", () => {
  it("经已提交决定发布 → 回执落库且 kind 正确", async () => {
    const { core, feed } = coreFixture();
    const publish = await core.prepareBroadcastPublish({ broadcast: content("Initial") });
    const candidateId = publish.candidate.candidate_id;
    const broadcastId = String(publish.candidate.arguments.broadcast_id);
    const candidate = core.getCommand(candidateId)!;
    await core.executeCommittedDecision(
      { operationId: "operation-publish-1", candidateId, actorId: PRINCIPAL, decision: "approve" },
      {
        verifyCommittedDecision: (v: { actionDigest: string }) =>
          v.actionDigest ===
          contentHash({ arguments: candidate.arguments, preconditions: candidate.preconditions }),
      },
    );
    expect(feed.getBroadcast(MERCHANT, broadcastId)).toMatchObject({ status: "published" });
    expect(feed.getOperation(MERCHANT, "operation-publish-1")).toMatchObject({
      operation_kind: BROADCAST_OPERATION_KINDS.publish,
      broadcast_id: broadcastId,
    });
  });

  it("写后不确定 → 按 operation_id 查回执得出 succeeded（本文件的核心）", async () => {
    const { core, feed, approvals } = coreFixture();
    const publish = await core.prepareBroadcastPublish({ broadcast: content("Uncertain") });
    const candidateId = publish.candidate.candidate_id;
    const broadcastId = String(publish.candidate.arguments.broadcast_id);

    // 模拟「写成功了，但回执没回到我们这里」：认领 → 直接对 store 写入 → 候选 supersede
    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    feed.publishWithId(MERCHANT, broadcastId, {
      kind: "service_notice",
      title: "Uncertain",
      body: "Plain text announcement",
      skuRefs: ["sku-001"],
      audience: "public",
    }, {
      operationId: "operation-uncertain",
      operationKind: BROADCAST_OPERATION_KINDS.publish,
      requestHash: "sha256:whatever-the-original-request-was",
    });
    approvals.supersede(candidateId);

    // 若执行器仍缺 queryOutcome，这里会返回 unknown +「no downstream operation query adapter」
    await expect(
      core.queryCommittedDecisionOutcome({
        operationId: "operation-uncertain",
        candidateId,
        actorId: PRINCIPAL,
        decision: "approve",
      }),
    ).resolves.toEqual({ status: "succeeded" });
    expect(core.getCommand(candidateId)?.status).toBe("executed");
  });

  it("回执存在但对着别的广播 → 判 unknown，不当成功", async () => {
    const { core, feed, approvals } = coreFixture();
    const publish = await core.prepareBroadcastPublish({ broadcast: content("Mismatch") });
    const candidateId = publish.candidate.candidate_id;
    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    feed.publishWithId(MERCHANT, "bct_ffffffffffffffff", input("Other"), {
      operationId: "operation-mismatch",
      operationKind: BROADCAST_OPERATION_KINDS.publish,
      requestHash: "sha256:other",
    });
    approvals.supersede(candidateId);

    const outcome = await core.queryCommittedDecisionOutcome({
      operationId: "operation-mismatch",
      candidateId,
      actorId: PRINCIPAL,
      decision: "approve",
    });
    expect(outcome.status).toBe("unknown");
    expect(core.getCommand(candidateId)?.status).not.toBe("executed");
  });
});
