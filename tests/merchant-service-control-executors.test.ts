import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import {
  contentHash,
  WriteApprovalCandidateStore,
} from "../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient } from "../src/agent/merchant/fake-merchant-client.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import { createServiceControlExecutors } from "../src/merchant/service-control-executors.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { testProfile } from "./helpers.js";

const NOW = "2026-09-21T12:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";

describe("committed service recovery executor", () => {
  it("requires WebAuthn committed decision and a fresh readiness gate", async () => {
    const db = new DatabaseSync(":memory:");
    migrateMemorySchema(db);
    db.prepare(
      `INSERT INTO principals
       (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
       VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
    ).run(PRINCIPAL, NOW, NOW);
    const state = new MutableServiceState("OPERATING");
    state.attachPersistence(db, "merchant-001");
    state.pause("incident");
    const approvals = new WriteApprovalCandidateStore({
      db,
      principalId: PRINCIPAL,
      now: () => NOW,
    });
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
    const prepared = await core.prepareServiceResume({ expectedRevision: 2 });
    await expect(core.executeApproved(prepared.candidate.candidate_id)).rejects.toThrow(/WebAuthn/);
    expect(state.state).toBe("PAUSED");
    const candidate = core.getCommand(prepared.candidate.candidate_id)!;
    expect(
      await core.executeCommittedDecision(
        {
          operationId: "operation-resume",
          candidateId: candidate.candidate_id,
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
      ),
    ).toMatchObject({ kind: "executed" });
    expect(state.state).toBe("OPERATING");
    expect(state.serviceRevision).toBe(3);
    db.close();
  });
});
