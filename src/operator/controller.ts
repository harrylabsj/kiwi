/**
 * OperatorController — the typed operator control plane (design §13).
 *
 * Owns the operator session: strategy, mode, approval state, pause/resume
 * and shutdown. Every state transition is recorded as an append-only event
 * and the state itself is derived by folding the event stream (reducer),
 * so a restart rebuilds the session from the store.
 *
 * Boundaries:
 * - no HTTP: formal writes go through NegotiationRunner -> CommerceClient;
 * - HardPolicy (profile) is never widened by a strategy patch;
 * - supervised is the default mode and never submits before approve();
 * - approve is idempotent per candidate_id (no duplicate formal messages);
 * - waiting approval, timeout-free: shutdown/reject/revise abandon the
 *   claim, they never complete an unsubmitted one;
 * - operator messages are private; only candidate drafts (already produced
 *   by the backend) are ever submitted, and only after the gate.
 */

import type { AgentProfile } from "../config/profile.js";
import type { NegotiationDecision } from "../negotiation/types.js";
import type { NegotiationRunner, PreparedCandidate } from "./runner.js";
import type { StrategyContext, StrategyEngine } from "./strategy.js";
import type { OperatorEventStore } from "./store.js";
import {
  OPERATOR_MODES,
  type Candidate,
  type CandidateRoute,
  type EventVisibility,
  type OperatorEvent,
  type OperatorMode,
  type OperatorState,
  type StrategyPatch,
} from "./types.js";

export const DEFAULT_OPERATOR_MODE: OperatorMode = "supervised";

// ---------------------------------------------------------------------------
// Approval gate (design §9)
// ---------------------------------------------------------------------------

/** Route a candidate by mode; autopilot escalates to approval on risk. */
export function routeCandidate(
  decision: NegotiationDecision,
  mode: OperatorMode,
  profile: AgentProfile,
): CandidateRoute {
  if (mode === "manual") return "advice_only";
  if (mode === "supervised") return "await_approval";
  // autopilot: risk escalation paths still require a human (design §9).
  if (decision.request_human_review || decision.action === "escalate") return "await_approval";
  if ((decision.confidence ?? 1) < 0.5) return "await_approval";
  const reviewOn =
    profile.role === "buyer"
      ? (profile.buyer_policy?.human_review_on ?? [])
      : (profile.merchant_policy?.human_review_on ?? []);
  if (decision.reason_codes.some((code) => reviewOn.includes(code))) return "await_approval";
  return "auto_submit";
}

// ---------------------------------------------------------------------------
// Reducer: OperatorState is a fold over the event stream
// ---------------------------------------------------------------------------

export function initialOperatorState(): OperatorState {
  return {
    started: false,
    shutdown: false,
    mode: DEFAULT_OPERATOR_MODE,
    paused: false,
    strategy: { version: 1, directives: [] },
    approval: { kind: "idle" },
    candidates: new Map(),
    stats: {
      operator_messages: 0,
      patches_applied: 0,
      patches_rejected: 0,
      candidates_generated: 0,
      decisions_submitted: 0,
      approvals: 0,
      rejections: 0,
      revisions: 0,
    },
    event_count: 0,
  };
}

function clearApprovalFor(state: OperatorState, candidateId: string): void {
  if (state.approval.kind !== "idle" && state.approval.candidate_id === candidateId) {
    state.approval = { kind: "idle" };
  }
}

/**
 * Fold one event into the state (mutates and returns `state`, fold-style).
 * Pure with respect to its inputs: same events -> same state.
 */
