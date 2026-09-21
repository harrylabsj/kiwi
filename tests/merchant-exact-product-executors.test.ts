import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import {
  contentHash,
  WriteApprovalCandidateStore,
} from "../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient } from "../src/agent/merchant/fake-merchant-client.js";
import {
  WORKBENCH_CURRENCY_TABLE_VERSION,
  type ExactMoney,
} from "../src/merchant/application/money.js";
import { createExactProductExecutors } from "../src/merchant/exact-product-executors.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { testProfile } from "./helpers.js";

const NOW = "2026-09-21T12:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";

describe("exact-money product executors", () => {
  it("creates and updates exact products only through committed decisions", async () => {
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
    const client = new FakeMerchantClient();
    const core = new MerchantCoreService({
      profile: testProfile(),
      merchantClient: client,
      approvals,
      mode: () => "supervised",
      now: () => NOW,
      commandPrincipalId: PRINCIPAL,
      extraExecutors: createExactProductExecutors({
        merchantId: "merchant-001",
        client,
      }),
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
    const money = (amount: string): ExactMoney => ({
      currency: "CNY",
      amount_minor: amount,
      currency_table_version: WORKBENCH_CURRENCY_TABLE_VERSION,
    });
    const create = await core.prepareExactProductCreate({
      sku: "sku-exact",
      title: "Exact Product",
      money: money("9999"),
      stock: 5,
      expectedAuthorityVersion: 1,
      authorization: { actor_id: "owner:merchant-001", action: "product.create" },
    });
    await expect(core.executeApproved(create.candidate.candidate_id)).rejects.toThrow(/WebAuthn/);
    expect(JSON.stringify(create.candidate.arguments)).not.toContain("floor");
    expect(await execute(create.candidate.candidate_id, "operation-create")).toMatchObject({
      kind: "executed",
    });
    expect(await client.getExactProduct("merchant-001", "sku-exact")).toMatchObject({
      price_minor: "9999",
      authority_version: 1,
    });

    const update = await core.prepareExactProductMoneyUpdate({
      sku: "sku-exact",
      money: money("9250"),
      expectedAuthorityVersion: 1,
      authorization: { actor_id: "owner:merchant-001", action: "product.draft" },
    });
    expect(JSON.stringify(update.candidate.arguments)).not.toContain("floor");
    expect(await execute(update.candidate.candidate_id, "operation-update")).toMatchObject({
      kind: "executed",
    });
    expect((await client.getExactProduct("merchant-001", "sku-exact")).price_minor).toBe("9250");

    const uncertain = await core.prepareExactProductCreate({
      sku: "sku-uncertain",
      title: "Uncertain Product",
      money: money("5000"),
      stock: 2,
      expectedAuthorityVersion: 1,
      authorization: { actor_id: "owner:merchant-001", action: "product.create" },
    });
    approvals.markApproved(uncertain.candidate.candidate_id);
    approvals.claimForExecution(uncertain.candidate.candidate_id);
    await client.createExactProduct({
      operation_id: "operation-uncertain",
      merchant_id: "merchant-001",
      sku: "sku-uncertain",
      title: "Uncertain Product",
      price_minor: "5000",
      stock: 2,
      expected_authority_version: 1,
      currency: "CNY",
      currency_table_version: WORKBENCH_CURRENCY_TABLE_VERSION,
    });
    approvals.supersede(uncertain.candidate.candidate_id);
    await expect(
      core.queryCommittedDecisionOutcome({
        operationId: "operation-uncertain",
        candidateId: uncertain.candidate.candidate_id,
        actorId: "owner:merchant-001",
        decision: "approve",
      }),
    ).resolves.toEqual({ status: "succeeded" });
    expect(core.getCommand(uncertain.candidate.candidate_id)?.status).toBe("executed");

    const missing = await core.prepareExactProductCreate({
      sku: "sku-missing-receipt",
      title: "Missing Receipt",
      money: money("5100"),
      stock: 1,
      expectedAuthorityVersion: 1,
      authorization: { actor_id: "owner:merchant-001", action: "product.create" },
    });
    approvals.markApproved(missing.candidate.candidate_id);
    approvals.claimForExecution(missing.candidate.candidate_id);
    approvals.supersede(missing.candidate.candidate_id);
    await expect(
      core.queryCommittedDecisionOutcome({
        operationId: "operation-missing",
        candidateId: missing.candidate.candidate_id,
        actorId: "owner:merchant-001",
        decision: "approve",
      }),
    ).resolves.toMatchObject({ status: "unknown" });
    db.close();
  });
});
