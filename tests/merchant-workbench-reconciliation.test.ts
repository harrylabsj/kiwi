import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { WorkbenchConfirmationStore } from "../src/http/merchant-management/webauthn-confirmation.js";
import {
  committedDecisionOutcomeResult,
  WorkbenchReconciliationStore,
  WorkbenchReconciliationWorker,
} from "../src/http/merchant-management/reconciliation-worker.js";

const MERCHANT = "merchant-worker";

function fixture() {
  const db = new DatabaseSync(":memory:");
  new WorkbenchConfirmationStore({ db }); // owns operation/outbox schema
  let nowMs = Date.parse("2026-09-21T12:00:00.000Z");
  const now = () => new Date(nowMs).toISOString();
  const store = new WorkbenchReconciliationStore({ db, now, jitter: () => 0 });
  return {
    db,
    store,
    now,
    setNow: (value: string) => {
      nowMs = Date.parse(value);
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function seed(db: DatabaseSync, operationId = "op-1", candidateId = "candidate-1"): void {
  const stamp = "2026-09-21T12:00:00.000Z";
  db.prepare(
    `INSERT INTO workbench_approval_decisions
     (merchant_id, candidate_id, approval_generation, decision, actor_id, confirmation_id,
      operation_id, action_digest, decided_at)
     VALUES (?, ?, 1, 'approve', 'owner', ?, ?, ?, ?)`,
  ).run(
    MERCHANT,
    candidateId,
    `confirmation-${operationId}`,
    operationId,
    `sha256:${"a".repeat(64)}`,
    stamp,
  );
  db.prepare(
    `INSERT INTO workbench_approval_operations
     (operation_id, merchant_id, candidate_id, approval_generation, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'accepted', ?, ?)`,
  ).run(operationId, MERCHANT, candidateId, stamp, stamp);
  db.prepare(
    `INSERT INTO workbench_approval_outbox
     (merchant_id, operation_id, action_step, fencing_token, status, created_at)
     VALUES (?, ?, 'execute-approved-candidate', 0, 'pending', ?)`,
  ).run(MERCHANT, operationId, stamp);
}

describe("Workbench persistent reconciliation worker", () => {
  it("does not report stale/expired committed candidate outcomes as succeeded", () => {
    expect(committedDecisionOutcomeResult({ kind: "executed" })).toEqual({ status: "succeeded" });
    expect(committedDecisionOutcomeResult({ status: "rejected" })).toEqual({ status: "succeeded" });
    expect(committedDecisionOutcomeResult({ kind: "stale" })).toEqual({
      status: "failed",
      error: "candidate execution ended as stale",
    });
    expect(committedDecisionOutcomeResult({ kind: "expired" })).toEqual({
      status: "failed",
      error: "candidate execution ended as expired",
    });
  });
  it("expired lease is fenced: the old worker cannot commit after a new token is issued", () => {
    const { db, store, advance } = fixture();
    seed(db);
    const oldLease = store.leaseOutbox(MERCHANT, "worker-old", 30_000)!;
    expect(oldLease.fencingToken).toBe(1);
    advance(31_000);
    const newLease = store.leaseOutbox(MERCHANT, "worker-new", 30_000)!;
    expect(newLease.fencingToken).toBe(2);
    expect(store.finishOutbox(oldLease, { status: "succeeded" })).toBe(false);
    expect(store.finishOutbox(newLease, { status: "succeeded" })).toBe(true);
    expect(
      (
        db
          .prepare("SELECT status FROM workbench_approval_operations WHERE operation_id='op-1'")
          .get() as {
          status: string;
        }
      ).status,
    ).toBe("succeeded");
  });

  it("UNKNOWN never re-executes the outbox and later query can resolve the same operation", async () => {
    const { db, store, setNow } = fixture();
    seed(db);
    const execute = vi.fn(async () => ({ status: "unknown", error: "connection reset" }) as const);
    const query = vi.fn(async () => ({ status: "succeeded" }) as const);
    const worker = new WorkbenchReconciliationWorker(store, {
      workerId: "worker-1",
      merchantId: MERCHANT,
      execute,
      query,
    });
    expect(await worker.runOnce()).toBe("outbox");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      (
        db
          .prepare("SELECT status FROM workbench_approval_operations WHERE operation_id='op-1'")
          .get() as {
          status: string;
        }
      ).status,
    ).toBe("unknown");
    const job = db
      .prepare(
        "SELECT next_attempt_at FROM workbench_reconciliation_jobs WHERE operation_id='op-1'",
      )
      .get() as { next_attempt_at: string };
    setNow(job.next_attempt_at);
    expect(await worker.runOnce()).toBe("reconciliation");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(
      (
        db
          .prepare("SELECT status FROM workbench_approval_operations WHERE operation_id='op-1'")
          .get() as {
          status: string;
        }
      ).status,
    ).toBe("succeeded");
  });

  it("five unresolved queries warn; ten escalate to human without resending the action", async () => {
    const { db, store, setNow } = fixture();
    seed(db);
    const execute = vi.fn(
      async () => ({ status: "unknown", error: "timeout token=secret" }) as const,
    );
    const query = vi.fn(async () => ({ status: "unknown", error: "still unknown" }) as const);
    const worker = new WorkbenchReconciliationWorker(store, {
      workerId: "worker-2",
      merchantId: MERCHANT,
      execute,
      query,
    });
    expect(await worker.runOnce()).toBe("outbox");
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const job = db
        .prepare(
          "SELECT next_attempt_at FROM workbench_reconciliation_jobs WHERE operation_id='op-1'",
        )
        .get() as { next_attempt_at: string };
      setNow(job.next_attempt_at);
      expect(await worker.runOnce()).toBe("reconciliation");
      if (attempt === 5) {
        expect(
          (
            db.prepare("SELECT severity FROM workbench_alerts WHERE resource='op-1'").get() as {
              severity: string;
            }
          ).severity,
        ).toBe("warning");
      }
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(10);
    expect(
      (
        db
          .prepare("SELECT status FROM workbench_reconciliation_jobs WHERE operation_id='op-1'")
          .get() as {
          status: string;
        }
      ).status,
    ).toBe("human_required");
    expect(
      (
        db.prepare("SELECT severity FROM workbench_alerts WHERE resource='op-1'").get() as {
          severity: string;
        }
      ).severity,
    ).toBe("critical");
    expect(await worker.runOnce()).toBe("idle");
  });
});
