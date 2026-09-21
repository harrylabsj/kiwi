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
import { MerchantFeedStore } from "../src/merchant/feed-store.js";
import { createBroadcastExecutors } from "../src/merchant/feed-executors.js";
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
  const approvals = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => NOW });
  const feed = new MerchantFeedStore({ db, cursorKey: randomBytes(32), now: () => NOW });
  const publishedWorkflows: string[] = [];
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
    approvals,
    mode: () => "supervised",
    now: () => NOW,
    commandPrincipalId: PRINCIPAL,
    extraExecutors: createBroadcastExecutors({
      merchantId: "merchant-001",
      getStore: () => feed,
      onPublished: (args) => {
        if (typeof args.workflow_id === "string") publishedWorkflows.push(args.workflow_id);
      },
    }),
  });
  return { db, feed, core, publishedWorkflows };
}

const content = (title: string) => ({
  kind: "service_notice",
  title,
  body: "Plain text announcement",
  audience: "public",
  sku_refs: ["sku-001"],
});

describe("approval-gated Feed executors", () => {
  it("publish/revise/withdraw only change Feed after candidate approval", async () => {
    const { db, feed, core } = fixture();
    const publish = await core.prepareBroadcastPublish({ broadcast: content("Initial") });
    const broadcastId = String(publish.candidate.arguments.broadcast_id);
    expect(feed.getBroadcast("merchant-001", broadcastId)).toBeUndefined();
    await expect(core.executeApproved(publish.candidate.candidate_id)).rejects.toThrow(/WebAuthn/);
    expect(feed.getBroadcast("merchant-001", broadcastId)).toBeUndefined();
    db.close();
  });

  it("publish/revise/withdraw executors apply after the committed-decision gate", async () => {
    const { db, feed, core } = fixture();
    const execute = async (candidateId: string) => {
      const candidate = core.getCommand(candidateId)!;
      const verifier = {
        verifyCommittedDecision: (input: { actionDigest: string }) =>
          input.actionDigest ===
          contentHash({
            arguments: candidate.arguments,
            preconditions: candidate.preconditions,
          }),
      };
      return await core.executeCommittedDecision(
        {
          operationId: `operation-${candidateId}`,
          candidateId,
          actorId: PRINCIPAL,
          decision: "approve",
        },
        verifier,
      );
    };
    const publish = await core.prepareBroadcastPublish({ broadcast: content("Initial") });
    const broadcastId = String(publish.candidate.arguments.broadcast_id);
    expect(await execute(publish.candidate.candidate_id)).toMatchObject({ kind: "executed" });
    expect(feed.getBroadcast("merchant-001", broadcastId)).toMatchObject({
      title: "Initial",
      revision: 1,
      status: "published",
    });

    const revise = await core.prepareBroadcastRevise({
      broadcastId,
      expectedRevision: 1,
      broadcast: content("Revised"),
    });
    expect(feed.getBroadcast("merchant-001", broadcastId)?.title).toBe("Initial");
    expect(await execute(revise.candidate.candidate_id)).toMatchObject({ kind: "executed" });
    expect(feed.getBroadcast("merchant-001", broadcastId)).toMatchObject({
      title: "Revised",
      revision: 2,
    });

    const withdraw = await core.prepareBroadcastWithdraw({
      broadcastId,
      expectedRevision: 2,
    });
    expect(await execute(withdraw.candidate.candidate_id)).toMatchObject({ kind: "executed" });
    expect(feed.getBroadcast("merchant-001", broadcastId)).toMatchObject({
      revision: 3,
      status: "withdrawn",
    });
    const events = feed.read("merchant-001");
    expect(events.kind).toBe("events");
    if (events.kind === "events") {
      expect(events.events.map((event) => event.event_type)).toEqual([
        "published",
        "revised",
        "withdrawn",
      ]);
    }
    db.close();
  });

  it("stale revision is superseded before any Feed write", async () => {
    const { db, feed, core } = fixture();
    const publish = await core.prepareBroadcastPublish({ broadcast: content("Initial") });
    const id = String(publish.candidate.arguments.broadcast_id);
    const publishCandidate = core.getCommand(publish.candidate.candidate_id)!;
    await core.executeCommittedDecision(
      {
        operationId: "operation-publish",
        candidateId: publish.candidate.candidate_id,
        actorId: PRINCIPAL,
        decision: "approve",
      },
      {
        verifyCommittedDecision: (input) =>
          input.actionDigest ===
          contentHash({
            arguments: publishCandidate.arguments,
            preconditions: publishCandidate.preconditions,
          }),
      },
    );
    const stale = await core.prepareBroadcastRevise({
      broadcastId: id,
      expectedRevision: 1,
      broadcast: content("Stale"),
    });
    feed.revise("merchant-001", id, 1, {
      kind: "service_notice",
      title: "Concurrent",
      body: "Concurrent update",
      audience: "public",
    });
    const staleCandidate = core.getCommand(stale.candidate.candidate_id)!;
    expect(
      await core.executeCommittedDecision(
        {
          operationId: "operation-stale",
          candidateId: stale.candidate.candidate_id,
          actorId: PRINCIPAL,
          decision: "approve",
        },
        {
          verifyCommittedDecision: (input) =>
            input.actionDigest ===
            contentHash({
              arguments: staleCandidate.arguments,
              preconditions: staleCandidate.preconditions,
            }),
        },
      ),
    ).toMatchObject({ kind: "stale" });
    expect(feed.getBroadcast("merchant-001", id)?.title).toBe("Concurrent");
    db.close();
  });

  it("notifies the promotion workflow only after Feed publish succeeds", async () => {
    const { db, feed, core, publishedWorkflows } = fixture();
    const prepared = await core.prepareBroadcastPublish({
      broadcast: content("Workflow announcement"),
      workflowId: "pwf-test",
    });
    const candidate = core.getCommand(prepared.candidate.candidate_id)!;
    await core.executeCommittedDecision(
      {
        operationId: "operation-workflow-broadcast",
        candidateId: candidate.candidate_id,
        actorId: PRINCIPAL,
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
    expect(
      feed.getBroadcast("merchant-001", String(candidate.arguments.broadcast_id)),
    ).toBeDefined();
    expect(publishedWorkflows).toEqual(["pwf-test"]);
    db.close();
  });
});
