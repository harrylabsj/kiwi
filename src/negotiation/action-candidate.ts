/**
 * A2A v0.4 candidate model (docs/kiwi-a2a-architecture-baseline.md §7).
 *
 * ActionCandidate is the unified base class semantics: "Agent 建议执行、但尚未
 * 真正执行的外部有副作用动作" — an external side-effectful action the agent
 * suggests but has not yet executed. NegotiationActionCandidate is its
 * negotiation subtype. DecisionCandidate is retained ONLY as a v0.2
 * compatibility term and bridged by toNegotiationActionCandidate(); new code
 * must not create a third candidate model.
 *
 * Nothing in a candidate proves execution. The approval pipeline (§19) binds
 * candidate_digest + expected_remote_revision + policy_version +
 * counterparty_identity, and re-reads + re-validates remote state before any
 * send — any bound-field change makes the candidate STALE.
 */

import { contentDigest } from "./jcs.js";
import type { DecisionAction, NegotiationDecision } from "./types.js";

export const ACTION_CANDIDATE_KINDS = ["negotiation"] as const;
export type ActionCandidateKind = (typeof ACTION_CANDIDATE_KINDS)[number];

/** Risk levels bound to a candidate (mirrors the operator's strategy risk). */
export const CANDIDATE_RISK_LEVELS = ["ok", "confirm", "blocked"] as const;
export type CandidateRiskLevel = (typeof CANDIDATE_RISK_LEVELS)[number];

export interface CandidateRisk {
  level: CandidateRiskLevel;
  reason: string;
}

/** Base: a suggested, not-yet-executed external side-effectful action. */
export interface ActionCandidate {
  /** Stable identifier; never reused for a different action. */
  candidate_id: string;
  /** Subtype discriminant for narrowing across candidate families. */
  kind: ActionCandidateKind;
  /** The proposed external side-effect action, as a stable action token. */
  action: string;
  /** The payload the action would be executed with. */
  payload: unknown;
}

/** Negotiation action candidate — an ActionCandidate bound to a negotiation. */
export interface NegotiationActionCandidate extends ActionCandidate {
  kind: "negotiation";
  action: DecisionAction;
  payload: NegotiationDecision;
  /** The business negotiation this candidate belongs to (v0.2 conversation_id). */
  negotiation_id: string;
  /** RFC 8785 JCS + SHA-256 content digest of the bound candidate fields. */
  candidate_digest: string;
  /** Remote revision the candidate was generated against (§19 re-validation). */
  expected_remote_revision: string;
  /** Policy version that produced/approved this candidate. */
  policy_version: string;
  /** Counterparty identity the candidate targets, as observed by us. */
  counterparty_identity: string;
  /** Public draft shown to the counterpart (never private reasoning). */
  public_message: string;
  reason_codes: string[];
  risk: CandidateRisk;
}

/**
 * v0.2 compatibility term (docs §6/§7.3). The v0.2 operator control plane's
 * `Candidate` (`src/operator/types.ts`) satisfies this shape. Only the bridge
 * below still names it; new code consumes NegotiationActionCandidate.
 */
export interface DecisionCandidate {
  candidate_id: string;
  binding: {
    conversation_id: string;
    message_id: number;
  };
  decision: NegotiationDecision;
  created_at: string;
}

/** Context bindings the v0.2 DecisionCandidate does not carry itself. */
export interface NegotiationActionCandidateContext {
  expected_remote_revision: string;
  policy_version: string;
  counterparty_identity: string;
  risk: CandidateRisk;
}

export class CandidateAdapterError extends Error {
  readonly code: "missing_field" | "invalid_field";
  readonly field?: string;
  constructor(code: CandidateAdapterError["code"], message: string, field?: string) {
    super(message);
    this.name = "CandidateAdapterError";
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Adapter: DecisionCandidate (v0.2) -> NegotiationActionCandidate
// ---------------------------------------------------------------------------

const DECISION_ACTIONS = [
  "ask",
  "propose",
  "counter",
  "accept_nonbinding",
  "decline",
  "escalate",
] as const;

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CandidateAdapterError("missing_field", `${field} is required`, field);
  }
  return value;
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new CandidateAdapterError("invalid_field", `${field} must be a positive integer`, field);
  }
  return value;
}

