import { describe, expect, it } from "vitest";

import {
  LeasedJobStore,
  type LeasedJobHandle,
  type LeasedJobPersistence,
} from "../src/merchant-core/storage/leased-job.js";

interface Job {
  id: string;
  token: number;
  attempts: number;
  leasedUntil?: string;
  owner?: string;
  status: "pending" | "leased" | "done";
}

interface Result {
  status: "done" | "failed";
}

class MemoryJobs implements LeasedJobPersistence<{ value: string }, Result> {
  readonly jobs = new Map<string, Job>();
  transactions = 0;
  failFinish = false;

  inTransaction<T>(fn: () => T): T {
    this.transactions += 1;
    return fn();
  }

  enqueueOutstanding(): number {
    return 0;
  }

  leaseCandidate(now: string): { jobId: string; fencingToken: number } | undefined {
    const row = [...this.jobs.values()].find(
      (job) =>
        job.status === "pending" || (job.status === "leased" && (job.leasedUntil ?? "") <= now),
    );
    return row === undefined ? undefined : { jobId: row.id, fencingToken: row.token };
  }

  claim(input: {
    jobId: string;
    workerId: string;
    expectedFencingToken: number;
    nextFencingToken: number;
    leaseExpiresAt: string;
    now: string;
  }): LeasedJobHandle<{ value: string }> | undefined {
    const row = this.jobs.get(input.jobId);
    if (row === undefined || row.token !== input.expectedFencingToken) return undefined;
    row.status = "leased";
    row.token = input.nextFencingToken;
    row.attempts += 1;
    row.owner = input.workerId;
    row.leasedUntil = input.leaseExpiresAt;
    return {
      jobId: row.id,
      workerId: input.workerId,
      fencingToken: row.token,
      attempts: row.attempts,
      payload: { value: row.id },
    };
  }

  finish(input: {
    lease: LeasedJobHandle<{ value: string }>;
    result: Result;
    now: string;
  }): boolean {
    if (this.failFinish) {
      this.failFinish = false;
      return false;
    }
    const row = this.jobs.get(input.lease.jobId);
    if (
      row === undefined ||
      row.status !== "leased" ||
      row.owner !== input.lease.workerId ||
      row.token !== input.lease.fencingToken
    ) {
      return false;
    }
    row.status = input.result.status === "done" ? "done" : "pending";
    return true;
  }
}

describe("LeasedJobStore", () => {
  it("claims and finishes inside persistence transactions with token+1", () => {
    const persistence = new MemoryJobs();
    persistence.jobs.set("job-1", { id: "job-1", token: 0, attempts: 0, status: "pending" });
    const store = new LeasedJobStore({
      persistence,
      now: () => "2026-09-22T08:00:00.000Z",
      leaseMs: 30_000,
    });
    const lease = store.lease("worker-a")!;
    expect(lease).toMatchObject({ jobId: "job-1", fencingToken: 1, attempts: 1 });
    expect(store.finish(lease, { status: "done" })).toBe(true);
    expect(persistence.jobs.get("job-1")?.status).toBe("done");
    expect(persistence.transactions).toBe(2);
  });

  it("reclaims expired leases with a higher token and fences the old handle", () => {
    let now = "2026-09-22T08:00:00.000Z";
    const persistence = new MemoryJobs();
    persistence.jobs.set("job-1", {
      id: "job-1",
      token: 3,
      attempts: 1,
      owner: "old",
      leasedUntil: "2026-09-22T07:59:00.000Z",
      status: "leased",
    });
    const store = new LeasedJobStore({ persistence, now: () => now, leaseMs: 30_000 });
    const old: LeasedJobHandle<{ value: string }> = {
      jobId: "job-1",
      workerId: "old",
      fencingToken: 3,
      attempts: 1,
      payload: { value: "job-1" },
    };
    const fresh = store.lease("new")!;
    expect(fresh.fencingToken).toBe(4);
    expect(store.finish(old, { status: "done" })).toBe(false);
    now = "2026-09-22T08:00:01.000Z";
    expect(store.finish(fresh, { status: "done" })).toBe(true);
  });

  it("preserves adapter finish failure and validates leaseMs", () => {
    const persistence = new MemoryJobs();
    persistence.jobs.set("job-1", { id: "job-1", token: 0, attempts: 0, status: "pending" });
    const store = new LeasedJobStore({
      persistence,
      now: () => "2026-09-22T08:00:00.000Z",
      leaseMs: 1,
    });
    const lease = store.lease("worker")!;
    persistence.failFinish = true;
    expect(store.finish(lease, { status: "done" })).toBe(false);
    expect(() => new LeasedJobStore({ persistence, now: () => "", leaseMs: 0 })).toThrow(
      /positive integer/,
    );
  });
});
