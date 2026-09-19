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
 * RFQ 持久化（设计 v0.1.1 §10.1/§10.2/§10.3）。
 *
 *   - 表结构为迁移 MIGRATION_8（src/agent/memory/schema.ts，编号迁移 +
 *     schema_version）；本层只读写，不建表。
 *   - 单商家单 owner 写（与审批候选同一 state.sqlite）；跨商家读取一律
 *     fail-closed（TENANT_MISMATCH，不泄露对象存在性）。
 *   - 状态转移用条件 UPDATE（CAS）串行化：只有一个调用方能完成转移，
 *     并发失败返回 version_conflict / approval_stale。
 *   - 幂等：merchant+principal+operation+key 唯一；同键同请求摘要重放
 *     同一结果，同键不同摘要 IDEMPOTENCY_CONFLICT（摘要 = rfq-canonical-json-v1）。
 */

import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  rfqContentDigest,
  RfqError,
  type QuoteEventKind,
  type QuoteStatus,
  type RfqBlocker,
  type RfqCaseFields,
  type RfqStage,
} from "./types.js";

export const RFQ_SCHEMA_VERSION = 8;

export interface RfqCaseRow {
  case_id: string;
  merchant_id: string;
  current_revision: number;
  current_quote_id: string | null;
  current_quote_revision: number | null;
  stage: RfqStage;
  /** 乐观锁计数（expected_revision CAS）。 */
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RfqCaseRevisionRow {
  case_id: string;
  revision: number;
  fields: RfqCaseFields;
  blockers: RfqBlocker[];
  source_ids: string[];
  created_at: string;
}

export interface RfqSourceRow {
  source_id: string;
  case_id: string;
  merchant_id: string;
  kind: string;
  content_sha256: string;
  content: string;
  received_at: string;
  submitted_by: string;
  synthetic: boolean;
}

export interface RfqQuoteRow {
  quote_id: string;
  revision: number;
  case_id: string;
  case_revision: number;
  merchant_id: string;
  snapshot_id: string;
  fact_fingerprint: string;
  pricing_input_json: string;
  pricing_output_json: string;
  projection_json: string;
  content_digest: string;
  policy_version: string;
  valid_until: string;
  status: QuoteStatus;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface RfqQuoteEventRow {
  event_id: string;
  quote_id: string;
  revision: number;
  event: QuoteEventKind;
  actor: string;
  reason: string | null;
  at: string;
}

export interface RfqReleaseRow {
  release_id: string;
  merchant_id: string;
  quote_id: string;
  quote_revision: number;
  candidate_id: string;
  artifact_id: string;
  artifact_sha256: string;
  public_projection_digest: string;
  recipient_ref: string;
  policy_version: string;
  fact_fingerprint: string;
  status: "PENDING_APPROVAL" | "APPROVED" | "EXPORTED" | "REJECTED" | "SUPERSEDED" | "EXPIRED";
  created_at: string;
  updated_at: string;
}

export interface RfqArtifactRow {
  artifact_id: string;
  merchant_id: string;
  quote_id: string;
  quote_revision: number;
  content_sha256: string;
  template_version: string;
  content_type: string;
  /** 私有产物目录内相对路径；下载时服务端映射（绝不接受模型传路径）。 */
  relative_path: string;
  activated: boolean;
  created_at: string;
}

export interface RfqDeliveryRow {
  delivery_id: string;
  merchant_id: string;
  quote_id: string;
  quote_revision: number;
  release_id: string | null;
  status: "NOT_SENT" | "REPORTED_SENT" | "RECEIPT_VERIFIED" | "DELIVERY_UNKNOWN";
  channel: string;
  evidence_ref: string;
  recorded_by: string;
  recorded_at: string;
}

export interface RfqHandoffRow {
  handoff_id: string;
  merchant_id: string;
  quote_id: string;
  quote_revision: number;
  origin_kind: "manual_quote" | "knp_agreement";
  target_ref: string;
  intent_evidence_ref: string;
  packet_digest: string;
  packet_json: string;
  status: "PACKET_READY" | "OWNER_RECORDED" | "TARGET_VERIFIED" | "REJECTED" | "UNKNOWN";
  receipt_json: string | null;
  recorded_by: string;
  created_at: string;
  updated_at: string;
}

export interface RfqJobRow {
  job_id: string;
  merchant_id: string;
  operation: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "UNKNOWN";
  progress: number;
  checkpoint_json: string | null;
  error_code: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface RfqRepositoryDeps {
  db: DatabaseSync;
  merchantId: string;
  now: () => string;
}

function nowIsoOrThrow(value: unknown, name: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new RfqError("validation", `${name} 必须是 RFC 3339 时间戳`);
  }
  return value;
}

export class RfqRepository {
  private readonly db: DatabaseSync;
  readonly merchantId: string;
  private readonly now: () => string;

  constructor(deps: RfqRepositoryDeps) {
    this.db = deps.db;
    this.merchantId = deps.merchantId;
    this.now = deps.now;
  }

  private inTx = false;

  /** 事务执行（可重入：内层调用加入外层事务——内层失败抛错由外层统一回滚）。 */
  private tx<T>(work: () => T): T {
    if (this.inTx) return work();
    this.inTx = true;
    this.db.exec("BEGIN");
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

  private id(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }

  // ---- 审计 ---------------------------------------------------------------

  appendAudit(input: { actor: string; operation: string; objectDigest: string; result: string; traceId: string }): void {
    this.db
      .prepare(
        "INSERT INTO rfq_audit_events (at, actor, operation, object_digest, result, trace_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(this.now(), input.actor, input.operation, input.objectDigest, input.result, input.traceId);
  }

  // ---- Case 与需求 revision ----------------------------------------------

  createCase(): RfqCaseRow {
    const caseId = this.id("rfqcase");
    const now = this.now();
    return this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO rfq_cases (case_id, merchant_id, current_revision, stage, version, created_at, updated_at) VALUES (?, ?, 0, 'NEW', 1, ?, ?)",
        )
        .run(caseId, this.merchantId, now, now);
      return this.getCase(caseId) as RfqCaseRow;
    });
  }

