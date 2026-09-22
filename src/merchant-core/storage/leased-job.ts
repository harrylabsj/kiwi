/** Shared lease/fencing state machine for persistent SQLite jobs (P2-1 knife 5). */

export interface LeasedJobHandle<TPayload> {
  jobId: string;
  workerId: string;
  fencingToken: number;
  attempts: number;
  payload: TPayload;
}

export interface LeasedJobPersistence<TPayload, TResult> {
  inTransaction<T>(fn: () => T): T;
  enqueueOutstanding(now: string): number;
  leaseCandidate(now: string): { jobId: string; fencingToken: number } | undefined;
  claim(input: {
    jobId: string;
    workerId: string;
    expectedFencingToken: number;
    nextFencingToken: number;
    leaseExpiresAt: string;
    now: string;
  }): LeasedJobHandle<TPayload> | undefined;
  finish(input: { lease: LeasedJobHandle<TPayload>; result: TResult; now: string }): boolean;
}

export class LeasedJobStore<TPayload, TResult> {
  private readonly persistence: LeasedJobPersistence<TPayload, TResult>;
  private readonly now: () => string;
  private readonly leaseMs: number;

  constructor(options: {
    persistence: LeasedJobPersistence<TPayload, TResult>;
    now: () => string;
    leaseMs: number;
  }) {
    this.persistence = options.persistence;
    this.now = options.now;
    this.leaseMs = options.leaseMs;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) {
      throw new Error("leaseMs must be a positive integer");
    }
  }

  enqueueOutstanding(): number {
    return this.persistence.enqueueOutstanding(this.now());
  }

  lease(workerId: string): LeasedJobHandle<TPayload> | undefined {
    const stamp = this.now();
    const expires = new Date(Date.parse(stamp) + this.leaseMs).toISOString();
    return this.persistence.inTransaction(() => {
      const candidate = this.persistence.leaseCandidate(stamp);
      if (candidate === undefined) return undefined;
      return this.persistence.claim({
        jobId: candidate.jobId,
        workerId,
        expectedFencingToken: candidate.fencingToken,
        nextFencingToken: candidate.fencingToken + 1,
        leaseExpiresAt: expires,
        now: stamp,
      });
    });
  }

  finish(lease: LeasedJobHandle<TPayload>, result: TResult): boolean {
    return this.persistence.inTransaction(() =>
      this.persistence.finish({ lease, result, now: this.now() }),
    );
  }
}
