/**
 * Role-aware single-turn orchestration (buyer and merchant share one loop).
 *
 * Flow per design §10 (with M3 reliability):
 *   capabilities (fail closed) -> recover own stale claims -> list pending
 *   -> claim -> Pi agent loop under claim heartbeat (snapshot -> decision)
 *   -> policy result -> complete / fail / abandon.
 *
 * The marketplace conversation is the authoritative memory; no Pi session is
 * persisted. Every turn rebuilds its context from the snapshot.
 *
 * Shutdown semantics (design §16.2): an external AbortSignal (SIGINT/SIGTERM
 * in the foreground loop) aborts the Pi run; a claim that was never accepted
 * is abandoned (never completed) so another worker can pick it up. A
 * decision already accepted by the policy gate is never rolled back — the
 * claim completes normally.
 */

import { Agent, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentProfile } from "../config/profile.js";
import type { CommerceClient } from "../commerce/types.js";
import { CommerceError, idempotencyKey } from "../commerce/types.js";
import { PROTOCOL_VERSION, type PolicyResult } from "../negotiation/types.js";
import { systemPromptForRole, userPromptForRole } from "../negotiation/prompt.js";
import {
  buildNegotiationTools,
  createToolGuard,
  toolAllowlistForRole,
  type ToolOutcomeTracker,
} from "./tools.js";
import { buildModel, resolveThinkingLevel } from "./model.js";
import { startClaimHeartbeat } from "./heartbeat.js";

export type TurnOutcome =
  | { kind: "no_work" }
  | { kind: "already_claimed"; status: string }
  | { kind: "accepted"; message_id?: number }
  | { kind: "human_required"; reason_codes: string[] }
  | { kind: "no_decision"; reason: string }
  | { kind: "timeout"; reason: string }
  | { kind: "aborted"; reason: string }
  | { kind: "failed"; error: string; retriable: boolean };

export interface TurnUsage {
  input: number;
  output: number;
  total: number;
  cost_total: number;
}

export interface TurnReport {
  outcome: TurnOutcome;
  conversation_id?: string;
  message_id?: number;
  idempotency_key?: string;
  policy_result?: PolicyResult;
  steps: number;
  usage: TurnUsage;
  /** Claim heartbeat activity while the turn held the claim. */
  heartbeat?: { beats: number; failures: number };
}

export interface NegotiationTurnOptions {
  profile: AgentProfile;
  client: CommerceClient;
  streamFn: StreamFn;
  /** Resolves the model API key for the real provider; unused for fake. */
  getApiKey?: () => string | undefined;
  /** External shutdown signal (SIGINT/SIGTERM). Aborts the Pi run. */
  signal?: AbortSignal;
  /** Claim heartbeat cadence; defaults to HEARTBEAT_INTERVAL_MS. */
  heartbeatIntervalMs?: number;
}

const REQUIRED_CAPABILITIES = [
  "consultation_read",
  "consultation_write",
  "inventory_read",
] as const;

/**
 * M3 reliability constants (documented in README): claims untouched for
 * STALE_CLAIM_TTL_SECONDS are recovered as crashed; a claimed turn
 * heartbeats every HEARTBEAT_INTERVAL_MS — comfortably below the TTL — so
 * healthy long turns are never mistaken for crashed ones.
 */
export const STALE_CLAIM_TTL_SECONDS = 300;
export const HEARTBEAT_INTERVAL_MS = 60_000;