  listCases(limit: number): RfqCaseRow[] {
    const rows = this.db
      .prepare("SELECT case_id FROM rfq_cases WHERE merchant_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(this.merchantId, limit) as unknown as { case_id: string }[];
    return rows.map((r) => this.getCase(r.case_id) as RfqCaseRow);
  }

  getCase(caseId: string): RfqCaseRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM rfq_cases WHERE case_id = ? AND merchant_id = ?")
      .get(caseId, this.merchantId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      case_id: String(row.case_id),
      merchant_id: String(row.merchant_id),
      current_revision: Number(row.current_revision),
      current_quote_id: row.current_quote_id === null ? null : String(row.current_quote_id),
      current_quote_revision: row.current_quote_revision === null ? null : Number(row.current_quote_revision),
      stage: String(row.stage) as RfqStage,
      version: Number(row.version),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  /** 期望版本 CAS 推进（任何关键变更都必须带 expected_revision）。 */
  assertCaseVersion(caseId: string, expectedVersion: number): RfqCaseRow {
    const current = this.getCase(caseId);
    if (current === undefined) {
      throw new RfqError("not_found", `未知询盘 ${caseId}`);
    }
    if (current.version !== expectedVersion) {
      throw new RfqError("version_conflict", `询盘 ${caseId} 已变化（version ${current.version} ≠ 期望 ${expectedVersion}）`);
    }
    return current;
  }

  /** 新需求 revision：单调递增；stage 按 current_revision 重算（v0.1.1 §8.1）。 */
  createCaseRevision(input: {
    caseId: string;
    expectedVersion: number;
    fields: RfqCaseFields;
    blockers: RfqBlocker[];
    sourceIds: string[];
    quoteId?: string | null;
    quoteRevision?: number | null;
  }): { case: RfqCaseRow; revision: RfqCaseRevisionRow } {
    return this.tx(() => {
      const current = this.assertCaseVersion(input.caseId, input.expectedVersion);
      const revisionNo = current.current_revision + 1;
      const now = this.now();
      this.db
        .prepare(
          "INSERT INTO rfq_case_revisions (case_id, revision, fields_json, source_ids_json, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          input.caseId,
          revisionNo,
          canonicalJson(input.fields),
          canonicalJson(input.sourceIds),
          now,
        );
      const stage: RfqStage = input.blockers.length === 0 ? "READY" : "NEEDS_CLARIFICATION";
      // stage 判定对象始终是 current_revision；不继承旧 revision 的 READY/PRICED。
      this.db
        .prepare(
          "UPDATE rfq_cases SET current_revision = ?, current_quote_id = ?, current_quote_revision = ?, stage = ?, version = version + 1, updated_at = ? WHERE case_id = ? AND version = ?",
        )
        .run(
          revisionNo,
          input.quoteId ?? null,
          input.quoteRevision ?? null,
          stage,
          now,
          input.caseId,
          input.expectedVersion,
        );
      const updated = this.getCase(input.caseId) as RfqCaseRow;
      if (updated.version !== current.version + 1) {
        throw new RfqError("version_conflict", `询盘 ${input.caseId} 并发修改，revision 未创建`);
      }
      return {
        case: updated,
        revision: {
          case_id: input.caseId,
          revision: revisionNo,
          fields: input.fields,
          blockers: input.blockers,
          source_ids: input.sourceIds,
          created_at: now,
        },
      };
    });
  }

  getCaseRevision(caseId: string, revision: number): RfqCaseRevisionRow | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM rfq_case_revisions WHERE case_id = ? AND revision = ?",
      )
      .get(caseId, revision) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      case_id: caseId,
      revision,
      fields: JSON.parse(String(row.fields_json)) as RfqCaseFields,
      blockers: [],
      source_ids: JSON.parse(String(row.source_ids_json)) as string[],
      created_at: String(row.created_at),
    };
  }

  /** 终态推进（CLOSED/CANCELLED）：只能由操作者显式触发；未决审批候选由服务层失效。 */
  closeCase(input: { caseId: string; expectedVersion: number; stage: "CLOSED" | "CANCELLED" }): RfqCaseRow {
    return this.tx(() => {
      const current = this.assertCaseVersion(input.caseId, input.expectedVersion);
      if (current.stage === "CLOSED" || current.stage === "CANCELLED") {
        throw new RfqError("case_closed", `询盘 ${input.caseId} 已是终态 ${current.stage}`);
      }
      this.db
        .prepare("UPDATE rfq_cases SET stage = ?, version = version + 1, updated_at = ? WHERE case_id = ? AND version = ?")
        .run(input.stage, this.now(), input.caseId, input.expectedVersion);
      return this.getCase(input.caseId) as RfqCaseRow;
    });
  }

  /** current_quote 指针更新（版本替代/失效/回退 READY 时同步维护）。 */
  updateCurrentQuote(input: {
    caseId: string;
    expectedVersion: number;
    quoteId: string | null;
    quoteRevision: number | null;
    stage?: RfqStage;
  }): RfqCaseRow {
    return this.tx(() => this.updateCurrentQuoteInTx(input));
  }

