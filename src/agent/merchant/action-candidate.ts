/**
 * Approval WriteApprovalCandidates (design §16).
 *
 * The operator approves a specific argument set against a specific
 * precondition state — never a free-form "agree". A candidate carries:
 *   candidate_id, tool, arguments_hash, preconditions_hash, risk, expires_at.
 *
 * Execution re-reads the preconditions (product / inventory / conversation /
 * task state) and re-hashes them. If the state changed since the candidate
 * was created, the old approval is invalid: the candidate is superseded and
 * must be regenerated. The store is a plain SQLite-backed persistence layer;
 * the lifecycle routing (mode -> pending_approval / auto-execute) lives in
 * the tool layer.
 *
 * Privacy invariant: arguments_json / preconditions_json hold only public
 * catalog/inventory/task facts. Restricted values (private floors, costs)
 * never enter this table, the event log or model-visible output.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { uuidv7 } from "@earendil-works/pi-ai";

export const WRITE_APPROVAL_CANDIDATE_STATUSES = [
  "pending_approval",
  "approved",
  "executed",
  "rejected",
  "superseded",
  "expired",
] as const;
export type WriteApprovalCandidateStatus = (typeof WRITE_APPROVAL_CANDIDATE_STATUSES)[number];

export interface WriteApprovalCandidate {
  candidate_id: string;
  principal_id: string;
  task_id?: string;
  tool: string;
  arguments: Record<string, unknown>;
  arguments_hash: string;
  preconditions: Record<string, unknown>;
  preconditions_hash: string;
  risk: string;
  status: WriteApprovalCandidateStatus;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export class WriteApprovalCandidateError extends Error {
  readonly code: "not_found" | "conflict" | "expired";
  constructor(code: WriteApprovalCandidateError["code"], message: string) {
    super(message);
    this.name = "WriteApprovalCandidateError";
    this.code = code;
  }
}

/**
 * Deterministic canonical serialization (sorted keys, no undefined) so equal
 * argument sets always hash identically — content addressing across retries
 * and restarts.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** sha256 content hash of a structured value, prefixed for audit clarity. */
export function contentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export interface WriteApprovalCandidateStoreOptions {
  db: DatabaseSync;
  principalId: string;
  now?: () => string;
}