function requireDecisionAction(value: unknown): DecisionAction {
  if (typeof value !== "string" || !(DECISION_ACTIONS as readonly string[]).includes(value)) {
    throw new CandidateAdapterError(
      "invalid_field",
      `action must be one of ${DECISION_ACTIONS.join("/")}`,
      "action",
    );
  }
  return value as DecisionAction;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CandidateAdapterError("invalid_field", `${field} must be a string array`, field);
  }
  return [...value];
}

function requireRisk(value: unknown, field: string): CandidateRisk {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CandidateAdapterError("missing_field", `${field} is required`, field);
  }
  const risk = value as Record<string, unknown>;
  const level = risk.level;
  if (typeof level !== "string" || !(CANDIDATE_RISK_LEVELS as readonly string[]).includes(level)) {
    throw new CandidateAdapterError(
      "invalid_field",
      `${field}.level must be ${CANDIDATE_RISK_LEVELS.join("|")}`,
      `${field}.level`,
    );
  }
  const reason = risk.reason;
  if (typeof reason !== "string" || reason.length === 0) {
    throw new CandidateAdapterError("missing_field", `${field}.reason is required`, `${field}.reason`);
  }
  return { level: level as CandidateRiskLevel, reason };
}

/**
 * Bridge the v0.2 DecisionCandidate into the v0.4 NegotiationActionCandidate.
 * Missing or malformed binding fields fail closed (CandidateAdapterError); the
 * digest is always recomputed from the mapped fields, never trusted from input.
 */
export function toNegotiationActionCandidate(
  decision: DecisionCandidate,
  context: NegotiationActionCandidateContext,
): NegotiationActionCandidate {
  const candidateId = requireNonEmptyString(decision.candidate_id, "candidate_id");
  const negotiationId = requireNonEmptyString(
    decision.binding?.conversation_id,
    "binding.conversation_id",
  );
  requirePositiveInt(decision.binding?.message_id, "binding.message_id");
  const d = decision.decision;
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    throw new CandidateAdapterError("invalid_field", "decision must be an object", "decision");
  }
  const action = requireDecisionAction(d.action);
  const publicMessage = requireNonEmptyString(d.public_message, "decision.public_message");
  const reasonCodes = requireStringArray(d.reason_codes, "decision.reason_codes");
  const expectedRemoteRevision = requireNonEmptyString(
    context.expected_remote_revision,
    "context.expected_remote_revision",
  );
  const policyVersion = requireNonEmptyString(context.policy_version, "context.policy_version");
  const counterpartyIdentity = requireNonEmptyString(
    context.counterparty_identity,
    "context.counterparty_identity",
  );
  const risk = requireRisk(context.risk, "context.risk");

  const fields = {
    kind: "negotiation",
    candidate_id: candidateId,
    negotiation_id: negotiationId,
    action,
    payload: d,
    expected_remote_revision: expectedRemoteRevision,
    policy_version: policyVersion,
    counterparty_identity: counterpartyIdentity,
    public_message: publicMessage,
    reason_codes: reasonCodes,
    risk,
  } satisfies Omit<NegotiationActionCandidate, "candidate_digest">;

  return { ...fields, candidate_digest: candidateDigest(fields) };
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * RFC 8785 JCS + SHA-256 digest over the bound candidate fields (docs §17).
 * `candidate_digest` itself is excluded — content addressing never hashes its
 * own envelope. Equal candidates always produce the same digest; any bound
 * field change produces a different one.
 */
export function candidateDigest(input: Omit<NegotiationActionCandidate, "candidate_digest">): string {
  return contentDigest({
    kind: input.kind,
    candidate_id: input.candidate_id,
    negotiation_id: input.negotiation_id,
    action: input.action,
    payload: input.payload,
    expected_remote_revision: input.expected_remote_revision,
    policy_version: input.policy_version,
    counterparty_identity: input.counterparty_identity,
    public_message: input.public_message,
    reason_codes: input.reason_codes,
    risk: input.risk,
  });
}

/** Recomputed-digest check; false means the candidate is stale (§19). */
export function verifyCandidateDigest(candidate: NegotiationActionCandidate): boolean {
  const { candidate_digest, ...rest } = candidate;
  return candidateDigest(rest) === candidate_digest;
}
