import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import {
  MerchantOperationReceipts,
  operationReceiptsSchema,
  type OperationReceiptIntent,
} from "../src/merchant/operation-receipts.js";
import { inImmediateTransaction } from "../src/merchant-core/storage/transaction.js";
import type { OperationReceipt } from "../src/merchant/application/service.js";

const NOW = "2026-09-22T08:00:00.000Z";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

class ReceiptConflictError extends Error {}

function localReceipts(db: DatabaseSync): MerchantOperationReceipts {
  db.exec(operationReceiptsSchema("test_operation_receipts", "item_id"));
  return new MerchantOperationReceipts({
    db,
    table: "test_operation_receipts",
    entityColumn: "item_id",
    now: () => NOW,
    conflictError: (message) => new ReceiptConflictError(message),
  });
}

function intent(overrides: Partial<OperationReceiptIntent> = {}): OperationReceiptIntent {
  return {
    operationId: "operation-1",
    operationKind: "test_write",
    requestHash: "sha256:request-a",
    ...overrides,
  };
}

function terminalReceipt(
  operationId: string,
  status: "succeeded" | "failed" | "unknown",
): OperationReceipt {
  return {
    operation_id: operationId,
    command_type: "test.command",
    status,
    resource_ref: "resource-1",
    result_revision: 2,
    created_at: NOW,
    completed_at: NOW,
    support_id: `support-${operationId}`,
  };
}

function runBeginWorker(workerData: Record<string, unknown>): Promise<{
  outcome?: { kind: string; operationId?: string; receipt?: OperationReceipt };
  error?: string;
}> {
  const worker = new Worker(new URL("./helpers/operation-begin-race-worker.mjs", import.meta.url), {
    workerData,
  });
  cleanups.push(() => void worker.terminate());
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`operation begin worker exited with code ${code}`));
    });
  });
}

