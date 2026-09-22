/** Workbench v0.1.1 retention and Buyer privacy-request authority (design §21 / WB-036—038,058). */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { inImmediateTransaction } from "../merchant-core/storage/transaction.js";

export const PRIVACY_REQUEST_STATUSES = [
  "RECEIVED",
  "IDENTITY_CHECK",
  "SCOPED",
  "PROCESSING",
  "COMPLETED",
  "RESTRICTED",
  "PARTIAL_EXTERNAL",
] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];

export const RETENTION_CATEGORIES = [
  "follow_relationship",
  "follow_tombstone",
  "follow_idempotency",
  "broadcast_content",
  "feed_event",
  "engagement_detail",
  "negotiation_personal_content",
  "confirmation_temporary",
  "operation_trace",
  "minimal_audit",
  "debug_log",
  "anonymous_aggregate",
  "backup",
  "deletion_suppression",
] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

export interface RetentionPolicyEntry {
  category: RetentionCategory;
  processor: string;
  purpose: string;
  basis: string;
  retentionDays: number;
  reviewAt: string;
}

export interface PrivacyRequestRecord {
  requestId: string;
  merchantId: string;
  buyerPrincipalId: string;
  status: PrivacyRequestStatus;
  consentGeneration: number;
  receivedAt: string;
  updatedAt: string;
}

export interface DeletionSuppressionRecord {
  merchantId: string;
  buyerPrincipalId: string;
  consentGeneration: number;
  expiresAt: string;
  createdAt: string;
}

const TRANSITIONS: Readonly<Record<PrivacyRequestStatus, readonly PrivacyRequestStatus[]>> = {
  RECEIVED: ["IDENTITY_CHECK", "RESTRICTED"],
  IDENTITY_CHECK: ["SCOPED", "RESTRICTED"],
  SCOPED: ["PROCESSING", "RESTRICTED"],
  PROCESSING: ["COMPLETED", "RESTRICTED", "PARTIAL_EXTERNAL"],
  COMPLETED: [],
  RESTRICTED: [],
  PARTIAL_EXTERNAL: [],
};

