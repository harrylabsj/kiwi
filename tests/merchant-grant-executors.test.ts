import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import {
  contentHash,
  WriteApprovalCandidateStore,
} from "../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient } from "../src/agent/merchant/fake-merchant-client.js";
import { createGrantExecutors } from "../src/merchant/grant-executors.js";
import { MerchantGrantStore } from "../src/merchant/grant-store.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { testProfile } from "./helpers.js";

const NOW = "2026-09-21T12:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";

function fixture() {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals
     (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, NOW, NOW);
  const grants = new MerchantGrantStore({ db, now: () => NOW });
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => NOW });
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({ products: [] }),
    approvals,
    mode: () => "supervised",
    now: () => NOW,
    commandPrincipalId: PRINCIPAL,
    extraExecutors: createGrantExecutors({
      merchantId: "merchant-001",
      getStore: () => grants,
    }),
  });
  const execute = async (candidateId: string) => {
    const candidate = core.getCommand(candidateId)!;
    return await core.executeCommittedDecision(
      {
        operationId: `operation-${candidateId}`,
        candidateId,
        actorId: "owner:merchant-001",
        decision: "approve",
      },
      {
        verifyCommittedDecision: (input) =>
          input.actionDigest === contentHash({
            arguments: candidate.arguments,
            preconditions: candidate.preconditions,
          }),
      },
    );
  };
  return { db, grants, core, execute };
}

describe("approval-gated Operator grant executors", () => {
  it("blocks legacy approval and applies create/revoke only after committed decisions", async () => {
    const { db, grants, core, execute } = fixture();
    const create = await core.prepareGrantCreate({
      ownerActorId: "owner:merchant-001",
      subjectId: "operator:1",
      action: "broadcast.draft",
      resourceType: "merchant",
      resourceSelector: "merchant",
      expiresAt: "2026-10-21T12:00:00.000Z",
    });
    await expect(core.executeApproved(create.candidate.candidate_id)).rejects.toThrow(/WebAuthn/);
    expect(grants.listGrants("merchant-001").items).toHaveLength(0);
    expect(await execute(create.candidate.candidate_id)).toMatchObject({ kind: "executed" });
    const [grant] = grants.listGrants("merchant-001").items;
    expect(grant).toMatchObject({
      subject_id: "operator:1",
      action: "broadcast.draft",
      revoked_at: null,
    });

    const revoke = await core.prepareGrantRevoke({
      ownerActorId: "owner:merchant-001",
      grantId: grant!.grant_id,
    });
    expect(await execute(revoke.candidate.candidate_id)).toMatchObject({ kind: "executed" });
    expect(grants.getGrant("merchant-001", grant!.grant_id)?.revoked_at).toBe(NOW);
    db.close();
  });

  it("supersedes a stale grant candidate after an authorization-generation change", async () => {
    const { db, grants, core, execute } = fixture();
    const first = await core.prepareGrantCreate({
      ownerActorId: "owner:merchant-001",
      subjectId: "operator:1",
      action: "broadcast.draft",
      resourceType: "merchant",
      resourceSelector: "merchant",
      expiresAt: "2026-10-21T12:00:00.000Z",
    });
    const stale = await core.prepareGrantCreate({
      ownerActorId: "owner:merchant-001",
      subjectId: "operator:1",
      action: "broadcast.decide",
      resourceType: "merchant",
      resourceSelector: "merchant",
      expiresAt: "2026-10-21T12:00:00.000Z",
    });
    await execute(first.candidate.candidate_id);
    expect(await execute(stale.candidate.candidate_id)).toMatchObject({ kind: "stale" });
    expect(grants.listGrants("merchant-001").items).toHaveLength(1);
    db.close();
  });
});