export async function runNegotiationTurn(options: NegotiationTurnOptions): Promise<TurnReport> {
  const { profile, client, streamFn } = options;
  const usage: TurnUsage = { input: 0, output: 0, total: 0, cost_total: 0 };

  // 0. Protocol + capability check: fail closed.
  const caps = await client.getCapabilities();
  if (!caps.protocol_versions.includes(PROTOCOL_VERSION)) {
    throw new CommerceError(
      "validation",
      `Gateway does not support ${PROTOCOL_VERSION}: ${caps.protocol_versions.join(", ")}`,
    );
  }
  for (const cap of REQUIRED_CAPABILITIES) {
    if (!caps.capabilities[cap]) {
      throw new CommerceError("validation", `Gateway lacks required capability: ${cap}`);
    }
  }
  if (caps.capabilities.orders !== false) {
    throw new CommerceError("validation", "Gateway violates the no-order boundary (orders=true)");
  }

  // 0.5. Crash recovery BEFORE any work or heartbeat on this runtime:
  // abandon this identity's own stale processing claims (never revives them;
  // abandoned claims stay reclaimable). Runs in once and foreground modes.
  await client.abandonStaleClaims({ ttl_seconds: STALE_CLAIM_TTL_SECONDS });

  // 1. Find work. Role and owner are derived from the token server-side.
  const pending = await client.listPendingMessages();
  const target = pending[0];
  if (!target) {
    return { outcome: { kind: "no_work" }, steps: 0, usage };
  }

  // 2. Claim. Idempotency key: agent_id + message_id + protocol version.
  const idem = idempotencyKey(profile.agent_id, target.message_id, PROTOCOL_VERSION);
  const claim = await client.claimMessage({
    conversation_id: target.conversation_id,
    message_id: target.message_id,
    idempotency_key: idem,
  });
  const base = {
    conversation_id: target.conversation_id,
    message_id: target.message_id,
    idempotency_key: idem,
  };
  if (!claim.claimed) {
    return {
      outcome: { kind: "already_claimed", status: claim.status },
      ...base,
      steps: 0,
      usage,
    };
  }

  // 3. Run the constrained Pi agent loop under a claim heartbeat: a healthy
  // long turn refreshes the claim so it is never mistaken for a crashed one.
  const heartbeat = startClaimHeartbeat(
    client,
    target.message_id,
    options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
  );
  let report: TurnReport;
  try {
    report = await finishTurn(options, profile, client, streamFn, target, idem, base, usage);
  } catch (err) {
    // An error escaping a claimed turn (transient snapshot/submit/settle
    // failures) must not strand the claim until the 300s stale TTL:
    // best-effort abandon so the message is reclaimable immediately. The
    // stale TTL stays the backstop if this abandon fails too.
    try {
      await client.abandonClaim({
        message_id: target.message_id,
        idempotency_key: idem,
        error: `turn escaped settlement: ${err instanceof Error ? err.message : String(err)}`,
      });
    } catch {
      // The original error is what propagates.
    }
    throw err;
  } finally {
    // No timer or in-flight heartbeat outlives the turn.
    await heartbeat.stop();
  }
  return { ...report, heartbeat: { beats: heartbeat.beats(), failures: heartbeat.failures() } };
}

interface TurnTarget {
  conversation_id: string;
  message_id: number;
}

