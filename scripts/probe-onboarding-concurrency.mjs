#!/usr/bin/env node

/**
 * 两个独立 Node 进程、两个 SQLite 连接同时调用 OnboardingStore.openIntent()。
 *
 * 这是 M5/T008 的存储层故障注入探针，不是单线程顺序替身。运行前先 `npm run build`。
 * 期望：100 轮每轮两个进程都取得同一个 record_id，库中只有 100 条记录和 100 个槽。
 */

import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { OnboardingStore, digestOf } from "../dist/cloud/onboarding/store.js";

const ROUNDS = 100;

if (process.argv[2] === "--worker") {
  const dbPath = process.argv[3];
  const workerId = process.argv[4];
  if (dbPath === undefined || workerId === undefined || process.send === undefined) process.exit(2);
  const db = new DatabaseSync(dbPath);
  const store = new OnboardingStore(db);
  process.on("message", (message) => {
    if (typeof message !== "object" || message === null || !("round" in message)) return;
    const round = Number(message.round);
    try {
      const merchantId = `probe-merchant-${round}`;
      const record = store.openIntent({
        merchantId,
        intentId: `probe-intent-${round}`,
        versionDigest: `sha256:${"a".repeat(64)}`,
        idempotencyKey: `probe-${workerId}-${round}`,
        requestDigest: digestOf({ intent: round, version: "probe" }),
      });
      process.send?.({ round, recordId: record.recordId });
    } catch (error) {
      process.send?.({ round, error: error instanceof Error ? error.message : String(error) });
    }
  });
  process.send({ ready: true });
} else {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-onboarding-concurrency-"));
  const dbPath = path.join(dir, "state.sqlite");
  const bootstrapDb = new DatabaseSync(dbPath);
  new OnboardingStore(bootstrapDb);
  bootstrapDb.close();

  const script = fileURLToPath(import.meta.url);
  const workers = ["a", "b"].map((id) =>
    fork(script, ["--worker", dbPath, id], { stdio: ["ignore", "inherit", "inherit", "ipc"] }),
  );

  try {
    await Promise.all(workers.map(waitReady));
    for (let round = 1; round <= ROUNDS; round += 1) {
      const results = await Promise.all(workers.map((worker) => runRound(worker, round)));
      if (results[0] !== results[1]) {
        throw new Error(`round ${round} returned different records: ${results.join(" vs ")}`);
      }
    }

    const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    const records = verifyDb.prepare("select count(*) as count from onboarding_records").get().count;
    const slots = verifyDb.prepare("select count(*) as count from onboarding_slots").get().count;
    const duplicateSlots = verifyDb
      .prepare(
        "select count(*) as count from (select merchant_id from onboarding_slots group by merchant_id having count(*) > 1)",
      )
      .get().count;
    verifyDb.close();
    const report = {
      rounds: ROUNDS,
      processes: workers.length,
      records,
      slots,
      duplicate_slots: duplicateSlots,
      passed: records === ROUNDS && slots === ROUNDS && duplicateSlots === 0,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    for (const worker of workers) worker.kill();
    await Promise.all(workers.map(waitExit));
    rmSync(dir, { recursive: true, force: true });
  }
}

function waitReady(worker) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.ready === true) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`worker exited before ready (${code})`));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("exit", onExit);
  });
}

function runRound(worker, round) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.round !== round) return;
      cleanup();
      if (message.error !== undefined) reject(new Error(`round ${round}: ${message.error}`));
      else resolve(message.recordId);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`worker exited during round ${round} (${code})`));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("exit", onExit);
    worker.send({ round });
  });
}

function waitExit(worker) {
  if (worker.exitCode !== null || worker.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => worker.once("exit", resolve));
}
