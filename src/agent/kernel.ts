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
import { ensureAgentPaths, openAgentDatabase, type AgentPaths } from "./agent-db.js";
import { buildBuyerTools } from "./buyer/buyer-tools.js";
import { TaskScheduler, type TickBudget, type TickResult } from "./buyer/scheduler.js";
import { BuyerTaskStore } from "./buyer/task-store.js";
import { buildMemoryTools } from "./chat-tools.js";
import type { CommerceConnector } from "./connector/types.js";
import { MemoryStore } from "./memory/store.js";
import { MemoryError, type MemoryItem, type Principal } from "./memory/types.js";
import { PrivateVault } from "./memory/vault.js";
import { openMainSession } from "./session.js";
import { baseSystemPrompt, renderMemoryBriefing } from "./system-prompt.js";
import type { DatabaseSync } from "node:sqlite";

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

const COMMANDS_HELP = `/memory [preferences|private]  查看记忆概览 / 学习到的偏好 / 私密资料字段与状态
/forget <memory-id|描述>   删除记忆（tombstone + 审计）
/correct <memory-id> <新内容>  修正记忆（保留前后版本审计）
/why                       说明最近的回答使用了哪些记忆
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
    const session = await openMainSession(paths);

    // Buyer capability pack (v0.3.0-B): task store + scheduler + tools.
    // All clocks are normalized to UTC ISO (SQLite compares timestamps
    // lexicographically; mixed offsets would silently break due checks).
    const clock = () => new Date(Date.parse((options.now ?? (() => new Date().toISOString()))())).toISOString();
    let taskStore: BuyerTaskStore | undefined;
    let scheduler: TaskScheduler | undefined;
    let buyerTools: ReturnType<typeof buildBuyerTools> = [];
    if (options.profile.role === "buyer" && options.connector !== undefined) {
      taskStore = new BuyerTaskStore({ db, principalId: principal.principal_id, now: clock });
      scheduler = new TaskScheduler({
        store: taskStore,
        connectors: [options.connector],
        now: clock,
      });
      buyerTools = buildBuyerTools({ store: taskStore, connector: options.connector, now: clock });
    }

    const base = baseSystemPrompt(options.profile, principal);
    let briefing: string | undefined;
    const harness = new AgentHarness({
      session,
      models: options.models,
      model: options.model,
      tools: [...buildMemoryTools(store), ...buyerTools],
      systemPrompt: async () => (briefing === undefined ? base : `${base}\n\n${briefing}`),
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
      ...(taskStore !== undefined ? { taskStore } : {}),
      ...(scheduler !== undefined ? { scheduler } : {}),
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
        return this.handleSlash(text);
      }
      const memories = this.store.retrieve({
        session_id: MAIN_SESSION_ID,
        purpose: "clarify",
        text,
      });
      this.briefingSetter(renderMemoryBriefing(memories));
      try {
        const message = await this.harness.prompt(text);
        return { text: assistantText(message), quit: false };
      } finally {
        this.briefingSetter(undefined);
      }
    });
  }

  private handleSlash(input: string): KernelReply {
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
        case "/why":
          return { text: this.renderWhy(), quit: false };
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
