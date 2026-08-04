/**
 * Operator control plane types (docs/operator-tui-v0.2.md §5–§10).
 *
 * Three state domains stay separate: the marketplace conversation (owned by
 * shopping-cli), the operator session (this private event stream), and the
 * reasoning session (per-turn, never persisted here). Operator state is
 * derived by folding an append-only event log; nothing here calls HTTP or
 * holds secrets — formal writes stay behind CommerceClient.
 */

import type { DecisionAction, NegotiationDecision, Role } from "../negotiation/types.js";

/** Runtime modes (design §9). Default is `supervised`. */
export type OperatorMode = "autopilot" | "supervised" | "manual";
export const OPERATOR_MODES: readonly OperatorMode[] = ["autopilot", "supervised", "manual"];

/** Strategy patch risk classes (design §8). */
export type PatchKind = "tighten" | "soft_preference" | "relax" | "forbidden";
/** `turn` directives expire after one candidate settles; `session` persist. */
export type PatchScope = "session" | "turn";

/**
 * Structured result of compiling one operator message. The raw text never
 * enters the negotiation prompt directly; only the classified patch is kept.
 */
export interface StrategyPatch {
  kind: PatchKind;
  scope: PatchScope;
  /** One-line operator-facing summary of what was understood. */
  summary: string;
  /** Normalized directive text, kept private and applied to future turns. */
  directive: string;
  /** relax patches never apply without an explicit second confirmation. */
  requires_confirmation: boolean;
  /** Deterministic rule ids that produced this classification (for /why). */
  matched_rules: string[];
}

/** An applied strategy directive inside the effective strategy. */
export interface StrategyDirective {
  kind: Exclude<PatchKind, "forbidden">;
  scope: PatchScope;
  directive: string;
  summary: string;
  applied_at: string;
}

/**
 * The compiled session view: applied directives plus at most one relax patch
 * awaiting explicit confirmation. HardPolicy (profile buyer_policy /
 * merchant_policy) is NOT here — it lives in the profile and can never be
 * widened by a patch.
 */
export interface EffectiveStrategy {
  version: 1;
  directives: StrategyDirective[];
  /** relax patch waiting for the operator's explicit confirmation. */
  pending_relax?: StrategyPatch;
}

/** Approval-gate routing for a generated candidate (design §9). */
export type CandidateRoute = "auto_submit" | "await_approval" | "advice_only";

export type CandidateStatus =
  | "awaiting_approval"
  | "advice_only"
  | "approved"
  | "submitted"
  | "settled"
  | "rejected"
  | "superseded"
  | "expired";

/** Claim binding a candidate replies to; re-validated before any submit. */
export interface CandidateBinding {
  conversation_id: string;
  message_id: number;
  idempotency_key: string;
}

/**
 * An untrusted decision candidate. In supervised mode it is never submitted
 * before `/approve`; in manual mode it is advice only. `decision.public_message`
 * is the 公开草稿 (public draft) shown to the operator.
 */
export interface Candidate {
  candidate_id: string;
  binding: CandidateBinding;
  decision: NegotiationDecision;
  /** Concise decision-summary lines — never raw chain-of-thought. */
  analysis: string[];
  route: CandidateRoute;
  status: CandidateStatus;
  created_at: string;
}

/** Approval sub-state of the operator session (design §10, reduced). */
export type ApprovalState =
  | { kind: "idle" }
  | { kind: "awaiting_approval"; candidate_id: string }
  | { kind: "advice_ready"; candidate_id: string };

/** Event visibility (design §6). Private events never leave this process. */
export type EventVisibility = "private" | "public_draft" | "public_sent";

interface OperatorEventBase {
  event_id: string;
  occurred_at: string;
  agent_id: string;
  role: Role;
  visibility: EventVisibility;
  /** Operator identity source, e.g. "local_tui". */
  origin: string;
}

/** Append-only operator event stream (design §6). */
export type OperatorEvent = OperatorEventBase &
  (
    | { type: "operator.message"; payload: { text: string } }
    | { type: "strategy.patch.proposed"; payload: { patch: StrategyPatch } }
    | { type: "strategy.patch.applied"; payload: { patch: StrategyPatch } }
    | { type: "strategy.patch.rejected"; payload: { patch: StrategyPatch; reason: string } }
    | { type: "mode.changed"; payload: { from: OperatorMode; to: OperatorMode } }
    | { type: "negotiation.paused"; payload: { reason?: string } }
    | { type: "negotiation.resumed"; payload: { reason?: string } }
    | { type: "candidate.generated"; payload: { candidate: Candidate } }
    | { type: "candidate.approved"; payload: { candidate_id: string } }
    | { type: "candidate.rejected"; payload: { candidate_id: string; reason?: string } }
    | { type: "candidate.revised"; payload: { candidate_id: string; instruction: string } }
    | {
        type: "decision.submitted";
        payload: {
          candidate_id: string;
          action: DecisionAction;
          policy_result: string;
          message_id?: number;
        };
      }
    | {
        type: "turn.settled";
        payload: {
          candidate_id: string;
          settlement: "completed" | "failed" | "abandoned";
          reason?: string;
        };
      }
  );

export type OperatorEventType = OperatorEvent["type"];

/** Counters surfaced by `/usage`. Model tokens are backend-dependent. */
export interface OperatorStats {
  operator_messages: number;
  patches_applied: number;
  patches_rejected: number;
  candidates_generated: number;
  decisions_submitted: number;
  approvals: number;
  rejections: number;
  revisions: number;
}

/** The reduced operator session, rebuilt by folding the event stream. */
export interface OperatorState {
  started: boolean;
  shutdown: boolean;
  mode: OperatorMode;
  paused: boolean;
  strategy: EffectiveStrategy;
  approval: ApprovalState;
  candidates: Map<string, Candidate>;
  stats: OperatorStats;
  event_count: number;
}
