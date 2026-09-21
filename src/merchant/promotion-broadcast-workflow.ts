/** Persistent promotion -> optional broadcast-draft partial-completion workflow. */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_promotion_broadcast_workflows (
  workflow_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  promotion_id TEXT NOT NULL,
  promotion_candidate_id TEXT,
  promotion_revision INTEGER,
  broadcast_requested INTEGER NOT NULL CHECK(broadcast_requested IN (0,1)),
  broadcast_json TEXT,
  broadcast_candidate_id TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'promotion_pending','promotion_published','broadcast_pending','partial','completed','failed'
  )),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export interface PromotionBroadcastWorkflowProjection {
  workflow_id: string;
  promotion_id: string;
  promotion_candidate_id: string | null;
  promotion_revision: number | null;
  broadcast_requested: boolean;
  broadcast_candidate_id: string | null;
  status:
    | "promotion_pending"
    | "promotion_published"
    | "broadcast_pending"
    | "partial"
    | "completed"
    | "failed";
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export class PromotionBroadcastWorkflowStore {
  constructor(private readonly options: { db: DatabaseSync; now?: () => string }) {
    this.options.db.exec("pragma busy_timeout=5000");
    this.options.db.exec(SCHEMA);
  }

  create(input: {
    merchantId: string;
    promotionId: string;
    broadcast?: Readonly<Record<string, unknown>>;
  }): PromotionBroadcastWorkflowProjection {
    const workflowId = `pwf_${randomBytes(16).toString("base64url")}`;
    const stamp = this.now();
    this.options.db
      .prepare(
        `INSERT INTO merchant_promotion_broadcast_workflows
         (workflow_id, merchant_id, promotion_id, broadcast_requested, broadcast_json,
          status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'promotion_pending', ?, ?)`,
      )
      .run(
        workflowId,
        requireText(input.merchantId, "merchantId"),
        requireText(input.promotionId, "promotionId"),
        input.broadcast === undefined ? 0 : 1,
        input.broadcast === undefined ? null : JSON.stringify(input.broadcast),
        stamp,
        stamp,
      );
    return this.get(input.merchantId, workflowId)!;
  }

  bindPromotionCandidate(merchantId: string, workflowId: string, candidateId: string): boolean {
    return (
      this.options.db
        .prepare(
          `UPDATE merchant_promotion_broadcast_workflows
           SET promotion_candidate_id=?, updated_at=?
           WHERE merchant_id=? AND workflow_id=? AND status='promotion_pending'
             AND promotion_candidate_id IS NULL`,
        )
        .run(candidateId, this.now(), merchantId, workflowId).changes === 1
    );
  }

  markPromotionPublished(
    merchantId: string,
    workflowId: string,
    revision: number,
  ): PromotionBroadcastWorkflowProjection {
    const row = this.require(merchantId, workflowId);
    if (row.status !== "promotion_pending" && row.status !== "promotion_published") {
      throw new Error(`workflow cannot publish promotion from ${row.status}`);
    }
    const nextStatus = row.broadcast_requested ? "promotion_published" : "completed";
    this.options.db
      .prepare(
        `UPDATE merchant_promotion_broadcast_workflows
         SET promotion_revision=?, status=?, updated_at=? WHERE merchant_id=? AND workflow_id=?`,
      )
      .run(revision, nextStatus, this.now(), merchantId, workflowId);
    return this.get(merchantId, workflowId)!;
  }

  markBroadcastPending(
    merchantId: string,
    workflowId: string,
    candidateId: string,
  ): PromotionBroadcastWorkflowProjection {
    const changed = this.options.db
      .prepare(
        `UPDATE merchant_promotion_broadcast_workflows
         SET broadcast_candidate_id=?, status='broadcast_pending', last_error=NULL, updated_at=?
         WHERE merchant_id=? AND workflow_id=? AND status IN ('promotion_published','partial')`,
      )
      .run(candidateId, this.now(), merchantId, workflowId);
    if (changed.changes !== 1) throw new Error("workflow cannot create broadcast candidate");
    return this.get(merchantId, workflowId)!;
  }

  markPartial(
    merchantId: string,
    workflowId: string,
    error: string,
  ): PromotionBroadcastWorkflowProjection {
    const changed = this.options.db
      .prepare(
        `UPDATE merchant_promotion_broadcast_workflows
         SET status='partial', last_error=?, updated_at=?
         WHERE merchant_id=? AND workflow_id=? AND status IN ('promotion_published','partial')`,
      )
      .run(sanitize(error), this.now(), merchantId, workflowId);
    if (changed.changes !== 1) throw new Error("workflow cannot enter partial state");
    return this.get(merchantId, workflowId)!;
  }

  markCompleted(merchantId: string, workflowId: string): PromotionBroadcastWorkflowProjection {
    const changed = this.options.db
      .prepare(
        `UPDATE merchant_promotion_broadcast_workflows
         SET status='completed', last_error=NULL, updated_at=?
         WHERE merchant_id=? AND workflow_id=? AND status='broadcast_pending'`,
      )
      .run(this.now(), merchantId, workflowId);
    if (changed.changes !== 1) throw new Error("workflow cannot complete broadcast");
    return this.get(merchantId, workflowId)!;
  }

  markFailed(merchantId: string, workflowId: string, error: string): void {
    this.options.db
      .prepare(
        `UPDATE merchant_promotion_broadcast_workflows
         SET status='failed', last_error=?, updated_at=?
         WHERE merchant_id=? AND workflow_id=? AND status='promotion_pending'`,
      )
      .run(sanitize(error), this.now(), merchantId, workflowId);
  }

  get(merchantId: string, workflowId: string): PromotionBroadcastWorkflowProjection | undefined {
    const row = this.options.db
      .prepare(
        `SELECT workflow_id, promotion_id, promotion_candidate_id, promotion_revision,
                broadcast_requested, broadcast_candidate_id, status, last_error,
                created_at, updated_at
         FROM merchant_promotion_broadcast_workflows WHERE merchant_id=? AND workflow_id=?`,
      )
      .get(merchantId, workflowId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : project(row);
  }

  broadcastContent(merchantId: string, workflowId: string): Record<string, unknown> | undefined {
    const row = this.options.db
      .prepare(
        `SELECT broadcast_json FROM merchant_promotion_broadcast_workflows
         WHERE merchant_id=? AND workflow_id=?
           AND status IN ('promotion_published','partial') AND broadcast_requested=1`,
      )
      .get(merchantId, workflowId) as { broadcast_json: string | null } | undefined;
    return row?.broadcast_json === null || row?.broadcast_json === undefined
      ? undefined
      : (JSON.parse(row.broadcast_json) as Record<string, unknown>);
  }

  private require(merchantId: string, workflowId: string): PromotionBroadcastWorkflowProjection {
    const value = this.get(merchantId, workflowId);
    if (value === undefined) throw new Error("unknown promotion broadcast workflow");
    return value;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function project(row: Record<string, unknown>): PromotionBroadcastWorkflowProjection {
  return {
    workflow_id: String(row["workflow_id"]),
    promotion_id: String(row["promotion_id"]),
    promotion_candidate_id:
      row["promotion_candidate_id"] === null ? null : String(row["promotion_candidate_id"]),
    promotion_revision:
      row["promotion_revision"] === null ? null : Number(row["promotion_revision"]),
    broadcast_requested: Number(row["broadcast_requested"]) === 1,
    broadcast_candidate_id:
      row["broadcast_candidate_id"] === null ? null : String(row["broadcast_candidate_id"]),
    status: String(row["status"]) as PromotionBroadcastWorkflowProjection["status"],
    last_error: row["last_error"] === null ? null : String(row["last_error"]),
    created_at: String(row["created_at"]),
    updated_at: String(row["updated_at"]),
  };
}

function sanitize(value: string): string {
  return String(value ?? "")
    .replace(/\b(Bearer|token|api[_-]?key|secret|password)\b\s*[:=]?\s*\S+/giu, "$1 [redacted]")
    .slice(0, 500);
}

function requireText(value: string, field: string): string {
  const text = String(value ?? "").trim();
  if (text === "") throw new Error(`${field} is required`);
  return text;
}
