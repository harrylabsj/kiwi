/** Standalone external delivery queue for persistent Workbench alerts. */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { recordClockSkewAlert } from "../merchant-core/storage/clock-skew-alerts.js";
import { sanitize } from "../merchant-core/storage/redact.js";
import {
  LeasedJobStore,
  type LeasedJobHandle,
  type LeasedJobPersistence,
} from "../merchant-core/storage/leased-job.js";
import { inImmediateTransaction } from "../merchant-core/storage/transaction.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workbench_alert_deliveries (
  delivery_id TEXT PRIMARY KEY,
  alert_id TEXT UNIQUE NOT NULL,
  merchant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','leased','delivered','failed')),
  attempts INTEGER NOT NULL,
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  fencing_token INTEGER NOT NULL,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export interface ExternalAlertLease {
  deliveryId: string;
  alertId: string;
  merchantId: string;
  severity: "warning" | "critical";
  category: string;
  summary: string;
  createdAt: string;
  attempts: number;
  workerId: string;
  fencingToken: number;
}

export class ExternalAlertDeliveryStore {
  private readonly leasePersistence: LeasedJobPersistence<
    ExternalAlertLease,
    { delivered: true } | { delivered: false; error: string }
  >;

  constructor(private readonly options: { db: DatabaseSync; now?: () => string }) {
    options.db.exec("pragma busy_timeout=5000");
    options.db.exec(SCHEMA);
    this.leasePersistence = {
      inTransaction: (fn) => inImmediateTransaction(this.options.db, fn),
      enqueueOutstanding: (now) => this.enqueueOutstandingAt(now),
      leaseCandidate: (now) => {
        const row = this.options.db
          .prepare(
            `SELECT d.delivery_id, d.fencing_token
             FROM workbench_alert_deliveries d JOIN workbench_alerts a ON a.alert_id=d.alert_id
             WHERE (d.status='pending' AND d.next_attempt_at<=?)
                OR (d.status='leased' AND d.lease_expires_at<=?)
             ORDER BY CASE a.severity WHEN 'critical' THEN 0 ELSE 1 END,
                      d.next_attempt_at, d.delivery_id LIMIT 1`,
          )
          .get(now, now) as { delivery_id: string; fencing_token: number } | undefined;
        return row === undefined
          ? undefined
          : { jobId: row.delivery_id, fencingToken: Number(row.fencing_token) };
      },
      claim: (input) => this.claimLease(input),
      finish: (input) => this.finishLease(input.lease.payload, input.result, input.now),
    };
  }

  enqueueOutstanding(): number {
    return this.enqueueOutstandingAt(this.now());
  }

  private enqueueOutstandingAt(stamp: string): number {
    const rows = this.options.db
      .prepare(
        `SELECT alert_id, merchant_id FROM workbench_alerts
         WHERE resolved_at IS NULL ORDER BY created_at, alert_id`,
      )
      .all() as Array<{ alert_id: string; merchant_id: string }>;
    let created = 0;
    for (const row of rows) {
      created += Number(
        this.options.db
          .prepare(
            `INSERT OR IGNORE INTO workbench_alert_deliveries
             (delivery_id, alert_id, merchant_id, status, attempts, next_attempt_at,
              fencing_token, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', 0, ?, 0, ?, ?)`,
          )
          .run(
            `wad_${randomBytes(16).toString("base64url")}`,
            row.alert_id,
            row.merchant_id,
            stamp,
            stamp,
            stamp,
          ).changes,
      );
    }
    return created;
  }

  lease(workerId: string, leaseMs = 30_000): ExternalAlertLease | undefined {
    const leased = new LeasedJobStore<
      ExternalAlertLease,
      { delivered: true } | { delivered: false; error: string }
    >({
      persistence: this.leasePersistence,
      now: () => this.now(),
      leaseMs,
    }).lease(workerId);
    return leased?.payload;
  }

