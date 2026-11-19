/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * P1 客户通知的持久化（设计 §16.3 / M6-2）。
 *
 * 唯一发送真相是 `followup_outbox`：本模块只把已冻结的 DeliveryRecord 映射
 * 到该表，不另建第二份队列表。领取/回执通过 `inImmediateTransaction` 与
 * dispatcher 组合，保证同一 stream 的单流在途约束。
 */

import { deliveryAttemptDigest, type DeliveryEvidence } from "./reconciliation.js";
import type { DatabaseSync } from "node:sqlite";

import { inImmediateTransaction } from "../storage/transaction.js";
import { DeliveryGateError, type DeliveryStatus } from "./types.js";
import type { DeliveryRecord, DeliveryStore } from "./dispatcher.js";

interface OutboxRow {
  outbox_id: string;
  task_id: string;
  merchant_id: string;
  stream_key: string | null;
  seq: number | null;
  payload_json: string;
  payload_digest: string | null;
  valid_until: string | null;
  binding_id: string | null;
  binding_epoch: number | null;
  subscription_id: string | null;
  subscription_epoch: number | null;
  purpose: string | null;
  channel: string | null;
  source_grants_json: string | null;
  status: DeliveryStatus;
  provider_request_id: string | null;
  receipt_json: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
  accepted_at: string | null;
  read_at: string | null;
  read_evidence_ref: string | null;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: OutboxRow): DeliveryRecord | undefined {
  // 旧 followup_outbox 行没有 M6 扩展字段；它们不是 P1 通知，忽略。
  if (
    row.stream_key === null ||
    row.binding_id === null ||
    row.binding_epoch === null ||
    row.subscription_id === null ||
    row.subscription_epoch === null ||
    row.purpose === null ||
    row.channel === null ||
    row.payload_digest === null ||
    row.valid_until === null ||
    row.seq === null
  ) {
    return undefined;
  }
  return {
    delivery_id: row.outbox_id,
    merchant_id: row.merchant_id,
    stream_key: row.stream_key,
    binding_id: row.binding_id,
    binding_epoch: row.binding_epoch,
    channel: row.channel as DeliveryRecord["channel"],
    purpose: row.purpose as DeliveryRecord["purpose"],
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    payload_digest: row.payload_digest,
    seq: row.seq,
    valid_until: row.valid_until,
    subscription_id: row.subscription_id,
    subscription_epoch: row.subscription_epoch,
    source_grants: row.source_grants_json === null ? [] : (JSON.parse(row.source_grants_json) as DeliveryRecord["source_grants"]),
    created_at: row.created_at,
    status: row.status,
    ...(row.lease_owner !== null ? { lease_owner: row.lease_owner } : {}),
    ...(row.lease_expires_at !== null ? { lease_expires_at: row.lease_expires_at } : {}),
    ...(row.started_at !== null ? { started_at: row.started_at } : {}),
    attempts: row.attempts,
    ...(row.next_attempt_at !== null ? { next_attempt_at: row.next_attempt_at } : {}),
    ...(row.provider_request_id !== null ? { provider_request_id: row.provider_request_id } : {}),
    ...(row.receipt_json !== null
      ? { receipt: JSON.parse(row.receipt_json) as Record<string, unknown> }
      : {}),
    ...(row.accepted_at !== null ? { accepted_at: row.accepted_at } : {}),
    ...(row.read_at !== null ? { read_at: row.read_at } : {}),
    ...(row.read_evidence_ref !== null ? { read_evidence_ref: row.read_evidence_ref } : {}),
    ...(row.blocked_reason !== null ? { blocked_reason: row.blocked_reason } : {}),
  };
}