describe("P2-1 lifecycle receipt characterization", () => {
  it("keeps local effect and terminal receipt in one caller-owned transaction", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE effects (item_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const receipts = localReceipts(db);
    const operation = intent();
    const response = { item_id: "item-1", revision: 1 };

    inImmediateTransaction(db, () => {
      expect(receipts.replay("merchant-1", operation)).toBeUndefined();
      db.prepare("INSERT INTO effects(item_id, value) VALUES (?, ?)").run("item-1", "written");
      receipts.record("merchant-1", operation, "item-1", response);
    });

    expect(receipts.replay("merchant-1", operation)).toEqual({
      operation_kind: "test_write",
      entity_id: "item-1",
      response,
    });
    expect(receipts.get("merchant-1", operation.operationId)).toEqual({
      operation_kind: "test_write",
      entity_id: "item-1",
      response,
    });
    expect(receipts.get("merchant-2", operation.operationId)).toBeUndefined();
    expect(() =>
      receipts.replay("merchant-1", intent({ requestHash: "sha256:request-b" })),
    ).toThrow(ReceiptConflictError);
    db.close();
  });

  it("rolls back both local effect and receipt when the surrounding transaction fails", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE effects (item_id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const receipts = localReceipts(db);
    const operation = intent();

    expect(() =>
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO effects(item_id, value) VALUES (?, ?)").run("item-1", "written");
        receipts.record("merchant-1", operation, "item-1", { ok: true });
        throw new Error("injected failure after receipt");
      }),
    ).toThrow(/injected failure/);

    expect(
      (db.prepare("SELECT count(*) count FROM effects").get() as { count: number }).count,
    ).toBe(0);
    expect(receipts.get("merchant-1", operation.operationId)).toBeUndefined();
    db.close();
  });

  it("does not create a local receipt when no committed operation is supplied", () => {
    const db = new DatabaseSync(":memory:");
    const receipts = localReceipts(db);
    receipts.record("merchant-1", undefined, "item-1", { ok: true });
    expect(
      (
        db.prepare("SELECT count(*) count FROM test_operation_receipts").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(receipts.replay("merchant-1", undefined)).toBeUndefined();
    db.close();
  });

  it("freezes management probe/begin/running/complete/release semantics", () => {
    const db = new DatabaseSync(":memory:");
    const store = new MerchantManagementOperationStore({ db, now: () => NOW });
    const key = {
      merchantId: "merchant-1",
      actorId: "owner-1",
      commandType: "test.command",
      idempotencyKey: "key-1",
      requestDigest: "sha256:request-a",
    };

    expect(store.probe(key)).toEqual({ kind: "miss" });
    const begun = store.begin(key);
    expect(begun.kind).toBe("execute");
    if (begun.kind !== "execute") throw new Error("expected execute");
    expect(store.begin(key)).toMatchObject({
      kind: "replay",
      receipt: { operation_id: begun.operationId, status: "running", completed_at: null },
    });
    expect(store.probe({ ...key, requestDigest: "sha256:request-b" })).toEqual({
      kind: "conflict",
    });

    const unknown = terminalReceipt(begun.operationId, "unknown");
    store.complete(begun.operationId, "unknown", unknown);
    expect(store.probe(key)).toEqual({ kind: "replay", receipt: unknown });
    store.release(begun.operationId);
    expect(store.get(begun.operationId, "merchant-1")).toEqual(unknown);
    expect(store.get(begun.operationId, "merchant-2")).toBeUndefined();

    const retryKey = { ...key, idempotencyKey: "key-release" };
    const first = store.begin(retryKey);
    if (first.kind !== "execute") throw new Error("expected execute");
    store.release(first.operationId);
    expect(store.probe(retryKey)).toEqual({ kind: "miss" });
    const second = store.begin(retryKey);
    expect(second.kind).toBe("execute");
    if (second.kind !== "execute") throw new Error("expected execute");
    expect(second.operationId).not.toBe(first.operationId);
    db.close();
  });

  it("returns execute plus replay for concurrent identical begin calls", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-operation-begin-race-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, "state.sqlite");
    const setup = new DatabaseSync(dbPath);
    new MerchantManagementOperationStore({ db: setup, now: () => NOW });
    setup.close();
    const input = {
      merchantId: "merchant-race",
      actorId: "owner-race",
      commandType: "test.command",
      idempotencyKey: "same-key",
      requestDigest: "sha256:same-request",
    };
    const barrierBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const results = await Promise.all([
      runBeginWorker({ dbPath, now: NOW, input, barrierBuffer }),
      runBeginWorker({ dbPath, now: NOW, input, barrierBuffer }),
    ]);
    expect(results.map((result) => result.error)).toEqual([undefined, undefined]);
    expect(results.map((result) => result.outcome?.kind).sort()).toEqual(["execute", "replay"]);
    const operationIds = results.map(
      (result) => result.outcome?.operationId ?? result.outcome?.receipt?.operation_id,
    );
    expect(operationIds[0]).toBe(operationIds[1]);
  });

  it("returns execute plus conflict for concurrent different digests", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-operation-conflict-race-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, "state.sqlite");
    const setup = new DatabaseSync(dbPath);
    new MerchantManagementOperationStore({ db: setup, now: () => NOW });
    setup.close();
    const base = {
      merchantId: "merchant-race",
      actorId: "owner-race",
      commandType: "test.command",
      idempotencyKey: "conflict-key",
    };
    const barrierBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const results = await Promise.all([
      runBeginWorker({
        dbPath,
        now: NOW,
        input: { ...base, requestDigest: "sha256:request-a" },
        barrierBuffer,
      }),
      runBeginWorker({
        dbPath,
        now: NOW,
        input: { ...base, requestDigest: "sha256:request-b" },
        barrierBuffer,
      }),
    ]);
    expect(results.map((result) => result.error)).toEqual([undefined, undefined]);
    expect(results.map((result) => result.outcome?.kind).sort()).toEqual(["conflict", "execute"]);
  });
});
