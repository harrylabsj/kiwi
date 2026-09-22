import { describe, expect, it, vi } from "vitest";

import {
  OperationLifecycleReceipts,
  type LifecycleIntent,
  type LifecycleReceiptPersistence,
  type LifecycleReceiptRow,
} from "../src/merchant-core/storage/operation-lifecycle.js";

interface Receipt {
  status: "running" | "succeeded" | "unknown";
  value: string;
}

class ConflictError extends Error {}

class MemoryPersistence implements LifecycleReceiptPersistence<Receipt> {
  readonly rows = new Map<string, LifecycleReceiptRow<Receipt> & { completed: boolean }>();
  failNextInsert = false;
  readonly pruneCompletedBefore = vi.fn((_cutoffIso: string) => 0);

  findByKey(intent: LifecycleIntent) {
    return this.rows.get(keyOf(intent));
  }

  insertRunning(intent: LifecycleIntent, operationId: string, pending: Receipt): void {
    this.insert(intent, operationId, pending, false);
  }

  insertTerminal(intent: LifecycleIntent, operationId: string, receipt: Receipt): void {
    this.insert(intent, operationId, receipt, true);
  }

  updateTerminal(operationId: string, receipt: Receipt): void {
    const row = [...this.rows.values()].find((item) => item.operationId === operationId);
    if (row !== undefined) {
      row.receipt = receipt;
      row.completed = true;
    }
  }

  deleteRunning(operationId: string): void {
    for (const [key, row] of this.rows) {
      if (row.operationId === operationId && !row.completed) this.rows.delete(key);
    }
  }

  getById(operationId: string, scope: Readonly<Record<string, string>>): Receipt | undefined {
    return [...this.rows.values()].find(
      (item) =>
        item.operationId === operationId && JSON.stringify(item.scope) === JSON.stringify(scope),
    )?.receipt;
  }

  private insert(
    intent: LifecycleIntent,
    operationId: string,
    receipt: Receipt,
    completed: boolean,
  ): void {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      throw new Error("injected insert failure");
    }
    const key = keyOf(intent);
    if (this.rows.has(key)) throw new Error("unique conflict");
    this.rows.set(key, {
      operationId,
      scope: intent.scope,
      requestDigest: intent.requestDigest,
      receipt,
      completed,
    });
  }
}

function keyOf(intent: LifecycleIntent): string {
  return intent.idempotencyKey;
}

function intent(digest = "sha256:a"): LifecycleIntent {
  return {
    scope: { merchantId: "merchant-1", actorId: "owner-1", commandType: "test" },
    idempotencyKey: "key-1",
    requestDigest: digest,
  };
}

function fixture(options: { retentionMs?: number } = {}) {
  const persistence = new MemoryPersistence();
  let counter = 0;
  const lifecycle = new OperationLifecycleReceipts<Receipt>({
    persistence,
    operationId: () => `operation-${++counter}`,
    pendingReceipt: (operationId) => ({ status: "running", value: operationId }),
    conflictError: (message) => new ConflictError(message),
    now: () => "2026-09-22T08:00:00.000Z",
    ...(options.retentionMs !== undefined ? { retentionMs: options.retentionMs } : {}),
  });
  return { persistence, lifecycle };
}

describe("OperationLifecycleReceipts", () => {
  it("begins once, replays the running receipt and reports digest conflicts", () => {
    const { lifecycle } = fixture();
    const begun = lifecycle.begin(intent());
    expect(begun).toMatchObject({ kind: "execute", operationId: "operation-1" });
    expect(lifecycle.begin(intent())).toMatchObject({
      kind: "replay",
      operationId: "operation-1",
      receipt: { status: "running" },
    });
    expect(lifecycle.probe(intent("sha256:b"))).toEqual({ kind: "conflict" });
    expect(
      lifecycle.probe({
        ...intent(),
        scope: { merchantId: "merchant-2", actorId: "owner-1", commandType: "test" },
      }),
    ).toEqual({ kind: "conflict" });
  });

  it("completes, scopes get and does not release terminal receipts", () => {
    const { lifecycle } = fixture();
    const begun = lifecycle.begin(intent());
    if (begun.kind !== "execute") throw new Error("expected execute");
    const terminal: Receipt = { status: "unknown", value: "uncertain" };
    lifecycle.complete(begun.operationId, terminal);
    lifecycle.release(begun.operationId);
    expect(lifecycle.get(begun.operationId, intent().scope)).toEqual(terminal);
    expect(lifecycle.get(begun.operationId, { merchantId: "merchant-2" })).toBeUndefined();
  });

  it("releases only running rows so the same key can begin again", () => {
    const { lifecycle } = fixture();
    const first = lifecycle.begin(intent());
    if (first.kind !== "execute") throw new Error("expected execute");
    lifecycle.release(first.operationId);
    expect(lifecycle.probe(intent())).toEqual({ kind: "miss" });
    expect(lifecycle.begin(intent())).toMatchObject({
      kind: "execute",
      operationId: "operation-2",
    });
  });

  it("runs atomic local effects once and replays their terminal receipt", () => {
    const { lifecycle } = fixture();
    const effect = vi.fn((operationId: string): Receipt => ({
      status: "succeeded",
      value: operationId,
    }));
    expect(lifecycle.runOnce({ intent: intent(), effect })).toEqual({
      replayed: false,
      operationId: "operation-1",
      receipt: { status: "succeeded", value: "operation-1" },
    });
    expect(lifecycle.runOnce({ intent: intent(), effect })).toEqual({
      replayed: true,
      operationId: "operation-1",
      receipt: { status: "succeeded", value: "operation-1" },
    });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(() => lifecycle.runOnce({ intent: intent("sha256:b"), effect })).toThrow(ConflictError);
  });

  it("recovers begin insert races by rereading replay or conflict", () => {
    const { persistence, lifecycle } = fixture();
    const original = persistence.insertRunning.bind(persistence);
    persistence.insertRunning = (value, operationId, pending) => {
      original(value, "winner-operation", { status: "running", value: "winner" });
      throw new Error(`lost race for ${operationId}:${pending.value}`);
    };
    expect(lifecycle.begin(intent())).toMatchObject({
      kind: "replay",
      operationId: "winner-operation",
    });
  });

  it("rethrows insert failures when no concurrent winner exists", () => {
    const { persistence, lifecycle } = fixture();
    persistence.failNextInsert = true;
    expect(() => lifecycle.begin(intent())).toThrow(/injected insert failure/);
  });

  it("prunes completed rows only when retention is configured", () => {
    const retained = fixture({ retentionMs: 7 * 24 * 60 * 60 * 1000 });
    retained.lifecycle.probe(intent());
    expect(retained.persistence.pruneCompletedBefore).toHaveBeenCalledWith(
      "2026-09-15T08:00:00.000Z",
    );

    const unbounded = fixture();
    unbounded.lifecycle.probe(intent());
    expect(unbounded.persistence.pruneCompletedBefore).not.toHaveBeenCalled();
  });

  it("rejects invalid retention windows and invalid injected clocks", () => {
    expect(() => fixture({ retentionMs: 0 })).toThrow(/positive integer/);
    const persistence = new MemoryPersistence();
    const lifecycle = new OperationLifecycleReceipts<Receipt>({
      persistence,
      operationId: () => "operation",
      pendingReceipt: () => ({ status: "running", value: "operation" }),
      conflictError: (message) => new ConflictError(message),
      now: () => "not-a-time",
      retentionMs: 1000,
    });
    expect(() => lifecycle.probe(intent())).toThrow(/invalid time/);
  });
});
