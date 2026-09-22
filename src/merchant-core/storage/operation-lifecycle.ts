/** Shared lifecycle state machine for idempotent operation receipts (P2-1 knife 4). */

export interface LifecycleIntent {
  scope: Readonly<Record<string, string>>;
  idempotencyKey: string;
  requestDigest: string;
}

export type LifecycleProbe<TReceipt> =
  | { kind: "miss" }
  | { kind: "replay"; operationId: string; receipt: TReceipt }
  | { kind: "conflict" };

export type LifecycleBegin<TReceipt> =
  | { kind: "execute"; operationId: string }
  | { kind: "replay"; operationId: string; receipt: TReceipt }
  | { kind: "conflict" };

export interface LifecycleReceiptRow<TReceipt> {
  operationId: string;
  requestDigest: string;
  receipt: TReceipt;
}

export interface LifecycleReceiptPersistence<TReceipt> {
  findByKey(intent: LifecycleIntent): LifecycleReceiptRow<TReceipt> | undefined;
  insertRunning(intent: LifecycleIntent, operationId: string, pending: TReceipt): void;
  insertTerminal(intent: LifecycleIntent, operationId: string, receipt: TReceipt): void;
  updateTerminal(operationId: string, receipt: TReceipt): void;
  deleteRunning(operationId: string): void;
  getById(operationId: string, scope: Readonly<Record<string, string>>): TReceipt | undefined;
  pruneCompletedBefore?(cutoffIso: string): number;
}

export class OperationLifecycleReceipts<TReceipt> {
  private readonly persistence: LifecycleReceiptPersistence<TReceipt>;
  private readonly operationId: () => string;
  private readonly pendingReceipt: (operationId: string, intent: LifecycleIntent) => TReceipt;
  private readonly conflictError: (message: string) => Error;
  private readonly now: () => string;
  private readonly retentionMs?: number;

  constructor(options: {
    persistence: LifecycleReceiptPersistence<TReceipt>;
    operationId: () => string;
    pendingReceipt: (operationId: string, intent: LifecycleIntent) => TReceipt;
    conflictError: (message: string) => Error;
    now: () => string;
    retentionMs?: number;
  }) {
    this.persistence = options.persistence;
    this.operationId = options.operationId;
    this.pendingReceipt = options.pendingReceipt;
    this.conflictError = options.conflictError;
    this.now = options.now;
    this.retentionMs = options.retentionMs;
    if (
      options.retentionMs !== undefined &&
      (!Number.isSafeInteger(options.retentionMs) || options.retentionMs <= 0)
    ) {
      throw new Error("retentionMs must be a positive integer");
    }
  }

  probe(intent: LifecycleIntent): LifecycleProbe<TReceipt> {
    this.prune();
    return this.outcome(intent, this.persistence.findByKey(intent));
  }

  begin(intent: LifecycleIntent): LifecycleBegin<TReceipt> {
    this.prune();
    const existing = this.persistence.findByKey(intent);
    if (existing !== undefined) return this.existingOutcome(intent, existing);
    const operationId = this.operationId();
    try {
      this.persistence.insertRunning(intent, operationId, this.pendingReceipt(operationId, intent));
      return { kind: "execute", operationId };
    } catch (error) {
      const raced = this.persistence.findByKey(intent);
      if (raced !== undefined) return this.existingOutcome(intent, raced);
      throw error;
    }
  }

  complete(operationId: string, receipt: TReceipt): void {
    this.persistence.updateTerminal(operationId, receipt);
  }

  release(operationId: string): void {
    this.persistence.deleteRunning(operationId);
  }

  get(operationId: string, scope: Readonly<Record<string, string>>): TReceipt | undefined {
    return this.persistence.getById(operationId, scope);
  }

  /**
   * Atomic local-write mode. The caller must wrap this method and its persistence adapter in
   * the same database transaction. It must never wrap an external/network side effect.
   */
  runOnce(input: { intent: LifecycleIntent; effect: (operationId: string) => TReceipt }): {
    replayed: boolean;
    operationId: string;
    receipt: TReceipt;
  } {
    this.prune();
    const existing = this.persistence.findByKey(input.intent);
    if (existing !== undefined) {
      const outcome = this.outcome(input.intent, existing);
      if (outcome.kind === "replay") {
        return {
          replayed: true,
          operationId: outcome.operationId,
          receipt: outcome.receipt,
        };
      }
      throw this.conflictError("operation key was reused with a different request");
    }
    const operationId = this.operationId();
    const receipt = input.effect(operationId);
    // A uniqueness failure here occurs after the effect ran. Replaying would hide a possible
    // duplicate side effect, so never compensate it here: caller-owned BEGIN IMMEDIATE must
    // serialize runOnce users, and any violation is surfaced for rollback/UNKNOWN handling.
    this.persistence.insertTerminal(input.intent, operationId, receipt);
    return { replayed: false, operationId, receipt };
  }

  private outcome(
    intent: LifecycleIntent,
    row: LifecycleReceiptRow<TReceipt> | undefined,
  ): LifecycleProbe<TReceipt> {
    if (row === undefined) return { kind: "miss" };
    if (row.requestDigest !== intent.requestDigest) return { kind: "conflict" };
    return { kind: "replay", operationId: row.operationId, receipt: row.receipt };
  }

  private existingOutcome(
    intent: LifecycleIntent,
    row: LifecycleReceiptRow<TReceipt>,
  ): Exclude<LifecycleProbe<TReceipt>, { kind: "miss" }> {
    if (row.requestDigest !== intent.requestDigest) return { kind: "conflict" };
    return { kind: "replay", operationId: row.operationId, receipt: row.receipt };
  }

  private prune(): void {
    if (this.retentionMs === undefined || this.persistence.pruneCompletedBefore === undefined) {
      return;
    }
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) throw new Error("operation lifecycle clock returned invalid time");
    this.persistence.pruneCompletedBefore(new Date(nowMs - this.retentionMs).toISOString());
  }
}