interface CandidateRow {
  candidate_id: string;
  principal_id: string;
  task_id: string | null;
  tool: string;
  arguments_json: string;
  arguments_hash: string;
  preconditions_json: string;
  preconditions_hash: string;
  risk: string;
  status: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export class WriteApprovalCandidateStore {
  private readonly db: DatabaseSync;
  private readonly principalId: string;
  private readonly now: () => string;

  constructor(options: WriteApprovalCandidateStoreOptions) {
    this.db = options.db;
    this.principalId = options.principalId;
    const clock = options.now ?? (() => new Date().toISOString());
    this.now = () => new Date(Date.parse(clock())).toISOString();
  }

  create(input: {
    tool: string;
    arguments: Record<string, unknown>;
    preconditions: Record<string, unknown>;
    risk: string;
    task_id?: string;
    expires_at: string;
  }): WriteApprovalCandidate {
    const candidateId = `act_${uuidv7()}`;
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO action_candidates
           (candidate_id, principal_id, task_id, tool, arguments_json, arguments_hash,
            preconditions_json, preconditions_hash, risk, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?)`,
      )
      .run(
        candidateId,
        this.principalId,
        input.task_id ?? null,
        input.tool,
        JSON.stringify(input.arguments),
        contentHash(input.arguments),
        JSON.stringify(input.preconditions),
        contentHash(input.preconditions),
        input.risk,
        input.expires_at,
        now,
        now,
      );
    return this.get(candidateId) as WriteApprovalCandidate;
  }

  get(candidateId: string): WriteApprovalCandidate | undefined {
    const row = this.db
      .prepare("SELECT * FROM action_candidates WHERE candidate_id = ? AND principal_id = ?")
      .get(candidateId, this.principalId) as unknown as CandidateRow | undefined;
    return row === undefined ? undefined : this.rowToCandidate(row);
  }

  listPending(): WriteApprovalCandidate[] {
    this.expireDue();
    const rows = this.db
      .prepare(
        "SELECT * FROM action_candidates WHERE principal_id = ? AND status = 'pending_approval' ORDER BY created_at, candidate_id",
      )
      .all(this.principalId) as unknown as CandidateRow[];
    return rows.map((r) => this.rowToCandidate(r));
  }

  /** Expire pending/approved candidates past their deadline. Returns count. */
  expireDue(): number {
    const now = this.now();
    const due = this.db
      .prepare(
        `SELECT candidate_id FROM action_candidates
         WHERE principal_id = ? AND status IN ('pending_approval','approved') AND expires_at < ?`,
      )
      .all(this.principalId, now) as { candidate_id: string }[];
    for (const { candidate_id } of due) {
      this.db
        .prepare("UPDATE action_candidates SET status = 'expired', updated_at = ? WHERE candidate_id = ?")
        .run(now, candidate_id);
    }
    return due.length;
  }

  private setStatus(candidateId: string, status: WriteApprovalCandidateStatus): WriteApprovalCandidate {
    const existing = this.get(candidateId);
    if (existing === undefined) throw new WriteApprovalCandidateError("not_found", `no candidate ${candidateId}`);
    this.db
      .prepare("UPDATE action_candidates SET status = ?, updated_at = ? WHERE candidate_id = ?")
      .run(status, this.now(), candidateId);
    return this.get(candidateId) as WriteApprovalCandidate;
  }

  /** Record operator approval (idempotent on already-approved/executed). */
  markApproved(candidateId: string): WriteApprovalCandidate {
    this.expireDue();
    const existing = this.get(candidateId);
    if (existing === undefined) throw new WriteApprovalCandidateError("not_found", `no candidate ${candidateId}`);
    if (existing.status === "executed" || existing.status === "approved") return existing;
    if (existing.status === "expired") throw new WriteApprovalCandidateError("expired", `candidate ${candidateId} expired`);
    if (existing.status !== "pending_approval") {
      throw new WriteApprovalCandidateError(
        "conflict",
        `candidate ${candidateId} is ${existing.status}, not approvable`,
      );
    }
    return this.setStatus(candidateId, "approved");
  }

  markExecuted(candidateId: string): WriteApprovalCandidate {
    return this.setStatus(candidateId, "executed");
  }

  reject(candidateId: string): WriteApprovalCandidate {
    return this.setStatus(candidateId, "rejected");
  }

  supersede(candidateId: string): WriteApprovalCandidate {
    return this.setStatus(candidateId, "superseded");
  }

  private rowToCandidate(row: CandidateRow): WriteApprovalCandidate {
    const candidate: WriteApprovalCandidate = {
      candidate_id: row.candidate_id,
      principal_id: row.principal_id,
      tool: row.tool,
      arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
      arguments_hash: row.arguments_hash,
      preconditions: JSON.parse(row.preconditions_json) as Record<string, unknown>,
      preconditions_hash: row.preconditions_hash,
      risk: row.risk,
      status: row.status as WriteApprovalCandidateStatus,
      expires_at: row.expires_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (row.task_id !== null) candidate.task_id = row.task_id;
    return candidate;
  }
}

// ---------------------------------------------------------------------------
// Approval execution
// ---------------------------------------------------------------------------

export type ApprovalExecutionResult =
  | { kind: "executed"; candidate: WriteApprovalCandidate; output: unknown }
  | { kind: "stale"; candidate: WriteApprovalCandidate; reason: string }
  | { kind: "expired"; candidate: WriteApprovalCandidate }
  | { kind: "not_approvable"; candidate: WriteApprovalCandidate; reason: string };

/**
 * Execute an approved candidate after re-validating its preconditions (§16):
 *  1. The candidate must be `approved` and not past its deadline.
 *  2. Preconditions are re-read from the current marketplace/task state and
 *     re-hashed. A different hash means the old approval no longer applies —
 *     the candidate is superseded and nothing is executed.
 *  3. Only the STORED arguments (what the operator approved) are executed,
 *     never anything re-read from the model.
 */
export async function executeApprovedCandidate(
  store: WriteApprovalCandidateStore,
  candidateId: string,
  hooks: {
    /** Re-read the current precondition state (product/task/conversation). */
    readPreconditions: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    /** Execute the write using the approved (stored) arguments. */
    execute: (args: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<ApprovalExecutionResult> {
  const candidate = store.get(candidateId);
  if (candidate === undefined) {
    throw new WriteApprovalCandidateError("not_found", `no candidate ${candidateId}`);
  }
  if (candidate.status === "expired") return { kind: "expired", candidate };
  if (candidate.status !== "approved") {
    return {
      kind: "not_approvable",
      candidate,
      reason: `候选 ${candidateId} 状态为 ${candidate.status}，不是 approved；不会执行。`,
    };
  }
  const freshPreconditions = await hooks.readPreconditions();
  const freshHash = contentHash(freshPreconditions);
  if (freshHash !== candidate.preconditions_hash) {
    store.supersede(candidateId);
    return {
      kind: "stale",
      candidate: store.get(candidateId) as WriteApprovalCandidate,
      reason:
        "前置状态已变化（preconditions_hash 不匹配），旧批准失效；已标记 superseded，请重新生成候选。",
    };
  }
  const output = await hooks.execute(candidate.arguments);
  const executed = store.markExecuted(candidateId);
  return { kind: "executed", candidate: executed, output };
}
