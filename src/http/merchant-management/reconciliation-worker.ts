/** Persistent Workbench outbox execution and UNKNOWN reconciliation (design v0.1.1 §22). */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workbench_reconciliation_jobs (
  operation_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  first_unknown_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','leased','human_required','completed')),
  fencing_token INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workbench_alerts (
  alert_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  category TEXT NOT NULL,
  resource TEXT NOT NULL,
  episode TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT,
  UNIQUE (merchant_id, category, resource, episode)
);
`;

export interface OutboxLease {
  merchantId: string;
  operationId: string;
  candidateId: string;
  approvalGeneration: number;
  actionStep: string;
  workerId: string;
  fencingToken: number;
  actorId: string;
  decision: "approve" | "reject";
  actionDigest: string;
}

export interface ReconciliationLease {
  merchantId: string;
  operationId: string;
  workerId: string;
  fencingToken: number;
  attempts: number;
  firstUnknownAt: string;
}

export type OperationResult =
  | { status: "succeeded" }
  | { status: "failed"; error: string }
  | { status: "unknown"; error: string };

export function committedDecisionOutcomeResult(outcome: unknown): OperationResult {
  if (
    outcome !== null &&
    typeof outcome === "object" &&
    "kind" in outcome &&
    (outcome as { kind?: unknown }).kind !== "executed"
  ) {
    return {
      status: "failed",
      error: `candidate execution ended as ${String((outcome as { kind?: unknown }).kind)}`,
    };
  }
  return { status: "succeeded" };
}

export function candidateReconciliationResult(input: {
  status: string;
  executionClaimed: boolean | undefined;
}): OperationResult {
  if (input.status === "executed" || input.status === "rejected") {
    return { status: "succeeded" };
  }
  if (input.status === "expired" || input.status === "superseded") {
    if (input.executionClaimed === false) {
      return { status: "failed", error: `candidate ended as ${input.status} before execution` };
    }
    return {
      status: "unknown",
      error: `candidate ended as ${input.status} after execution may have started`,
    };
  }
  return { status: "unknown", error: `candidate remains ${input.status}` };
}

interface OutboxRow {
  merchant_id: string;
  operation_id: string;
  candidate_id: string;
  approval_generation: number;
  action_step: string;
  fencing_token: number;
  actor_id: string;
  decision: "approve" | "reject";
  action_digest: string;
}

interface ReconciliationRow {
  merchant_id: string;
  operation_id: string;
  attempts: number;
  first_unknown_at: string;
  fencing_token: number;
}

export class WorkbenchReconciliationStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly jitter: () => number;

  constructor(options: { db: DatabaseSync; now?: () => string; jitter?: () => number }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.jitter = options.jitter ?? (() => Math.random() * 0.4 - 0.2);
    this.db.exec("pragma busy_timeout = 5000");
    this.db.exec(SCHEMA);
    ensureColumn(this.db, "workbench_alerts", "acknowledged_by", "TEXT");
  }

  candidateIdForOperation(operationId: string): string | undefined {
    const row = this.db
      .prepare("SELECT candidate_id FROM workbench_approval_decisions WHERE operation_id=?")
      .get(operationId) as { candidate_id: string } | undefined;
    return row?.candidate_id;
  }

  listAlerts(
    merchantId: string,
    options: { cursor?: string; limit?: number } = {},
  ): {
    items: Array<{
      alert_id: string;
      category: string;
      resource: string;
      episode: string;
      severity: "warning" | "critical";
      summary: string;
      created_at: string;
      acknowledged_at: string | null;
      acknowledged_by: string | null;
      resolved_at: string | null;
    }>;
    next_cursor: string | null;
  } {
    const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("alert cursor is invalid");
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const rows = this.db
      .prepare(
        `SELECT alert_id, category, resource, episode, severity, summary, created_at,
                acknowledged_at, acknowledged_by, resolved_at
         FROM workbench_alerts WHERE merchant_id=?
         ORDER BY resolved_at IS NULL DESC, created_at DESC, alert_id LIMIT ? OFFSET ?`,
      )
      .all(merchantId, limit + 1, offset) as Array<Record<string, unknown>>;
    return {
      items: rows.slice(0, limit).map((row) => ({
        alert_id: String(row["alert_id"]),
        category: String(row["category"]),
        resource: String(row["resource"]),
        episode: String(row["episode"]),
        severity: String(row["severity"]) as "warning" | "critical",
        summary: String(row["summary"]),
        created_at: String(row["created_at"]),
        acknowledged_at: row["acknowledged_at"] === null ? null : String(row["acknowledged_at"]),
        acknowledged_by: row["acknowledged_by"] === null ? null : String(row["acknowledged_by"]),
        resolved_at: row["resolved_at"] === null ? null : String(row["resolved_at"]),
      })),
      next_cursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  acknowledgeAlert(merchantId: string, alertId: string, actorId: string): boolean {
    const changed = this.db
      .prepare(
        `UPDATE workbench_alerts SET acknowledged_at=COALESCE(acknowledged_at, ?),
          acknowledged_by=COALESCE(acknowledged_by, ?)
         WHERE merchant_id=? AND alert_id=?`,
      )
      .run(this.now(), actorId, merchantId, alertId);
    return changed.changes === 1;
  }

  recordClockSkew(input: { merchantId: string; paused: boolean; offsetMs: number }): void {
    const stamp = this.now();
    if (!input.paused) {
      this.db
        .prepare(
          `UPDATE workbench_alerts SET resolved_at=?
           WHERE merchant_id=? AND category='clock_skew' AND resource='clock:system'
             AND episode='clock-skew' AND resolved_at IS NULL`,
        )
        .run(stamp, input.merchantId);
      return;
    }
    const existing = this.db
      .prepare(
        `SELECT alert_id, resolved_at FROM workbench_alerts
         WHERE merchant_id=? AND category='clock_skew' AND resource='clock:system'
           AND episode='clock-skew'`,
      )
      .get(input.merchantId) as { alert_id: string; resolved_at: string | null } | undefined;
    const summary = `System clock skew exceeded limit: offset_ms=${Math.round(input.offsetMs)}`;
    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO workbench_alerts
           (alert_id, merchant_id, category, resource, episode, severity, summary, created_at)
           VALUES (?, ?, 'clock_skew', 'clock:system', 'clock-skew', 'critical', ?, ?)`,
        )
        .run(`wba_${randomBytes(12).toString("hex")}`, input.merchantId, summary, stamp);
      return;
    }
    if (existing.resolved_at === null) {
      this.db
        .prepare("UPDATE workbench_alerts SET severity='critical', summary=? WHERE alert_id=?")
        .run(summary, existing.alert_id);
      return;
    }
    this.db
      .prepare(
        `UPDATE workbench_alerts SET severity='critical', summary=?, created_at=?, resolved_at=NULL,
           acknowledged_at=NULL, acknowledged_by=NULL WHERE alert_id=?`,
      )
      .run(summary, stamp, existing.alert_id);
    const deliveriesPresent = this.db
      .prepare(
        "SELECT 1 present FROM sqlite_master WHERE type='table' AND name='workbench_alert_deliveries'",
      )
      .get() as { present: number } | undefined;
    if (deliveriesPresent?.present === 1) {
      this.db
        .prepare("DELETE FROM workbench_alert_deliveries WHERE alert_id=?")
        .run(existing.alert_id);
    }
  }

  leaseOutbox(merchantId: string, workerId: string, leaseMs = 30_000): OutboxLease | undefined {
    const stamp = this.now();
    const leaseExpires = new Date(Date.parse(stamp) + leaseMs).toISOString();
    this.db.exec("begin immediate");
    try {
      const row = this.db
        .prepare(
          `SELECT o.merchant_id, o.operation_id, d.candidate_id, d.approval_generation,
                  o.action_step, o.fencing_token, d.actor_id, d.decision, d.action_digest
           FROM workbench_approval_outbox o
           JOIN workbench_approval_decisions d ON d.operation_id = o.operation_id
           WHERE o.merchant_id = ?
             AND (o.status = 'pending' OR (o.status = 'leased' AND o.lease_expires_at <= ?))
           ORDER BY o.created_at, o.operation_id LIMIT 1`,
        )
        .get(merchantId, stamp) as unknown as OutboxRow | undefined;
      if (row === undefined) {
        this.db.exec("commit");
        return undefined;
      }
      const token = row.fencing_token + 1;
      const changed = this.db
        .prepare(
          `UPDATE workbench_approval_outbox
           SET status='leased', lease_owner=?, lease_expires_at=?, fencing_token=?, attempts=attempts+1
           WHERE merchant_id=? AND operation_id=? AND action_step=? AND fencing_token=?`,
        )
        .run(
          workerId,
          leaseExpires,
          token,
          row.merchant_id,
          row.operation_id,
          row.action_step,
          row.fencing_token,
        );
      if (changed.changes !== 1) throw new Error("outbox lease CAS failed");
      this.db.exec("commit");
      return {
        merchantId: row.merchant_id,
        operationId: row.operation_id,
        candidateId: row.candidate_id,
        approvalGeneration: row.approval_generation,
        actionStep: row.action_step,
        workerId,
        fencingToken: token,
        actorId: row.actor_id,
        decision: row.decision,
        actionDigest: row.action_digest,
      };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  finishOutbox(lease: OutboxLease, result: OperationResult): boolean {
    const stamp = this.now();
    this.db.exec("begin immediate");
    try {
      const terminal = result.status === "failed" ? "failed" : "completed";
      const changed = this.db
        .prepare(
          `UPDATE workbench_approval_outbox
           SET status=?, lease_owner=NULL, lease_expires_at=NULL
           WHERE merchant_id=? AND operation_id=? AND action_step=? AND status='leased'
             AND lease_owner=? AND fencing_token=?`,
        )
        .run(
          terminal,
          lease.merchantId,
          lease.operationId,
          lease.actionStep,
          lease.workerId,
          lease.fencingToken,
        );
      if (changed.changes !== 1) {
        this.db.exec("rollback");
        return false;
      }
      this.db
        .prepare(
          "UPDATE workbench_approval_operations SET status=?, updated_at=? WHERE operation_id=?",
        )
        .run(result.status, stamp, lease.operationId);
      if (result.status === "unknown") {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO workbench_reconciliation_jobs
             (operation_id, merchant_id, first_unknown_at, next_attempt_at, attempts, status,
              fencing_token, last_error, updated_at)
             VALUES (?, ?, ?, ?, 0, 'pending', 0, ?, ?)`,
          )
          .run(
            lease.operationId,
            lease.merchantId,
            stamp,
            new Date(Date.parse(stamp) + 5_000).toISOString(),
            sanitize(result.error),
            stamp,
          );
      }
      this.db.exec("commit");
      return true;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  leaseReconciliation(workerId: string, leaseMs = 30_000): ReconciliationLease | undefined {
    const stamp = this.now();
    const expires = new Date(Date.parse(stamp) + leaseMs).toISOString();
    this.db.exec("begin immediate");
    try {
      const row = this.db
        .prepare(
          `SELECT merchant_id, operation_id, attempts, first_unknown_at, fencing_token
           FROM workbench_reconciliation_jobs
           WHERE (status='pending' AND next_attempt_at <= ?)
              OR (status='leased' AND lease_expires_at <= ?)
           ORDER BY next_attempt_at, operation_id LIMIT 1`,
        )
        .get(stamp, stamp) as unknown as ReconciliationRow | undefined;
      if (row === undefined) {
        this.db.exec("commit");
        return undefined;
      }
      const token = row.fencing_token + 1;
      const changed = this.db
        .prepare(
          `UPDATE workbench_reconciliation_jobs
           SET status='leased', lease_owner=?, lease_expires_at=?, fencing_token=?, updated_at=?
           WHERE operation_id=? AND fencing_token=?`,
        )
        .run(workerId, expires, token, stamp, row.operation_id, row.fencing_token);
      if (changed.changes !== 1) throw new Error("reconciliation lease CAS failed");
      this.db.exec("commit");
      return {
        merchantId: row.merchant_id,
        operationId: row.operation_id,
        workerId,
        fencingToken: token,
        attempts: row.attempts,
        firstUnknownAt: row.first_unknown_at,
      };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  finishReconciliation(lease: ReconciliationLease, result: OperationResult): boolean {
    const stamp = this.now();
    this.db.exec("begin immediate");
    try {
      const owned = this.db
        .prepare(
          `SELECT attempts, first_unknown_at FROM workbench_reconciliation_jobs
           WHERE operation_id=? AND status='leased' AND lease_owner=? AND fencing_token=?`,
        )
        .get(lease.operationId, lease.workerId, lease.fencingToken) as
        { attempts: number; first_unknown_at: string } | undefined;
      if (owned === undefined) {
        this.db.exec("rollback");
        return false;
      }
      if (result.status !== "unknown") {
        this.db
          .prepare(
            `UPDATE workbench_reconciliation_jobs
             SET status='completed', lease_owner=NULL, lease_expires_at=NULL, updated_at=?, last_error=?
             WHERE operation_id=?`,
          )
          .run(
            stamp,
            result.status === "failed" ? sanitize(result.error) : null,
            lease.operationId,
          );
        this.db
          .prepare(
            "UPDATE workbench_approval_operations SET status=?, updated_at=? WHERE operation_id=?",
          )
          .run(result.status, stamp, lease.operationId);
        this.db.exec("commit");
        return true;
      }

      const attempts = owned.attempts + 1;
      const elapsedMs = Date.parse(stamp) - Date.parse(owned.first_unknown_at);
      const humanRequired = attempts >= 10 || elapsedMs >= 30 * 60 * 1000;
      if (humanRequired) {
        this.db
          .prepare(
            `UPDATE workbench_reconciliation_jobs
             SET status='human_required', attempts=?, lease_owner=NULL, lease_expires_at=NULL,
                 last_error=?, updated_at=? WHERE operation_id=?`,
          )
          .run(attempts, sanitize(result.error), stamp, lease.operationId);
        this.upsertAlert(lease, "critical", "UNKNOWN 结果需要人工核查", stamp);
      } else {
        const delay = retryDelayMs(attempts, this.jitter());
        this.db
          .prepare(
            `UPDATE workbench_reconciliation_jobs
             SET status='pending', attempts=?, next_attempt_at=?, lease_owner=NULL,
                 lease_expires_at=NULL, last_error=?, updated_at=? WHERE operation_id=?`,
          )
          .run(
            attempts,
            new Date(Date.parse(stamp) + delay).toISOString(),
            sanitize(result.error),
            stamp,
            lease.operationId,
          );
        if (attempts >= 5 || elapsedMs >= 5 * 60 * 1000) {
          this.upsertAlert(lease, "warning", "UNKNOWN 结果持续未确认", stamp);
        }
      }
      this.db.exec("commit");
      return true;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private upsertAlert(
    lease: Pick<ReconciliationLease, "merchantId" | "operationId">,
    severity: "warning" | "critical",
    summary: string,
    stamp: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO workbench_alerts
         (alert_id, merchant_id, category, resource, episode, severity, summary, created_at)
         VALUES (?, ?, 'operation_unknown', ?, ?, ?, ?, ?)
         ON CONFLICT(merchant_id, category, resource, episode) DO UPDATE SET
           severity=excluded.severity, summary=excluded.summary`,
      )
      .run(
        `wba_${randomBytes(12).toString("hex")}`,
        lease.merchantId,
        lease.operationId,
        lease.operationId,
        severity,
        summary,
        stamp,
      );
  }
}

export class WorkbenchReconciliationWorker {
  constructor(
    private readonly store: WorkbenchReconciliationStore,
    private readonly options: {
      workerId: string;
      merchantId: string;
      execute: (lease: OutboxLease) => Promise<OperationResult>;
      query: (lease: ReconciliationLease) => Promise<OperationResult>;
    },
  ) {}

  async runOnce(): Promise<"outbox" | "reconciliation" | "idle"> {
    const outbox = this.store.leaseOutbox(this.options.merchantId, this.options.workerId);
    if (outbox !== undefined) {
      const result = await this.options.execute(outbox);
      if (!this.store.finishOutbox(outbox, result)) throw new Error("outbox lease was fenced");
      return "outbox";
    }
    const reconciliation = this.store.leaseReconciliation(this.options.workerId);
    if (reconciliation !== undefined) {
      const result = await this.options.query(reconciliation);
      if (!this.store.finishReconciliation(reconciliation, result)) {
        throw new Error("reconciliation lease was fenced");
      }
      return "reconciliation";
    }
    return "idle";
  }
}

function retryDelayMs(attempts: number, jitter: number): number {
  const seconds = [5, 15, 30, 60, 300][Math.min(Math.max(attempts - 1, 0), 4)]!;
  const boundedJitter = Math.min(0.2, Math.max(-0.2, jitter));
  return Math.round(seconds * 1000 * (1 + boundedJitter));
}

function sanitize(value: string): string {
  return String(value ?? "")
    .replace(/\b(Bearer|token|api[_-]?key|secret|password)\b\s*[:=]?\s*\S+/gi, "$1 [redacted]")
    .slice(0, 500);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
