/**
 * NegotiationRunner — the safe v0.2.0 seam between the operator control
 * plane and the negotiation runtime (follow-up §3).
 *
 * Fully pausing the existing runNegotiationTurn would be a large unsafe
 * rewrite, so instead the turn is split at the candidate boundary:
 *
 *   prepare(): claim + snapshot + generate an UNTRUSTED candidate decision.
 *              No Commerce write happens here.
 *   submit():  the single formal write path — buyer local policy gate, then
 *              CommerceClient.submitNegotiationDecision with the content-
 *              addressed idempotency key, then claim settlement. Nothing is
 *              faked: every write goes through the CommerceClient boundary.
 *   abandon(): best-effort claim release for candidates that will not be
 *              submitted (reject / revise / shutdown). Never completes.
 *
 * DeterministicNegotiationRunner is the v0.2.0 adapter: it derives the
 * candidate with the same pure rule functions as the fake model
 * (runtime/fake-model.ts), so the TUI works offline against a real gateway
 * or the FakeCommerceClient. NEXT INTEGRATION HOOK: a PiNegotiationRunner
 * that generates the candidate with the embedded Pi loop (and later
 * Hermes/OpenClaw ACP backends) while keeping this prepare/submit contract.
 */

import type { AgentProfile } from "../config/profile.js";
import { idempotencyKey, type CommerceClient } from "../commerce/types.js";
import {
  PROTOCOL_VERSION,
  type NegotiationDecision,
  type NegotiationSnapshot,
  type PolicyResult,
} from "../negotiation/types.js";
import { checkBuyerLocalPolicy, localBuyerPolicyResult } from "../runtime/buyer-policy.js";
import { HEARTBEAT_INTERVAL_MS } from "../runtime/negotiation-turn.js";
import { startClaimHeartbeat, type ClaimHeartbeat } from "../runtime/heartbeat.js";
import {
  deterministicBuyerDecision,
  deterministicMerchantDecision,
} from "../runtime/fake-model.js";
import { submitIdempotencyKey } from "../runtime/tools.js";
import type { CandidateBinding, StrategyDirective } from "./types.js";
import type { DecisionHints } from "../runtime/fake-model.js";

/** A claimed turn with a generated, not-yet-submitted candidate decision. */
export interface PreparedCandidate {
  binding: CandidateBinding;
  decision: NegotiationDecision;
  /** Concise decision-summary lines (no chain-of-thought, no private numbers). */
  analysis: string[];
  conversation_status: string;
  /** Last counterpart public message, for the TUI transcript pane. */
  counterpart_message?: string;
}

export interface SubmitOutcome {
  policy_result: PolicyResult;
  /** completed = gateway accepted/escalated and claim completed; failed = claim failed. */
  settlement: "completed" | "failed";
}

export interface NegotiationRunner {
  /**
   * Claim the next pending message and generate a candidate. No write.
   * `skipMessageIds` excludes messages the operator rejected this session;
   * they stay reclaimable for later runs (abandoned, never completed).
   * `directives` are the applied session/turn strategy directives that guide
   * candidate generation (design §7) — the compiled hints never widen the
   * profile's HardPolicy, which the gates re-check at submit time.
   */
  prepare(options?: {
    skipMessageIds?: ReadonlySet<number>;
    directives?: readonly StrategyDirective[];
  }): Promise<PreparedCandidate | undefined>;
  /** Submit an approved candidate through the Commerce boundary and settle. */
  submit(prepared: Pick<PreparedCandidate, "binding" | "decision">): Promise<SubmitOutcome>;
  /** Best-effort abandon of the claim behind a candidate. Never completes. */
  abandon(prepared: Pick<PreparedCandidate, "binding">, reason: string): Promise<void>;
  /**
   * Start claim heartbeats while a candidate sits awaiting approval (design
   * §10): the claim must not be stolen by stale recovery during a long human
   * decision. Stop before submit/abandon.
   */
  startHeartbeat(prepared: Pick<PreparedCandidate, "binding">): void;
  stopHeartbeat(): Promise<void>;
}

/**
 * Translate the applied strategy directives into structured generation
 * hints for the deterministic backends (design §7). Rules mirror
 * StrategyEngine.compile: budget/floor/quantity directives carry numbers,
 * soft preferences are recognized by their wording. Unmatched preferences
 * stay recorded and visible (/strategy, /why) but have no rule-based effect
 * in the deterministic backend — an LLM backend (v0.2.1) consumes them.
 */