export function reduceOperatorEvent(state: OperatorState, event: OperatorEvent): OperatorState {
  state.event_count += 1;
  switch (event.type) {
    case "operator.message":
      state.stats.operator_messages += 1;
      break;
    case "strategy.patch.proposed":
      // A relax patch parks here until an explicit confirmation applies it.
      if (event.payload.patch.kind === "relax") {
        state.strategy.pending_relax = event.payload.patch;
      }
      break;
    case "strategy.patch.applied": {
      const patch = event.payload.patch;
      delete state.strategy.pending_relax;
      if (patch.kind !== "forbidden") {
        state.strategy.directives.push({
          kind: patch.kind,
          scope: patch.scope,
          directive: patch.directive,
          summary: patch.summary,
          applied_at: event.occurred_at,
        });
        state.stats.patches_applied += 1;
      }
      break;
    }
    case "strategy.patch.rejected":
      delete state.strategy.pending_relax;
      state.stats.patches_rejected += 1;
      break;
    case "mode.changed":
      state.mode = event.payload.to;
      break;
    case "negotiation.paused":
      state.paused = true;
      break;
    case "negotiation.resumed":
      state.paused = false;
      break;
    case "candidate.generated": {
      const candidate = event.payload.candidate;
      state.candidates.set(candidate.candidate_id, candidate);
      state.stats.candidates_generated += 1;
      if (candidate.route === "await_approval") {
        state.approval = { kind: "awaiting_approval", candidate_id: candidate.candidate_id };
      } else if (candidate.route === "advice_only") {
        state.approval = { kind: "advice_ready", candidate_id: candidate.candidate_id };
      }
      break;
    }
    case "candidate.approved": {
      const candidate = state.candidates.get(event.payload.candidate_id);
      if (candidate) candidate.status = "approved";
      state.stats.approvals += 1;
      break;
    }
    case "candidate.rejected": {
      const candidate = state.candidates.get(event.payload.candidate_id);
      if (candidate) candidate.status = "rejected";
      clearApprovalFor(state, event.payload.candidate_id);
      state.stats.rejections += 1;
      break;
    }
    case "candidate.revised": {
      const candidate = state.candidates.get(event.payload.candidate_id);
      if (candidate) candidate.status = "superseded";
      clearApprovalFor(state, event.payload.candidate_id);
      state.stats.revisions += 1;
      break;
    }
    case "decision.submitted": {
      const candidate = state.candidates.get(event.payload.candidate_id);
      if (candidate) candidate.status = "submitted";
      state.stats.decisions_submitted += 1;
      break;
    }
    case "turn.settled": {
      const candidate = state.candidates.get(event.payload.candidate_id);
      if (candidate) {
        if (event.payload.settlement === "completed") {
          candidate.status = "settled";
        } else if (candidate.status !== "rejected" && candidate.status !== "superseded") {
          // failed / abandoned: the candidate must never be submitted later.
          candidate.status = "expired";
        }
      }
      clearApprovalFor(state, event.payload.candidate_id);
      // Turn-scope directives expire once a candidate settles (design §7.3).
      state.strategy.directives = state.strategy.directives.filter((d) => d.scope !== "turn");
      break;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type OperatorMessageResult =
  | { kind: "applied"; patch: StrategyPatch }
  | { kind: "needs_confirmation"; patch: StrategyPatch }
  | { kind: "rejected"; patch?: StrategyPatch; reason: string };

export type ModeChangeResult =
  | { kind: "changed"; mode: OperatorMode }
  | { kind: "needs_confirmation"; mode: OperatorMode; reason: string }
  | { kind: "unchanged"; mode: OperatorMode }
  | { kind: "error"; error: string };

export type SimpleResult = { ok: true } | { ok: false; error: string };

export type ApprovalResult =
  | {
      kind: "submitted";
      candidate_id: string;
      policy_result: string;
      settlement: "completed" | "failed";
      message_id?: number;
    }
  | { kind: "replayed"; candidate_id: string }
  | { kind: "invalid"; reason: string };

export type PrepareResult =
  | { kind: "no_work" }
  | { kind: "blocked"; reason: string }
  | { kind: "awaiting_approval"; candidate: Candidate }
  | { kind: "advice_ready"; candidate: Candidate }
  | { kind: "auto_submitted"; candidate_id: string; policy_result: string; message_id?: number };

export interface WhyReport {
  candidate_id?: string;
  route?: CandidateRoute;
  analysis: string[];
  reason_codes: string[];
  active_directives: string[];
  note?: string;
}

export interface ShutdownResult {
  abandoned_candidate?: string;
  events: number;
}

export interface OperatorControllerOptions {
  profile: AgentProfile;
  store: OperatorEventStore;
  engine: StrategyEngine;
  runner: NegotiationRunner;
  /** Clock injection for deterministic tests. */
  now?: () => string;
  /** Operator identity source recorded on events (default "local_tui"). */
  origin?: string;
}

export class OperatorController {
  readonly profile: AgentProfile;
  private readonly store: OperatorEventStore;
  private readonly engine: StrategyEngine;
  private readonly runner: NegotiationRunner;
  private readonly now: () => string;
  private readonly origin: string;
  private readonly state: OperatorState;
  private readonly eventsLog: OperatorEvent[] = [];
  /** Live prepared turns for candidates generated by this process. */
  private readonly prepared = new Map<string, PreparedCandidate>();
  /** Messages rejected this session; not re-claimed until a later run. */
  private readonly rejectedMessageIds = new Set<number>();
  /** Last counterpart public message seen by prepare (TUI transcript pane). */
  lastCounterpartMessage?: string;
  private eventSeq = 0;
  private candidateSeq = 0;

  constructor(options: OperatorControllerOptions) {
    this.profile = options.profile;
    this.store = options.store;
    this.engine = options.engine;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date().toISOString());
    this.origin = options.origin ?? "local_tui";
    this.state = initialOperatorState();
  }

  getState(): OperatorState {
    return this.state;
  }

  /** Load and fold the persisted event stream (fail closed on corruption). */
  async start(): Promise<void> {
    const events = await this.store.readAll();
    for (const event of events) {
      reduceOperatorEvent(this.state, event);
      this.eventsLog.push(event);
    }
    this.eventSeq = events.length;
    this.candidateSeq = events.filter((e) => e.type === "candidate.generated").length;
    // Recovery rule (design §14.3/§14.4): a candidate from a previous run
    // cannot be re-validated against the live claim, so it is expired —
    // never submitted. The operator regenerates with fresh state.
    for (const candidate of this.state.candidates.values()) {
      if (
        candidate.status === "awaiting_approval" ||
        candidate.status === "advice_only" ||
        candidate.status === "approved"
      ) {
        candidate.status = "expired";
      }
    }
    if (this.state.approval.kind !== "idle") {
      const candidate = this.state.candidates.get(this.state.approval.candidate_id);
      if (!candidate || candidate.status === "expired") {
        this.state.approval = { kind: "idle" };
      }
    }
    this.state.started = true;
  }

  // ---- event plumbing -----------------------------------------------------

  private nextBase(visibility: EventVisibility): {
    event_id: string;
    occurred_at: string;
    agent_id: string;
    role: AgentProfile["role"];
    origin: string;
    visibility: EventVisibility;
  } {
    this.eventSeq += 1;
    return {
      event_id: `evt-${this.eventSeq}`,
      occurred_at: this.now(),
      agent_id: this.profile.agent_id,
      role: this.profile.role,
      origin: this.origin,
      visibility,
    };
  }

  private async record(event: OperatorEvent): Promise<void> {
    await this.store.append(event);
    reduceOperatorEvent(this.state, event);
    this.eventsLog.push(event);
  }

  /**
   * Compile context: profile HardPolicy values overridden by the LAST applied
   * budget/floor directive, so compiling again sees the session-effective
   * values (e.g. after a confirmed raise, "提高到 500" is no longer a raise).
   */
  private strategyContext(): StrategyContext {
    const context: StrategyContext = { role: this.profile.role };
    if (this.profile.buyer_policy) {
      let max = this.profile.buyer_policy.max_total_price_private;
      for (const d of this.state.strategy.directives) {
        if (/预算|budget/i.test(d.directive)) {
          const n = /\d+(?:\.\d+)?/.exec(d.directive);
          if (n !== null) max = Number(n[0]);
        }
      }
      context.buyer_max_total_price = max;
    }
    if (this.profile.merchant_policy?.min_unit_price_private !== undefined) {
      let floor = this.profile.merchant_policy.min_unit_price_private;
      for (const d of this.state.strategy.directives) {
        if (/底价|最低价|floor/i.test(d.directive)) {
          const n = /\d+(?:\.\d+)?/.exec(d.directive);
          if (n !== null) floor = Number(n[0]);
        }
      }
      context.merchant_min_unit_price = floor;
    }
    return context;
  }

  // ---- strategy + operator messages ---------------------------------------

  async sendOperatorMessage(text: string): Promise<OperatorMessageResult> {
    const trimmed = text.trim();
    if (trimmed === "") return { kind: "rejected", reason: "空消息" };
    if (this.state.shutdown) return { kind: "rejected", reason: "控制器已关闭" };

    await this.record({
      ...this.nextBase("private"),
      type: "operator.message",
      payload: { text: trimmed },
    });
    const patch = this.engine.compile(trimmed, this.strategyContext());
    await this.record({
      ...this.nextBase("private"),
      type: "strategy.patch.proposed",
      payload: { patch },
    });

    const risk = this.engine.assess(patch);
    if (risk.level === "blocked") {
      await this.record({
        ...this.nextBase("private"),
        type: "strategy.patch.rejected",
        payload: { patch, reason: risk.reason },
      });
      return { kind: "rejected", patch, reason: risk.reason };
    }
    if (risk.level === "confirm") {
      // The reducer parked the patch in strategy.pending_relax.
      return { kind: "needs_confirmation", patch };
    }
    await this.record({
      ...this.nextBase("private"),
      type: "strategy.patch.applied",
      payload: { patch },
    });
    return { kind: "applied", patch };
  }

  /** Apply the parked relax patch after the operator's explicit confirmation. */
  async confirmStrategy(): Promise<SimpleResult> {
    const pending = this.state.strategy.pending_relax;
    if (!pending) return { ok: false, error: "没有待确认的策略变更" };
    await this.record({
      ...this.nextBase("private"),
      type: "strategy.patch.applied",
      payload: { patch: pending },
    });
    return { ok: true };
  }

  // ---- mode ---------------------------------------------------------------

  async setMode(mode: OperatorMode, options?: { confirmed?: boolean }): Promise<ModeChangeResult> {
    if (this.state.shutdown) return { kind: "error", error: "控制器已关闭" };
    if (!OPERATOR_MODES.includes(mode)) {
      return { kind: "error", error: `未知模式: ${mode}（可选 ${OPERATOR_MODES.join("/")}）` };
    }
    const from = this.state.mode;
    if (from === mode) return { kind: "unchanged", mode };
    // Design §8: switching INTO autopilot requires explicit confirmation.
    if (mode === "autopilot" && options?.confirmed !== true) {
      return {
        kind: "needs_confirmation",
        mode,
        reason: "切换到 autopilot 需要显式确认：/mode autopilot confirm",
      };
    }
    await this.record({
      ...this.nextBase("private"),
      type: "mode.changed",
      payload: { from, to: mode },
    });
    return { kind: "changed", mode };
  }

  // ---- candidate lifecycle --------------------------------------------------

  /**
   * Pull the next pending message and generate a candidate. No Commerce
   * write happens unless the gate routes to auto_submit (autopilot).
   */
  async prepareNextCandidate(): Promise<PrepareResult> {
    if (this.state.shutdown) return { kind: "blocked", reason: "控制器已关闭" };
    if (this.state.paused) return { kind: "blocked", reason: "已暂停，/resume 后恢复" };
    if (this.state.approval.kind !== "idle") {
      return { kind: "blocked", reason: "已有待处理候选，请先 /approve、/reject 或 /revise" };
    }

    // Applied session/turn directives steer candidate generation (design §7).
    // The runner clamps them to the profile's HardPolicy, so they can narrow
    // but never widen the submit-time gates.
    const prepared = await this.runner.prepare({
      skipMessageIds: this.rejectedMessageIds,
      directives: [...this.state.strategy.directives],
    });
    if (!prepared) return { kind: "no_work" };

    this.candidateSeq += 1;
    const candidateId = `cand-${this.candidateSeq}`;
    const route = routeCandidate(prepared.decision, this.state.mode, this.profile);
    const candidate: Candidate = {
      candidate_id: candidateId,
      binding: prepared.binding,
      decision: prepared.decision,
      analysis: prepared.analysis,
      route,
      status:
        route === "await_approval"
          ? "awaiting_approval"
          : route === "advice_only"
            ? "advice_only"
            : "approved",
      created_at: this.now(),
    };
    if (prepared.counterpart_message !== undefined) {
      this.lastCounterpartMessage = prepared.counterpart_message;
    }
    this.prepared.set(candidateId, prepared);
    await this.record({
      ...this.nextBase("public_draft"),
      type: "candidate.generated",
      payload: { candidate },
    });

    if (route === "await_approval") return { kind: "awaiting_approval", candidate };
    if (route === "advice_only") return { kind: "advice_ready", candidate };

    const submitted = await this.submitCandidate(candidateId);
    if (submitted.kind === "submitted") {
      const result: PrepareResult & { kind: "auto_submitted" } = {
        kind: "auto_submitted",
        candidate_id: candidateId,
        policy_result: submitted.policy_result,
      };
      if (submitted.message_id !== undefined) result.message_id = submitted.message_id;
      return result;
    }
    if (submitted.kind === "invalid") return { kind: "blocked", reason: submitted.reason };
    return { kind: "blocked", reason: "auto submit replayed" };
  }

  private async submitCandidate(candidateId: string): Promise<ApprovalResult> {
    const candidate = this.state.candidates.get(candidateId);
    if (!candidate) return { kind: "invalid", reason: `未知候选 ${candidateId}` };
    // Idempotent approval replay: one candidate_id -> at most one formal message.
    if (candidate.status === "submitted" || candidate.status === "settled") {
      return { kind: "replayed", candidate_id: candidateId };
    }
    const prepared = this.prepared.get(candidateId);
    if (!prepared || candidate.status === "expired") {
      return { kind: "invalid", reason: "候选已过期（需重新生成），不会提交" };
    }

    const outcome = await this.runner.submit(prepared);
    const submittedPayload: {
      candidate_id: string;
      action: Candidate["decision"]["action"];
      policy_result: string;
      message_id?: number;
    } = {
      candidate_id: candidateId,
      action: candidate.decision.action,
      policy_result: outcome.policy_result.result,
    };
    if (outcome.policy_result.message_id !== undefined) {
      submittedPayload.message_id = outcome.policy_result.message_id;
    }
    await this.record({
      ...this.nextBase("public_sent"),
      type: "decision.submitted",
      payload: submittedPayload,
    });
    await this.record({
      ...this.nextBase("private"),
      type: "turn.settled",
      payload: {
        candidate_id: candidateId,
        settlement: outcome.settlement,
        ...(outcome.settlement === "failed" ? { reason: outcome.policy_result.public_reason } : {}),
      },
    });
    this.prepared.delete(candidateId);

    const result: ApprovalResult & { kind: "submitted" } = {
      kind: "submitted",
      candidate_id: candidateId,
      policy_result: outcome.policy_result.result,
      settlement: outcome.settlement,
    };
    if (outcome.policy_result.message_id !== undefined) {
      result.message_id = outcome.policy_result.message_id;
    }
    return result;
  }

  /** Approve the current awaiting candidate (idempotent per candidate_id). */
  async approve(candidateId?: string): Promise<ApprovalResult> {
    if (this.state.shutdown) return { kind: "invalid", reason: "控制器已关闭" };
    const id =
      candidateId ??
      (this.state.approval.kind === "awaiting_approval"
        ? this.state.approval.candidate_id
        : undefined);
    if (id === undefined) {
      return {
        kind: "invalid",
        reason:
          this.state.approval.kind === "advice_ready"
            ? "manual 模式只提供建议，不自动提交；可 /reject 放弃或 /revise 重算"
            : "没有等待审批的候选",
      };
    }
    if (
      this.state.approval.kind !== "awaiting_approval" ||
      this.state.approval.candidate_id !== id
    ) {
      const existing = this.state.candidates.get(id);
      if (existing && (existing.status === "submitted" || existing.status === "settled")) {
        return { kind: "replayed", candidate_id: id };
      }
      return { kind: "invalid", reason: `候选 ${id} 不在待审批状态` };
    }
    await this.record({
      ...this.nextBase("private"),
      type: "candidate.approved",
      payload: { candidate_id: id },
    });
    return this.submitCandidate(id);
  }

  private currentCandidateId(allowAdvice: boolean): string | undefined {
    if (this.state.approval.kind === "awaiting_approval") return this.state.approval.candidate_id;
    if (allowAdvice && this.state.approval.kind === "advice_ready") {
      return this.state.approval.candidate_id;
    }
    return undefined;
  }

  /** Reject the current candidate and abandon its claim. Never submits. */
  async reject(candidateId?: string, reason?: string): Promise<SimpleResult> {
    if (this.state.shutdown) return { ok: false, error: "控制器已关闭" };
    const id = candidateId ?? this.currentCandidateId(true);
    if (id === undefined) return { ok: false, error: "没有待处理的候选" };
    const candidate = this.state.candidates.get(id);
    if (
      !candidate ||
      (candidate.status !== "awaiting_approval" && candidate.status !== "advice_only")
    ) {
      return { ok: false, error: `候选 ${id} 不可驳回` };
    }
    await this.record({
      ...this.nextBase("private"),
      type: "candidate.rejected",
      payload: { candidate_id: id, ...(reason !== undefined ? { reason } : {}) },
    });
    this.rejectedMessageIds.add(candidate.binding.message_id);
    const prepared = this.prepared.get(id);
    if (prepared) {
      await this.runner.abandon(prepared, reason ?? "operator rejected candidate");
      this.prepared.delete(id);
    }
    await this.record({
      ...this.nextBase("private"),
      type: "turn.settled",
      payload: { candidate_id: id, settlement: "abandoned", reason: "operator rejected" },
    });
    return { ok: true };
  }

  /**
   * Record a turn instruction, abandon the old candidate's claim and
   * regenerate. The instruction is compiled as a turn-scope directive and
   * expires when the next candidate settles (design §7.3).
   */
  async revise(instruction: string, candidateId?: string): Promise<PrepareResult> {
    if (this.state.shutdown) return { kind: "blocked", reason: "控制器已关闭" };
    const trimmed = instruction.trim();
    if (trimmed === "") return { kind: "blocked", reason: "用法: /revise <新指令>" };
    const id = candidateId ?? this.currentCandidateId(true);
    if (id === undefined) return { kind: "blocked", reason: "没有可重算的候选" };
    const candidate = this.state.candidates.get(id);
    if (
      !candidate ||
      (candidate.status !== "awaiting_approval" && candidate.status !== "advice_only")
    ) {
      return { kind: "blocked", reason: `候选 ${id} 不可重算` };
    }

    // Compile BEFORE touching the candidate: a relax instruction must never
    // apply silently (design §8 — relax requires an explicit confirmation),
    // and a forbidden one is refused outright. Both leave the current
    // candidate, its claim and the strategy untouched.
    const patch = this.engine.compile(trimmed, this.strategyContext());
    if (patch.kind === "relax") {
      return {
        kind: "blocked",
        reason:
          `放宽约束不能通过 /revise 直接生效：${patch.summary}。候选保持不变；` +
          "如确需放宽，请以普通指令发送并用 /strategy confirm 确认（仍不会突破 profile 硬约束）。",
      };
    }
    if (patch.kind === "forbidden") {
      return { kind: "blocked", reason: `指令被拒绝：${patch.summary}。候选保持不变。` };
    }

    await this.record({
      ...this.nextBase("private"),
      type: "candidate.revised",
      payload: { candidate_id: id, instruction: trimmed },
    });
    const prepared = this.prepared.get(id);
    if (prepared) {
      await this.runner.abandon(prepared, "operator requested revise");
      this.prepared.delete(id);
    }
    await this.record({
      ...this.nextBase("private"),
      type: "turn.settled",
      payload: { candidate_id: id, settlement: "abandoned", reason: "operator revised" },
    });

    // Apply the instruction as a turn-scope strategy patch before regenerating.
    await this.record({
      ...this.nextBase("private"),
      type: "strategy.patch.applied",
      payload: { patch: { ...patch, scope: "turn" } },
    });
    return this.prepareNextCandidate();
  }

  // ---- pause / resume -------------------------------------------------------

  async pause(): Promise<SimpleResult> {
    if (this.state.shutdown) return { ok: false, error: "控制器已关闭" };
    if (this.state.paused) return { ok: true };
    await this.record({ ...this.nextBase("private"), type: "negotiation.paused", payload: {} });
    return { ok: true };
  }

  async resume(): Promise<SimpleResult> {
    if (this.state.shutdown) return { ok: false, error: "控制器已关闭" };
    if (!this.state.paused) return { ok: true };
    await this.record({ ...this.nextBase("private"), type: "negotiation.resumed", payload: {} });
    return { ok: true };
  }

  // ---- inspection -----------------------------------------------------------

  why(): WhyReport {
    const id = this.currentCandidateId(true);
    const directives = this.state.strategy.directives.map(
      (d) => `[${d.kind}/${d.scope}] ${d.summary}`,
    );
    if (id === undefined) {
      return {
        analysis: [],
        reason_codes: [],
        active_directives: directives,
        note: "当前没有候选决策",
      };
    }
    const candidate = this.state.candidates.get(id);
    if (!candidate) {
      return {
        analysis: [],
        reason_codes: [],
        active_directives: directives,
        note: "当前没有候选决策",
      };
    }
    return {
      candidate_id: id,
      route: candidate.route,
      analysis: [...candidate.analysis],
      reason_codes: [...candidate.decision.reason_codes],
      active_directives: directives,
    };
  }

  /** Recent events, newest last. Private to this operator session. */
  history(limit = 20): OperatorEvent[] {
    return this.eventsLog.slice(-Math.max(1, limit));
  }

  usage(): OperatorState["stats"] & { events: number } {
    return { ...this.state.stats, events: this.state.event_count };
  }

  // ---- shutdown ---------------------------------------------------------------

  /**
   * Safe shutdown (design §17): a candidate still waiting for approval is
   * best-effort abandoned (never completed) and kept as an audit record.
   */
  async shutdown(): Promise<ShutdownResult> {
    if (this.state.shutdown) return { events: this.state.event_count };
    const result: ShutdownResult = { events: 0 };
    const pendingId = this.currentCandidateId(true);
    if (pendingId !== undefined) {
      const prepared = this.prepared.get(pendingId);
      if (prepared) {
        await this.runner.abandon(prepared, "operator shutdown with pending candidate");
        this.prepared.delete(pendingId);
      }
      await this.record({
        ...this.nextBase("private"),
        type: "turn.settled",
        payload: {
          candidate_id: pendingId,
          settlement: "abandoned",
          reason: "operator shutdown",
        },
      });
      result.abandoned_candidate = pendingId;
    }
    this.state.shutdown = true;
    result.events = this.state.event_count;
    return result;
  }
}