  finish(
    lease: ExternalAlertLease,
    result: { delivered: true } | { delivered: false; error: string },
  ): boolean {
    return new LeasedJobStore<
      ExternalAlertLease,
      { delivered: true } | { delivered: false; error: string }
    >({
      persistence: this.leasePersistence,
      now: () => this.now(),
      leaseMs: 30_000,
    }).finish(
      {
        jobId: lease.deliveryId,
        workerId: lease.workerId,
        fencingToken: lease.fencingToken,
        attempts: lease.attempts,
        payload: lease,
      },
      result,
    );
  }

  private claimLease(input: {
    jobId: string;
    workerId: string;
    expectedFencingToken: number;
    nextFencingToken: number;
    leaseExpiresAt: string;
    now: string;
  }): LeasedJobHandle<ExternalAlertLease> | undefined {
    const changed = this.options.db
      .prepare(
        `UPDATE workbench_alert_deliveries
         SET status='leased', lease_owner=?, lease_expires_at=?, fencing_token=?,
             attempts=attempts+1, updated_at=?
         WHERE delivery_id=? AND fencing_token=?
           AND ((status='pending' AND next_attempt_at<=?)
             OR (status='leased' AND lease_expires_at<=?))`,
      )
      .run(
        input.workerId,
        input.leaseExpiresAt,
        input.nextFencingToken,
        input.now,
        input.jobId,
        input.expectedFencingToken,
        input.now,
        input.now,
      );
    if (changed.changes !== 1) return undefined;
    const row = this.options.db
      .prepare(
        `SELECT d.*, a.severity, a.category, a.summary, a.created_at alert_created_at
         FROM workbench_alert_deliveries d JOIN workbench_alerts a ON a.alert_id=d.alert_id
         WHERE d.delivery_id=?`,
      )
      .get(input.jobId) as Record<string, unknown>;
    const payload: ExternalAlertLease = {
      deliveryId: String(row["delivery_id"]),
      alertId: String(row["alert_id"]),
      merchantId: String(row["merchant_id"]),
      severity: String(row["severity"]) as "warning" | "critical",
      category: String(row["category"]),
      summary: sanitize(String(row["summary"])),
      createdAt: String(row["alert_created_at"]),
      attempts: Number(row["attempts"]),
      workerId: input.workerId,
      fencingToken: input.nextFencingToken,
    };
    return {
      jobId: input.jobId,
      workerId: input.workerId,
      fencingToken: input.nextFencingToken,
      attempts: payload.attempts,
      payload,
    };
  }