export function compileDirectiveHints(directives: readonly StrategyDirective[]): DecisionHints {
  const hints: DecisionHints = {};
  for (const directive of directives) {
    if (/预算|budget/i.test(directive.directive)) {
      const amount = /\d+(?:\.\d+)?/.exec(directive.directive);
      if (amount !== null) hints.buyer_max_total_price = Number(amount[0]);
    }
    if (/底价|最低价|floor/i.test(directive.directive)) {
      const amount = /\d+(?:\.\d+)?/.exec(directive.directive);
      if (amount !== null) hints.merchant_min_unit_price = Number(amount[0]);
    }
    if (/最多(买|要)?\s*\d+|at most \d+/i.test(directive.directive)) {
      const amount = /\d+/.exec(directive.directive);
      if (amount !== null) {
        const cap = Number(amount[0]);
        // A degenerate cap ("最多买 0 件") would produce 0-quantity quotes.
        if (cap >= 1) {
          hints.quantity_cap = Math.min(hints.quantity_cap ?? Number.POSITIVE_INFINITY, cap);
        }
      }
    }
    if (/包邮|免运费|免配送费|free shipping/i.test(directive.directive)) {
      hints.prefer_free_shipping = true;
    }
    if (/只问|先问|仅询问|only ask|just ask/i.test(directive.directive)) {
      hints.ask_only = true;
    }
  }
  return hints;
}

/**
 * Clamp compiled hints to the profile's HardPolicy (design §7.1): directives
 * may only NARROW the envelope the deterministic backend works with. A
 * confirmed relax directive stays recorded (/strategy, /why) but its hint is
 * clamped here, so generation can never exceed what the submit-time gates
 * (buyer local policy + gateway policy gate) enforce from the profile.
 */
export function clampHintsToHardPolicy(profile: AgentProfile, hints: DecisionHints): DecisionHints {
  const clamped = { ...hints };
  const budget = profile.buyer_policy?.max_total_price_private;
  if (clamped.buyer_max_total_price !== undefined && budget !== undefined) {
    clamped.buyer_max_total_price = Math.min(clamped.buyer_max_total_price, budget);
  }
  const floor = profile.merchant_policy?.min_unit_price_private;
  if (clamped.merchant_min_unit_price !== undefined && floor !== undefined) {
    clamped.merchant_min_unit_price = Math.max(clamped.merchant_min_unit_price, floor);
  }
  return clamped;
}

/** Concise, private-number-free decision summary lines for the TUI. */
function buildAnalysis(
  profile: AgentProfile,
  snapshot: NegotiationSnapshot,
  decision: NegotiationDecision,
): string[] {
  const lines: string[] = [];
  const proposal = decision.proposal;
  if (profile.role === "buyer" && profile.buyer_policy && proposal) {
    const policy = profile.buyer_policy;
    const total = proposal.unit_price * proposal.quantity + proposal.delivery.fee;
    lines.push(
      total <= policy.max_total_price_private ? "总价在私有预算约束内" : "总价超出私有预算约束",
    );
    const etaOk = Date.parse(proposal.delivery.eta_end) <= Date.parse(policy.acceptable_eta_latest);
    lines.push(etaOk ? "交期在可接受范围内" : "交期超出可接受范围");
    const refs = new Set(proposal.after_sales_policy_refs);
    const missing = policy.required_after_sales_terms.filter((term) => !refs.has(term));
    lines.push(
      missing.length === 0 ? "售后条款满足要求" : `售后条款缺少 ${missing.length} 项必需条款`,
    );
  }
  if (profile.role === "merchant" && proposal) {
    const floor = profile.merchant_policy?.min_unit_price_private;
    if (floor !== undefined) {
      lines.push(
        proposal.unit_price >= floor ? "报价不低于私有底价" : "报价低于私有底价，将被策略门拦截",
      );
    }
    lines.push(
      proposal.quantity <= snapshot.stock.quantity ? "库存数量可满足" : "库存不足，无法满足该数量",
    );
  }
  if (decision.action === "escalate") lines.push("建议转人工处理");
  if (decision.action === "decline") lines.push("建议拒绝当前磋商");
  lines.push(`理由代码: ${decision.reason_codes.join(", ") || "无"}`);
  return lines;
}

/**
 * v0.2.0 deterministic adapter. Candidate generation reuses the pure
 * rule-based decision functions; submission reuses the same gates as the
 * headless turn (buyer local policy -> gateway policy gate -> settlement).
 */
export interface DeterministicRunnerOptions {
  /** Claim-heartbeat cadence while awaiting approval (defaults to runtime value). */
  heartbeatIntervalMs?: number;
}

export class DeterministicNegotiationRunner implements NegotiationRunner {
  private readonly profile: AgentProfile;
  private readonly client: CommerceClient;
  private readonly heartbeatIntervalMs: number;
  private heartbeat?: ClaimHeartbeat;

