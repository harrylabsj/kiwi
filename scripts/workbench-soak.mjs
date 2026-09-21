#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { MerchantFeedStore } from "../dist/merchant/feed-store.js";
import { MerchantFollowStore, followRequestDigest } from "../dist/merchant/follow-store.js";
import { WorkbenchConfirmationStore } from "../dist/http/merchant-management/webauthn-confirmation.js";
import { WorkbenchReconciliationStore } from "../dist/http/merchant-management/reconciliation-worker.js";
import { WorkbenchEventProjectionStore } from "../dist/http/merchant-management/event-projection.js";
import { MutableServiceState } from "../dist/http/merchant-management/service-state.js";

const args = parseArgs(process.argv.slice(2));
const durationMs =
  args.durationSeconds !== undefined
    ? args.durationSeconds * 1000
    : (args.durationHours ?? 24) * 60 * 60 * 1000;
const intervalMs = args.intervalMs ?? 800;
const restartEvery = args.restartEvery ?? 375;
const merchantId = "soak-merchant";
const root = mkdtempSync(path.join(tmpdir(), "kiwi-workbench-soak-"));
const dbPath = path.join(root, "state.sqlite");
const cursorKey = randomBytes(32);
const beganAt = new Date();
const deadline = Date.now() + durationMs;
let stack = openStack();
let iterations = 0;
let restarts = 0;
let errors = 0;
let feedWrites = 0;
let followMutations = 0;
let eventReads = 0;
let lastError = null;
const latencies = [];
let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

try {
  while (!stopping && Date.now() < deadline) {
    const before = performance.now();
    try {
      iterations += 1;
      if (iterations % 5 === 0) {
        stack.feed.publish(merchantId, {
          kind: "service_notice",
          title: `Soak event ${iterations}`,
          body: "bounded soak payload",
          audience: "public",
        });
        feedWrites += 1;
      } else if (iterations % 3 === 0) {
        const buyer = `buyer-${iterations % 5000}`;
        const read = stack.follows.read(merchantId, buyer);
        const action = read.follow.following ? "unfollow" : "follow";
        const context =
          action === "follow"
            ? read.mutation_contexts.follow.ref
            : read.mutation_contexts.unfollow.ref;
        stack.follows.mutate({
          merchantId,
          buyerPrincipalId: buyer,
          action,
          expectedRevision: read.follow.revision,
          mutationContext: context,
          idempotencyKey: `soak:${iterations}:${action}`,
          requestDigest: followRequestDigest({ buyer, action, iteration: iterations }),
          ...(action === "follow" ? { consentVersion: "soak-v1" } : {}),
        });
        followMutations += 1;
      } else {
        stack.feed.read(merchantId, { limit: 50 });
        stack.events.list(merchantId, { limit: 50 });
        eventReads += 1;
      }
      if (iterations % restartEvery === 0) {
        stack.db.close();
        stack = openStack();
        restarts += 1;
        if (stack.serviceState.state !== "PAUSED") {
          throw new Error("persisted PAUSED service state was lost across restart");
        }
      }
    } catch (error) {
      errors += 1;
      lastError = error instanceof Error ? error.message : String(error);
    }
    latencies.push(performance.now() - before);
    if (iterations % 75 === 0) {
      process.stderr.write(
        `[soak] iterations=${iterations} restarts=${restarts} errors=${errors} remaining_s=${Math.max(0, Math.round((deadline - Date.now()) / 1000))}\n`,
      );
    }
    await delay(intervalMs);
  }
  const report = {
    schema_version: 1,
    evidence_class: "local_soak",
    started_at: beganAt.toISOString(),
    completed_at: new Date().toISOString(),
    requested_duration_seconds: Math.round(durationMs / 1000),
    actual_duration_seconds: Math.round((Date.now() - beganAt.getTime()) / 1000),
    interrupted: stopping,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    workload: {
      iterations,
      feed_writes: feedWrites,
      follow_mutations: followMutations,
      event_reads: eventReads,
      simulated_restarts: restarts,
    },
    database_bytes: statSync(dbPath).size,
    active_followers: stack.follows.activeCount(merchantId),
    latency_ms: summarize(latencies),
    errors,
    last_error: lastError,
    passed: !stopping && errors === 0 && restarts > 0,
    limitations: [
      "Local single-process SQLite workload; no platform network or external downstream.",
      "Periodic close/reopen simulates restart boundaries, not instruction-level process kill.",
      "Backup restore and real WebAuthn device operations are outside this harness.",
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
} finally {
  try {
    stack.db.close();
  } catch {
    // already closed during interruption
  }
  rmSync(root, { recursive: true, force: true });
}

function openStack() {
  const db = new DatabaseSync(dbPath);
  db.exec("pragma journal_mode=WAL; pragma synchronous=NORMAL; pragma busy_timeout=5000");
  const feed = new MerchantFeedStore({ db, cursorKey });
  const follows = new MerchantFollowStore({ db });
  new WorkbenchConfirmationStore({ db });
  new WorkbenchReconciliationStore({ db });
  const events = new WorkbenchEventProjectionStore({ db, cursorKey });
  const serviceState = new MutableServiceState("OPERATING");
  serviceState.attachPersistence(db, merchantId);
  if (serviceState.state === "OPERATING") serviceState.pause("soak safety invariant");
  return { db, feed, follows, events, serviceState };
}

function parseArgs(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    const raw = values[index + 1];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    if (name === "--duration-hours") out.durationHours = value;
    else if (name === "--duration-seconds") out.durationSeconds = value;
    else if (name === "--interval-ms") out.intervalMs = value;
    else if (name === "--restart-every") out.restartEvery = Math.floor(value);
    else throw new Error(`unknown argument: ${name}`);
    index += 1;
  }
  return out;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function summarize(values) {
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    samples: values.length,
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(Math.max(...values, 0)),
  };
}