  private finishLease(
    lease: ExternalAlertLease,
    result: { delivered: true } | { delivered: false; error: string },
    stamp: string,
  ): boolean {
    const terminalFailure = !result.delivered && lease.attempts >= 10;
    const delayMs = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(lease.attempts - 1, 8));
    const changed = this.options.db
      .prepare(
        `UPDATE workbench_alert_deliveries SET
           status=?, lease_owner=NULL, lease_expires_at=NULL, last_error=?,
           next_attempt_at=?, delivered_at=?, updated_at=?
         WHERE delivery_id=? AND status='leased' AND lease_owner=? AND fencing_token=?`,
      )
      .run(
        result.delivered ? "delivered" : terminalFailure ? "failed" : "pending",
        result.delivered ? null : sanitize(result.error),
        result.delivered ? stamp : new Date(Date.parse(stamp) + delayMs).toISOString(),
        result.delivered ? stamp : null,
        stamp,
        lease.deliveryId,
        lease.workerId,
        lease.fencingToken,
      );
    return changed.changes === 1;
  }

  status(
    alertId: string,
  ): { status: string; attempts: number; last_error: string | null } | undefined {
    return this.options.db
      .prepare(
        `SELECT status, attempts, last_error FROM workbench_alert_deliveries WHERE alert_id=?`,
      )
      .get(alertId) as { status: string; attempts: number; last_error: string | null } | undefined;
  }

  recordRuntimeProbe(input: {
    merchantId: string;
    publicOrigin: string;
    healthy: boolean;
    error?: string;
  }): { alertId?: string; changed: boolean } {
    const resource = `runtime:${input.publicOrigin}`;
    const episode = "runtime-offline";
    const stamp = this.now();
    if (input.healthy) {
      const changed = this.options.db
        .prepare(
          `UPDATE workbench_alerts SET resolved_at=?
           WHERE merchant_id=? AND category='runtime_offline' AND resource=? AND episode=?
             AND resolved_at IS NULL`,
        )
        .run(stamp, input.merchantId, resource, episode);
      return { changed: changed.changes === 1 };
    }
    const existing = this.options.db
      .prepare(
        `SELECT alert_id, resolved_at FROM workbench_alerts
         WHERE merchant_id=? AND category='runtime_offline' AND resource=? AND episode=?`,
      )
      .get(input.merchantId, resource, episode) as
      { alert_id: string; resolved_at: string | null } | undefined;
    const alertId = existing?.alert_id ?? `wba_${randomBytes(12).toString("hex")}`;
    const summary = `Runtime health probe failed: ${sanitize(input.error ?? "unreachable")}`;
    if (existing === undefined) {
      this.options.db
        .prepare(
          `INSERT INTO workbench_alerts
           (alert_id, merchant_id, category, resource, episode, severity, summary, created_at)
           VALUES (?, ?, 'runtime_offline', ?, ?, 'critical', ?, ?)`,
        )
        .run(alertId, input.merchantId, resource, episode, summary, stamp);
      return { alertId, changed: true };
    }
    if (existing.resolved_at !== null) {
      this.options.db
        .prepare(
          `UPDATE workbench_alerts SET resolved_at=NULL, acknowledged_at=NULL,
             acknowledged_by=NULL, summary=?, created_at=? WHERE alert_id=?`,
        )
        .run(summary, stamp, alertId);
      this.options.db
        .prepare("DELETE FROM workbench_alert_deliveries WHERE alert_id=?")
        .run(alertId);
      return { alertId, changed: true };
    }
    return { alertId, changed: false };
  }

  recordClockSkew(input: { merchantId: string; paused: boolean; offsetMs: number }): void {
    // 原语见 merchant-core/storage/clock-skew-alerts.ts（刀 3：与
    // reconciliation-worker 共享一份实现；本库投递表恒存在，守卫恒真，行为不变）。
    recordClockSkewAlert(this.options.db, this.now(), input);
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

export async function probeRuntimeHealth(
  store: ExternalAlertDeliveryStore,
  input: {
    merchantId: string;
    healthUrl: URL;
    fetchImpl?: typeof globalThis.fetch;
  },
): Promise<{ alertId?: string; changed: boolean; healthy: boolean }> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(input.healthUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`health probe returned HTTP ${response.status}`);
    return {
      ...store.recordRuntimeProbe({
        merchantId: input.merchantId,
        publicOrigin: input.healthUrl.origin,
        healthy: true,
      }),
      healthy: true,
    };
  } catch (error) {
    return {
      ...store.recordRuntimeProbe({
        merchantId: input.merchantId,
        publicOrigin: input.healthUrl.origin,
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      healthy: false,
    };
  }
}

export class ExternalAlertDeliveryWorker {
  constructor(
    private readonly store: ExternalAlertDeliveryStore,
    private readonly options: {
      workerId: string;
      send: (payload: {
        alert_id: string;
        merchant_id: string;
        severity: "warning" | "critical";
        category: string;
        summary: string;
        created_at: string;
      }) => Promise<void>;
    },
  ) {}

  async runOnce(): Promise<"delivered" | "retry" | "idle"> {
    this.store.enqueueOutstanding();
    const lease = this.store.lease(this.options.workerId);
    if (lease === undefined) return "idle";
    try {
      await this.options.send({
        alert_id: lease.alertId,
        merchant_id: lease.merchantId,
        severity: lease.severity,
        category: lease.category,
        summary: lease.summary,
        created_at: lease.createdAt,
      });
      if (!this.store.finish(lease, { delivered: true })) throw new Error("alert lease was fenced");
      return "delivered";
    } catch (error) {
      if (
        !this.store.finish(lease, {
          delivered: false,
          error: error instanceof Error ? error.message : String(error),
        })
      ) {
        throw new Error("alert lease was fenced", { cause: error });
      }
      return "retry";
    }
  }
}