const REQUIRED_NODES = [
  "runtime-primary",
  "buyer-preferences",
  "runtime-cache",
  "controlled-backup",
] as const;
export type PrivacyDeletionNode = (typeof REQUIRED_NODES)[number];
export interface PrivacyDeletionNodeResult {
  receiptRef: string;
  deletedRows?: number;
}
export type PrivacyDeletionNodeHandler = (input: {
  requestId: string;
  merchantId: string;
  buyerPrincipalId: string;
  consentGeneration: number;
}) => PrivacyDeletionNodeResult;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workbench_retention_policy (
  category TEXT PRIMARY KEY,
  processor TEXT NOT NULL,
  purpose TEXT NOT NULL,
  basis TEXT NOT NULL,
  retention_days INTEGER NOT NULL,
  review_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workbench_privacy_subjects (
  merchant_id TEXT NOT NULL,
  buyer_principal_id TEXT NOT NULL,
  consent_generation INTEGER NOT NULL,
  marketing_allowed INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, buyer_principal_id)
);
CREATE TABLE IF NOT EXISTS workbench_privacy_requests (
  request_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  buyer_principal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  consent_generation INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  limitation_reason TEXT
);
CREATE TABLE IF NOT EXISTS workbench_privacy_deletion_tasks (
  request_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','restricted','failed')),
  receipt_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (request_id, node_id)
);
CREATE TABLE IF NOT EXISTS workbench_deletion_suppressions (
  merchant_id TEXT NOT NULL,
  buyer_principal_id TEXT NOT NULL,
  consent_generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, buyer_principal_id)
);
`;

export class WorkbenchRetentionError extends Error {
  readonly code:
    | "POLICY_INVALID"
    | "REQUEST_NOT_FOUND"
    | "ILLEGAL_TRANSITION"
    | "DELETION_INCOMPLETE"
    | "DELETION_NODE_UNAVAILABLE";

  constructor(code: WorkbenchRetentionError["code"], message: string) {
    super(message);
    this.name = "WorkbenchRetentionError";
    this.code = code;
  }
}

export class WorkbenchRetentionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly deletionHandlers: Partial<Record<PrivacyDeletionNode, PrivacyDeletionNodeHandler>>;

  constructor(options: {
    db: DatabaseSync;
    now?: () => string;
    deletionHandlers?: Partial<Record<PrivacyDeletionNode, PrivacyDeletionNodeHandler>>;
  }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.deletionHandlers = options.deletionHandlers ?? {};
    this.db.exec("pragma busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  configurePolicy(entries: readonly RetentionPolicyEntry[]): void {
    if (entries.length !== RETENTION_CATEGORIES.length) {
      throw new WorkbenchRetentionError(
        "POLICY_INVALID",
        `retention policy must explicitly cover ${RETENTION_CATEGORIES.length} categories`,
      );
    }
    const byCategory = new Map(entries.map((entry) => [entry.category, entry]));
    if (byCategory.size !== RETENTION_CATEGORIES.length) {
      throw new WorkbenchRetentionError(
        "POLICY_INVALID",
        "retention policy categories are duplicated or missing",
      );
    }
    const stamp = this.now();
    inImmediateTransaction(this.db, () => {
      for (const category of RETENTION_CATEGORIES) {
        const entry = byCategory.get(category);
        if (entry === undefined)
          throw new WorkbenchRetentionError("POLICY_INVALID", `missing ${category}`);
        if (
          clean(entry.processor) === "" ||
          clean(entry.purpose) === "" ||
          clean(entry.basis) === "" ||
          !Number.isInteger(entry.retentionDays) ||
          entry.retentionDays < 0 ||
          entry.retentionDays > 4000 ||
          !Number.isFinite(Date.parse(entry.reviewAt))
        ) {
          throw new WorkbenchRetentionError("POLICY_INVALID", `invalid policy for ${category}`);
        }
        this.db
          .prepare(
            `INSERT INTO workbench_retention_policy
             (category, processor, purpose, basis, retention_days, review_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(category) DO UPDATE SET processor=excluded.processor,
               purpose=excluded.purpose, basis=excluded.basis,
               retention_days=excluded.retention_days, review_at=excluded.review_at,
               updated_at=excluded.updated_at`,
          )
          .run(
            category,
            clean(entry.processor),
            clean(entry.purpose),
            clean(entry.basis),
            entry.retentionDays,
            entry.reviewAt,
            stamp,
          );
      }
    });
  }

  policyReady(): boolean {
    const row = this.db.prepare("SELECT count(*) count FROM workbench_retention_policy").get() as {
      count: number;
    };
    return row.count === RETENTION_CATEGORIES.length;
  }

  receiveBuyerDeletionRequest(input: {
    merchantId: string;
    buyerPrincipalId: string;
  }): PrivacyRequestRecord {
    if (!this.policyReady()) {
      throw new WorkbenchRetentionError(
        "POLICY_INVALID",
        "retention policy lacks actual processor, purpose, basis or review ownership",
      );
    }
    const merchantId = requireText(input.merchantId, "merchantId");
    const buyerPrincipalId = requireText(input.buyerPrincipalId, "buyerPrincipalId");
    const stamp = this.now();
    const requestId = `wpr_${randomBytes(16).toString("base64url")}`;
    return inImmediateTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO workbench_privacy_subjects
           (merchant_id, buyer_principal_id, consent_generation, marketing_allowed, updated_at)
           VALUES (?, ?, 1, 0, ?)
           ON CONFLICT(merchant_id, buyer_principal_id) DO UPDATE SET
             consent_generation=consent_generation+1, marketing_allowed=0, updated_at=excluded.updated_at`,
        )
        .run(merchantId, buyerPrincipalId, stamp);
      this.stopRuntimeMarketingAndFollow(merchantId, buyerPrincipalId, stamp);
      const subject = this.db
        .prepare(
          `SELECT consent_generation FROM workbench_privacy_subjects
           WHERE merchant_id=? AND buyer_principal_id=?`,
        )
        .get(merchantId, buyerPrincipalId) as { consent_generation: number };
      this.db
        .prepare(
          `INSERT INTO workbench_privacy_requests
           (request_id, merchant_id, buyer_principal_id, status, consent_generation, received_at, updated_at)
           VALUES (?, ?, ?, 'RECEIVED', ?, ?, ?)`,
        )
        .run(requestId, merchantId, buyerPrincipalId, subject.consent_generation, stamp, stamp);
      for (const node of REQUIRED_NODES) {
        this.db
          .prepare(
            `INSERT INTO workbench_privacy_deletion_tasks
             (request_id, node_id, status, updated_at) VALUES (?, ?, 'pending', ?)`,
          )
          .run(requestId, node, stamp);
      }
      this.db
        .prepare(
          `INSERT INTO workbench_deletion_suppressions
           (merchant_id, buyer_principal_id, consent_generation, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(merchant_id, buyer_principal_id) DO UPDATE SET
             consent_generation=excluded.consent_generation,
             expires_at=excluded.expires_at, created_at=excluded.created_at`,
        )
        .run(
          merchantId,
          buyerPrincipalId,
          subject.consent_generation,
          new Date(Date.parse(stamp) + 42 * 24 * 60 * 60 * 1000).toISOString(),
          stamp,
        );
      return this.requireRequest(requestId);
    });
  }

  transition(
    requestId: string,
    next: PrivacyRequestStatus,
    limitationReason?: string,
  ): PrivacyRequestRecord {
    const current = this.requireRequest(requestId);
    if (!TRANSITIONS[current.status].includes(next)) {
      throw new WorkbenchRetentionError(
        "ILLEGAL_TRANSITION",
        `privacy request ${current.status} cannot transition to ${next}`,
      );
    }
    if (next === "COMPLETED") this.assertDeletionComplete(requestId);
    const stamp = this.now();
    this.db
      .prepare(
        "UPDATE workbench_privacy_requests SET status=?, limitation_reason=?, updated_at=? WHERE request_id=?",
      )
      .run(next, limitationReason === undefined ? null : clean(limitationReason), stamp, requestId);
    return this.requireRequest(requestId);
  }

  recordDeletionTask(input: {
    requestId: string;
    nodeId: string;
    status: "completed" | "restricted" | "failed";
    receiptRef: string;
  }): void {
    this.requireRequest(input.requestId);
    const result = this.db
      .prepare(
        `UPDATE workbench_privacy_deletion_tasks
         SET status=?, receipt_ref=?, updated_at=? WHERE request_id=? AND node_id=?`,
      )
      .run(
        input.status,
        requireText(input.receiptRef, "receiptRef"),
        this.now(),
        input.requestId,
        requireText(input.nodeId, "nodeId"),
      );
    if (result.changes !== 1) {
      throw new WorkbenchRetentionError("REQUEST_NOT_FOUND", "unknown deletion task node");
    }
  }

  processRuntimePrimary(requestId: string): { receiptRef: string; deletedRows: number } {
    const request = this.requireRequest(requestId);
    if (request.status !== "PROCESSING") {
      throw new WorkbenchRetentionError(
        "ILLEGAL_TRANSITION",
        "runtime-primary deletion requires PROCESSING status",
      );
    }
    let deletedRows = 0;
    return inImmediateTransaction(this.db, () => {
      for (const [table, where] of [
        ["merchant_follow_idempotency", "merchant_id=? AND buyer_principal_id=?"],
        ["merchant_follow_mutation_contexts", "merchant_id=? AND buyer_principal_id=?"],
        ["merchant_follow_relations", "merchant_id=? AND buyer_principal_id=?"],
        ["merchant_broadcast_engagement", "merchant_id=? AND buyer_principal_id=?"],
      ] as const) {
        if (!this.tableExists(table)) continue;
        deletedRows += Number(
          this.db
            .prepare(`DELETE FROM ${table} WHERE ${where}`)
            .run(request.merchantId, request.buyerPrincipalId).changes,
        );
      }
      const receiptRef = `runtime-primary:${requestId}:${request.consentGeneration}:${deletedRows}`;
      const changed = this.db
        .prepare(
          `UPDATE workbench_privacy_deletion_tasks
           SET status='completed', receipt_ref=?, updated_at=?
           WHERE request_id=? AND node_id='runtime-primary' AND status!='completed'`,
        )
        .run(receiptRef, this.now(), requestId);
      if (changed.changes !== 1) {
        const current = this.db
          .prepare(
            `SELECT receipt_ref FROM workbench_privacy_deletion_tasks
             WHERE request_id=? AND node_id='runtime-primary' AND status='completed'`,
          )
          .get(requestId) as { receipt_ref: string } | undefined;
        // 已完成早退（幂等重放）：fn 内 return，wrapper 提交（与手写 commit 一致）
        return { receiptRef: current?.receipt_ref ?? receiptRef, deletedRows: 0 };
      }
      return { receiptRef, deletedRows };
    });
  }

  /** Execute an externally-owned cleanup node with an idempotent receipt boundary. */
  processDeletionNode(requestId: string, nodeId: PrivacyDeletionNode): PrivacyDeletionNodeResult {
    if (nodeId === "runtime-primary") return this.processRuntimePrimary(requestId);
    const request = this.requireRequest(requestId);
    if (request.status !== "PROCESSING") {
      throw new WorkbenchRetentionError(
        "ILLEGAL_TRANSITION",
        "deletion node requires PROCESSING status",
      );
    }
    const existing = this.db
      .prepare(
        "SELECT status, receipt_ref FROM workbench_privacy_deletion_tasks WHERE request_id=? AND node_id=?",
      )
      .get(requestId, nodeId) as { status: string; receipt_ref: string | null } | undefined;
    if (existing?.status === "completed" && existing.receipt_ref !== null) {
      return { receiptRef: existing.receipt_ref, deletedRows: 0 };
    }
    const handler = this.deletionHandlers[nodeId];
    if (handler === undefined) {
      throw new WorkbenchRetentionError(
        "DELETION_NODE_UNAVAILABLE",
        `deletion node ${nodeId} has no controlled processor`,
      );
    }
    const result = handler({
      requestId,
      merchantId: request.merchantId,
      buyerPrincipalId: request.buyerPrincipalId,
      consentGeneration: request.consentGeneration,
    });
    this.recordDeletionTask({ requestId, nodeId, status: "completed", receiptRef: result.receiptRef });
    return result;
  }

  getRequest(requestId: string, merchantId: string): PrivacyRequestRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT request_id FROM workbench_privacy_requests
         WHERE request_id=? AND merchant_id=?`,
      )
      .get(requestId, merchantId) as { request_id: string } | undefined;
    return row === undefined ? undefined : this.requireRequest(row.request_id);
  }

  marketingAllowed(merchantId: string, buyerPrincipalId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT marketing_allowed FROM workbench_privacy_subjects
         WHERE merchant_id=? AND buyer_principal_id=?`,
      )
      .get(merchantId, buyerPrincipalId) as { marketing_allowed: number } | undefined;
    return row?.marketing_allowed === 1;
  }

  canRestoreSubject(
    merchantId: string,
    buyerPrincipalId: string,
    backupGeneration: number,
  ): boolean {
    const suppression = this.db
      .prepare(
        `SELECT consent_generation, expires_at FROM workbench_deletion_suppressions
         WHERE merchant_id=? AND buyer_principal_id=?`,
      )
      .get(merchantId, buyerPrincipalId) as
      { consent_generation: number; expires_at: string } | undefined;
    if (suppression === undefined || Date.parse(suppression.expires_at) <= Date.parse(this.now()))
      return true;
    // 等于删除代次的备份也可能在清理完成前生成，必须先重放抑制；只有显式产生的
    // 更高新同意代次才可恢复经营用途。
    return backupGeneration > suppression.consent_generation;
  }

  activeSuppressions(): DeletionSuppressionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT merchant_id, buyer_principal_id, consent_generation, expires_at, created_at
         FROM workbench_deletion_suppressions WHERE expires_at>? ORDER BY merchant_id, buyer_principal_id`,
      )
      .all(this.now()) as Array<{
      merchant_id: string;
      buyer_principal_id: string;
      consent_generation: number;
      expires_at: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      merchantId: row.merchant_id,
      buyerPrincipalId: row.buyer_principal_id,
      consentGeneration: row.consent_generation,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }

  private assertDeletionComplete(requestId: string): void {
    const rows = this.db
      .prepare(
        "SELECT node_id, status, receipt_ref FROM workbench_privacy_deletion_tasks WHERE request_id=?",
      )
      .all(requestId) as Array<{ node_id: string; status: string; receipt_ref: string | null }>;
    if (
      rows.length !== REQUIRED_NODES.length ||
      rows.some((row) => row.status !== "completed" || clean(row.receipt_ref ?? "") === "")
    ) {
      throw new WorkbenchRetentionError(
        "DELETION_INCOMPLETE",
        "all controlled nodes must return completed receipts before the request can be completed",
      );
    }
  }

  private stopRuntimeMarketingAndFollow(
    merchantId: string,
    buyerPrincipalId: string,
    stamp: string,
  ): void {
    if (!this.tableExists("merchant_follow_subject_epochs")) return;
    this.db
      .prepare(
        `INSERT INTO merchant_follow_subject_epochs
         (merchant_id, buyer_principal_id, epoch, updated_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(merchant_id, buyer_principal_id) DO UPDATE SET
           epoch=epoch+1, updated_at=excluded.updated_at`,
      )
      .run(merchantId, buyerPrincipalId, stamp);
    const epoch = (
      this.db
        .prepare(
          `SELECT epoch FROM merchant_follow_subject_epochs
           WHERE merchant_id=? AND buyer_principal_id=?`,
        )
        .get(merchantId, buyerPrincipalId) as { epoch: number }
    ).epoch;
    if (this.tableExists("merchant_follow_relations")) {
      this.db
        .prepare(
          `UPDATE merchant_follow_relations SET status='cancelled', revision=revision+1,
             epoch=?, updated_at=?, cancelled_at=?
           WHERE merchant_id=? AND buyer_principal_id=? AND status='active'`,
        )
        .run(epoch, stamp, stamp, merchantId, buyerPrincipalId);
    }
    if (this.tableExists("merchant_follow_mutation_contexts")) {
      this.db
        .prepare(
          `UPDATE merchant_follow_mutation_contexts SET used_at=?
           WHERE merchant_id=? AND buyer_principal_id=? AND used_at IS NULL`,
        )
        .run(stamp, merchantId, buyerPrincipalId);
    }
  }

  private tableExists(table: string): boolean {
    const row = this.db
      .prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { present: number } | undefined;
    return row?.present === 1;
  }

  private requireRequest(requestId: string): PrivacyRequestRecord {
    const row = this.db
      .prepare("SELECT * FROM workbench_privacy_requests WHERE request_id=?")
      .get(requestId) as unknown as
      | {
          request_id: string;
          merchant_id: string;
          buyer_principal_id: string;
          status: PrivacyRequestStatus;
          consent_generation: number;
          received_at: string;
          updated_at: string;
        }
      | undefined;
    if (row === undefined) {
      throw new WorkbenchRetentionError("REQUEST_NOT_FOUND", "unknown privacy request");
    }
    return {
      requestId: row.request_id,
      merchantId: row.merchant_id,
      buyerPrincipalId: row.buyer_principal_id,
      status: row.status,
      consentGeneration: row.consent_generation,
      receivedAt: row.received_at,
      updatedAt: row.updated_at,
    };
  }
}

export function recommendedRetentionPolicy(input: {
  processor: string;
  basis: string;
  reviewAt: string;
}): RetentionPolicyEntry[] {
  const days: Readonly<Record<RetentionCategory, number>> = {
    follow_relationship: 365,
    follow_tombstone: 30,
    follow_idempotency: 7,
    broadcast_content: 30,
    feed_event: 30,
    engagement_detail: 30,
    negotiation_personal_content: 90,
    confirmation_temporary: 7,
    operation_trace: 180,
    minimal_audit: 180,
    debug_log: 30,
    anonymous_aggregate: 395,
    backup: 35,
    deletion_suppression: 42,
  };
  return RETENTION_CATEGORIES.map((category) => ({
    category,
    processor: input.processor,
    purpose: `Workbench ${category} necessary processing`,
    basis: input.basis,
    retentionDays: days[category],
    reviewAt: input.reviewAt,
  }));
}

function requireText(value: string, field: string): string {
  const text = clean(value);
  if (text === "")
    throw new WorkbenchRetentionError("POLICY_INVALID", `${field} must be non-empty`);
  return text;
}

function clean(value: string): string {
  return String(value ?? "").trim();
}

export function replayDeletionSuppressions(
  db: DatabaseSync,
  records: readonly DeletionSuppressionRecord[],
  now: string = new Date().toISOString(),
): { applied: number; deletedRows: number } {
  new WorkbenchRetentionStore({ db, now: () => now });
  let applied = 0;
  let deletedRows = 0;
  return inImmediateTransaction(db, () => {
    for (const record of records) {
      if (Date.parse(record.expiresAt) <= Date.parse(now)) continue;
      db.prepare(
        `INSERT INTO workbench_deletion_suppressions
         (merchant_id, buyer_principal_id, consent_generation, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(merchant_id, buyer_principal_id) DO UPDATE SET
           consent_generation=max(consent_generation, excluded.consent_generation),
           expires_at=max(expires_at, excluded.expires_at),
           created_at=excluded.created_at`,
      ).run(
        record.merchantId,
        record.buyerPrincipalId,
        record.consentGeneration,
        record.expiresAt,
        record.createdAt,
      );
      applied += 1;
      for (const table of [
        "merchant_follow_idempotency",
        "merchant_follow_mutation_contexts",
        "merchant_follow_relations",
        "merchant_broadcast_engagement",
      ]) {
        const exists = db
          .prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name=?")
          .get(table) as { present: number } | undefined;
        if (exists === undefined) continue;
        deletedRows += Number(
          db
            .prepare(`DELETE FROM ${table} WHERE merchant_id=? AND buyer_principal_id=?`)
            .run(record.merchantId, record.buyerPrincipalId).changes,
        );
      }
    }
    return { applied, deletedRows };
  });
}
