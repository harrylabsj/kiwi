/**
 * AgentKernel (design §4.1): lifecycle and concurrency owner of one Kiwi
 * agent instance.
 *
 * v0.3.0-A responsibilities:
 * - open/recover the persistent main conversation (Pi AgentHarness Session);
 * - serialize every user message, slash command and (later) event through
 *   one queue — only the kernel submits state changes;
 * - retrieve relevant memories per turn (logged, redaction-leveled) and
 *   inject them into the system prompt as an untamperable briefing;
 * - expose memory write tools to the model (governance lives in
 *   MemoryStore) and deterministic slash commands to the operator.
 */

import {
  AgentHarness,
  type Session,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import type { AgentProfile } from "../config/profile.js";
import type { CommerceClient } from "../commerce/types.js";
import { ensureAgentPaths, openAgentDatabase, type AgentPaths } from "./agent-db.js";
import { buildBuyerTools } from "./buyer/buyer-tools.js";
import { TaskScheduler, type TickBudget, type TickResult } from "./buyer/scheduler.js";
import { BuyerTaskStore } from "./buyer/task-store.js";
import { buildMemoryTools } from "./chat-tools.js";
import type { CommerceConnector } from "./connector/types.js";
import { AGENT_MODES, DEFAULT_AGENT_MODE, isAgentMode, type AgentMode } from "./mode.js";
import {
  ActionCandidateStore,
  executeApprovedCandidate,
  type ApprovalExecutionResult,
} from "./merchant/action-candidate.js";
import type { CredentialBroker } from "./merchant/credential-broker.js";
import type { MerchantClient } from "./merchant/types.js";
import { buildMerchantTools } from "./merchant/merchant-tools.js";
import { DeterministicNegotiationRunner } from "../operator/runner.js";
import { MemoryStore } from "./memory/store.js";
import { MemoryError, type MemoryItem, type Principal } from "./memory/types.js";
import { PrivateVault } from "./memory/vault.js";
import { openMainSession } from "./session.js";
import { baseSystemPrompt, renderMemoryBriefing } from "./system-prompt.js";
import type { DatabaseSync } from "node:sqlite";

/** Execution hooks for a pending ActionCandidate (process-lifetime only). */
export interface PendingActionHooks {
  readPreconditions: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export const MAIN_SESSION_ID = "main";

export interface AgentKernelOptions {
  profile: AgentProfile;
  /** Injectable paths (tests); defaults to .kiwi/agents/<agent_id>. */
  paths?: AgentPaths;
  models: Models;
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  vault?: PrivateVault;
  /** Buyer tasks read facts through this connector (v0.3.0-B). */
  connector?: CommerceConnector;
  /**
   * Negotiation CommerceClient (v0.3.0-C): claim/snapshot/submit for linked
   * consultations. Optional — negotiation tools fail closed when absent.
   */
  commerceClient?: CommerceClient;
  /** Merchant catalog/inventory client (merchant kernels). */
  merchantClient?: MerchantClient;
  /** Credential Broker: negotiation/catalog/inventory scopes (§15.4). */
  broker?: CredentialBroker;
  /** Runtime write-approval mode (§16); defaults to supervised. */
  mode?: AgentMode;
  now?: () => string;
}

export interface KernelReply {
  /** Public assistant answer or deterministic command output. */
  text: string;
  /** True when the command was /quit. */
  quit: boolean;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** The owner's own Restricted memory values (Vault). Owner-only by isolation. */
function listRestrictedValues(store: MemoryStore): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const m of store.listMemories({ sensitivity: "restricted" })) {
    if (m.vault_ref === undefined) continue;
    try {
      out.push({ key: m.key, value: store.openVaultValue(m.vault_ref) });
    } catch {
      // data key unavailable on this run: skip rather than crash the read
    }
  }
  return out;
}

const COMMANDS_HELP = `/memory [preferences|private]  查看记忆概览 / 学习到的偏好 / 私密资料字段与状态
/forget <memory-id|描述>   删除记忆（tombstone + 审计）
/correct <memory-id> <新内容>  修正记忆（保留前后版本审计）
/confirm <memory-id>       人工确认候选记忆生效（硬约束/敏感记忆必须人工确认）
/private                   查看你自己的私密阈值明文（成本/底价，仅你可见，勿写入对外消息）
/why                       说明最近的回答使用了哪些记忆
/mode [manual|supervised|autopilot] [confirm]  查看或切换写操作审批模式
/pending                   列出等待批准的写操作候选
/approve <candidate-id>    批准并执行一个写操作候选（重新校验前置状态）
/reject <candidate-id>     驳回一个写操作候选（绝不执行）
/help                      本帮助
/quit                      退出`;

export class AgentKernel {
  readonly profile: AgentProfile;
  readonly principal: Principal;
  private readonly paths: AgentPaths;
  private readonly db: DatabaseSync;
  private readonly store: MemoryStore;
  private readonly session: Session;
  private readonly harness: AgentHarness;
  private briefing: string | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private shutdownRequested = false;
  private closed = false;
  private readonly taskStore?: BuyerTaskStore;
  private readonly scheduler?: TaskScheduler;
  private readonly approvals?: ActionCandidateStore;
  private readonly commerceClient?: CommerceClient;
  private readonly merchantClient?: MerchantClient;
  private readonly broker?: CredentialBroker;
  /** Shared mutable mode ref (tools read it via a getter before the kernel exists). */
  private readonly modeRef: { value: AgentMode } = { value: DEFAULT_AGENT_MODE };
  /** Live execution hooks for pending candidates (v0.3.0-C /approve). */
  private readonly pendingHooks: Map<string, PendingActionHooks>;
  /** Current conversation-turn id, shared with the remember tool (evidence dedup §9.3). */
  private readonly turnId: { current: string };
  private turnSeq = 0;

  private constructor(options: {
    profile: AgentProfile;
    paths: AgentPaths;
    db: DatabaseSync;
    store: MemoryStore;
    principal: Principal;
    session: Session;
    harness: AgentHarness;
    taskStore?: BuyerTaskStore;
    scheduler?: TaskScheduler;
    approvals?: ActionCandidateStore;
    commerceClient?: CommerceClient;
    merchantClient?: MerchantClient;
    broker?: CredentialBroker;
    modeRef?: { value: AgentMode };
    pendingHooks?: Map<string, PendingActionHooks>;
    turnId: { current: string };
  }) {
    this.profile = options.profile;
    this.paths = options.paths;
    this.db = options.db;
    this.store = options.store;
    this.principal = options.principal;
    this.session = options.session;
    this.harness = options.harness;
    if (options.taskStore !== undefined) this.taskStore = options.taskStore;
    if (options.scheduler !== undefined) this.scheduler = options.scheduler;
    if (options.approvals !== undefined) this.approvals = options.approvals;
    if (options.commerceClient !== undefined) this.commerceClient = options.commerceClient;
    if (options.merchantClient !== undefined) this.merchantClient = options.merchantClient;
    if (options.broker !== undefined) this.broker = options.broker;
    if (options.modeRef !== undefined) this.modeRef = options.modeRef;
    this.pendingHooks = options.pendingHooks ?? new Map();
    this.turnId = options.turnId;
  }

  static async open(options: AgentKernelOptions): Promise<AgentKernel> {
    const paths = options.paths ?? ensureAgentPaths(options.profile.agent_id);
    const db = openAgentDatabase(paths.db);
    const vault = options.vault ?? new PrivateVault();
    const store = new MemoryStore({ db, vault, ...(options.now ? { now: options.now } : {}) });
    const principal = store.ensurePrincipal({
      principal_id: options.profile.agent_id,
      owner_id: options.profile.owner_id,
      role: options.profile.role,
    });
    store.bindPrincipal(principal.principal_id);
    let session: Session;
    try {
      session = await openMainSession(paths);
    } catch (err) {
      db.close(); // never leak the SQLite handle on a fail-closed open
      throw err;
    }

    // Buyer capability pack (v0.3.0-B): task store + scheduler + tools.
    // All clocks are normalized to UTC ISO (SQLite compares timestamps
    // lexicographically; mixed offsets would silently break due checks).
    const clock = () => new Date(Date.parse((options.now ?? (() => new Date().toISOString()))())).toISOString();
    const modeRef = { value: options.mode ?? DEFAULT_AGENT_MODE };
    const pendingHooks = new Map<string, PendingActionHooks>();
    const turnId = { current: MAIN_SESSION_ID };
    const registerPending: (id: string, hooks: PendingActionHooks) => void = (id, hooks) => {
      pendingHooks.set(id, hooks);
    };

    const approvals = new ActionCandidateStore({ db, principalId: principal.principal_id, now: clock });
    let taskStore: BuyerTaskStore | undefined;
    let scheduler: TaskScheduler | undefined;
    let buyerTools: ReturnType<typeof buildBuyerTools> = [];
    let merchantTools: ReturnType<typeof buildMerchantTools> = [];
    if (options.profile.role === "buyer" && options.connector !== undefined) {
      taskStore = new BuyerTaskStore({ db, principalId: principal.principal_id, now: clock, vault });
      scheduler = new TaskScheduler({
        store: taskStore,
        connectors: [options.connector],
        now: clock,
      });
      buyerTools = buildBuyerTools({
        store: taskStore,
        connector: options.connector,
        profile: options.profile,
        ...(options.commerceClient !== undefined ? { commerceClient: options.commerceClient } : {}),
        ...(options.broker !== undefined ? { broker: options.broker } : {}),
        approvals,
        mode: () => modeRef.value,
        registerPending,
        now: clock,
      });
    } else if (
      options.profile.role === "merchant" &&
      options.merchantClient !== undefined &&
      options.commerceClient !== undefined &&
      options.broker !== undefined
    ) {
      merchantTools = buildMerchantTools({
        profile: options.profile,
        merchantClient: options.merchantClient,
        commerceClient: options.commerceClient,
        broker: options.broker,
        approvals,
        mode: () => modeRef.value,
        registerPending,
        now: clock,
        privateValues: () => listRestrictedValues(store),
      });
    }

    const base = baseSystemPrompt(options.profile, principal);
    let briefing: string | undefined;
    const harness = new AgentHarness({
      session,
      models: options.models,
      model: options.model,
      tools: [...buildMemoryTools(store, { turnId: () => turnId.current }), ...buyerTools, ...merchantTools],
      systemPrompt: async () => (briefing === undefined ? base : `${base}\n\n${briefing}`),
      // §18.1: a hung model/provider request must NOT wedge the chat forever —
      // abort after the profile's turn timeout and surface an error text.
      streamOptions: {
        timeoutMs: options.profile.runtime.turn_timeout_seconds * 1000,
      },
      ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
    });

    const kernel = new AgentKernel({
      profile: options.profile,
      paths,
      db,
      store,
      principal,
      session,
      harness,
      approvals,
      modeRef,
      pendingHooks,
      turnId,
      ...(taskStore !== undefined ? { taskStore } : {}),
      ...(scheduler !== undefined ? { scheduler } : {}),
      ...(options.commerceClient !== undefined ? { commerceClient: options.commerceClient } : {}),
      ...(options.merchantClient !== undefined ? { merchantClient: options.merchantClient } : {}),
      ...(options.broker !== undefined ? { broker: options.broker } : {}),
    });
    kernel.briefingSetter = (value) => {
      briefing = value;
    };
    return kernel;
  }

  private briefingSetter: (value: string | undefined) => void = () => undefined;

  get memoryStore(): MemoryStore {
    return this.store;
  }

  /** Buyer task store (undefined for merchant kernels). */
  get buyerTasks(): BuyerTaskStore | undefined {
    return this.taskStore;
  }

  /** ActionCandidate approval store (both roles; undefined only if unopened). */
  get actionCandidates(): ActionCandidateStore | undefined {
    return this.approvals;
  }

  /** Current runtime write-approval mode (design §16). */
  getMode(): AgentMode {
    return this.modeRef.value;
  }

  /**
   * Change the runtime mode. Switching INTO autopilot requires an explicit
   * `confirm` — the same fail-closed rule as the operator control plane
   * (docs/operator-tui-v0.2.md §8).
   */
  setMode(mode: AgentMode, options?: { confirmed?: boolean }): { ok: boolean; error?: string } {
    if (!isAgentMode(mode)) {
      return { ok: false, error: `未知模式：${String(mode)}（可选 ${AGENT_MODES.join("/")}）` };
    }
    if (this.modeRef.value === mode) return { ok: true };
    if (mode === "autopilot" && options?.confirmed !== true) {
      return { ok: false, error: "切换到 autopilot 需要显式确认：/mode autopilot confirm" };
    }
    this.modeRef.value = mode;
    return { ok: true };
  }

  /** Pending ActionCandidates awaiting /approve (fail closed on expiry). */
  listPendingApprovals(): ReturnType<ActionCandidateStore["listPending"]> {
    if (this.approvals === undefined) return [];
    return this.approvals.listPending();
  }

  /**
   * Approve + execute a pending ActionCandidate. Execution re-reads the
   * preconditions and re-hashes them (§16): a stale or expired approval is
   * superseded, never executed. A candidate left over from a previous process
   * (no live execution hooks) is expired, matching operator-plane recovery.
   */
  approveCandidate(candidateId: string): Promise<ApprovalExecutionResult> {
    // Serialized with all other kernel work. Note: slash handlers run INSIDE
    // the kernel chain, so they call approveCandidateInner directly to avoid
    // a nested-enqueue deadlock.
    return this.enqueue(() => this.approveCandidateInner(candidateId));
  }

  /** Approval execution without re-enqueueing (callers must already be serialized). */
  private async approveCandidateInner(candidateId: string): Promise<ApprovalExecutionResult> {
    if (this.approvals === undefined) {
      throw new MemoryError("validation", "审批存储不可用");
    }
    const candidate = this.approvals.get(candidateId);
    if (candidate === undefined) {
      throw new MemoryError("validation", `未知审批候选 ${candidateId}`);
    }
    const hooks = this.pendingHooks.get(candidateId);
    if (hooks === undefined) {
      // Cross-restart recovery (design §18.3): without live hooks the
      // candidate cannot be re-validated against the current marketplace.
      this.approvals.expireDue();
      this.approvals.supersede(candidateId);
      return {
        kind: "not_approvable",
        candidate: this.approvals.get(candidateId) as typeof candidate,
        reason: `候选 ${candidateId} 没有可用的执行钩子（可能在重启前生成）；已失效，请重新生成。`,
      };
    }
    this.approvals.markApproved(candidateId);
    return executeApprovedCandidate(this.approvals, candidateId, hooks);
  }

  /** Reject a pending/advice-only ActionCandidate. Never executes. */
  rejectCandidate(candidateId: string): { ok: boolean; error?: string } {
    if (this.approvals === undefined) return { ok: false, error: "审批存储不可用" };
    const candidate = this.approvals.get(candidateId);
    if (candidate === undefined) return { ok: false, error: `未知审批候选 ${candidateId}` };
    if (candidate.status !== "pending_approval" && candidate.status !== "approved") {
      return { ok: false, error: `候选 ${candidateId} 状态为 ${candidate.status}，不可驳回` };
    }
    this.approvals.reject(candidateId);
    this.pendingHooks.delete(candidateId);
    return { ok: true };
  }

  /**
   * Run one scheduler tick (buyer kernels only): due wakeups, tracking-rule
   * checks and notifications, all derived from the database (restart-safe).
   * Serialized with everything else the kernel does.
   */
  schedulerTick(budget: TickBudget = {}): Promise<TickResult> {
    return this.enqueue(async () => {
      if (this.scheduler === undefined) {
        return {
          checked_rules: 0,
          notifications: [],
          tasks_searched: [],
          tasks_expired: [],
          errors: [],
        };
      }
      return this.scheduler.tick(budget);
    });
  }

  /**
   * Autonomous negotiation follow-up (autopilot only): if this agent has a
   * pending negotiation message, drive ONE deterministic turn to handle it.
   * The deterministic decision negotiates within the profile's HardPolicy
   * (buyer budget / merchant floor+discount) and auto-submits through the
   * gateway gate — no per-turn human and no LLM tool-loop fragility. Escalated
   * (out-of-rule) decisions park for a human. Returns a progress line for the
   * chat, or undefined when there is nothing to do.
   */
  async negotiationAutoTick(): Promise<string | undefined> {
    if (this.modeRef.value !== "autopilot") return undefined;
    if (this.commerceClient === undefined) return undefined;
    const runner = new DeterministicNegotiationRunner(this.profile, this.commerceClient);
    const prepared = await runner.prepare().catch(() => undefined);
    if (prepared === undefined) return undefined;
    const outcome = await runner.submit(prepared).catch(() => undefined);
    if (outcome === undefined) return "磋商处理失败（网关异常），下一轮自动重试。";
    const detail =
      outcome.settlement === "failed" ? `（${outcome.policy_result.public_reason}）` : "";
    return `已自动处理一条磋商：${outcome.policy_result.result}${detail}`;
  }

  get isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }

  /** Serialize all kernel work — one message, command or event at a time. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * Handle one user input line: slash commands run deterministically;
   * anything else goes to the model with a per-turn memory briefing.
   */
  handleUserText(text: string): Promise<KernelReply> {
    return this.enqueue(async () => {
      if (this.closed) throw new MemoryError("validation", "kernel is closed");
      if (text.startsWith("/")) {
        return await this.handleSlash(text);
      }
      const memories = this.store.retrieve({
        session_id: MAIN_SESSION_ID,
        purpose: "clarify",
        text,
      });
      this.briefingSetter(renderMemoryBriefing(memories));
      // Advance the turn id so several remember calls inside this one turn
      // dedup into a single evidence piece (§9.3).
      this.turnId.current = `${MAIN_SESSION_ID}:${++this.turnSeq}`;
      try {
        const message = await this.harness.prompt(text);
        const reply = assistantText(message);
        // §18.1: a model failure (throw OR empty response) must leave the
        // conversation and TUI intact.
        if (reply === "") {
          return { text: "模型没有返回内容，请重试。", quit: false };
        }
        return { text: reply, quit: false };
      } catch (err) {
        return {
          text: `模型处理失败：${err instanceof Error ? err.message : String(err)}。对话状态未改变，请重试。`,
          quit: false,
        };
      } finally {
        this.briefingSetter(undefined);
      }
    });
  }

  private async handleSlash(input: string): Promise<KernelReply> {
    const [command = "", ...rest] = input.trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    try {
      switch (command) {
        case "/memory":
          return { text: this.renderMemory(arg), quit: false };
        case "/forget":
          return { text: this.handleForget(arg), quit: false };
        case "/correct":
          return { text: this.handleCorrect(arg), quit: false };
        case "/confirm":
          return { text: this.handleConfirm(arg), quit: false };
        case "/private":
          return { text: this.renderPrivate(), quit: false };
        case "/why":
          return { text: this.renderWhy(), quit: false };
        case "/mode":
          return { text: this.handleMode(arg), quit: false };
        case "/pending":
          return { text: this.renderPending(), quit: false };
        case "/approve":
          return { text: await this.handleApprove(arg), quit: false };
        case "/reject":
          return { text: this.handleReject(arg), quit: false };
        case "/help":
          return { text: COMMANDS_HELP, quit: false };
        case "/quit":
          this.shutdownRequested = true;
          return { text: "正在安全退出…", quit: true };
        default:
          return { text: `未知命令 ${command}，输入 /help 查看命令。`, quit: false };
      }
    } catch (err) {
      const message = err instanceof MemoryError ? err.message : String(err);
      return { text: `命令失败：${message}`, quit: false };
    }
  }

  // ---- slash command implementations ---------------------------------------

  private renderMemory(arg: string): string {
    if (arg === "preferences") {
      const prefs = this.store.listMemories({ namespace: "preference" });
      if (prefs.length === 0) return "[记忆] 还没有学习到的偏好。";
      const lines = prefs.map(
        (m) =>
          `  · ${m.memory_id} [${m.status}] ${m.key}（置信度 ${m.confidence} · ${m.source_kind} · 证据 ${m.evidence_count}）`,
      );
      return ["[记忆] 学习到的偏好（候选需确认后才生效）:", ...lines].join("\n");
    }
    if (arg === "private") {
      const restricted = this.store.listMemories({ sensitivity: "restricted" });
      const privates = this.store.listMemories({ sensitivity: "private" });
      const lines: string[] = ["[记忆] 私密资料（只显示字段名与状态，不回显明文）:"];
      if (restricted.length === 0 && privates.length === 0) {
        lines.push("  （暂无）");
      }
      for (const m of restricted) {
        lines.push(`  · ${m.memory_id} [${m.status}] ${m.key}（restricted · Vault 加密保存）`);
      }
      for (const m of privates) {
        lines.push(`  · ${m.memory_id} [${m.status}] ${m.key}（private）`);
      }
      return lines.join("\n");
    }
    const items = this.store.listMemories({});
    if (items.length === 0) return "[记忆] 还没有任何记忆。";
    const lines = items.map((m) => {
      const pending = m.status === "candidate" ? " · 待确认" : "";
      return `  · ${m.memory_id} [${m.status}] ${m.namespace}/${m.key}（置信度 ${m.confidence}${pending}）`;
    });
    return [`[记忆] 共 ${items.length} 条（candidate/active/needs_review）:`, ...lines].join("\n");
  }

  private findMemoryForForget(arg: string): MemoryItem | string {
    if (arg.startsWith("mem_")) {
      const item = this.store.getMemory(arg);
      return item ?? `找不到记忆 ${arg}`;
    }
    const needle = arg.toLowerCase();
    const matches = this.store
      .listMemories({})
      .filter((m) => m.key.toLowerCase().includes(needle));
    if (matches.length === 0) return `找不到与「${arg}」匹配的记忆`;
    if (matches.length > 1) {
      const lines = matches.map((m) => `  · ${m.memory_id} ${m.key}`);
      return [`「${arg}」匹配到多条记忆，请用 memory-id 指定:`, ...lines].join("\n");
    }
    return matches[0] as MemoryItem;
  }

  private handleForget(arg: string): string {
    if (arg === "") return "用法：/forget <memory-id|描述>";
    const target = this.findMemoryForForget(arg);
    if (typeof target === "string") return target;
    this.store.forgetMemory(target.memory_id, "user", "via /forget");
    return `[记忆] 已遗忘 ${target.memory_id}（${target.key}），不再用于任何回答。`;
  }

  private handleCorrect(arg: string): string {
    const splitAt = arg.indexOf(" ");
    if (splitAt <= 0) return "用法：/correct <memory-id> <新内容>";
    const memoryId = arg.slice(0, splitAt).trim();
    const raw = arg.slice(splitAt + 1).trim();
    if (raw === "") return "用法：/correct <memory-id> <新内容>";
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    const memory = this.store.correctMemory(memoryId, { value }, "user", "via /correct");
    return `[记忆] 已修正 ${memory.memory_id}（版本 ${memory.version}），旧值保留在审计事件中。`;
  }

  /** Owner-only reveal of Restricted (Vault) values — never echoed to a buyer. */
  private renderPrivate(): string {
    const values = listRestrictedValues(this.store);
    if (values.length === 0) return "[私有] 暂无私密阈值记忆。";
    return [
      "[私有] 你的私密阈值（仅你可见；绝不要把它们写进对外消息或报价）:",
      ...values.map((v) => `  · ${v.key} = ${v.value}`),
    ].join("\n");
  }

  /** Human-only promotion of a candidate (design §10.1): constraints and
   * restricted values require /confirm before they take effect. */
  private handleConfirm(arg: string): string {
    if (arg === "") return "用法：/confirm <memory-id>";
    if (!arg.startsWith("mem_")) {
      return "请用 memory-id 指定（/memory 可查看候选的 id）。";
    }
    const memory = this.store.confirmMemory(arg, "user");
    return `[记忆] 已确认 ${memory.memory_id}（${memory.key}），现在生效。`;
  }

  private renderWhy(): string {
    const { entries } = this.store.explainLastRetrieval(MAIN_SESSION_ID);
    if (entries.length === 0) {
      return "[记忆] 最近的回答没有使用任何记忆。";
    }
    const lines = entries.map(
      (e) =>
        `  · ${e.memory_id} ${e.namespace}/${e.key}（用途 ${e.purpose} · 精度 ${e.redaction_level} · 置信度 ${e.confidence}）`,
    );
    return ["[记忆] 最近一轮回答使用了以下记忆:", ...lines].join("\n");
  }

  // ---- write-approval slash commands (design §16) ---------------------------

  private handleMode(arg: string): string {
    if (arg === "") {
      return `[模式] 当前写操作审批模式：${this.getMode()}（manual/supervised/autopilot；autopilot 需 confirm）`;
    }
    const [target, confirm] = arg.split(/\s+/);
    const result = this.setMode(target as AgentMode, { confirmed: confirm === "confirm" });
    if (!result.ok) return `[模式] ${result.error ?? "切换失败"}`;
    return `[模式] 已切换到 ${this.getMode()}。写操作将按新模式路由（supervised 需 /approve）。`;
  }

  private renderPending(): string {
    const pending = this.listPendingApprovals();
    if (pending.length === 0) return "[审批] 当前没有等待批准的写操作候选。";
    const lines = pending.map((c, i) => {
      const args = JSON.stringify(c.arguments);
      return `  ${i + 1}. ${c.candidate_id} [${c.risk}] ${c.tool}（截止 ${c.expires_at}）args=${args.slice(0, 80)}`;
    });
    return [
      "[审批] 等待批准的写操作候选（/approve <编号|id> 批准；/approve all 全部批准；/reject <编号|id> 驳回）:",
      ...lines,
    ].join("\n");
  }

  private async handleApprove(arg: string): Promise<string> {
    if (arg === "") return "用法：/approve <编号|id|all>";
    const trimmed = arg.trim();
    if (trimmed === "all") {
      const pending = this.listPendingApprovals();
      const outcomes = [];
      for (const c of pending) {
        const r = await this.approveCandidateInner(c.candidate_id);
        const note =
          r.kind === "stale" || r.kind === "not_approvable" ? `（${r.reason}）` : "";
        outcomes.push(`${c.tool}: ${r.kind}${note}`);
      }
      return `[审批] 已处理 ${outcomes.length} 个候选：\n${outcomes.map((o) => `  · ${o}`).join("\n")}`;
    }
    const id = this.resolveApprovalId(trimmed);
    if (id === undefined) {
      return `[审批] 未知审批候选 ${trimmed}（用 /pending 看编号，或输入完整 id/唯一前缀）。`;
    }
    try {
      // Already inside the kernel chain (handleUserText enqueues handleSlash);
      // calling approveCandidate would re-enqueue and deadlock.
      const result = await this.approveCandidateInner(id);
      if (result.kind === "executed") {
        return `[审批] 候选 ${id} 已执行。结果：${JSON.stringify(result.output)}`;
      }
      if (result.kind === "stale") {
        return `[审批] 候选 ${id} 已失效（${result.reason}），未执行；请重新生成候选。`;
      }
      if (result.kind === "expired") {
        return `[审批] 候选 ${id} 已过期，未执行。`;
      }
      return `[审批] 候选 ${id} 无法执行：${result.reason}`;
    } catch (err) {
      return `[审批] 命令失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private handleReject(arg: string): string {
    if (arg === "") return "用法：/reject <编号|id>";
    const id = this.resolveApprovalId(arg.trim());
    if (id === undefined) {
      return `[审批] 未知审批候选 ${arg.trim()}（用 /pending 看编号，或输入完整 id/唯一前缀）。`;
    }
    const result = this.rejectCandidate(id);
    if (!result.ok) return `[审批] ${result.error ?? "驳回失败"}`;
    return `[审批] 候选 ${id} 已驳回，绝不会执行。`;
  }

  /**
   * Resolve a user-facing approval target: a /pending index, an exact id, or a
   * UNIQUE prefix of a pending candidate (LLM flows truncate long UUIDs).
   * Ambiguous prefixes and out-of-range indices stay rejected.
   */
  private resolveApprovalId(input: string): string | undefined {
    if (this.approvals === undefined) return undefined;
    const pending = this.approvals.listPending();
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= pending.length) {
      return pending[n - 1]?.candidate_id as string;
    }
    const exact = this.approvals.get(input);
    if (exact !== undefined) return exact.candidate_id;
    const matches = pending.filter((c) => c.candidate_id.startsWith(input));
    return matches.length === 1 ? (matches[0]?.candidate_id as string) : undefined;
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Flush the session and close the database. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.harness.waitForIdle();
    } catch {
      // best-effort flush; closing the store is what must not be skipped
    }
    this.db.close();
  }
}
