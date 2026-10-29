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
 * 订单事实持久化（v0.2 §11–§12 / §16）。
 *
 * 订单、行、事件、归因、退款分开存储；事件与退款按复合身份幂等。归因上限
 * 在写入前由 `allocateAttributions` 校验，数据库只保存已确认分配。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  allocateAttributions,
  mergeOrderEvent,
  mergeRefund,
  orderIdentityKey,
  refundTotalMinor,
  OrderFactError,
  type AttributionInput,
  type ExternalOrderIdentity,
  type OrderEvent,
  type OrderLineFact,
  type OrderStreamContract,
  type RefundFact,
  validateOrderLineFacts,
} from "./model.js";

export interface OrderRecordV2 {
  record_id: string;
  merchant_id: string;
  source_namespace: string;
  source_account_id: string;
  external_order_id: string;
  evidence_source: "manual_report" | "csv_import" | "external_verified";
  payment_status: string | null;
  fulfillment_status: string | null;
  refund_status: string | null;
  cancellation_status: string | null;
  currency: string | null;
  total_minor: number | null;
  source_version: string | null;
  observed_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OrderRow {
  record_id: string;
  merchant_id: string;
  source_namespace: string;
  source_account_id: string;
  external_order_id: string;
  evidence_source: "manual_report" | "csv_import" | "external_verified";
  payment_status: string | null;
  fulfillment_status: string | null;
  refund_status: string | null;
  cancellation_status: string | null;
  currency: string | null;
  total_minor: number | null;
  source_version: string | null;
  observed_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  event_id: string;
  record_id: string;
  external_event_id: string;
  dimension: OrderEvent["dimension"];
  source_version: string;
  occurred_at: string;
  observed_at: string;
  value: string;
  amount_minor: number | null;
  refund_id: string | null;
  raw_digest: string;
  created_at: string;
}

export interface OrderRepositoryOptions {
  db: DatabaseSync;
  now: () => string;
}

export class OrderRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private inTx = false;

  constructor(options: OrderRepositoryOptions) {
    this.db = options.db;
    this.now = options.now;
  }

