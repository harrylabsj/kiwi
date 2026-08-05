/**
 * Principal Memory types (design v0.3 §6–§9).
 *
 * A memory is a governed, evidence-backed state — never a chat summary.
 * Every item answers: what is remembered, who said it (or which behavior
 * showed it), kind, confidence, scope, review/expiry and sensitivity.
 */

export const MEMORY_NAMESPACES = [
  "profile",
  "constraint",
  "preference",
  "routine",
  "episode",
  "task_context",
] as const;
export type MemoryNamespace = (typeof MEMORY_NAMESPACES)[number];

export const MEMORY_SOURCE_KINDS = ["explicit", "observed", "inferred", "imported"] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export const MEMORY_SENSITIVITIES = ["normal", "private", "restricted"] as const;
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];

export const MEMORY_STATUSES = [
  "candidate",
  "active",
  "needs_review",
  "superseded",
  "deleted",
  "expired",
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const EVIDENCE_SOURCE_TYPES = [
  "chat",
  "task_feedback",
  "selection",
  "rejection",
  "import",
] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

export const MEMORY_EVENT_TYPES = [
  "memory.proposed",
  "memory.confirmed",
  "memory.activated",
  "memory.corrected",
  "memory.contradicted",
  "memory.superseded",
  "memory.forgotten",
  "memory.expired",
] as const;
export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[number];

export const RETRIEVAL_PURPOSES = ["filter", "rank", "clarify", "negotiate", "explain"] as const;
export type RetrievalPurpose = (typeof RETRIEVAL_PURPOSES)[number];

export const VAULT_KINDS = [
  "address",
  "contact",
  "private_budget",
  "merchant_cost",
  "merchant_floor",
  "other",
] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

/** Retrieval precision handed to the model, recorded in the retrieval log. */
export const REDACTION_LEVELS = ["full", "coarse", "metadata_only"] as const;
export type RedactionLevel = (typeof REDACTION_LEVELS)[number];

/** Empty scope = global. A scoped memory applies only inside its scope. */
export interface MemoryScope {
  category?: string;
  platform?: string;
  merchant_id?: string;
  task_id?: string;
}

export interface Principal {
  principal_id: string;
  owner_id: string;
  role: "buyer" | "merchant";
  display_name?: string;
  locale: string;
  timezone: string;
  memory_schema_version: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryItem {
  memory_id: string;
  principal_id: string;
  namespace: MemoryNamespace;
  key: string;
  /** Structured value. Undefined when the value lives in the Vault. */
  value?: unknown;
  vault_ref?: string;
  scope: MemoryScope;
  source_kind: MemorySourceKind;
  confidence: number;
  sensitivity: MemorySensitivity;
  status: MemoryStatus;
  confirmed_at?: string;
  valid_from?: string;
  expires_at?: string;
  last_observed_at?: string;
  evidence_count: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryEvidence {
  evidence_id: string;
  memory_id: string;
  source_type: EvidenceSourceType;
  /** Session/task/event reference — never raw reasoning. */
  source_ref: string;
  polarity: "support" | "contradict";
  weight: number;
  summary: string;
  observed_at: string;
  created_at: string;
}

export interface MemoryEventRecord {
  event_id: string;
  memory_id: string;
  type: MemoryEventType;
  actor: string;
  reason?: string;
  /** Minimal before/after version summaries — never Restricted plaintext. */
  before_json?: unknown;
  after_json?: unknown;
  created_at: string;
}

export interface RetrievalLogEntry {
  retrieval_id: string;
  task_id?: string;
  session_id: string;
  memory_id: string;
  purpose: RetrievalPurpose;
  redaction_level: RedactionLevel;
  created_at: string;
}

/** A memory as handed to the model: Restricted values never leave the store. */
export interface RetrievedMemory {
  memory_id: string;
  namespace: MemoryNamespace;
  key: string;
  value?: unknown;
  scope: MemoryScope;
  source_kind: MemorySourceKind;
  confidence: number;
  sensitivity: MemorySensitivity;
  status: "active" | "needs_review";
  redaction_level: RedactionLevel;
  score: number;
  last_observed_at?: string;
}

export class MemoryError extends Error {
  readonly code:
    | "validation"
    | "not_found"
    | "conflict"
    | "vault_unavailable"
    | "store_corrupted";
  constructor(code: MemoryError["code"], message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

export function isMemoryNamespace(value: unknown): value is MemoryNamespace {
  return typeof value === "string" && (MEMORY_NAMESPACES as readonly string[]).includes(value);
}
export function isMemorySourceKind(value: unknown): value is MemorySourceKind {
  return typeof value === "string" && (MEMORY_SOURCE_KINDS as readonly string[]).includes(value);
}
export function isMemorySensitivity(value: unknown): value is MemorySensitivity {
  return typeof value === "string" && (MEMORY_SENSITIVITIES as readonly string[]).includes(value);
}
export function isRetrievalPurpose(value: unknown): value is RetrievalPurpose {
  return typeof value === "string" && (RETRIEVAL_PURPOSES as readonly string[]).includes(value);
}
export function isVaultKind(value: unknown): value is VaultKind {
  return typeof value === "string" && (VAULT_KINDS as readonly string[]).includes(value);
}

/** Strict scope validation: unknown fields fail closed. */
export function parseMemoryScope(value: unknown): MemoryScope {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryError("validation", "scope must be an object");
  }
  const out: MemoryScope = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length === 0 || v.length > 200) {
      throw new MemoryError("validation", `scope.${k} must be a non-empty string`);
    }
    if (k === "category") out.category = v;
    else if (k === "platform") out.platform = v;
    else if (k === "merchant_id") out.merchant_id = v;
    else if (k === "task_id") out.task_id = v;
    else throw new MemoryError("validation", `unknown scope field: ${k}`);
  }
  return out;
}