async function finishTurn(
  options: NegotiationTurnOptions,
  profile: AgentProfile,
  client: CommerceClient,
  streamFn: StreamFn,
  target: TurnTarget,
  idem: string,
  base: { conversation_id: string; message_id: number; idempotency_key: string },
  usage: TurnUsage,
): Promise<TurnReport> {
  const tracker: ToolOutcomeTracker = { submissions: 0 };
  const binding = {
    conversation_id: target.conversation_id,
    message_id: target.message_id,
    idempotency_key: idem,
  };
  // max_retries = repair attempts beyond the first submission.
  const maxSubmissions = profile.runtime.max_retries + 1;
  const tools = buildNegotiationTools(client, binding, tracker, maxSubmissions, {
    ...(profile.role === "buyer" && profile.buyer_policy
      ? { buyerPolicy: profile.buyer_policy }
      : {}),
  });
  const guard = createToolGuard(toolAllowlistForRole(profile.role), binding);

  const model = buildModel(profile);
  const thinkingLevel = resolveThinkingLevel(profile);
  let steps = 0;
  let stepCapHit = false;
  const maxSteps = profile.runtime.max_model_steps;

  const agent = new Agent({
    streamFn,
    initialState: {
      systemPrompt: systemPromptForRole(profile),
      model,
      tools,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    },
    convertToLlm: (messages) => messages as Message[],
    toolExecution: "sequential",
    beforeToolCall: guard,
    ...(options.getApiKey !== undefined ? { getApiKey: options.getApiKey } : {}),
  });

  agent.subscribe((event: AgentEvent) => {
    if (event.type === "turn_end") {
      steps += 1;
      if (steps >= maxSteps) {
        stepCapHit = true;
        agent.abort();
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = event.message.usage;
      usage.input += u.input;
      usage.output += u.output;
      usage.total += u.totalTokens;
      usage.cost_total += u.cost.total;
    }
    return undefined;
  });

  const timeoutMs = profile.runtime.turn_timeout_seconds * 1000;
  let timedOut = false;
  let externalAbort = options.signal?.aborted === true;
  const onExternalAbort = (): void => {
    externalAbort = true;
    agent.abort();
  };
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, timeoutMs);
  let runError: string | undefined;
  try {
    await agent.prompt(userPromptForRole(profile.role, target.conversation_id, target.message_id));
    await agent.waitForIdle();
    if (agent.state.errorMessage) {
      runError = agent.state.errorMessage;
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }

  // 4. Settle the claim based on the policy result. A decision the gate
  // already accepted is never rolled back, even if a shutdown arrived
  // afterwards.
  const result = tracker.decisionResult;
  if (result) {
    if (result.result === "accepted") {
      await client.completeClaim({ message_id: target.message_id, idempotency_key: idem });
      const outcome: TurnOutcome = { kind: "accepted" };
      if (result.message_id !== undefined) outcome.message_id = result.message_id;
      return { outcome, ...base, policy_result: result, steps, usage };
    }
    if (result.result === "human_required") {
      // The turn did its job by escalating; the conversation now routes to a
      // human. Completing the claim avoids an infinite retry loop.
      await client.completeClaim({ message_id: target.message_id, idempotency_key: idem });
      return {
        outcome: { kind: "human_required", reason_codes: result.reason_codes },
        ...base,
        policy_result: result,
        steps,
        usage,
      };
    }
    // rejected_retryable with no successful resubmission inside the turn.
    if (externalAbort) {
      // Shutdown semantics (design §16.2): a claim that was never accepted
      // is abandoned, never failed — both are reclaimable, but abandon is
      // the documented "unsettled on shutdown" settlement.
      const reason = "shutdown: turn aborted by signal before a decision was accepted";
      await client.abandonClaim({
        message_id: target.message_id,
        idempotency_key: idem,
        error: reason,
      });
      return {
        outcome: { kind: "aborted", reason },
        ...base,
        policy_result: result,
        steps,
        usage,
      };
    }
    const budgetNote = tracker.submissionLimitExceeded
      ? `; submission budget exhausted (max_retries=${profile.runtime.max_retries})`
      : "";
    await client.failClaim({
      message_id: target.message_id,
      idempotency_key: idem,
      error: `policy rejected: ${result.public_reason}${budgetNote}`,
    });
    return {
      outcome: {
        kind: "failed",
        error: `policy rejected: ${result.public_reason}${budgetNote}`,
        retriable: true,
      },
      ...base,
      policy_result: result,
      steps,
      usage,
    };
  }

  // 5. No decision submitted. External shutdown abandons the claim (another
  // worker may retry it); timeout/step-cap/model errors fail it. Neither is
  // ever completed.
  let outcome: TurnOutcome;
  let reason: string;
  if (externalAbort) {
    reason = "shutdown: turn aborted by signal before a decision was accepted";
    outcome = { kind: "aborted", reason };
    await client.abandonClaim({
      message_id: target.message_id,
      idempotency_key: idem,
      error: reason,
    });
    return { outcome, ...base, steps, usage };
  }
  if (timedOut) {
    reason = `turn timed out after ${profile.runtime.turn_timeout_seconds}s without a decision`;
    outcome = { kind: "timeout", reason };
  } else if (stepCapHit) {
    reason = `model did not submit a decision within ${maxSteps} steps`;
    outcome = { kind: "no_decision", reason };
  } else if (runError !== undefined && runError !== "") {
    reason = `model error: ${runError}`;
    outcome = { kind: "failed", error: reason, retriable: !isModelConfigError(runError) };
  } else {
    reason = "model ended without submitting a decision";
    outcome = { kind: "no_decision", reason };
  }
  await client.failClaim({
    message_id: target.message_id,
    idempotency_key: idem,
    error: reason,
  });
  return { outcome, ...base, steps, usage };
}

/** Model auth/config problems are not retried by an external supervisor. */
function isModelConfigError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("api key") ||
    m.includes("unauthorized") ||
    m.includes("401") ||
    m.includes("403") ||
    m.includes("forbidden") ||
    m.includes("quota")
  );
}