  private updateCurrentQuoteInTx(input: {
    caseId: string;
    expectedVersion: number;
    quoteId: string | null;
    quoteRevision: number | null;
    stage?: RfqStage;
  }): RfqCaseRow {
    this.assertCaseVersion(input.caseId, input.expectedVersion);
    this.db
      .prepare(
        "UPDATE rfq_cases SET current_quote_id = ?, current_quote_revision = ?, stage = COALESCE(?, stage), version = version + 1, updated_at = ? WHERE case_id = ? AND version = ?",
      )
      .run(
        input.quoteId,
        input.quoteRevision,
        input.stage ?? null,
        this.now(),
        input.caseId,
        input.expectedVersion,
      );
    return this.getCase(input.caseId) as RfqCaseRow;
  }

  // ---- 来源（内容摘要去重：仅同一 case 内） --------------------------------

  createSource(input: {
    caseId: string;
    kind: string;
    content: string;
    receivedAt: string;
    submittedBy: string;
    synthetic: boolean;
  }): { source: RfqSourceRow; deduplicated: boolean } {
    const sha = `sha256:${createHash("sha256").update(input.content, "utf8").digest("hex")}`;
    return this.tx(() => {
      const existing = this.db
        .prepare("SELECT * FROM rfq_sources WHERE case_id = ? AND content_sha256 = ?")
        .get(input.caseId, sha) as Record<string, unknown> | undefined;
      if (existing !== undefined) {
        return { source: this.sourceRow(existing), deduplicated: true };
      }
      const sourceId = this.id("src");
      this.db
        .prepare(
          "INSERT INTO rfq_sources (source_id, case_id, merchant_id, kind, content_sha256, content, received_at, submitted_by, synthetic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          sourceId,
          input.caseId,
          this.merchantId,
          input.kind,
          sha,
          input.content,
          nowIsoOrThrow(input.receivedAt, "received_at"),
          input.submittedBy,
          input.synthetic ? 1 : 0,
        );
      return {
        source: {
          source_id: sourceId,
          case_id: input.caseId,
          merchant_id: this.merchantId,
          kind: input.kind,
          content_sha256: sha,
          content: input.content,
          received_at: input.receivedAt,
          submitted_by: input.submittedBy,
          synthetic: input.synthetic,
        },
        deduplicated: false,
      };
    });
  }

  private sourceRow(row: Record<string, unknown>): RfqSourceRow {
    return {
      source_id: String(row.source_id),
      case_id: String(row.case_id),
      merchant_id: String(row.merchant_id),
      kind: String(row.kind),
      content_sha256: String(row.content_sha256),
      content: String(row.content),
      received_at: String(row.received_at),
      submitted_by: String(row.submitted_by),
      synthetic: Number(row.synthetic) === 1,
    };
  }

  getSource(sourceId: string): RfqSourceRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM rfq_sources WHERE source_id = ? AND merchant_id = ?")
      .get(sourceId, this.merchantId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.sourceRow(row);
  }

  // ---- 事实快照 -----------------------------------------------------------

  saveSnapshot(input: {
    snapshotId: string;
    caseId: string;
    caseRevision: number;
    fields: unknown[];
    contentFingerprint: string;
    complete: boolean;
    fetchedAt: string;
    synthetic: boolean;
  }): void {
    this.db
      .prepare(
        "INSERT INTO rfq_fact_snapshots (snapshot_id, case_id, case_revision, merchant_id, fields_json, content_fingerprint, complete, fetched_at, synthetic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        input.snapshotId,
        input.caseId,
        input.caseRevision,
        this.merchantId,
        canonicalJson(input.fields),
        input.contentFingerprint,
        input.complete ? 1 : 0,
        input.fetchedAt,
        input.synthetic ? 1 : 0,
      );
  }

  getSnapshot(snapshotId: string): { snapshot_id: string; case_id: string; case_revision: number; fields_json: string; content_fingerprint: string; fetched_at: string } | undefined {
    const row = this.db
      .prepare("SELECT * FROM rfq_fact_snapshots WHERE snapshot_id = ? AND merchant_id = ?")
      .get(snapshotId, this.merchantId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      snapshot_id: String(row.snapshot_id),
      case_id: String(row.case_id),
      case_revision: Number(row.case_revision),
      fields_json: String(row.fields_json),
      content_fingerprint: String(row.content_fingerprint),
      fetched_at: String(row.fetched_at),
    };
  }

