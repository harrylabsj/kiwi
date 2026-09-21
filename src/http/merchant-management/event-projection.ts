/** Read-only Workbench event timeline projected from authoritative domain tables. */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface WorkbenchTimelineEvent {
  event_id: string;
  event_type: string;
  aggregate_id: string;
  aggregate_version: number | null;
  occurred_at: string;
  actor_ref: string | null;
  correlation_id: string | null;
  visibility: "merchant_private";
  schema_version: "1";
  summary: Record<string, unknown>;
}

export class WorkbenchEventProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchEventProjectionError";
  }
}

export class WorkbenchEventProjectionStore {
  constructor(private readonly options: { db: DatabaseSync; cursorKey: Buffer }) {
    if (options.cursorKey.length < 32)
      throw new Error("event cursor key must be at least 32 bytes");
  }

  list(
    merchantId: string,
    options: { cursor?: string; limit?: number } = {},
  ): { items: WorkbenchTimelineEvent[]; next_cursor: string | null; has_more: boolean } {
    const after =
      options.cursor === undefined ? undefined : this.decodeCursor(merchantId, options.cursor);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const events = [
      ...this.approvalEvents(merchantId),
      ...this.operationEvents(merchantId),
      ...this.feedEvents(merchantId),
      ...this.promotionEvents(merchantId),
      ...this.alertEvents(merchantId),
      ...this.engagementEvents(merchantId),
    ]
      .filter(
        (event) =>
          after === undefined ||
          event.occurred_at > after.occurredAt ||
          (event.occurred_at === after.occurredAt && event.event_id > after.eventId),
      )
      .sort(
        (left, right) =>
          left.occurred_at.localeCompare(right.occurred_at) ||
          left.event_id.localeCompare(right.event_id),
      );
    const items = events.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      next_cursor:
        last === undefined ? null : this.encodeCursor(merchantId, last.occurred_at, last.event_id),
      has_more: events.length > items.length,
    };
  }

  private approvalEvents(merchantId: string): WorkbenchTimelineEvent[] {
    const rows = this.safeAll(
      `SELECT operation_id, candidate_id, approval_generation, decision, actor_id, decided_at
       FROM workbench_approval_decisions WHERE merchant_id=?`,
      merchantId,
    );
    return rows.map((row) => ({
      event_id: `approval:${String(row["operation_id"])}`,
      event_type: "approval.decided",
      aggregate_id: String(row["candidate_id"]),
      aggregate_version: Number(row["approval_generation"]),
      occurred_at: String(row["decided_at"]),
      actor_ref: String(row["actor_id"]),
      correlation_id: String(row["operation_id"]),
      visibility: "merchant_private",
      schema_version: "1",
      summary: { decision: String(row["decision"]) },
    }));
  }

  private operationEvents(merchantId: string): WorkbenchTimelineEvent[] {
    const rows = this.safeAll(
      `SELECT operation_id, candidate_id, approval_generation, status, updated_at
       FROM workbench_approval_operations WHERE merchant_id=?`,
      merchantId,
    );
    return rows.map((row) => ({
      event_id: `operation:${String(row["operation_id"])}:${String(row["status"])}`,
      event_type: "operation.status",
      aggregate_id: String(row["operation_id"]),
      aggregate_version: Number(row["approval_generation"]),
      occurred_at: String(row["updated_at"]),
      actor_ref: null,
      correlation_id: String(row["candidate_id"]),
      visibility: "merchant_private",
      schema_version: "1",
      summary: { status: String(row["status"]) },
    }));
  }

  private feedEvents(merchantId: string): WorkbenchTimelineEvent[] {
    const rows = this.safeAll(
      `SELECT event_id, event_type, broadcast_id, revision, created_at
       FROM merchant_feed_events WHERE merchant_id=?`,
      merchantId,
    );
    return rows.map((row) => ({
      event_id: `feed:${String(row["event_id"])}`,
      event_type: `broadcast.${String(row["event_type"])}`,
      aggregate_id: String(row["broadcast_id"]),
      aggregate_version: Number(row["revision"]),
      occurred_at: String(row["created_at"]),
      actor_ref: null,
      correlation_id: null,
      visibility: "merchant_private",
      schema_version: "1",
      summary: {},
    }));
  }

  private promotionEvents(merchantId: string): WorkbenchTimelineEvent[] {
    const rows = this.safeAll(
      `SELECT promotion_id, revision, created_at
       FROM merchant_promotion_revisions WHERE merchant_id=?`,
      merchantId,
    );
    return rows.map((row) => ({
      event_id: `promotion:${String(row["promotion_id"])}:${String(row["revision"])}`,
      event_type: "promotion.revised",
      aggregate_id: String(row["promotion_id"]),
      aggregate_version: Number(row["revision"]),
      occurred_at: String(row["created_at"]),
      actor_ref: null,
      correlation_id: null,
      visibility: "merchant_private",
      schema_version: "1",
      summary: {},
    }));
  }

  private alertEvents(merchantId: string): WorkbenchTimelineEvent[] {
    const rows = this.safeAll(
      `SELECT alert_id, category, resource, severity, created_at
       FROM workbench_alerts WHERE merchant_id=?`,
      merchantId,
    );
    return rows.map((row) => ({
      event_id: `alert:${String(row["alert_id"])}`,
      event_type: "alert.created",
      aggregate_id: String(row["resource"]),
      aggregate_version: null,
      occurred_at: String(row["created_at"]),
      actor_ref: null,
      correlation_id: null,
      visibility: "merchant_private",
      schema_version: "1",
      summary: {
        category: String(row["category"]),
        severity: String(row["severity"]),
      },
    }));
  }

  private engagementEvents(merchantId: string): WorkbenchTimelineEvent[] {
    const rows = this.safeAll(
      `SELECT event_id, buyer_principal_id, broadcast_id, event_type, occurred_at
       FROM merchant_broadcast_engagement WHERE merchant_id=?`,
      merchantId,
    );
    return rows.map((row) => ({
      event_id: `engagement:${String(row["event_id"])}`,
      event_type: `broadcast.${String(row["event_type"])}`,
      aggregate_id: String(row["broadcast_id"]),
      aggregate_version: null,
      occurred_at: String(row["occurred_at"]),
      actor_ref: String(row["buyer_principal_id"]),
      correlation_id: null,
      visibility: "merchant_private",
      schema_version: "1",
      summary: {},
    }));
  }

  private safeAll(sql: string, merchantId: string): Array<Record<string, unknown>> {
    try {
      return this.options.db.prepare(sql).all(merchantId) as Array<Record<string, unknown>>;
    } catch (error) {
      if (error instanceof Error && /no such table/u.test(error.message)) return [];
      throw error;
    }
  }

  private encodeCursor(merchantId: string, occurredAt: string, eventId: string): string {
    const payload = Buffer.from(
      JSON.stringify({ merchant_id: merchantId, occurred_at: occurredAt, event_id: eventId }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", this.options.cursorKey)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  private decodeCursor(
    merchantId: string,
    cursor: string,
  ): { occurredAt: string; eventId: string } {
    const [payload, signature, ...extra] = cursor.split(".");
    if (payload === undefined || signature === undefined || extra.length > 0) {
      throw new WorkbenchEventProjectionError("event cursor is invalid");
    }
    const expected = createHmac("sha256", this.options.cursorKey)
      .update(payload)
      .digest("base64url");
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new WorkbenchEventProjectionError("event cursor signature is invalid");
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new WorkbenchEventProjectionError("event cursor payload is invalid");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new WorkbenchEventProjectionError("event cursor payload is invalid");
    }
    const record = value as Record<string, unknown>;
    if (
      record["merchant_id"] !== merchantId ||
      typeof record["occurred_at"] !== "string" ||
      !Number.isFinite(Date.parse(record["occurred_at"])) ||
      typeof record["event_id"] !== "string" ||
      record["event_id"] === ""
    ) {
      throw new WorkbenchEventProjectionError("event cursor binding is invalid");
    }
    return { occurredAt: record["occurred_at"], eventId: record["event_id"] };
  }
}