  constructor(profile: AgentProfile, client: CommerceClient, options?: DeterministicRunnerOptions) {
    this.profile = profile;
    this.client = client;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  }

  startHeartbeat(prepared: Pick<PreparedCandidate, "binding">): void {
    // Never stack beaters: a newer claim supersedes the older one's heartbeat.
    this.heartbeat?.stop();
    this.heartbeat = startClaimHeartbeat(
      this.client,
      prepared.binding.message_id,
      this.heartbeatIntervalMs,
    );
  }

  async stopHeartbeat(): Promise<void> {
    const beat = this.heartbeat;
    this.heartbeat = undefined;
    await beat?.stop();
  }

  async prepare(options?: {
    skipMessageIds?: ReadonlySet<number>;
    directives?: readonly StrategyDirective[];
  }): Promise<PreparedCandidate | undefined> {
    const pending = await this.client.listPendingMessages();
    const target = pending.find((m) => options?.skipMessageIds?.has(m.message_id) !== true);
    if (!target) return undefined;

    const idem = idempotencyKey(this.profile.agent_id, target.message_id, PROTOCOL_VERSION);
    const claim = await this.client.claimMessage({
      conversation_id: target.conversation_id,
      message_id: target.message_id,
      idempotency_key: idem,
    });
    if (!claim.claimed) return undefined;

    const snapshot = await this.client.getNegotiationSnapshot({
      conversation_id: target.conversation_id,
      message_id: target.message_id,
    });

    const hints = clampHintsToHardPolicy(
      this.profile,
      compileDirectiveHints(options?.directives ?? []),
    );
    const decision =
      this.profile.role === "buyer"
        ? deterministicBuyerDecision(
            snapshot,
            this.profile.buyer_policy ?? {
              max_total_price_private: Number.POSITIVE_INFINITY,
              acceptable_eta_latest: "9999-12-31T23:59:59Z",
              required_after_sales_terms: [],
            },
            hints,
          )
        : deterministicMerchantDecision(
            snapshot,
            this.profile.merchant_policy?.quote_ttl_seconds ?? 300,
            hints,
          );

    const counterpart = [...snapshot.messages]
      .reverse()
      .find((m) => m.sender_role !== snapshot.role);

    const prepared: PreparedCandidate = {
      binding: {
        conversation_id: target.conversation_id,
        message_id: target.message_id,
        idempotency_key: idem,
      },
      decision,
      analysis: buildAnalysis(this.profile, snapshot, decision),
      conversation_status: snapshot.conversation.status,
    };
    if (counterpart !== undefined) prepared.counterpart_message = counterpart.public_message;
    return prepared;
  }

  async submit(prepared: Pick<PreparedCandidate, "binding" | "decision">): Promise<SubmitOutcome> {
    const { binding, decision } = prepared;

    // Buyer local private policy gate first (same as runtime/tools.ts): a
    // violation never reaches the gateway and never leaks private numbers.
    if (this.profile.role === "buyer" && this.profile.buyer_policy) {
      const violation = checkBuyerLocalPolicy(decision, this.profile.buyer_policy);
      if (violation) {
        const local = localBuyerPolicyResult(binding.conversation_id, violation, 0);
        await this.client.failClaim({
          message_id: binding.message_id,
          idempotency_key: binding.idempotency_key,
          error: `local policy rejected: ${violation.reason_codes.join(", ")}`,
        });
        return { policy_result: local, settlement: "failed" };
      }
    }

    const result = await this.client.submitNegotiationDecision({
      decision,
      idempotency_key: submitIdempotencyKey(binding.idempotency_key, decision),
    });

    if (result.result === "accepted" || result.result === "human_required") {
      await this.client.completeClaim({
        message_id: binding.message_id,
        idempotency_key: binding.idempotency_key,
      });
      return { policy_result: result, settlement: "completed" };
    }

    await this.client.failClaim({
      message_id: binding.message_id,
      idempotency_key: binding.idempotency_key,
      error: `policy rejected: ${result.public_reason}`,
    });
    return { policy_result: result, settlement: "failed" };
  }

  async abandon(prepared: Pick<PreparedCandidate, "binding">, reason: string): Promise<void> {
    // Best-effort: the 300s stale-claim TTL stays the backstop if this fails.
    try {
      await this.client.abandonClaim({
        message_id: prepared.binding.message_id,
        idempotency_key: prepared.binding.idempotency_key,
        error: reason,
      });
    } catch {
      // Abandon must never mask the operator-facing outcome.
    }
  }
}
