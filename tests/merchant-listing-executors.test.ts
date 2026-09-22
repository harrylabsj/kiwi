// 上下架写入执行器（v1：带 operation receipt，可对账）。
//
// 这条测试守的是 B 线最后那个缺口：上下架此前上游连状态都没有，只能 fail-closed
// 报「不可得」；有了 v1 端点后，若执行器仍是 merchant-core 里那条 legacy（没有
// queryOutcome），写后不确定时 `queryCommittedDecisionOutcome` 只能返回
// `unknown` +「no downstream operation query adapter for
// kiwi_merchant_prepare_listing_change」——无法查明副作用是否真的发生过。
//
// 因此本文件的核心断言不是"paused 被改了"，而是：
//   **写后不确定时，按 operation_id 查下游回执能得出 succeeded。**
// 若注册表里仍是 legacy 那条（没有 queryOutcome），这条断言必红——所以它同时
// 证明了「extras 覆盖同名的 defaults」这一注册语义确实生效。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import {
  contentHash,
  WriteApprovalCandidateStore,
} from "../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient } from "../src/agent/merchant/fake-merchant-client.js";
import type { ExactMerchantProduct } from "../src/agent/merchant/types.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { createListingExecutors } from "../src/merchant/listing-executors.js";
import { testProfile } from "./helpers.js";

const NOW = "2026-09-22T00:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const MERCHANT = "merchant-001";
const CURRENCY_TABLE = "kiwi-workbench-currency-v1-2026-09-21";

function exactProduct(sku: string, listingPaused = false): ExactMerchantProduct {
  return {
    sku,
    merchant_id: MERCHANT,
    title: "Tea",
    description: "",
    category: "",
    tags: [],
    stock: 5,
    listing_paused: listingPaused,
    currency: "CNY",
    price_minor: "8800",
    currency_table_version: CURRENCY_TABLE,
    authority_version: 1,
    delivery_attributes: [],
    handoff_destination: "",
  };
}

function makeCore(exactProducts: ExactMerchantProduct[]) {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals
     (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, NOW, NOW);
  const approvals = new WriteApprovalCandidateStore({
    db,
    principalId: PRINCIPAL,
    now: () => NOW,
  });
  const client = new FakeMerchantClient({
    products: exactProducts.map((p) => ({
      sku: p.sku,
      merchant_id: p.merchant_id,
      title: p.title,
      description: "",
      category: "",
      tags: [],
      price: 88,
      currency: "CNY",
      stock: p.stock,
      delivery_attributes: [],
      paused: p.listing_paused === true,
    })),
    exactProducts,
  });
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: client,
    approvals,
    mode: () => "supervised",
    now: () => NOW,
    commandPrincipalId: PRINCIPAL,
    extraExecutors: createListingExecutors({ merchantId: MERCHANT, client }),
  });
  return { core, client, approvals };
}

async function execute(core: MerchantCoreService, candidateId: string, operationId: string) {
  const candidate = core.getCommand(candidateId)!;
  return await core.executeCommittedDecision(
    { operationId, candidateId, actorId: "owner:merchant-001", decision: "approve" },
    {
      verifyCommittedDecision: (input) =>
        input.actionDigest ===
        contentHash({
          arguments: candidate.arguments,
          preconditions: candidate.preconditions,
        }),
    },
  );
}

