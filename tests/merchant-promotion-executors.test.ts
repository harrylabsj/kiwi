import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import {
  contentHash,
  WriteApprovalCandidateStore,
} from "../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient } from "../src/agent/merchant/fake-merchant-client.js";
import { createPromotionExecutors } from "../src/merchant/promotion-executors.js";
import { MerchantPromotionStore } from "../src/merchant/promotion-store.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { testProfile } from "./helpers.js";

const NOW = "2026-09-21T12:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";

describe("approval-gated promotion executors", () => {
  it("publishes and withdraws only from committed decisions with operation audit refs", async () => {
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db);
    db.prepare(
      `INSERT INTO principals
       (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
       VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
    ).run(PRINCIPAL, NOW, NOW);
    const promotions = new MerchantPromotionStore({ db, now: () => NOW });
    const approvals = new WriteApprovalCandidateStore({
      db,
      principalId: PRINCIPAL,
      now: () => NOW,
    });
    const core = new MerchantCoreService({
      profile: testProfile(),
      merchantClient: new FakeMerchantClient({ products: [] }),
      approvals,
      mode: () => "supervised",
      now: () => NOW,
      commandPrincipalId: PRINCIPAL,
      extraExecutors: createPromotionExecutors({
        merchantId: "merchant-001",
        getStore: () => promotions,
      }),
    });
    const draft = promotions.createDraft("merchant-001", {
      skuRefs: ["sku-1"],
      rule: {
        kind: "limited_price",
        unit_price: { currency: "CNY", amount_minor: "9999" },
      },
      audience: "public",
      starts: "2026-09-21T00:00:00Z",
      ends: "2026-09-22T00:00:00Z",
      timezone: "UTC",
    });
    const execute = async (candidateId: string, operationId: string) => {
      const candidate = core.getCommand(candidateId)!;
      return await core.executeCommittedDecision(
        {
          operationId,
          candidateId,
          actorId: "owner:merchant-001",
          decision: "approve",
        },
        {
          verifyCommittedDecision: (input) =>
            input.actionDigest ===
            contentHash({
              arguments: candidate.arguments,
              preconditions: candidate.preconditions,
            }),
        },
      );
    };

    const publish = await core.preparePromotionPublish({
      promotionId: draft.promotion_id,
      expectedRevision: 1,
    });
    await expect(core.executeApproved(publish.candidate.candidate_id)).rejects.toThrow(/WebAuthn/);
    expect(await execute(publish.candidate.candidate_id, "operation-publish")).toMatchObject({
      kind: "executed",
    });
    expect(promotions.getPromotion("merchant-001", draft.promotion_id)).toMatchObject({
      status: "published",
      revision: 2,
      published_by: "owner:merchant-001",
      approval_ref: "operation-publish",
    });

    const withdraw = await core.preparePromotionWithdraw({
      promotionId: draft.promotion_id,
      expectedRevision: 2,
    });
    expect(await execute(withdraw.candidate.candidate_id, "operation-withdraw")).toMatchObject({
      kind: "executed",
    });
    expect(promotions.getPromotion("merchant-001", draft.promotion_id)).toMatchObject({
      status: "withdrawn",
      revision: 3,
      approval_ref: "operation-withdraw",
    });
    db.close();
  });
});
