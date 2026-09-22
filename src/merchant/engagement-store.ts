/** Verified Buyer broadcast engagement facts with explicit metric separation. */

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { inImmediateTransaction } from "../merchant-core/storage/transaction.js";

export const ENGAGEMENT_EVENT_TYPES = ["received", "presented", "clicked"] as const;
export type EngagementEventType = (typeof ENGAGEMENT_EVENT_TYPES)[number];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_broadcast_engagement (
  event_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  buyer_principal_id TEXT NOT NULL,
  broadcast_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('received','presented','clicked')),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (merchant_id, buyer_principal_id, idempotency_key),
  UNIQUE (merchant_id, buyer_principal_id, broadcast_id, event_type)
);
`;

export class MerchantEngagementError extends Error {
  readonly code: "invalid_input" | "conflict" | "precondition_failed";
  constructor(code: MerchantEngagementError["code"], message: string) {
    super(message);
    this.name = "MerchantEngagementError";
    this.code = code;
  }
}

export class MerchantEngagementStore {
  constructor(private readonly options: { db: DatabaseSync; now?: () => string }) {
    options.db.exec("pragma busy_timeout=5000");
    options.db.exec(SCHEMA);
  }

  record(input: {
    merchantId: string;
    buyerPrincipalId: string;
    broadcastId: string;
    eventType: EngagementEventType;
    idempotencyKey: string;
    occurredAt: string;
  }): { event_id: string; replayed: boolean } {
    const merchantId = requireText(input.merchantId, "merchantId");
    const buyerId = requireText(input.buyerPrincipalId, "buyerPrincipalId");
    const broadcastId = requireText(input.broadcastId, "broadcastId");
    const key = requireText(input.idempotencyKey, "idempotencyKey");
    if (!ENGAGEMENT_EVENT_TYPES.includes(input.eventType)) {
      throw new MerchantEngagementError("invalid_input", "unknown engagement event type");
    }
    if (!Number.isFinite(Date.parse(input.occurredAt))) {
      throw new MerchantEngagementError("invalid_input", "occurred_at must be an ISO timestamp");
    }
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          merchant_id: merchantId,
          buyer_principal_id: buyerId,
          broadcast_id: broadcastId,
          event_type: input.eventType,
          occurred_at: input.occurredAt,
        }),
      )
      .digest("hex");
    return inImmediateTransaction(this.options.db, () => {
      const replay = this.options.db
        .prepare(
          `SELECT event_id, request_digest FROM merchant_broadcast_engagement
           WHERE merchant_id=? AND buyer_principal_id=? AND idempotency_key=?`,
        )
        .get(merchantId, buyerId, key) as { event_id: string; request_digest: string } | undefined;
      if (replay !== undefined) {
        if (replay.request_digest !== digest) {
          throw new MerchantEngagementError(
            "conflict",
            "idempotency key was reused for another engagement fact",
          );
        }
        // 早退在 fn 内 return：只读重放由 wrapper 提交空事务（与 rollback 等价）
        return { event_id: replay.event_id, replayed: true };
      }
      const requiredPrior =
        input.eventType === "presented"
          ? "received"
          : input.eventType === "clicked"
            ? "presented"
            : undefined;
      if (requiredPrior !== undefined) {
        const prior = this.options.db
          .prepare(
            `SELECT 1 present FROM merchant_broadcast_engagement
             WHERE merchant_id=? AND buyer_principal_id=? AND broadcast_id=? AND event_type=?`,
          )
          .get(merchantId, buyerId, broadcastId, requiredPrior) as { present: number } | undefined;
        if (prior === undefined) {
          throw new MerchantEngagementError(
            "precondition_failed",
            `${input.eventType} requires a prior ${requiredPrior} fact`,
          );
        }
      }
      const existing = this.options.db
        .prepare(
          `SELECT event_id FROM merchant_broadcast_engagement
           WHERE merchant_id=? AND buyer_principal_id=? AND broadcast_id=? AND event_type=?`,
        )
        .get(merchantId, buyerId, broadcastId, input.eventType) as { event_id: string } | undefined;
      if (existing !== undefined) {
        return { event_id: existing.event_id, replayed: true };
      }
      const eventId = `beg_${randomBytes(16).toString("base64url")}`;
      this.options.db
        .prepare(
          `INSERT INTO merchant_broadcast_engagement
           (event_id, merchant_id, buyer_principal_id, broadcast_id, event_type,
            idempotency_key, request_digest, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          merchantId,
          buyerId,
          broadcastId,
          input.eventType,
          key,
          digest,
          input.occurredAt,
          this.now(),
        );
      return { event_id: eventId, replayed: false };
    });
  }

  summary(merchantId: string): {
    received: number;
    presented: number;
    clicked: number;
  } {
    const rows = this.options.db
      .prepare(
        `SELECT event_type, count(*) count FROM merchant_broadcast_engagement
         WHERE merchant_id=? GROUP BY event_type`,
      )
      .all(merchantId) as Array<{ event_type: EngagementEventType; count: number }>;
    return {
      received: rows.find((row) => row.event_type === "received")?.count ?? 0,
      presented: rows.find((row) => row.event_type === "presented")?.count ?? 0,
      clicked: rows.find((row) => row.event_type === "clicked")?.count ?? 0,
    };
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function requireText(value: string, field: string): string {
  const text = String(value ?? "").trim();
  if (text === "") throw new MerchantEngagementError("invalid_input", `${field} is required`);
  return text;
}