  transaction<T>(work: () => T): T {
    if (this.inTx) return work();
    this.inTx = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  createOrder(input: {
    identity: ExternalOrderIdentity;
    evidenceSource: OrderRecordV2["evidence_source"];
    paymentStatus?: string;
    fulfillmentStatus?: string;
    refundStatus?: string;
    cancellationStatus?: string;
    currency?: string;
    totalMinor?: number;
    sourceVersion?: string;
    observedAt?: string;
    verifiedAt?: string;
    lines: OrderLineFact[];
  }): { order: OrderRecordV2; created: boolean } {
    const lines = validateOrderLineFacts(input.lines);
    return this.transaction(() => {
      const existing = this.findByIdentity(input.identity);
      if (existing !== undefined) return { order: existing, created: false };
      const recordId = `ord_${randomUUID()}`;
      const now = this.now();
      {
      this.db
        .prepare(
          `INSERT INTO order_records_v2
            (record_id, merchant_id, source_namespace, source_account_id, external_order_id,
             evidence_source, payment_status, fulfillment_status, refund_status, cancellation_status,
             currency, total_minor, source_version, observed_at, verified_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          recordId,
          input.identity.merchant_id,
          input.identity.source_namespace,
          input.identity.source_account_id,
          input.identity.external_order_id,
          input.evidenceSource,
          input.paymentStatus ?? null,
          input.fulfillmentStatus ?? null,
          input.refundStatus ?? null,
          input.cancellationStatus ?? null,
          input.currency ?? null,
          input.totalMinor ?? null,
          input.sourceVersion ?? null,
          input.observedAt ?? null,
          input.verifiedAt ?? null,
          now,
          now,
        );
      for (const line of lines) {
        this.db
          .prepare(
            `INSERT INTO order_lines_v2
              (record_id, line_id, sku, quantity, amount_minor, unit_price_minor)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(recordId, line.line_id, line.sku, line.quantity, line.amount_minor, null);
      }
      }
      return { order: this.getOrder(input.identity.merchant_id, recordId)!, created: true };
    });
  }

  findByIdentity(identity: ExternalOrderIdentity): OrderRecordV2 | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM order_records_v2
          WHERE merchant_id = ? AND source_namespace = ? AND source_account_id = ? AND external_order_id = ?`,
      )
      .get(
        identity.merchant_id,
        identity.source_namespace,
        identity.source_account_id,
        identity.external_order_id,
      ) as unknown as OrderRow | undefined;
    return row === undefined ? undefined : row;
  }

  getOrder(merchantId: string, recordId: string): OrderRecordV2 | undefined {
    const row = this.db
      .prepare("SELECT * FROM order_records_v2 WHERE merchant_id = ? AND record_id = ?")
      .get(merchantId, recordId) as unknown as OrderRow | undefined;
    return row === undefined ? undefined : row;
  }

  listOrders(merchantId: string): OrderRecordV2[] {
    return this.db
      .prepare("SELECT * FROM order_records_v2 WHERE merchant_id = ? ORDER BY observed_at DESC")
      .all(merchantId) as unknown as OrderRow[];
  }

  updateEvidence(merchantId: string, recordId: string, input: {
    evidenceSource?: OrderRecordV2["evidence_source"];
    verifiedAt?: string;
    sourceVersion?: string;
  }): OrderRecordV2 {
    const order = this.getOrder(merchantId, recordId);
    if (order === undefined) throw new OrderFactError("not_found", "order not found");
    this.db
      .prepare(
        `UPDATE order_records_v2
            SET evidence_source = ?, verified_at = ?, source_version = ?, updated_at = ?
          WHERE merchant_id = ? AND record_id = ?`,
      )
      .run(
        input.evidenceSource ?? order.evidence_source,
        input.verifiedAt ?? order.verified_at,
        input.sourceVersion ?? order.source_version,
        this.now(),
        merchantId,
        recordId,
      );
    return this.getOrder(merchantId, recordId)!;
  }

  listLines(recordId: string): OrderLineFact[] {
    return this.db
      .prepare(
        "SELECT line_id, sku, quantity, amount_minor FROM order_lines_v2 WHERE record_id = ? ORDER BY rowid",
      )
      .all(recordId) as unknown as OrderLineFact[];
  }

  /** 事件合并：同维度按契约比较；accepted 才写入。 */
  appendEvent(input: {
    merchantId: string;
    recordId: string;
    incoming: OrderEvent;
    contract: OrderStreamContract;
  }): { inserted: boolean; status: string } {
    const events = this.listEvents(input.recordId, input.incoming.dimension, input.incoming.identity);
    const current = events.length === 0 ? undefined : events[events.length - 1];
    const merge = mergeOrderEvent({
      ...(current !== undefined ? { current } : {}),
      incoming: input.incoming,
      contract: input.contract,
    });
    if (merge.status !== "accepted") return { inserted: false, status: merge.status };
    this.db
      .prepare(
        `INSERT INTO order_events_v2
          (event_id, record_id, external_event_id, dimension, source_version, occurred_at,
           observed_at, value, amount_minor, refund_id, raw_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.recordId,
        input.incoming.event_id,
        input.incoming.dimension,
        input.incoming.source_version,
        input.incoming.occurred_at,
        input.incoming.observed_at,
        input.incoming.value,
        input.incoming.amount_minor ?? null,
        input.incoming.refund_id ?? null,
        input.incoming.raw_digest,
        this.now(),
      );
    return { inserted: true, status: "accepted" };
  }

  listEvents(
    recordId: string,
    dimension?: OrderEvent["dimension"],
    identity?: ExternalOrderIdentity,
  ): OrderEvent[] {
    const where = ["record_id = ?"];
    const params: string[] = [recordId];
    if (dimension !== undefined) {
      where.push("dimension = ?");
      params.push(dimension);
    }
    const rows = this.db
      .prepare(`SELECT * FROM order_events_v2 WHERE ${where.join(" AND ")} ORDER BY rowid`)
      .all(...params) as unknown as EventRow[];
    return rows.map((row) => ({
      event_id: row.event_id,
      identity: identity ?? {
        merchant_id: "",
        source_namespace: "",
        source_account_id: "",
        external_order_id: "",
      },
      dimension: row.dimension,
      source_version: row.source_version,
      occurred_at: row.occurred_at,
      observed_at: row.observed_at,
      value: row.value,
      ...(row.amount_minor !== null ? { amount_minor: row.amount_minor } : {}),
      ...(row.refund_id !== null ? { refund_id: row.refund_id } : {}),
      raw_digest: row.raw_digest,
    }));
  }

