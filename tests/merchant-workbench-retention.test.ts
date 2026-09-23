import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  recommendedRetentionPolicy,
  createSqlDeletionHandlers,
  replayDeletionSuppressions,
  WorkbenchRetentionError,
  WorkbenchRetentionStore,
} from "../src/privacy/workbench-retention.js";
import { MerchantFollowStore } from "../src/merchant/follow-store.js";
import { MerchantEngagementStore } from "../src/merchant/engagement-store.js";
import { followRequestDigest } from "../src/merchant/follow-store.js";
import { createLocalBackupDeletionHandler } from "../src/privacy/local-backup-deletion.js";
import { runBackup } from "../src/merchant-runtime/backup.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  let now = "2026-09-21T12:00:00.000Z";
  const store = new WorkbenchRetentionStore({ db, now: () => now });
  return { db, store, setNow: (value: string) => (now = value) };
}

function configure(store: WorkbenchRetentionStore): void {
  store.configurePolicy(
    recommendedRetentionPolicy({
      processor: "北京海纳福星文化传媒有限公司",
      basis: "试点前由数据处理责任人核准的必要处理依据",
      reviewAt: "2026-10-21T00:00:00.000Z",
    }),
  );
}

describe("Workbench retention and Buyer privacy requests", () => {
  it("fails closed until every category has an actual processor, basis and review date", () => {
    const { store } = fixture();
    expect(() =>
      store.receiveBuyerDeletionRequest({ merchantId: "m1", buyerPrincipalId: "buyer-1" }),
    ).toThrow(/lacks actual processor/);
    expect(() => store.configurePolicy([])).toThrowError(WorkbenchRetentionError);
    configure(store);
    expect(store.policyReady()).toBe(true);
  });

  it("receiving a request immediately stops marketing, increments consent generation and creates all cleanup tasks", () => {
    const { db, store } = fixture();
    configure(store);
    const first = store.receiveBuyerDeletionRequest({
      merchantId: "m1",
      buyerPrincipalId: "buyer-1",
    });
    expect(first.status).toBe("RECEIVED");
    expect(first.consentGeneration).toBe(1);
    expect(store.marketingAllowed("m1", "buyer-1")).toBe(false);
    expect(
      (
        db.prepare("SELECT count(*) count FROM workbench_privacy_deletion_tasks").get() as {
          count: number;
        }
      ).count,
    ).toBe(4);
    const second = store.receiveBuyerDeletionRequest({
      merchantId: "m1",
      buyerPrincipalId: "buyer-1",
    });
    expect(second.consentGeneration).toBe(2);
  });

  it("enforces the request state machine and requires real per-node receipts before COMPLETED", () => {
    const { store } = fixture();
    configure(store);
    const request = store.receiveBuyerDeletionRequest({
      merchantId: "m1",
      buyerPrincipalId: "buyer-1",
    });
    expect(() => store.transition(request.requestId, "PROCESSING")).toThrow(/cannot transition/);
    store.transition(request.requestId, "IDENTITY_CHECK");
    store.transition(request.requestId, "SCOPED");
    store.transition(request.requestId, "PROCESSING");
    expect(() => store.transition(request.requestId, "COMPLETED")).toThrow(/controlled nodes/);
    for (const nodeId of [
      "runtime-primary",
      "buyer-preferences",
      "runtime-cache",
      "controlled-backup",
    ]) {
      store.recordDeletionTask({
        requestId: request.requestId,
        nodeId,
        status: "completed",
        receiptRef: `receipt-${nodeId}`,
      });
    }
    expect(store.transition(request.requestId, "COMPLETED").status).toBe("COMPLETED");
  });

  it("suppression prevents an older backup generation from reviving deleted consent", () => {
    const { store, setNow } = fixture();
    configure(store);
    const request = store.receiveBuyerDeletionRequest({
      merchantId: "m1",
      buyerPrincipalId: "buyer-1",
    });
    expect(store.canRestoreSubject("m1", "buyer-1", request.consentGeneration - 1)).toBe(false);
    expect(store.canRestoreSubject("m1", "buyer-1", request.consentGeneration)).toBe(false);
    expect(store.canRestoreSubject("m1", "buyer-1", request.consentGeneration + 1)).toBe(true);
    setNow("2026-11-03T12:00:00.000Z");
    expect(store.canRestoreSubject("m1", "buyer-1", 0)).toBe(true);
  });

  it("immediately cancels Follow and processes the real runtime-primary deletion node", () => {
    const db = new DatabaseSync(":memory:");
    const follow = new MerchantFollowStore({ db, now: () => "2026-09-21T12:00:00.000Z" });
    const engagement = new MerchantEngagementStore({
      db,
      now: () => "2026-09-21T12:00:00.000Z",
    });
    const retention = new WorkbenchRetentionStore({
      db,
      now: () => "2026-09-21T12:00:00.000Z",
    });
    configure(retention);
    const initial = follow.read("m1", "buyer-1");
    follow.mutate({
      merchantId: "m1",
      buyerPrincipalId: "buyer-1",
      action: "follow",
      expectedRevision: 0,
      mutationContext: initial.mutation_contexts.follow.ref,
      idempotencyKey: "follow-before-delete",
      requestDigest: followRequestDigest({ action: "follow" }),
    });
    engagement.record({
      merchantId: "m1",
      buyerPrincipalId: "buyer-1",
      broadcastId: "broadcast-1",
      eventType: "received",
      idempotencyKey: "received-before-delete",
      occurredAt: "2026-09-21T12:00:00.000Z",
    });
    expect(follow.activeCount("m1")).toBe(1);

    const request = retention.receiveBuyerDeletionRequest({
      merchantId: "m1",
      buyerPrincipalId: "buyer-1",
    });
    expect(follow.activeCount("m1")).toBe(0);
    expect(follow.read("m1", "buyer-1").follow.following).toBe(false);
    retention.transition(request.requestId, "IDENTITY_CHECK");
    retention.transition(request.requestId, "SCOPED");
    retention.transition(request.requestId, "PROCESSING");
    const processed = retention.processRuntimePrimary(request.requestId);
    expect(processed.deletedRows).toBeGreaterThan(0);
    expect(engagement.summary("m1")).toEqual({ received: 0, presented: 0, clicked: 0 });
    expect(retention.processRuntimePrimary(request.requestId).receiptRef).toBe(
      processed.receiptRef,
    );
    expect(() => retention.transition(request.requestId, "COMPLETED")).toThrow(/controlled nodes/u);
    db.close();
  });

  it("replays deletion suppression before an older backup can serve restored data", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-retention-restore-"));
    const livePath = path.join(dir, "live.sqlite");
    const backupPath = path.join(dir, "backup.sqlite");
    const restoredPath = path.join(dir, "restored.sqlite");
    try {
      const liveDb = new DatabaseSync(livePath);
      const follow = new MerchantFollowStore({ db: liveDb });
      const engagement = new MerchantEngagementStore({ db: liveDb });
      const retention = new WorkbenchRetentionStore({ db: liveDb });
      configure(retention);
      const initial = follow.read("m1", "buyer-restore");
      follow.mutate({
        merchantId: "m1",
        buyerPrincipalId: "buyer-restore",
        action: "follow",
        expectedRevision: 0,
        mutationContext: initial.mutation_contexts.follow.ref,
        idempotencyKey: "follow-backup",
        requestDigest: followRequestDigest({ action: "follow-backup" }),
      });
      engagement.record({
        merchantId: "m1",
        buyerPrincipalId: "buyer-restore",
        broadcastId: "broadcast-backup",
        eventType: "received",
        idempotencyKey: "received-backup",
        occurredAt: "2026-09-21T12:00:00.000Z",
      });
      liveDb.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
      retention.receiveBuyerDeletionRequest({
        merchantId: "m1",
        buyerPrincipalId: "buyer-restore",
      });
      const suppressions = retention.activeSuppressions();
      expect(suppressions).toHaveLength(1);
      liveDb.close();

      copyFileSync(backupPath, restoredPath);
      const restoredDb = new DatabaseSync(restoredPath);
      const restoredFollow = new MerchantFollowStore({ db: restoredDb });
      const restoredEngagement = new MerchantEngagementStore({ db: restoredDb });
      expect(restoredFollow.activeCount("m1")).toBe(1);
      expect(restoredEngagement.summary("m1").received).toBe(1);
      const replayed = replayDeletionSuppressions(
        restoredDb,
        suppressions,
        "2026-09-22T00:00:00.000Z",
      );
      expect(replayed).toMatchObject({ applied: 1 });
      expect(replayed.deletedRows).toBeGreaterThanOrEqual(2);
      expect(restoredFollow.activeCount("m1")).toBe(0);
      expect(restoredEngagement.summary("m1").received).toBe(0);
      expect(
        new WorkbenchRetentionStore({ db: restoredDb }).canRestoreSubject("m1", "buyer-restore", 0),
      ).toBe(false);
      restoredDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs externally-owned deletion nodes through an idempotent receipt boundary", () => {
    const { store } = fixture();
    configure(store);
    const request = store.receiveBuyerDeletionRequest({ merchantId: "m1", buyerPrincipalId: "buyer-1" });
    store.transition(request.requestId, "IDENTITY_CHECK");
    store.transition(request.requestId, "SCOPED");
    store.transition(request.requestId, "PROCESSING");
    let calls = 0;
    const controlled = new WorkbenchRetentionStore({
      db: new DatabaseSync(":memory:"),
      deletionHandlers: {
        "buyer-preferences": ({ buyerPrincipalId }) => {
          calls += 1;
          return { receiptRef: `preferences:${buyerPrincipalId}`, deletedRows: 2 };
        },
      },
    });
    configure(controlled);
    const other = controlled.receiveBuyerDeletionRequest({ merchantId: "m1", buyerPrincipalId: "buyer-1" });
    controlled.transition(other.requestId, "IDENTITY_CHECK");
    controlled.transition(other.requestId, "SCOPED");
    controlled.transition(other.requestId, "PROCESSING");
    expect(controlled.processDeletionNode(other.requestId, "buyer-preferences")).toEqual({
      receiptRef: "preferences:buyer-1",
      deletedRows: 2,
    });
    expect(controlled.processDeletionNode(other.requestId, "buyer-preferences")).toEqual({
      receiptRef: "preferences:buyer-1",
      deletedRows: 0,
    });
    expect(calls).toBe(1);
    expect(() => store.processDeletionNode(request.requestId, "runtime-cache")).toThrow(/no controlled processor/);
  });

  it("deletes only allowlisted preference/cache tables and emits receipts", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE buyer_preferences (merchant_id TEXT, buyer_principal_id TEXT, value TEXT)");
    db.prepare("INSERT INTO buyer_preferences VALUES ('m1','b1','x')").run();
    const handlers = createSqlDeletionHandlers(db);
    const result = handlers["buyer-preferences"]!({
      requestId: "wpr_test",
      merchantId: "m1",
      buyerPrincipalId: "b1",
      consentGeneration: 2,
    });
    expect(result.deletedRows).toBe(1);
    expect(result.receiptRef).toContain("buyer-preferences:wpr_test:2:1");
    expect((db.prepare("SELECT count(*) count FROM buyer_preferences").get() as { count: number }).count).toBe(0);
    db.close();
  });

  it("erases all verified local backup generations after live deletion receipts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-controlled-backup-delete-"));
    const dataDir = path.join(root, "merchant-data");
    const backupsDir = path.join(dataDir, "backups");
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(dataDir, "state.sqlite"));
    try {
      const follow = new MerchantFollowStore({ db });
      const engagement = new MerchantEngagementStore({ db });
      const retention = new WorkbenchRetentionStore({
        db,
        deletionHandlers: {
          ...createSqlDeletionHandlers(db),
          "controlled-backup": createLocalBackupDeletionHandler({ dataDir, backupsDir }),
        },
      });
      configure(retention);
      db.exec("CREATE TABLE buyer_preferences (merchant_id TEXT, buyer_principal_id TEXT)");
      db.prepare("INSERT INTO buyer_preferences VALUES ('m1', 'buyer-erasure')").run();
      db.exec("CREATE TABLE merchant_settings (merchant_id TEXT PRIMARY KEY, setting TEXT NOT NULL)");
      db.prepare("INSERT INTO merchant_settings VALUES ('m1', 'preserve-me')").run();
      const state = follow.read("m1", "buyer-erasure");
      follow.mutate({
        merchantId: "m1",
        buyerPrincipalId: "buyer-erasure",
        action: "follow",
        expectedRevision: state.follow.revision,
        mutationContext: state.mutation_contexts.follow.ref,
        idempotencyKey: "follow-before-backup-delete",
        requestDigest: followRequestDigest({ action: "follow-before-backup-delete" }),
      });
      engagement.record({
        merchantId: "m1",
        buyerPrincipalId: "buyer-erasure",
        broadcastId: "broadcast-before-backup-delete",
        eventType: "received",
        idempotencyKey: "received-before-backup-delete",
        occurredAt: "2026-09-21T12:00:00.000Z",
      });

      runBackup({ dataDir, backupsDir, now: () => "2026-09-21T12:01:00.000Z" });
      const request = retention.receiveBuyerDeletionRequest({ merchantId: "m1", buyerPrincipalId: "buyer-erasure" });
      runBackup({ dataDir, backupsDir, now: () => "2026-09-21T12:02:00.000Z" });
      retention.transition(request.requestId, "IDENTITY_CHECK");
      retention.transition(request.requestId, "SCOPED");
      retention.transition(request.requestId, "PROCESSING");

      expect(() => retention.processDeletionNode(request.requestId, "controlled-backup")).toThrow(
        /before live deletion processors/u,
      );
      retention.processRuntimePrimary(request.requestId);
      retention.processDeletionNode(request.requestId, "buyer-preferences");
      retention.processDeletionNode(request.requestId, "runtime-cache");

      const erased = retention.processDeletionNode(request.requestId, "controlled-backup");
      expect(erased.receiptRef).toContain(
        `local-backup:${request.requestId}:${request.consentGeneration}:replaced-2:fresh-`,
      );
      expect(erased.deletedArtifacts).toBe(2);
      const latest = JSON.parse(readFileSync(path.join(backupsDir, "latest-backup.json"), "utf8")) as {
        snapshot_dir: string;
      };
      const snapshotDirs = readdirSync(backupsDir).filter((name) => name !== "latest-backup.json");
      expect(snapshotDirs).toEqual([path.basename(latest.snapshot_dir)]);
      const cleanSnapshot = new DatabaseSync(path.join(latest.snapshot_dir, "state.sqlite"), { readOnly: true });
      try {
        expect(
          (cleanSnapshot.prepare("SELECT count(*) count FROM merchant_follow_relations WHERE buyer_principal_id='buyer-erasure'").get() as { count: number }).count,
        ).toBe(0);
        expect(
          (cleanSnapshot.prepare("SELECT count(*) count FROM merchant_settings WHERE merchant_id='m1' AND setting='preserve-me'").get() as { count: number }).count,
        ).toBe(1);
      } finally {
        cleanSnapshot.close();
      }
      expect(retention.transition(request.requestId, "COMPLETED").status).toBe("COMPLETED");
      const replay = retention.processDeletionNode(request.requestId, "controlled-backup");
      expect(replay).toEqual({ receiptRef: erased.receiptRef, deletedArtifacts: 0 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to purge an unrecognized backup generation without deleting valid siblings", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kiwi-controlled-backup-owner-"));
    const dataDir = path.join(root, "merchant-data");
    const backupsDir = path.join(dataDir, "backups");
    const otherDataDir = path.join(root, "other-data");
    try {
      mkdirSync(dataDir, { recursive: true });
      runBackup({ dataDir, backupsDir, now: () => "2026-09-21T12:03:00.000Z" });
      const bad = path.join(backupsDir, "foreign-snapshot");
      mkdirSync(bad);
      writeFileSync(
        path.join(bad, "manifest.json"),
        JSON.stringify({
          created_at: "2026-09-21T12:04:00.000Z",
          source_dir: otherDataDir,
          files: [],
        }),
      );
      const handler = createLocalBackupDeletionHandler({ dataDir, backupsDir });
      expect(() =>
        handler({
          requestId: "wpr_test",
          merchantId: "m1",
          buyerPrincipalId: "buyer-1",
          consentGeneration: 1,
        }),
      ).toThrow(/different data directory/u);
      expect(existsSync(path.join(backupsDir, "2026-09-21T12-03-00-000Z", "manifest.json"))).toBe(true);
      expect(existsSync(path.join(bad, "manifest.json"))).toBe(true);
      expect(readFileSync(path.join(backupsDir, "latest-backup.json"), "utf8")).toContain("snapshot_dir");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
