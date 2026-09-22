/** Persistent guard for server-clock-sensitive merchant actions. */

import type { DatabaseSync } from "node:sqlite";

import { inImmediateTransaction } from "../merchant-core/storage/transaction.js";

const DEFAULT_MAX_ABS_OFFSET_MS = 2_000;
const DEFAULT_BREACH_LIMIT = 2;
const DEFAULT_MAX_SAMPLE_AGE_MS = 120_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_clock_safety (
  merchant_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('healthy','paused')),
  consecutive_breaches INTEGER NOT NULL,
  offset_ms INTEGER NOT NULL,
  reference_at TEXT NOT NULL,
  local_at TEXT NOT NULL,
  paused_at TEXT,
  updated_at TEXT NOT NULL
);
`;

export interface ClockSafetyAlertSink {
  recordClockSkew(input: { merchantId: string; paused: boolean; offsetMs: number }): void;
}

export interface ClockSafetyStatus {
  status: "unknown" | "healthy" | "paused";
  consecutive_breaches: number;
  offset_ms: number | null;
  reference_at: string | null;
  local_at: string | null;
  paused_at: string | null;
}

export class ClockSafetyError extends Error {
  readonly code: "clock_unverified" | "clock_skew";

  constructor(code: ClockSafetyError["code"], message: string) {
    super(message);
    this.name = "ClockSafetyError";
    this.code = code;
  }
}

export class ClockSafetyStore {
  private readonly db: DatabaseSync;
  private readonly alerts?: ClockSafetyAlertSink;
  private readonly maxAbsOffsetMs: number;
  private readonly breachLimit: number;
  private readonly maxSampleAgeMs: number;
  private readonly nowMs: () => number;

  constructor(options: {
    db: DatabaseSync;
    alerts?: ClockSafetyAlertSink;
    maxAbsOffsetMs?: number;
    breachLimit?: number;
    maxSampleAgeMs?: number;
    nowMs?: () => number;
  }) {
    this.db = options.db;
    this.alerts = options.alerts;
    this.maxAbsOffsetMs = options.maxAbsOffsetMs ?? DEFAULT_MAX_ABS_OFFSET_MS;
    this.breachLimit = options.breachLimit ?? DEFAULT_BREACH_LIMIT;
    this.maxSampleAgeMs = options.maxSampleAgeMs ?? DEFAULT_MAX_SAMPLE_AGE_MS;
    this.nowMs = options.nowMs ?? Date.now;
    if (!Number.isSafeInteger(this.maxAbsOffsetMs) || this.maxAbsOffsetMs < 0) {
      throw new Error("maxAbsOffsetMs must be a non-negative integer");
    }
    if (!Number.isSafeInteger(this.breachLimit) || this.breachLimit < 1) {
      throw new Error("breachLimit must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxSampleAgeMs) || this.maxSampleAgeMs < 1) {
      throw new Error("maxSampleAgeMs must be a positive integer");
    }
    this.db.exec("pragma busy_timeout=5000");
    this.db.exec(SCHEMA);
  }

  recordSample(input: {
    merchantId: string;
    referenceTimeMs: number;
    localTimeMs: number;
  }): ClockSafetyStatus {
    const merchantId = requireText(input.merchantId, "merchantId");
    requireEpoch(input.referenceTimeMs, "referenceTimeMs");
    requireEpoch(input.localTimeMs, "localTimeMs");
    const offsetMs = Math.round(input.localTimeMs - input.referenceTimeMs);
    if (!Number.isSafeInteger(offsetMs)) throw new Error("clock offset is outside the safe range");
    const breached = Math.abs(offsetMs) > this.maxAbsOffsetMs;
    const localAt = new Date(input.localTimeMs).toISOString();
    const referenceAt = new Date(input.referenceTimeMs).toISOString();
    const paused = inImmediateTransaction(this.db, () => {
      const previous = this.db
        .prepare(
          "SELECT status, consecutive_breaches, paused_at FROM merchant_clock_safety WHERE merchant_id=?",
        )
        .get(merchantId) as
        | { status: "healthy" | "paused"; consecutive_breaches: number; paused_at: string | null }
        | undefined;
      const consecutiveBreaches = breached
        ? Math.min((previous?.consecutive_breaches ?? 0) + 1, this.breachLimit)
        : 0;
      const pausedNow =
        breached && (previous?.status === "paused" || consecutiveBreaches >= this.breachLimit);
      const pausedAt = pausedNow ? (previous?.paused_at ?? localAt) : null;
      this.db
        .prepare(
          `INSERT INTO merchant_clock_safety
           (merchant_id, status, consecutive_breaches, offset_ms, reference_at, local_at,
            paused_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(merchant_id) DO UPDATE SET
             status=excluded.status,
             consecutive_breaches=excluded.consecutive_breaches,
             offset_ms=excluded.offset_ms,
             reference_at=excluded.reference_at,
             local_at=excluded.local_at,
             paused_at=excluded.paused_at,
             updated_at=excluded.updated_at`,
        )
        .run(
          merchantId,
          pausedNow ? "paused" : "healthy",
          consecutiveBreaches,
          offsetMs,
          referenceAt,
          localAt,
          pausedAt,
          localAt,
        );
      return pausedNow;
    });
    // 告警是事务外副作用（不进 fn）：只有状态已提交才告警，且告警失败不回滚状态。
    this.alerts?.recordClockSkew({ merchantId, paused, offsetMs });
    return this.status(merchantId);
  }

  status(merchantId: string): ClockSafetyStatus {
    const row = this.db
      .prepare(
        `SELECT status, consecutive_breaches, offset_ms, reference_at, local_at, paused_at
         FROM merchant_clock_safety WHERE merchant_id=?`,
      )
      .get(requireText(merchantId, "merchantId")) as
      | {
          status: "healthy" | "paused";
          consecutive_breaches: number;
          offset_ms: number;
          reference_at: string;
          local_at: string;
          paused_at: string | null;
        }
      | undefined;
    return (
      row ?? {
        status: "unknown",
        consecutive_breaches: 0,
        offset_ms: null,
        reference_at: null,
        local_at: null,
        paused_at: null,
      }
    );
  }

  assertTimeSensitiveWritesAllowed(merchantId: string): void {
    const status = this.status(merchantId);
    if (status.status === "unknown") {
      throw new ClockSafetyError(
        "clock_unverified",
        "reference clock has not been verified; time-sensitive writes are paused",
      );
    }
    const sampleAgeMs = this.nowMs() - Date.parse(status.local_at ?? "");
    if (
      !Number.isFinite(sampleAgeMs) ||
      sampleAgeMs > this.maxSampleAgeMs ||
      sampleAgeMs < -this.maxAbsOffsetMs
    ) {
      throw new ClockSafetyError(
        "clock_unverified",
        "reference clock sample is stale; time-sensitive writes are paused",
      );
    }
    if (status.status === "paused") {
      throw new ClockSafetyError(
        "clock_skew",
        "server clock skew exceeded the configured limit; time-sensitive writes are paused",
      );
    }
  }
}

export async function probeReferenceClock(
  store: ClockSafetyStore,
  input: {
    merchantId: string;
    referenceUrl: URL;
    fetchImpl?: typeof globalThis.fetch;
    nowMs?: () => number;
  },
): Promise<ClockSafetyStatus> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const nowMs = input.nowMs ?? Date.now;
  const startedAt = nowMs();
  const response = await fetchImpl(input.referenceUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const finishedAt = nowMs();
  if (!response.ok) throw new Error(`reference clock returned HTTP ${response.status}`);
  const date = response.headers.get("date");
  const referenceTimeMs = Date.parse(date ?? "");
  if (!Number.isFinite(referenceTimeMs))
    throw new Error("reference clock response has no valid Date header");
  return store.recordSample({
    merchantId: input.merchantId,
    referenceTimeMs,
    localTimeMs: Math.round((startedAt + finishedAt) / 2),
  });
}

function requireEpoch(value: number, field: string): void {
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value))) {
    throw new Error(`${field} must be a finite epoch millisecond value`);
  }
}

function requireText(value: string, field: string): string {
  const text = value.trim();
  if (text === "") throw new Error(`${field} is required`);
  return text;
}
