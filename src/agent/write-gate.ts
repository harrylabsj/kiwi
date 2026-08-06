/**
 * Shared write-gate for main-conversation write tools (design §16).
 *
 * Every write operation produces a content-hashed WriteApprovalCandidate
 * (arguments_hash + preconditions_hash + risk + expires_at). The gate routes
 * by mode:
 *   manual      -> advice only (never executes);
 *   supervised  -> pending_approval; the operator approves via /approve;
 *   autopilot   -> executes immediately unless a risk escalation applies.
 *
 * Execution always re-reads the preconditions and re-hashes them — a stale
 * approval is superseded, never executed. Only the stored (approved)
 * arguments are executed; nothing is re-read from the model at execution
 * time. Restricted values never enter candidate arguments or preconditions.
 */

import type { AgentProfile } from "../config/profile.js";
import type { OperatorApprovalStatusSource } from "../handoff/operator-approval.js";
import type { AgentMode } from "./mode.js";
import {
  executeApprovedCandidate,
  type WriteApprovalCandidate,
  type WriteApprovalCandidateStore,
} from "./merchant/action-candidate.js";

/** Default approval window (design §16 expires_at). */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export type WriteGateResult =
  | { kind: "executed"; candidate: WriteApprovalCandidate; output: unknown }
  | { kind: "pending_approval"; candidate: WriteApprovalCandidate }
  | { kind: "advice_only"; candidate: WriteApprovalCandidate }
  | { kind: "forbidden"; reason: string };

export interface WriteGateDeps {
  mode: () => AgentMode;
  approvals: WriteApprovalCandidateStore;
  profile: AgentProfile;
  now: () => string;
  /**
   * Register execution hooks for a pending candidate so the kernel's
   * `/approve` can execute it later. Hooks are process-lifetime only: a
   * candidate left pending across a restart cannot be re-validated and is
   * expired on recovery (design §18.3), exactly like the operator plane.
   */
  registerPending?: (
    candidateId: string,
    hooks: {
      readPreconditions: () => Promise<Record<string, unknown>> | Record<string, unknown>;
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    },
  ) => void;
}

/**
 * Adapt a WriteApprovalCandidateStore into the handoff operator-approval status
 * seam. The bridge (OperatorApprovalAuthorizationProvider) consults this so an
 * approval that is revoked / superseded / expired in the candidate store also
 * invalidates any checkout authorization minted from it. Unknown candidates
 * surface as `undefined` (fail closed).
 */
export function writeApprovalStatusSource(
  store: WriteApprovalCandidateStore,
): OperatorApprovalStatusSource {
  return {
    getApprovalState(candidateId) {
      const candidate = store.get(candidateId);
      if (candidate === undefined) return undefined;
      return { status: candidate.status, expires_at: candidate.expires_at };
    },
  };
}

export interface WriteCandidateInput {
  tool: string;
  arguments: Record<string, unknown>;
  preconditions: Record<string, unknown>;
  risk: string;
  task_id?: string;
  ttl_ms?: number;
  /** Execute the write with the approved (stored) arguments. */
  execute: (args: Record<string, unknown>) => Promise<unknown>;
  /** Re-read the current precondition state for stale detection. */
  readPreconditions: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  /**
   * Autopilot risk escalation: return a reason when this specific write must
   * still go to a human, or undefined to auto-execute within HardPolicy.
   */
  autopilotEscalation?: (args: Record<string, unknown>) => string | undefined;
  /**
   * Draft semantics: the candidate is always pending /approve (never
   * auto-executed, even in autopilot) — design §16 "生成公开草稿".
   */
  force_pending?: boolean;
}

/** Create + route one write candidate. Returns the gate outcome. */
export async function routeWriteCandidate(
  deps: WriteGateDeps,
  input: WriteCandidateInput,
): Promise<WriteGateResult> {
  const mode = deps.mode();
  const candidate = deps.approvals.create({
    tool: input.tool,
    arguments: input.arguments,
    preconditions: input.preconditions,
    risk: input.risk,
    ...(input.task_id !== undefined ? { task_id: input.task_id } : {}),
    expires_at: new Date(
      Date.parse(deps.now()) + (input.ttl_ms ?? APPROVAL_TTL_MS),
    ).toISOString(),
  });

  const pendingHooks = { readPreconditions: input.readPreconditions, execute: input.execute };
  if (mode === "manual") {
    deps.registerPending?.(candidate.candidate_id, pendingHooks);
    return { kind: "advice_only", candidate };
  }
  if (mode === "supervised") {
    deps.registerPending?.(candidate.candidate_id, pendingHooks);
    return { kind: "pending_approval", candidate };
  }
  // autopilot: escalate on risk, otherwise execute within HardPolicy.
  const escalate = input.autopilotEscalation?.(input.arguments);
  if (escalate !== undefined) {
    deps.registerPending?.(candidate.candidate_id, pendingHooks);
    return { kind: "pending_approval", candidate };
  }
  // Draft semantics: always pending, never auto-execute.
  if (input.force_pending === true) {
    deps.registerPending?.(candidate.candidate_id, pendingHooks);
    return { kind: "pending_approval", candidate };
  }
  deps.approvals.markApproved(candidate.candidate_id);
  const outcome = await executeApprovedCandidate(
    deps.approvals,
    candidate.candidate_id,
    { readPreconditions: input.readPreconditions, execute: input.execute },
  );
  if (outcome.kind === "executed") {
    return { kind: "executed", candidate: outcome.candidate, output: outcome.output };
  }
  // Fresh candidates should never be stale/expired on immediate execution,
  // but fail safe rather than pretending an unexecuted write happened.
  return { kind: "pending_approval", candidate: outcome.candidate };
}