const DELIVERY_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS customer_delivery_reconciliation_audit (
  id INTEGER PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  attempt_digest TEXT NOT NULL,
  outcome TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  reconciled_at TEXT NOT NULL,
  UNIQUE (merchant_id, delivery_id, attempt_digest)
);
`;

export class CustomerDeliveryRepository implements DeliveryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now: () => string }) {
    this.db = options.db;
    this.now = options.now;
  }

  /** 插入已冻结的 PENDING 通知；delivery_id 即 outbox_id。 */
  insert(record: DeliveryRecord, taskId: string): void {
    if (record.status !== "PENDING") {
      throw new DeliveryGateError("invalid_transition", "只有 PENDING 通知可以入队");
    }
    this.db
      .prepare(
        `INSERT INTO followup_outbox
          (outbox_id, task_id, merchant_id, payload_json, status, created_at, updated_at,
           stream_key, seq, payload_digest, valid_until, binding_id, binding_epoch,
           subscription_id, subscription_epoch, purpose, channel, source_grants_json,
           lease_owner, lease_expires_at, started_at, accepted_at, read_at,
           read_evidence_ref, blocked_reason, provider_request_id, receipt_json,
           attempts, next_attempt_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.delivery_id,
        taskId,
        record.merchant_id,
        JSON.stringify(record.payload),
        record.created_at,
        this.now(),
        record.stream_key,
        record.seq,
        record.payload_digest,
        record.valid_until,
        record.binding_id,
        record.binding_epoch,
        record.subscription_id,
        record.subscription_epoch,
        record.purpose,
        record.channel,
        JSON.stringify(record.source_grants),
        record.lease_owner ?? null,
        record.lease_expires_at ?? null,
        record.started_at ?? null,
        record.accepted_at ?? null,
        record.read_at ?? null,
        record.read_evidence_ref ?? null,
        record.blocked_reason ?? null,
        record.provider_request_id ?? null,
        record.receipt !== undefined ? JSON.stringify(record.receipt) : null,
        record.attempts ?? 0,
        record.next_attempt_at ?? null,
      );
  }

  get(merchantId: string, deliveryId: string): DeliveryRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM followup_outbox WHERE merchant_id = ? AND outbox_id = ?")
      .get(merchantId, deliveryId) as unknown as OutboxRow | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  findBlocking(
    merchantId: string,
    streamKey: string,
    deliveryId: string,
  ): DeliveryRecord | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM followup_outbox
          WHERE merchant_id = ? AND stream_key = ? AND outbox_id != ?
            AND (status = 'UNKNOWN' OR (status = 'PENDING' AND started_at IS NOT NULL))`,
      )
      .all(merchantId, streamKey, deliveryId) as unknown as OutboxRow[];
    for (const row of rows) {
      const record = rowToRecord(row);
      if (record !== undefined) return record;
    }
    return undefined;
  }

  save(record: DeliveryRecord): void {
    const result = this.db
      .prepare(
        `UPDATE followup_outbox SET
           status = ?, payload_json = ?, payload_digest = ?, valid_until = ?,
           lease_owner = ?, lease_expires_at = ?, started_at = ?, accepted_at = ?,
           read_at = ?, read_evidence_ref = ?, blocked_reason = ?,
           provider_request_id = ?, receipt_json = ?, attempts = ?,
           next_attempt_at = ?, updated_at = ?
         WHERE merchant_id = ? AND outbox_id = ?`,
      )
      .run(
        record.status,
        JSON.stringify(record.payload),
        record.payload_digest,
        record.valid_until,
        record.lease_owner ?? null,
        record.lease_expires_at ?? null,
        record.started_at ?? null,
        record.accepted_at ?? null,
        record.read_at ?? null,
        record.read_evidence_ref ?? null,
        record.blocked_reason ?? null,
        record.provider_request_id ?? null,
        record.receipt !== undefined ? JSON.stringify(record.receipt) : null,
        record.attempts ?? 0,
        record.next_attempt_at ?? null,
        this.now(),
        record.merchant_id,
        record.delivery_id,
      );
    if (Number(result.changes) !== 1) {
      throw new DeliveryGateError("invalid_transition", "通知不存在或已删除");
    }
  }

  /** A vanished worker may have reached the channel before recording the result. */
  recoverExpiredClaims(merchantId: string, now: string): number {
    const result = this.db
      .prepare(
        `UPDATE followup_outbox
           SET status = 'UNKNOWN', lease_owner = NULL, lease_expires_at = NULL,
               blocked_reason = 'send_lease_expired', updated_at = ?
         WHERE merchant_id = ? AND status = 'PENDING' AND stream_key IS NOT NULL
           AND (started_at IS NOT NULL OR lease_owner IS NOT NULL)
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(now, merchantId, now);
    return Number(result.changes);
  }

  /** Settle only the exact attempt inspected by the trusted evidence source. */
  reconcileUnknown(snapshot: DeliveryRecord, evidence: DeliveryEvidence): boolean {
    return this.inTransaction(() => {
      const current = this.get(snapshot.merchant_id, snapshot.delivery_id);
      const digest = deliveryAttemptDigest(snapshot);
      if (current?.status !== "UNKNOWN" || current.started_at === undefined ||
          deliveryAttemptDigest(current) !== digest ||
          !/^[A-Za-z0-9_.:/-]{1,180}$/.test(evidence.evidence_ref)) return false;
      const now = this.now();
      if (evidence.outcome === "accepted" &&
          !(Date.parse(evidence.accepted_at) >= Date.parse(current.started_at) &&
            Date.parse(evidence.accepted_at) <= Date.parse(now))) return false;
      if (evidence.outcome === "not_sent" && evidence.future_execution_blocked !== true) return false;
      this.db.exec(DELIVERY_AUDIT_SCHEMA);
      this.db.prepare(
        `INSERT INTO customer_delivery_reconciliation_audit
         (merchant_id, delivery_id, attempt_digest, outcome, actor_id, evidence_ref, reconciled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(current.merchant_id, current.delivery_id, digest, evidence.outcome, "service:delivery-evidence", evidence.evidence_ref, now);
      this.save({
        ...current,
        lease_owner: undefined, lease_expires_at: undefined,
        ...(evidence.outcome === "accepted"
          ? { status: "SENT", accepted_at: evidence.accepted_at, blocked_reason: undefined }
          // PENDING is a legacy storage enum; the deadline makes this row permanently ineligible.
          : { status: "PENDING", started_at: undefined, next_attempt_at: current.valid_until,
            blocked_reason: "reconciled_not_sent_no_retry" }),
      });
      return true;
    });
  }

  listReconciliationAudit(merchantId: string): Record<string, unknown>[] {
    if (this.db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'customer_delivery_reconciliation_audit'",
    ).get() === undefined) return [];
    return this.db.prepare(
      `SELECT delivery_id, attempt_digest, outcome, actor_id, evidence_ref, reconciled_at
       FROM customer_delivery_reconciliation_audit WHERE merchant_id = ? ORDER BY id DESC LIMIT 100`,
    ).all(merchantId);
  }

  /** dispatcher 扫描：PENDING、未过期、尚未领取、已过重试退避。 */
  listDue(merchantId: string, now: string, limit = 20): DeliveryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM followup_outbox
          WHERE merchant_id = ? AND status = 'PENDING' AND valid_until > ?
            AND started_at IS NULL AND lease_owner IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY seq ASC, created_at ASC
          LIMIT ?`,
      )
      .all(merchantId, now, now, limit) as unknown as OutboxRow[];
    return rows.map((row) => rowToRecord(row)).filter((row): row is DeliveryRecord => row !== undefined);
  }

  /** 当日（UTC 日）同一订阅已 accepted 的发送数；频控复核用。 */
  countSentToday(merchantId: string, subscriptionId: string, now: string): number {
    const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM followup_outbox
          WHERE merchant_id = ? AND subscription_id = ? AND status = 'SENT'
            AND accepted_at >= ?`,
      )
      .get(merchantId, subscriptionId, dayStart) as { n: number };
    return Number(row.n);
  }

  countUnknown(merchantId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM followup_outbox WHERE merchant_id = ? AND status = 'UNKNOWN' AND stream_key IS NOT NULL",
    ).get(merchantId) as { n: number };
    return row.n;
  }

  /** 运营核对：列出指定状态的投递记录（默认 UNKNOWN）。 */
  listByStatus(merchantId: string, status: DeliveryStatus, limit = 50, offset = 0): DeliveryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM followup_outbox
          WHERE merchant_id = ? AND status = ? AND stream_key IS NOT NULL
          ORDER BY created_at ASC, outbox_id ASC LIMIT ? OFFSET ?`,
      )
      .all(merchantId, status, limit, offset) as unknown as OutboxRow[];
    return rows.map((row) => rowToRecord(row)).filter((row): row is DeliveryRecord => row !== undefined);
  }

  /** 在 IMMEDIATE 事务内执行领取/回执组合，确保单流约束与写入原子。 */
  inTransaction<T>(fn: () => T): T {
    return inImmediateTransaction(this.db, fn);
  }

  /** DeliveryStore.transaction：dispatcher 在领取时使用。 */
  transaction<T>(fn: () => T): T {
    return this.inTransaction(fn);
  }
}