  /** 询盘当前最新快照（refreshFacts 的指纹变化检测用）。 */
  getLatestSnapshotForCase(caseId: string, excludeSnapshotId: string): { snapshot_id: string; content_fingerprint: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT snapshot_id, content_fingerprint FROM rfq_fact_snapshots WHERE case_id = ? AND merchant_id = ? AND snapshot_id <> ? ORDER BY fetched_at DESC, snapshot_id DESC LIMIT 1",
      )
      .get(caseId, this.merchantId, excludeSnapshotId) as
      | { snapshot_id: string; content_fingerprint: string }
      | undefined;
    return row === undefined
      ? undefined
      : { snapshot_id: String(row.snapshot_id), content_fingerprint: String(row.content_fingerprint) };
  }

  // ---- 报价版本与事件 ------------------------------------------------------

  createQuote(input: {
    quoteId: string;
    revision: number;
    caseId: string;
    caseRevision: number;
    snapshotId: string;
    factFingerprint: string;
    pricingInput: unknown;
    pricingOutput: unknown;
    projection: unknown;
    policyVersion: string;
    validUntil: string;
    actor: string;
  }): RfqQuoteRow {
    const digestInput = {
      quote_id: input.quoteId,
      revision: input.revision,
      case_id: input.caseId,
      case_revision: input.caseRevision,
      pricing_input: input.pricingInput,
      pricing_output: input.pricingOutput,
      valid_until: input.validUntil,
      fact_fingerprint: input.factFingerprint,
      policy_version: input.policyVersion,
    };
    const digest = rfqContentDigest(digestInput);
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO rfq_quote_revisions
           (quote_id, revision, case_id, case_revision, merchant_id, snapshot_id, fact_fingerprint,
            pricing_input_json, pricing_output_json, projection_json, content_digest, policy_version,
            valid_until, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VALIDATED', ?, ?)`,
      )
      .run(
        input.quoteId,
        input.revision,
        input.caseId,
        input.caseRevision,
        this.merchantId,
        input.snapshotId,
        input.factFingerprint,
        canonicalJson(input.pricingInput),
        canonicalJson(input.pricingOutput),
        canonicalJson(input.projection),
        digest,
        input.policyVersion,
        nowIsoOrThrow(input.validUntil, "valid_until"),
        now,
        now,
      );
    this.appendQuoteEvent({
      quoteId: input.quoteId,
      revision: input.revision,
      event: "VALIDATED",
      actor: input.actor,
      reason: "确定性校验通过（创建即 VALIDATED；不可变内容 + 可重算输出）",
    });
    return this.getQuote(input.quoteId, input.revision) as RfqQuoteRow;
  }

  appendQuoteEvent(input: { quoteId: string; revision: number; event: QuoteEventKind; actor: string; reason?: string }): void {
    this.db
      .prepare(
        "INSERT INTO rfq_quote_events (event_id, quote_id, revision, event, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(this.id("ev"), input.quoteId, input.revision, input.event, input.actor, input.reason ?? null, this.now());
  }

  getQuote(quoteId: string, revision: number): RfqQuoteRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM rfq_quote_revisions WHERE quote_id = ? AND revision = ? AND merchant_id = ?")
      .get(quoteId, revision, this.merchantId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return this.quoteRow(row);
  }

  private quoteRow(row: Record<string, unknown>): RfqQuoteRow {
    return {
      quote_id: String(row.quote_id),
      revision: Number(row.revision),
      case_id: String(row.case_id),
      case_revision: Number(row.case_revision),
      merchant_id: String(row.merchant_id),
      snapshot_id: String(row.snapshot_id),
      fact_fingerprint: String(row.fact_fingerprint),
      pricing_input_json: String(row.pricing_input_json),
      pricing_output_json: String(row.pricing_output_json),
      projection_json: String(row.projection_json),
      content_digest: String(row.content_digest),
      policy_version: String(row.policy_version),
      valid_until: String(row.valid_until),
      status: String(row.status) as QuoteStatus,
      status_reason: row.status_reason === null ? null : String(row.status_reason),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  listQuotesForCase(caseId: string): RfqQuoteRow[] {
    const rows = this.db
      .prepare("SELECT * FROM rfq_quote_revisions WHERE case_id = ? AND merchant_id = ? ORDER BY created_at, revision")
      .all(caseId, this.merchantId) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.quoteRow(r));
  }

  listQuoteEvents(quoteId: string, revision: number): RfqQuoteEventRow[] {
    const rows = this.db
      .prepare("SELECT * FROM rfq_quote_events WHERE quote_id = ? AND revision = ? ORDER BY at, event_id")
      .all(quoteId, revision) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      event_id: String(r.event_id),
      quote_id: String(r.quote_id),
      revision: Number(r.revision),
      event: String(r.event) as QuoteEventKind,
      actor: String(r.actor),
      reason: r.reason === null ? null : String(r.reason),
      at: String(r.at),
    }));
  }

  /** 报价状态 CAS 转移：只允许 FROM 状态集合内的转移（独立事务）。 */
  transitionQuote(input: {
    quoteId: string;
    revision: number;
    from: QuoteStatus[];
    to: QuoteStatus;
    actor: string;
    reason?: string;
  }): RfqQuoteRow {
    return this.tx(() => this.transitionQuoteInTx(input));
  }

  /** 事务内版本（供 activateReleaseAtomic 等复合操作复用；不开新事务）。 */
  private transitionQuoteInTx(input: {
    quoteId: string;
    revision: number;
    from: QuoteStatus[];
    to: QuoteStatus;
    actor: string;
    reason?: string;
  }): RfqQuoteRow {
    const current = this.getQuote(input.quoteId, input.revision);
    if (current === undefined) {
      throw new RfqError("not_found", `未知报价 ${input.quoteId}@${input.revision}`);
    }
    if (!input.from.includes(current.status)) {
      throw new RfqError(
        "approval_stale",
        `报价 ${input.quoteId}@${input.revision} 状态为 ${current.status}，不能转移到 ${input.to}`,
      );
    }
    const result = this.db
      .prepare(
        "UPDATE rfq_quote_revisions SET status = ?, status_reason = ?, updated_at = ? WHERE quote_id = ? AND revision = ? AND status = ?",
      )
      .run(input.to, input.reason ?? null, this.now(), input.quoteId, input.revision, current.status);
    if (Number(result.changes) !== 1) {
      throw new RfqError("approval_stale", `报价 ${input.quoteId}@${input.revision} 并发转移失败`);
    }
    this.appendQuoteEvent({
      quoteId: input.quoteId,
      revision: input.revision,
      event: input.to as QuoteEventKind,
      actor: input.actor,
      reason: input.reason,
    });
    return this.getQuote(input.quoteId, input.revision) as RfqQuoteRow;
  }

  /**
   * 版本替代：当前报价 → SUPERSEDED，并清空 case 指针。stage 由调用方给定
   * （修订后的新阶段 / 事实失效回退 READY）——不硬编码，避免覆盖 revision
   * 重算结果（v0.1.1 §8.1：stage 判定对象始终是 current_revision）。
   */
  supersedeCurrentQuote(input: {
    caseId: string;
    expectedVersion: number;
    actor: string;
    reason: string;
    stage: RfqStage;
  }): void {
    this.tx(() => {
      const kase = this.assertCaseVersion(input.caseId, input.expectedVersion);
      if (kase.current_quote_id !== null && kase.current_quote_revision !== null) {
        const quote = this.getQuote(kase.current_quote_id, kase.current_quote_revision);
        if (quote !== undefined && ["DRAFT", "VALIDATED", "PENDING_APPROVAL", "APPROVED"].includes(quote.status)) {
          this.transitionQuoteInTx({
            quoteId: quote.quote_id,
            revision: quote.revision,
            from: [quote.status],
            to: "SUPERSEDED",
            actor: input.actor,
            reason: input.reason,
          });
        }
      }
      this.updateCurrentQuoteInTx({
        caseId: input.caseId,
        expectedVersion: kase.version,
        quoteId: null,
        quoteRevision: null,
        stage: input.stage,
      });
    });
  }

  /** EXPIRED 惰性判定（服务端时钟；读取与前置校验时调用）。 */
  expireDueQuote(quote: RfqQuoteRow, actor = "system"): RfqQuoteRow {
    if (quote.status !== "PENDING_APPROVAL" && quote.status !== "APPROVED") return quote;
    if (Date.parse(quote.valid_until) > Date.parse(this.now())) return quote;
    return this.transitionQuote({
      quoteId: quote.quote_id,
      revision: quote.revision,
      from: [quote.status],
      to: "EXPIRED",
      actor,
      reason: "超过报价有效期（服务端时钟惰性判定）",
    });
  }

  // ---- 发布与产物 ----------------------------------------------------------

  saveArtifact(row: RfqArtifactRow): void {
    this.db
      .prepare(
        `INSERT INTO rfq_artifacts
           (artifact_id, merchant_id, quote_id, quote_revision, content_sha256, template_version, content_type, relative_path, activated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.artifact_id,
        row.merchant_id,
        row.quote_id,
        row.quote_revision,
        row.content_sha256,
        row.template_version,
        row.content_type,
        row.relative_path,
        row.activated ? 1 : 0,
        row.created_at,
      );
  }

  getArtifact(artifactId: string): RfqArtifactRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM rfq_artifacts WHERE artifact_id = ? AND merchant_id = ?")
      .get(artifactId, this.merchantId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      artifact_id: String(row.artifact_id),
      merchant_id: String(row.merchant_id),
      quote_id: String(row.quote_id),
      quote_revision: Number(row.quote_revision),
      content_sha256: String(row.content_sha256),
      template_version: String(row.template_version),
      content_type: String(row.content_type),
      relative_path: String(row.relative_path),
      activated: Number(row.activated) === 1,
      created_at: String(row.created_at),
    };
  }

  activateArtifact(artifactId: string): void {
    const result = this.db
      .prepare("UPDATE rfq_artifacts SET activated = 1 WHERE artifact_id = ? AND merchant_id = ?")
      .run(artifactId, this.merchantId);
    if (Number(result.changes) !== 1) {
      throw new RfqError("not_found", `未知产物 ${artifactId}`);
    }
  }

  createRelease(row: RfqReleaseRow): void {
    this.db
      .prepare(
        `INSERT INTO rfq_release_requests
           (release_id, merchant_id, quote_id, quote_revision, candidate_id, artifact_id, artifact_sha256,
            public_projection_digest, recipient_ref, policy_version, fact_fingerprint, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', ?, ?)`,
      )
      .run(
        row.release_id,
        row.merchant_id,
        row.quote_id,
        row.quote_revision,
        row.candidate_id,
        row.artifact_id,
        row.artifact_sha256,
        row.public_projection_digest,
        row.recipient_ref,
        row.policy_version,
        row.fact_fingerprint,
        row.created_at,
        row.created_at,
      );
  }

  getRelease(releaseId: string): RfqReleaseRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM rfq_release_requests WHERE release_id = ? AND merchant_id = ?")
      .get(releaseId, this.merchantId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      release_id: String(row.release_id),
      merchant_id: String(row.merchant_id),
      quote_id: String(row.quote_id),
      quote_revision: Number(row.quote_revision),
      candidate_id: String(row.candidate_id),
      artifact_id: String(row.artifact_id),
      artifact_sha256: String(row.artifact_sha256),
      public_projection_digest: String(row.public_projection_digest),
      recipient_ref: String(row.recipient_ref),
      policy_version: String(row.policy_version),
      fact_fingerprint: String(row.fact_fingerprint),
      status: String(row.status) as RfqReleaseRow["status"],
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  transitionRelease(releaseId: string, from: RfqReleaseRow["status"][], to: RfqReleaseRow["status"]): RfqReleaseRow {
    return this.tx(() => {
      const current = this.getRelease(releaseId);
      if (current === undefined) throw new RfqError("not_found", `未知发布 ${releaseId}`);
      if (!from.includes(current.status)) {
        throw new RfqError("approval_stale", `发布 ${releaseId} 状态为 ${current.status}，不能转移到 ${to}`);
      }
      this.db
        .prepare("UPDATE rfq_release_requests SET status = ?, updated_at = ? WHERE release_id = ? AND status = ?")
        .run(to, this.now(), releaseId, current.status);
      return this.getRelease(releaseId) as RfqReleaseRow;
    });
  }

  /** 候选登记后回填 candidate_id（prepare 与命令记录同一请求内完成）。 */
  updateReleaseCandidate(releaseId: string, candidateId: string): void {
    const result = this.db
      .prepare("UPDATE rfq_release_requests SET candidate_id = ?, updated_at = ? WHERE release_id = ? AND merchant_id = ?")
      .run(candidateId, this.now(), releaseId, this.merchantId);
    if (Number(result.changes) !== 1) throw new RfqError("not_found", `未知发布 ${releaseId}`);
  }

  listReleasesForQuote(quoteId: string, revision: number): RfqReleaseRow[] {
    const rows = this.db
      .prepare(
        "SELECT release_id FROM rfq_release_requests WHERE merchant_id = ? AND quote_id = ? AND quote_revision = ? ORDER BY created_at",
      )
      .all(this.merchantId, quoteId, revision) as unknown as { release_id: string }[];
    return rows.map((r) => this.getRelease(r.release_id) as RfqReleaseRow);
  }

  /** 移交包登记（批准后执行器写入；PACKET_READY 起步）。 */
  saveHandoffPacket(input: { handoffId: string; packetJson: string; digest: string; actor: string }): void {
    const packet = JSON.parse(input.packetJson) as {
      origin: { quote_id: string; revision: number };
      target_ref: string;
      intent_evidence_ref: string;
    };
    this.db
      .prepare(
        `INSERT INTO rfq_handoffs
           (handoff_id, merchant_id, quote_id, quote_revision, origin_kind, target_ref, intent_evidence_ref,
            packet_digest, packet_json, status, receipt_json, recorded_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'manual_quote', ?, ?, ?, ?, 'PACKET_READY', NULL, ?, ?, ?)`,
      )
      .run(
        input.handoffId,
        this.merchantId,
        packet.origin.quote_id,
        packet.origin.revision,
        packet.target_ref,
        packet.intent_evidence_ref,
        input.digest,
        input.packetJson,
        input.actor,
        this.now(),
        this.now(),
      );
  }

  listReleasesByStatus(status: RfqReleaseRow["status"]): RfqReleaseRow[] {
    const rows = this.db
      .prepare("SELECT * FROM rfq_release_requests WHERE merchant_id = ? AND status = ? ORDER BY created_at")
      .all(this.merchantId, status) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.getRelease(String(r.release_id)) as RfqReleaseRow);
  }

  /**
   * 原子激活（§9.2 C；§10.2：候选、release、产物权限在同一写事务内）：
   * 报价 PENDING_APPROVAL → APPROVED、release → APPROVED、产物可下载。
   * 任何一步失败整体回滚，绝不出现「批准已记录但文件不可下载」的中间态。
   */
  activateReleaseAtomic(input: { releaseId: string; actor: string; caseExpectedVersion: number }): {
    release: RfqReleaseRow;
    quote: RfqQuoteRow;
  } {
    return this.tx(() => {
      const release = this.getRelease(input.releaseId);
      if (release === undefined) throw new RfqError("not_found", `未知发布 ${input.releaseId}`);
      const quote = this.getQuote(release.quote_id, release.quote_revision);
      if (quote === undefined) {
        throw new RfqError("not_found", `未知报价 ${release.quote_id}@${release.quote_revision}`);
      }
      if (quote.status !== "PENDING_APPROVAL") {
        throw new RfqError("approval_stale", `报价状态为 ${quote.status}，不是 PENDING_APPROVAL`);
      }
      // 事务内复查 case 终态与需求 revision（§8.1/§9.2 C：与外层校验构成防御纵深）。
      const kase = this.getCase(quote.case_id);
      if (kase === undefined) {
        throw new RfqError("not_found", `未知询盘 ${quote.case_id}`);
      }
      if (kase.stage === "CLOSED" || kase.stage === "CANCELLED") {
        throw new RfqError("case_closed", `询盘 ${quote.case_id} 已是终态 ${kase.stage}；批准失效`);
      }
      if (kase.current_revision !== quote.case_revision) {
        throw new RfqError("approval_stale", "需求已更新（case_revision 变化）；旧批准失效");
      }
      // 前置重验：报价有效期（服务端时钟）。
      if (Date.parse(quote.valid_until) <= Date.parse(this.now())) {
        throw new RfqError("approval_stale", "报价已过有效期，批准失效");
      }
      this.transitionQuoteInTx({
        quoteId: quote.quote_id,
        revision: quote.revision,
        from: ["PENDING_APPROVAL"],
        to: "APPROVED",
        actor: input.actor,
        reason: "可信批准 + 一次性凭证消费 + 事实与策略重验通过",
      });
      this.db
        .prepare("UPDATE rfq_release_requests SET status = 'APPROVED', updated_at = ? WHERE release_id = ? AND status = 'PENDING_APPROVAL'")
        .run(this.now(), input.releaseId);
      this.activateArtifact(release.artifact_id);
      // current 指针指向已批准版本；stage → PRICED（判定对象=当前指针）。
      this.updateCurrentQuoteInTx({
        caseId: quote.case_id,
        expectedVersion: input.caseExpectedVersion,
        quoteId: quote.quote_id,
        quoteRevision: quote.revision,
        stage: "PRICED",
      });
      const after = this.getRelease(input.releaseId) as RfqReleaseRow;
      return { release: after, quote: this.getQuote(quote.quote_id, quote.revision) as RfqQuoteRow };
    });
  }

  /** 下载记录（EXPORTED 唯一触发通道：可信管理页认证主体的成功取走）。 */
  markQuoteExported(input: { quoteId: string; revision: number; actor: string }): RfqQuoteRow {
    return this.transitionQuote({
      quoteId: input.quoteId,
      revision: input.revision,
      from: ["APPROVED"],
      to: "EXPORTED",
      actor: input.actor,
      reason: "可信管理页认证主体成功取走产物（摘要校验通过）",
    });
  }

  // ---- 发送与移交 ----------------------------------------------------------

  createDelivery(row: RfqDeliveryRow): RfqDeliveryRow {
    this.db
      .prepare(
        `INSERT INTO rfq_delivery_records
           (delivery_id, merchant_id, quote_id, quote_revision, release_id, status, channel, evidence_ref, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.delivery_id,
        row.merchant_id,
        row.quote_id,
        row.quote_revision,
        row.release_id,
        row.status,
        row.channel,
        row.evidence_ref,
        row.recorded_by,
        row.recorded_at,
      );
    return row;
  }

  createHandoff(row: RfqHandoffRow): RfqHandoffRow {
    this.db
      .prepare(
        `INSERT INTO rfq_handoffs
           (handoff_id, merchant_id, quote_id, quote_revision, origin_kind, target_ref, intent_evidence_ref,
            packet_digest, packet_json, status, receipt_json, recorded_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.handoff_id,
        row.merchant_id,
        row.quote_id,
        row.quote_revision,
        row.origin_kind,
        row.target_ref,
        row.intent_evidence_ref,
        row.packet_digest,
        row.packet_json,
        row.status,
        row.receipt_json,
        row.recorded_by,
        row.created_at,
        row.created_at,
      );
    return row;
  }

  getHandoff(handoffId: string): RfqHandoffRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM rfq_handoffs WHERE handoff_id = ? AND merchant_id = ?")
      .get(handoffId, this.merchantId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      handoff_id: String(row.handoff_id),
      merchant_id: String(row.merchant_id),
      quote_id: String(row.quote_id),
      quote_revision: Number(row.quote_revision),
      origin_kind: String(row.origin_kind) as RfqHandoffRow["origin_kind"],
      target_ref: String(row.target_ref),
      intent_evidence_ref: String(row.intent_evidence_ref),
      packet_digest: String(row.packet_digest),
      packet_json: String(row.packet_json),
      status: String(row.status) as RfqHandoffRow["status"],
      receipt_json: row.receipt_json === null ? null : String(row.receipt_json),
      recorded_by: String(row.recorded_by),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  /** 移交状态推进（PACKET_READY → OWNER_RECORDED；其余通道后续接入）。 */
  updateHandoffStatus(handoffId: string, status: RfqHandoffRow["status"], actor: string): RfqHandoffRow {
    return this.tx(() => {
      const current = this.getHandoff(handoffId);
      if (current === undefined) throw new RfqError("not_found", `未知移交 ${handoffId}`);
      this.db
        .prepare("UPDATE rfq_handoffs SET status = ?, recorded_by = ?, updated_at = ? WHERE handoff_id = ? AND status = ?")
        .run(status, actor, this.now(), handoffId, current.status);
      return this.getHandoff(handoffId) as RfqHandoffRow;
    });
  }

  // ---- 幂等 ---------------------------------------------------------------

  /**
   * 幂等包装（§10.3）：同键同请求摘要重放同一结果；同键不同摘要冲突。
   * 请求摘要在执行前登记（防并发双执行）；结果成功后回填。
   */
  withIdempotency<T>(input: {
    principalId: string;
    operation: string;
    key: string;
    request: unknown;
    run: () => T;
    serialize: (result: T) => unknown;
    deserialize: (stored: string) => T;
  }): { result: T; replayed: boolean } {
    if (input.key.trim() === "") {
      throw new RfqError("validation", "idempotency_key 不能为空");
    }
    const digest = rfqContentDigest(input.request ?? null);
    return this.tx(() => {
      const existing = this.db
        .prepare(
          "SELECT request_digest, result_json FROM rfq_idempotency WHERE merchant_id = ? AND principal_id = ? AND operation = ? AND idem_key = ?",
        )
        .get(this.merchantId, input.principalId, input.operation, input.key) as
        | { request_digest: string; result_json: string | null }
        | undefined;
      if (existing !== undefined) {
        if (existing.request_digest !== digest) {
          throw new RfqError("idempotency_conflict", "同幂等键不同请求内容（IDEMPOTENCY_CONFLICT）");
        }
        if (existing.result_json === null) {
          throw new RfqError("operation_unknown", "相同幂等键的请求仍在执行中；请查询原作业结果，禁止盲重放");
        }
        return { result: input.deserialize(existing.result_json), replayed: true };
      }
      this.db
        .prepare(
          "INSERT INTO rfq_idempotency (merchant_id, principal_id, operation, idem_key, request_digest, result_json, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
        )
        .run(this.merchantId, input.principalId, input.operation, input.key, digest, this.now());
      const result = input.run();
      this.db
        .prepare(
          "UPDATE rfq_idempotency SET result_json = ? WHERE merchant_id = ? AND principal_id = ? AND operation = ? AND idem_key = ?",
        )
        .run(JSON.stringify(input.serialize(result)), this.merchantId, input.principalId, input.operation, input.key);
      return { result, replayed: false };
    });
  }

  // ---- 作业 ----------------------------------------------------------------

  /**
   * 异步幂等（§10.3/§10.4）：tombstone 先行登记（同键同摘要可继续，不同
   * 摘要冲突，重复并发按「结果尚未确定」处理），异步工作完成后回填结果。
   * 崩溃留下的 tombstone 无结果 = OPERATION_UNKNOWN——先查询原作业，禁止
   * 盲重放。prepare_release / 激活类关键幂等不设 30 天清理（跟随报价保留）。
   */
  async withIdempotencyAsync<T>(input: {
    principalId: string;
    operation: string;
    key: string;
    request: unknown;
    run: () => Promise<T>;
    serialize: (result: T) => unknown;
    deserialize: (stored: string) => T;
  }): Promise<{ result: T; replayed: boolean }> {
    if (input.key.trim() === "") {
      throw new RfqError("validation", "idempotency_key 不能为空");
    }
    const digest = rfqContentDigest(input.request ?? null);
    const existing = this.db
      .prepare(
        "SELECT request_digest, result_json FROM rfq_idempotency WHERE merchant_id = ? AND principal_id = ? AND operation = ? AND idem_key = ?",
      )
      .get(this.merchantId, input.principalId, input.operation, input.key) as
      | { request_digest: string; result_json: string | null }
      | undefined;
    if (existing !== undefined) {
      if (existing.request_digest !== digest) {
        throw new RfqError("idempotency_conflict", "同幂等键不同请求内容（IDEMPOTENCY_CONFLICT）");
      }
      if (existing.result_json === null) {
        throw new RfqError("operation_unknown", "相同幂等键的请求尚未完成；请先查询原作业/发布状态，禁止盲重放");
      }
      return { result: input.deserialize(existing.result_json), replayed: true };
    }
    this.tx(() => {
      // tx 内复查（并发窗口内第二个请求走冲突路径而非双执行）。
      const again = this.db
        .prepare(
          "SELECT request_digest FROM rfq_idempotency WHERE merchant_id = ? AND principal_id = ? AND operation = ? AND idem_key = ?",
        )
        .get(this.merchantId, input.principalId, input.operation, input.key) as
        | { request_digest: string }
        | undefined;
      if (again !== undefined) {
        throw new RfqError(
          again.request_digest === digest ? "operation_unknown" : "idempotency_conflict",
          again.request_digest === digest
            ? "相同幂等键的请求正在执行中；请先查询原作业结果"
            : "同幂等键不同请求内容（IDEMPOTENCY_CONFLICT）",
        );
      }
      this.db
        .prepare(
          "INSERT INTO rfq_idempotency (merchant_id, principal_id, operation, idem_key, request_digest, result_json, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
        )
        .run(this.merchantId, input.principalId, input.operation, input.key, digest, this.now());
    });
    let result: T;
    try {
      result = await input.run();
    } catch (err) {
      // 确定性失败（run() 抛出）：结果已确定为失败而非未知——清理 tombstone，
      // 与同步路径语义一致（失败不留残键；同键可修正后重试）。进程崩溃留下的
      // tombstone 无结果仍按 OPERATION_UNKNOWN 处理（§10.3）。
      this.db
        .prepare(
          "DELETE FROM rfq_idempotency WHERE merchant_id = ? AND principal_id = ? AND operation = ? AND idem_key = ? AND result_json IS NULL",
        )
        .run(this.merchantId, input.principalId, input.operation, input.key);
      throw err;
    }
    this.tx(() => {
      this.db
        .prepare(
          "UPDATE rfq_idempotency SET result_json = ? WHERE merchant_id = ? AND principal_id = ? AND operation = ? AND idem_key = ?",
        )
        .run(
          JSON.stringify(input.serialize(result)),
          this.merchantId,
          input.principalId,
          input.operation,
          input.key,
        );
    });
    return { result, replayed: false };
  }

  /**
   * 幂等记录保留清理（§10.3：建议保留 30 天；prepare/激活类关键幂等跟随
   * 对应报价保留策略，不清理）。返回删除条数。
   */
  pruneIdempotency(input: { olderThanDays: number; preserveOperations: string[] }): number {
    const cutoff = new Date(Date.parse(this.now()) - input.olderThanDays * 86_400_000).toISOString();
    const placeholders = input.preserveOperations.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `DELETE FROM rfq_idempotency WHERE created_at < ?${placeholders ? ` AND operation NOT IN (${placeholders})` : ""}`,
      )
      .run(cutoff, ...input.preserveOperations);
    return Number(result.changes);
  }

  createJob(operation: string): RfqJobRow {
    const jobId = this.id("job");
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO rfq_jobs (job_id, merchant_id, operation, status, progress, created_at, updated_at) VALUES (?, ?, ?, 'QUEUED', 0, ?, ?)",
      )
      .run(jobId, this.merchantId, operation, now, now);
    return this.getJob(jobId) as RfqJobRow;
  }

  markJob(jobId: string, status: RfqJobRow["status"], patch?: { progress?: number; errorCode?: string; result?: unknown; checkpoint?: unknown }): RfqJobRow {
    const result = this.db
      .prepare("UPDATE rfq_jobs SET status = ?, progress = ?, error_code = ?, result_json = ?, checkpoint_json = ?, updated_at = ? WHERE job_id = ? AND merchant_id = ?")
      .run(
        status,
        patch?.progress ?? 0,
        patch?.errorCode ?? null,
        patch?.result === undefined ? null : JSON.stringify(patch.result),
        patch?.checkpoint === undefined ? null : JSON.stringify(patch.checkpoint),
        this.now(),
        jobId,
        this.merchantId,
      );
    if (Number(result.changes) !== 1) throw new RfqError("not_found", `未知作业 ${jobId}`);
    return this.getJob(jobId) as RfqJobRow;
  }

  getJob(jobId: string): RfqJobRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM rfq_jobs WHERE job_id = ? AND merchant_id = ?")
      .get(jobId, this.merchantId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      job_id: String(row.job_id),
      merchant_id: String(row.merchant_id),
      operation: String(row.operation),
      status: String(row.status) as RfqJobRow["status"],
      progress: Number(row.progress),
      checkpoint_json: row.checkpoint_json === null ? null : String(row.checkpoint_json),
      error_code: row.error_code === null ? null : String(row.error_code),
      result_json: row.result_json === null ? null : String(row.result_json),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }
}
