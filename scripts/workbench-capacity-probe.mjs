#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { MerchantFeedStore } from "../dist/merchant/feed-store.js";
import { MerchantFollowStore } from "../dist/merchant/follow-store.js";
import { WorkbenchConfirmationStore } from "../dist/http/merchant-management/webauthn-confirmation.js";
import { WorkbenchReconciliationStore } from "../dist/http/merchant-management/reconciliation-worker.js";
import { WorkbenchEventProjectionStore } from "../dist/http/merchant-management/event-projection.js";

const EVENT_COUNT = 100_000;
const FOLLOWER_COUNT = 5_000;
const OPERATION_COUNT = 10_000;
const READ_SAMPLES = 200;
const WRITE_SAMPLES = 500;
const MERCHANT = "capacity-merchant";
const NOW = "2026-09-22T00:00:00.000Z";

const root = mkdtempSync(path.join(tmpdir(), "kiwi-workbench-capacity-"));
const dbPath = path.join(root, "state.sqlite");
const started = performance.now();

try {
  const db = new DatabaseSync(dbPath);
  db.exec("pragma journal_mode=WAL; pragma synchronous=NORMAL; pragma busy_timeout=5000");
  const cursorKey = randomBytes(32);
  const feed = new MerchantFeedStore({ db, cursorKey, now: () => NOW });
  const follows = new MerchantFollowStore({ db, now: () => NOW });
  new WorkbenchConfirmationStore({ db, now: () => NOW });
  new WorkbenchReconciliationStore({ db, now: () => NOW });
  const events = new WorkbenchEventProjectionStore({ db, cursorKey });

  // Create the authoritative feed state, then bulk-load a full daily retention slice.
  feed.read(MERCHANT);
  const feedState = db
    .prepare("SELECT feed_id, epoch FROM merchant_feed_state WHERE merchant_id=?")
    .get(MERCHANT);
  const insertEvent = db.prepare(
    `INSERT INTO merchant_feed_events
     (merchant_id, feed_id, epoch, seq, event_id, event_type, broadcast_id,
      revision, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'published', ?, 1, ?, ?)`,
  );
  const representativePayload = JSON.stringify({
    broadcast_id: "bct_capacity_representative",
    revision: 1,
    kind: "service_notice",
    title: "Representative persisted Workbench event",
    body: "x".repeat(320),
    sku_refs: ["sku-1", "sku-2"],
    audience: "public",
  });
  db.exec("begin immediate");
  for (let index = 1; index <= EVENT_COUNT; index += 1) {
    insertEvent.run(
      MERCHANT,
      feedState.feed_id,
      feedState.epoch,
      index,
      `evt_capacity_${String(index).padStart(6, "0")}`,
      `bct_capacity_${String(index).padStart(6, "0")}`,
      representativePayload,
      new Date(Date.parse(NOW) + index).toISOString(),
    );
  }
  db.prepare("UPDATE merchant_feed_state SET next_seq=? WHERE merchant_id=?").run(
    EVENT_COUNT + 1,
    MERCHANT,
  );

  const insertFollower = db.prepare(
    `INSERT INTO merchant_follow_relations
     (merchant_id, buyer_principal_id, status, revision, epoch, created_at, updated_at)
     VALUES (?, ?, 'active', 1, 1, ?, ?)`,
  );
  for (let index = 0; index < FOLLOWER_COUNT; index += 1) {
    insertFollower.run(MERCHANT, `buyer-${String(index).padStart(5, "0")}`, NOW, NOW);
  }

  const insertOperation = db.prepare(
    `INSERT INTO workbench_approval_operations
     (operation_id, merchant_id, candidate_id, approval_generation, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'succeeded', ?, ?)`,
  );
  for (let index = 0; index < OPERATION_COUNT; index += 1) {
    insertOperation.run(
      `operation-capacity-${index}`,
      MERCHANT,
      `candidate-capacity-${index}`,
      NOW,
      new Date(Date.parse(NOW) + index).toISOString(),
    );
  }
  db.exec("commit");
  db.exec("pragma wal_checkpoint(TRUNCATE)");

  const feedRead = sample(READ_SAMPLES, () => feed.read(MERCHANT, { limit: 50 }));
  const followerRead = sample(READ_SAMPLES, () => follows.activeCount(MERCHANT));
  const eventRead = sample(READ_SAMPLES, () => events.list(MERCHANT, { limit: 50 }));
  const broadcastWrite = sample(WRITE_SAMPLES, (index) =>
    feed.publish(MERCHANT, {
      kind: "service_notice",
      title: `Capacity write ${index}`,
      body: "bounded write",
      audience: "public",
    }),
  );
  db.exec("pragma wal_checkpoint(TRUNCATE)");

  const report = {
    schema_version: 1,
    evidence_class: "local_capacity_probe",
    generated_at: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sqlite_journal_mode: "WAL",
      sqlite_synchronous: "NORMAL",
    },
    dataset: {
      merchant_count: 1,
      feed_events: EVENT_COUNT,
      active_followers: FOLLOWER_COUNT,
      approval_operations: OPERATION_COUNT,
      sampled_broadcast_writes: WRITE_SAMPLES,
      representative_event_bytes: Buffer.byteLength(representativePayload),
    },
    database_bytes: statSync(dbPath).size,
    setup_seconds: round((performance.now() - started) / 1000),
    latency_ms: {
      feed_page_50: summarize(feedRead),
      active_follower_count: summarize(followerRead),
      management_event_page_50: summarize(eventRead),
      broadcast_publish: summarize(broadcastWrite),
    },
    assertions: {
      follower_count_exact: follows.activeCount(MERCHANT) === FOLLOWER_COUNT,
      feed_page_bounded:
        feed.read(MERCHANT, { limit: 50 }).kind === "events" &&
        feed.read(MERCHANT, { limit: 50 }).events.length === 50,
      write_p95_under_1000ms: percentile(broadcastWrite, 0.95) < 1000,
      write_p99_under_2000ms: percentile(broadcastWrite, 0.99) < 2000,
      management_event_p95_under_1000ms: percentile(eventRead, 0.95) < 1000,
    },
    limitations: [
      "Local single-process SQLite probe; not a WorkBuddy platform SLA.",
      "Bulk load measures retained capacity; sampled writes measure per-command latency.",
      "This is not the required 24-hour mixed-load, network-fault or backup-restore experiment.",
    ],
  };
  const failed = Object.entries(report.assertions)
    .filter(([, value]) => value !== true)
    .map(([name]) => name);
  process.stdout.write(`${JSON.stringify({ ...report, passed: failed.length === 0, failed }, null, 2)}\n`);
  db.close();
  if (failed.length > 0) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}

function sample(count, callback) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const before = performance.now();
    callback(index);
    values.push(performance.now() - before);
  }
  return values;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function summarize(values) {
  return {
    samples: values.length,
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(Math.max(...values)),
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
