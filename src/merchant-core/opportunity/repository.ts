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
 * 机会/来源/需求持久化（v0.2 §6.1 / §6.3 / §16）。
 *
 * 写操作使用 `BEGIN IMMEDIATE`；外部事件按 (source_id, external_event_id)
 * 幂等，来源记录按 (merchant, namespace, account, external_inquiry_id) 幂等。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { contentDigest } from "../../negotiation/jcs.js";
import {
  OpportunityError,
  type OpportunityLink,
  type OpportunitySource,
  type OpportunitySourceEvent,
  type OpportunityStatus,
  type RequirementField,
  type RequirementSnapshot,
  type SalesOpportunity,
} from "./types.js";

export interface OpportunityRepositoryOptions {
  db: DatabaseSync;
  now: () => string;
}

interface SourceRow {
  source_id: string;
  merchant_id: string;
  source_namespace: string;
  source_account_id: string;
  external_inquiry_id: string;
  raw_excerpt: string;
  received_at: string;
  operator: string;
  parse_version: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface SourceEventRow {
  event_id: string;
  source_id: string;
  external_event_id: string;
  event_kind: string;
  payload_digest: string;
  received_at: string;
  created_at: string;
}

interface OpportunityRow {
  opportunity_id: string;
  merchant_id: string;
  status: OpportunityStatus;
  owner: string;
  next_action: string | null;
  next_action_due_at: string | null;
  waiting_reason: string | null;
  rfq_case_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface LinkRow {
  link_id: string;
  merchant_id: string;
  opportunity_id: string;
  source_id: string;
  status: "LINKED" | "UNLINKED";
  basis: string;
  confirmed_by: string;
  confirmed_at: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface RequirementRow {
  opportunity_id: string;
  revision: number;
  merchant_id: string;
  fields_json: string;
  created_at: string;
  created_by: string;
}

function sourceToRow(row: SourceRow): OpportunitySource {
  return { ...row };
}

function eventToRow(row: SourceEventRow): OpportunitySourceEvent {
  return { ...row };
}

function opportunityToRow(row: OpportunityRow): SalesOpportunity {
  return { ...row };
}

function linkToRow(row: LinkRow): OpportunityLink {
  return { ...row };
}

function requirementToRow(row: RequirementRow): RequirementSnapshot {
  return {
    opportunity_id: row.opportunity_id,
    revision: row.revision,
    fields: JSON.parse(row.fields_json) as RequirementField[],
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

export class OpportunityRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private inTx = false;

  constructor(options: OpportunityRepositoryOptions) {
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

  getSourceByExternalId(input: {
    merchantId: string;
    sourceNamespace: string;
    sourceAccountId: string;
    externalInquiryId: string;
  }): OpportunitySource | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM opportunity_sources
          WHERE merchant_id = ? AND source_namespace = ? AND source_account_id = ? AND external_inquiry_id = ?`,
      )
      .get(input.merchantId, input.sourceNamespace, input.sourceAccountId, input.externalInquiryId) as
      | SourceRow
      | undefined;
    return row === undefined ? undefined : sourceToRow(row);
  }

  getSource(merchantId: string, sourceId: string): OpportunitySource | undefined {
    const row = this.db
      .prepare("SELECT * FROM opportunity_sources WHERE merchant_id = ? AND source_id = ?")
      .get(merchantId, sourceId) as SourceRow | undefined;
    return row === undefined ? undefined : sourceToRow(row);
  }

  insertSource(input: Omit<OpportunitySource, "source_id" | "revision" | "created_at" | "updated_at">): OpportunitySource {
    const sourceId = `src_${randomUUID()}`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO opportunity_sources
          (source_id, merchant_id, source_namespace, source_account_id, external_inquiry_id,
           raw_excerpt, received_at, operator, parse_version, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        sourceId,
        input.merchant_id,
        input.source_namespace,
        input.source_account_id,
        input.external_inquiry_id,
        input.raw_excerpt,
        input.received_at,
        input.operator,
        input.parse_version,
        now,
        now,
      );
    return this.getSource(input.merchant_id, sourceId)!;
  }

  touchSource(merchantId: string, sourceId: string): OpportunitySource {
    this.db
      .prepare(
        "UPDATE opportunity_sources SET revision = revision + 1, updated_at = ? WHERE merchant_id = ? AND source_id = ?",
      )
      .run(this.now(), merchantId, sourceId);
    return this.getSource(merchantId, sourceId)!;
  }

  getSourceEvent(sourceId: string, externalEventId: string): OpportunitySourceEvent | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM opportunity_source_events WHERE source_id = ? AND external_event_id = ?",
      )
      .get(sourceId, externalEventId) as SourceEventRow | undefined;
    return row === undefined ? undefined : eventToRow(row);
  }

  insertSourceEvent(input: {
    sourceId: string;
    externalEventId: string;
    eventKind: string;
    payload: unknown;
    receivedAt: string;
  }): OpportunitySourceEvent {
    const eventId = `evt_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO opportunity_source_events
          (event_id, source_id, external_event_id, event_kind, payload_digest, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.sourceId,
        input.externalEventId,
        input.eventKind,
        contentDigest(input.payload ?? {}),
        input.receivedAt,
        this.now(),
      );
    const row = this.db
      .prepare("SELECT * FROM opportunity_source_events WHERE event_id = ?")
      .get(eventId) as unknown as SourceEventRow;
    return eventToRow(row);
  }

  getOpportunity(merchantId: string, opportunityId: string): SalesOpportunity | undefined {
    const row = this.db
      .prepare("SELECT * FROM sales_opportunities WHERE merchant_id = ? AND opportunity_id = ?")
      .get(merchantId, opportunityId) as OpportunityRow | undefined;
    return row === undefined ? undefined : opportunityToRow(row);
  }

  listOpportunities(
    merchantId: string,
    filter: { status?: OpportunityStatus; owner?: string } = {},
  ): SalesOpportunity[] {
    const where = ["merchant_id = ?"];
    const params: string[] = [merchantId];
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.owner !== undefined) {
      where.push("owner = ?");
      params.push(filter.owner);
    }
    const rows = this.db
      .prepare(`SELECT * FROM sales_opportunities WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`)
      .all(...params) as unknown as OpportunityRow[];
    return rows.map(opportunityToRow);
  }

  insertOpportunity(input: {
    merchantId: string;
    status: OpportunityStatus;
    owner: string;
    nextAction?: string;
    nextActionDueAt?: string;
    waitingReason?: string;
    rfqCaseId?: string;
  }): SalesOpportunity {
    const opportunityId = `opp_${randomUUID()}`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO sales_opportunities
          (opportunity_id, merchant_id, status, owner, next_action, next_action_due_at,
           waiting_reason, rfq_case_id, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        opportunityId,
        input.merchantId,
        input.status,
        input.owner,
        input.nextAction ?? null,
        input.nextActionDueAt ?? null,
        input.waitingReason ?? null,
        input.rfqCaseId ?? null,
        now,
        now,
      );
    return this.getOpportunity(input.merchantId, opportunityId)!;
  }

  updateOpportunity(input: {
    merchantId: string;
    opportunityId: string;
    expectedRevision: number;
    status: OpportunityStatus;
    owner?: string;
    nextAction?: string | null;
    nextActionDueAt?: string | null;
    waitingReason?: string | null;
  }): SalesOpportunity {
    const current = this.getOpportunity(input.merchantId, input.opportunityId);
    if (current === undefined) {
      throw new OpportunityError("not_found", `opportunity ${input.opportunityId} not found`);
    }
    const result = this.db
      .prepare(
        `UPDATE sales_opportunities
            SET status = ?, owner = ?, next_action = ?, next_action_due_at = ?, waiting_reason = ?,
                revision = ?, updated_at = ?
          WHERE merchant_id = ? AND opportunity_id = ? AND revision = ?`,
      )
      .run(
        input.status,
        input.owner ?? current.owner,
        input.nextAction !== undefined ? input.nextAction : current.next_action,
        input.nextActionDueAt !== undefined ? input.nextActionDueAt : current.next_action_due_at,
        input.waitingReason !== undefined ? input.waitingReason : current.waiting_reason,
        current.revision + 1,
        this.now(),
        input.merchantId,
        input.opportunityId,
        input.expectedRevision,
      );
    if (Number(result.changes) !== 1) {
      throw new OpportunityError("version_conflict", "机会已被其他操作修改，请刷新后重试");
    }
    return this.getOpportunity(input.merchantId, input.opportunityId)!;
  }

  getLinkBySource(sourceId: string): OpportunityLink | undefined {
    const row = this.db
      .prepare("SELECT * FROM opportunity_links WHERE source_id = ?")
      .get(sourceId) as LinkRow | undefined;
    return row === undefined ? undefined : linkToRow(row);
  }

  insertLink(input: {
    merchantId: string;
    opportunityId: string;
    sourceId: string;
    basis: string;
    confirmedBy: string;
    confirmedAt: string;
  }): OpportunityLink {
    const linkId = `lnk_${randomUUID()}`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO opportunity_links
          (link_id, merchant_id, opportunity_id, source_id, status, basis, confirmed_by,
           confirmed_at, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'LINKED', ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        linkId,
        input.merchantId,
        input.opportunityId,
        input.sourceId,
        input.basis,
        input.confirmedBy,
        input.confirmedAt,
        now,
        now,
      );
    return this.getLink(linkId)!;
  }

  getLink(linkId: string): OpportunityLink | undefined {
    const row = this.db
      .prepare("SELECT * FROM opportunity_links WHERE link_id = ?")
      .get(linkId) as LinkRow | undefined;
    return row === undefined ? undefined : linkToRow(row);
  }

  updateLink(input: {
    linkId: string;
    merchantId: string;
    expectedRevision: number;
    opportunityId: string;
    status: "LINKED" | "UNLINKED";
    basis: string;
    confirmedBy: string;
    confirmedAt: string;
  }): OpportunityLink {
    const result = this.db
      .prepare(
        `UPDATE opportunity_links
            SET opportunity_id = ?, status = ?, basis = ?, confirmed_by = ?, confirmed_at = ?,
                revision = revision + 1, updated_at = ?
          WHERE link_id = ? AND merchant_id = ? AND revision = ?`,
      )
      .run(
        input.opportunityId,
        input.status,
        input.basis,
        input.confirmedBy,
        input.confirmedAt,
        this.now(),
        input.linkId,
        input.merchantId,
        input.expectedRevision,
      );
    if (Number(result.changes) !== 1) {
      throw new OpportunityError("version_conflict", "来源关联已被其他操作修改，请刷新后重试");
    }
    return this.getLink(input.linkId)!;
  }

  appendLinkEvent(input: {
    merchantId: string;
    linkId: string;
    opportunityId: string;
    sourceId: string;
    event: string;
    actor: string;
    basis: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO opportunity_link_events
          (merchant_id, link_id, opportunity_id, source_id, event, actor, basis, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.merchantId,
        input.linkId,
        input.opportunityId,
        input.sourceId,
        input.event,
        input.actor,
        input.basis,
        this.now(),
      );
  }

  getLatestRequirement(merchantId: string, opportunityId: string): RequirementSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM opportunity_requirements
          WHERE merchant_id = ? AND opportunity_id = ?
          ORDER BY revision DESC LIMIT 1`,
      )
      .get(merchantId, opportunityId) as RequirementRow | undefined;
    return row === undefined ? undefined : requirementToRow(row);
  }

  insertRequirement(input: {
    merchantId: string;
    opportunityId: string;
    revision: number;
    fields: RequirementField[];
    createdBy: string;
  }): RequirementSnapshot {
    this.db
      .prepare(
        `INSERT INTO opportunity_requirements
          (opportunity_id, revision, merchant_id, fields_json, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.opportunityId,
        input.revision,
        input.merchantId,
        JSON.stringify(input.fields),
        this.now(),
        input.createdBy,
      );
    return this.getLatestRequirement(input.merchantId, input.opportunityId)!;
  }

  appendOpportunityEvent(input: {
    merchantId: string;
    opportunityId: string;
    event: string;
    fromStatus: OpportunityStatus;
    toStatus: OpportunityStatus;
    actor: string;
    sideEffects: string[];
    detail: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO opportunity_events
          (opportunity_id, merchant_id, event, from_status, to_status, actor,
           side_effects_json, detail_json, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.opportunityId,
        input.merchantId,
        input.event,
        input.fromStatus,
        input.toStatus,
        input.actor,
        JSON.stringify(input.sideEffects),
        JSON.stringify(input.detail),
        this.now(),
      );
  }

  readIdempotent(merchantId: string, key: string): { operation: string; requestDigest: string; result: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT operation, request_digest, result_json FROM merchant_command_idempotency WHERE merchant_id = ? AND idempotency_key = ?",
      )
      .get(merchantId, key) as { operation: string; request_digest: string; result_json: string } | undefined;
    return row === undefined
      ? undefined
      : { operation: row.operation, requestDigest: row.request_digest, result: row.result_json };
  }

  saveIdempotent(input: {
    merchantId: string;
    key: string;
    operation: string;
    request: unknown;
    result: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO merchant_command_idempotency
          (merchant_id, idempotency_key, operation, request_digest, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.merchantId,
        input.key,
        input.operation,
        contentDigest({ operation: input.operation, request: input.request }),
        JSON.stringify(input.result),
        this.now(),
      );
  }
}