describe("上下架写入执行器（v1）", () => {
  it("经已提交决定写入，销售状态与回执同时落地", async () => {
    const { core, client } = makeCore([exactProduct("sku-a")]);
    const prepared = await core.prepareListingChange({
      sku: "sku-a",
      paused: true,
      authorization: { actor_id: "owner:merchant-001", action: "product.draft" },
    });
    // 未走确认通道 → 不得执行
    await expect(core.executeApproved(prepared.candidate.candidate_id)).rejects.toThrow(/WebAuthn/);

    await expect(execute(core, prepared.candidate.candidate_id, "op-lst-1")).resolves.toMatchObject({
      kind: "executed",
    });
    expect((await client.getExactProduct(MERCHANT, "sku-a")).listing_paused).toBe(true);
    // legacy 读面同步（两套读面不能各说各话）
    expect((await client.getProduct("sku-a")).paused).toBe(true);
    // 回执落库且 kind 正确，响应体携带 paused 目标态（对账核对的语义字段）
    const receipt = await client.getProductOperation(MERCHANT, "op-lst-1");
    expect(receipt).toMatchObject({ operation_kind: "product_listing_change", sku: "sku-a" });
    expect((receipt.result?.["product"] as { listing_paused?: unknown }).listing_paused).toBe(true);
  });

  it("写后不确定 → 按 operation_id 查回执得出 succeeded（本文件的核心）", async () => {
    const { core, client, approvals } = makeCore([exactProduct("sku-b")]);
    const prepared = await core.prepareListingChange({
      sku: "sku-b",
      paused: true,
      authorization: { actor_id: "owner:merchant-001", action: "product.draft" },
    });
    const candidateId = prepared.candidate.candidate_id;

    // 模拟「下游写成功了，但回执没回到我们这里」：先认领，再直接对下游写入，然后候选被 supersede
    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    await client.updateListingExact({
      operation_id: "op-lst-uncertain",
      merchant_id: MERCHANT,
      sku: "sku-b",
      paused: true,
      currency_table_version: CURRENCY_TABLE,
    });
    approvals.supersede(candidateId);

    // 若注册表里仍是 legacy 执行器（没有 queryOutcome），这里会返回
    // unknown +「no downstream operation query adapter for …」——那正是要修的缺口。
    await expect(
      core.queryCommittedDecisionOutcome({
        operationId: "op-lst-uncertain",
        candidateId,
        actorId: "owner:merchant-001",
        decision: "approve",
      }),
    ).resolves.toEqual({ status: "succeeded" });
    expect(core.getCommand(candidateId)?.status).toBe("executed");
  });

  it("回执存在但对着别的 sku → 判 unknown，不当成功", async () => {
    const { core, client, approvals } = makeCore([exactProduct("sku-c"), exactProduct("sku-d")]);
    const prepared = await core.prepareListingChange({
      sku: "sku-c",
      paused: true,
      authorization: { actor_id: "owner:merchant-001", action: "product.draft" },
    });
    const candidateId = prepared.candidate.candidate_id;
    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    // 回执是给 sku-d 的，候选要的是 sku-c → 不得据此判成功
    await client.updateListingExact({
      operation_id: "op-lst-mismatch",
      merchant_id: MERCHANT,
      sku: "sku-d",
      paused: true,
      currency_table_version: CURRENCY_TABLE,
    });
    approvals.supersede(candidateId);

    const outcome = await core.queryCommittedDecisionOutcome({
      operationId: "op-lst-mismatch",
      candidateId,
      actorId: "owner:merchant-001",
      decision: "approve",
    });
    expect(outcome.status).toBe("unknown");
    expect(core.getCommand(candidateId)?.status).not.toBe("executed");
  });

  it("回执 kind/sku 对上但 paused 目标态相反 → 判 unknown（回执属于另一次写）", async () => {
    const { core, client, approvals } = makeCore([exactProduct("sku-e")]);
    // 候选要「恢复销售」（paused=false）
    const prepared = await core.prepareListingChange({
      sku: "sku-e",
      paused: false,
      authorization: { actor_id: "owner:merchant-001", action: "product.draft" },
    });
    const candidateId = prepared.candidate.candidate_id;
    approvals.markApproved(candidateId);
    approvals.claimForExecution(candidateId);
    // 同 operation_id 在下游留下的回执却是「暂停销售」（paused=true）——
    // 上游按冲突拒绝第二次写，留下的回执反映的是另一次写，不得据它判成功。
    await client.updateListingExact({
      operation_id: "op-lst-flip",
      merchant_id: MERCHANT,
      sku: "sku-e",
      paused: true,
      currency_table_version: CURRENCY_TABLE,
    });
    approvals.supersede(candidateId);

    const outcome = await core.queryCommittedDecisionOutcome({
      operationId: "op-lst-flip",
      candidateId,
      actorId: "owner:merchant-001",
      decision: "approve",
    });
    expect(outcome.status).toBe("unknown");
    expect(core.getCommand(candidateId)?.status).not.toBe("executed");
  });
});
