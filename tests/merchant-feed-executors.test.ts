import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient, fakeMerchantProduct } from "../src/agent/merchant/fake-merchant-client.js";
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
    }),
  });
  return { db, feed, core };
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
    expect((await core.executeApproved(publish.candidate.candidate_id)).kind).toBe("executed");
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
    expect((await core.executeApproved(revise.candidate.candidate_id)).kind).toBe("executed");
    expect(feed.getBroadcast("merchant-001", broadcastId)).toMatchObject({
      title: "Revised",
      revision: 2,
    });

    const withdraw = await core.prepareBroadcastWithdraw({
      broadcastId,
      expectedRevision: 2,
    });
    expect((await core.executeApproved(withdraw.candidate.candidate_id)).kind).toBe("executed");
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
    await core.executeApproved(publish.candidate.candidate_id);
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
    expect((await core.executeApproved(stale.candidate.candidate_id)).kind).toBe("stale");
    expect(feed.getBroadcast("merchant-001", id)?.title).toBe("Concurrent");
    db.close();
  });
});