  replaceAttributions(merchantId: string, recordId: string, allocations: AttributionInput[]): {
    allocations: AttributionInput[];
    unassigned: Array<{ line_id: string; quantity: number; amount_minor: number }>;
  } {
    if (this.getOrder(merchantId, recordId) === undefined) {
      throw new OrderFactError("not_found", `order ${recordId} not found`);
    }
    const lines = this.listLines(recordId);
    const result = allocateAttributions(lines, allocations);
    return this.transaction(() => {
      this.db.prepare("DELETE FROM order_attributions_v2 WHERE record_id = ?").run(recordId);
      for (const allocation of result.allocations) {
        this.db
          .prepare(
            `INSERT INTO order_attributions_v2
              (attribution_id, record_id, order_line_id, opportunity_id, quantity, amount_minor,
               method, confirmed_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            allocation.attribution_id,
            recordId,
            allocation.order_line_id,
            allocation.opportunity_id,
            allocation.quantity,
            allocation.amount_minor,
            allocation.method,
            allocation.confirmed_by ?? null,
            this.now(),
          );
      }
      return { allocations: result.allocations, unassigned: result.unassigned };
    });
  }

  listAttributions(recordId: string): AttributionInput[] {
    return this.db
      .prepare(
        "SELECT order_line_id, opportunity_id, quantity, amount_minor, method, confirmed_by FROM order_attributions_v2 WHERE record_id = ? ORDER BY rowid",
      )
      .all(recordId) as unknown as AttributionInput[];
  }

  mergeRefund(merchantId: string, recordId: string, incoming: RefundFact): {
    status: string;
    totalMinor: number;
  } {
    const current = this.listRefunds(merchantId, recordId);
    const merged = mergeRefund(current, incoming);
    if (merged.status === "inserted" || merged.status === "corrected") {
      const next = merged.refunds.find(
        (refund) =>
          refund.identity.external_refund_id === incoming.identity.external_refund_id,
      )!;
      this.db
        .prepare(
          `INSERT INTO refunds_v2
            (refund_row_id, merchant_id, record_id, source_namespace, source_account_id,
             external_order_id, external_refund_id, amount_minor, version, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (merchant_id, source_namespace, source_account_id, external_order_id, external_refund_id)
           DO UPDATE SET amount_minor = excluded.amount_minor, version = excluded.version,
                         status = excluded.status, updated_at = excluded.updated_at`,
        )
        .run(
          randomUUID(),
          merchantId,
          recordId,
          next.identity.source_namespace,
          next.identity.source_account_id,
          next.identity.external_order_id,
          next.identity.external_refund_id,
          next.amount_minor,
          next.version,
          next.status,
          this.now(),
        );
    }
    return {
      status: merged.status,
      totalMinor: refundTotalMinor(merged.refunds),
    };
  }

  listRefunds(merchantId: string, recordId: string): RefundFact[] {
    const rows = this.db
      .prepare(
        "SELECT source_namespace, source_account_id, external_order_id, external_refund_id, amount_minor, version, status FROM refunds_v2 WHERE merchant_id = ? AND record_id = ? ORDER BY rowid",
      )
      .all(merchantId, recordId) as unknown as Array<{
        source_namespace: string;
        source_account_id: string;
        external_order_id: string;
        external_refund_id: string;
        amount_minor: number;
        version: number;
        status: RefundFact["status"];
      }>;
    return rows.map((row) => ({
      identity: {
        merchant_id: merchantId,
        source_namespace: row.source_namespace,
        source_account_id: row.source_account_id,
        external_order_id: row.external_order_id,
        external_refund_id: row.external_refund_id,
      },
      amount_minor: row.amount_minor,
      version: row.version,
      status: row.status,
    }));
  }
}

export { orderIdentityKey };
