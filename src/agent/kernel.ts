/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import type { AgentProfile } from "../config/profile.js";
import type { CommerceClient } from "../commerce/types.js";
import { ensureAgentPaths, openAgentDatabase, type AgentPaths } from "./agent-db.js";
import {
  HandoffEventStore,
  HandoffIdempotencyStore,
  foldCandidateLifecycle,
  deliveryState,
  recordLaunch,
  recordOpenEvidence,
} from "../handoff/index.js";
import { buildBuyerTools } from "./buyer/buyer-tools.js";
import { TaskScheduler, type TickBudget, type TickResult } from "./buyer/scheduler.js";
import { BuyerTaskStore } from "./buyer/task-store.js";
import { buildMemoryTools } from "./chat-tools.js";
import type { CommerceConnector } from "./connector/types.js";
import { AGENT_MODES, DEFAULT_AGENT_MODE, isAgentMode, type AgentMode } from "./mode.js";
import {
  WriteApprovalCandidateStore,
  executeApprovedCandidate,
  type ApprovalExecutionResult,
} from "./merchant/action-candidate.js";
import type { CredentialBroker } from "./merchant/credential-broker.js";
import type { MerchantClient } from "./merchant/types.js";
import { buildMerchantTools } from "./merchant/merchant-tools.js";
import { DeterministicNegotiationRunner } from "../operator/runner.js";
import type { DecisionHints } from "../runtime/fake-model.js";
import type { BuyerTask } from "./buyer/types.js";
import { MemoryStore } from "./memory/store.js";
import { MemoryError, type MemoryItem, type Principal } from "./memory/types.js";
import { PrivateVault } from "./memory/vault.js";
import { openMainSession } from "./session.js";
import { registerCatalogAgent } from "../discovery/catalog-source/register.js";
import { KiwiCatalogSource } from "../discovery/catalog-source/kiwi-source.js";
import { baseSystemPrompt, renderMemoryBriefing } from "./system-prompt.js";
import type { DatabaseSync } from "node:sqlite";

/** Execution hooks for a pending WriteApprovalCandidate (process-lifetime only). */
export interface PendingActionHooks {
  readPreconditions: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export const MAIN_SESSION_ID = "main";

/** 审查 P2-I：autopilot 对网关权威门持续拒绝的消息——连续失败上限与冷却窗口。 */
export const AUTOPILOT_MAX_SUBMIT_FAILURES = 3;
export const AUTOPILOT_STALL_COOLDOWN_MS = 10 * 60 * 1000;

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
  /** agent catalog base URL（buyer `negotiate_buyer_task` 的 A2A 商家发现用）。 */
  catalog?: string;
}

/** A2A 磋商结果记忆记录（/negotiate 与 negotiate_buyer_task 共用形状）。 */
interface NegotiationRecord {
  negotiationId: string;
  catalogAgentId: string;
  sku: string;
  quantity: number;
  offerPriceMinor?: number;
  dealPriceMinor?: number;
  agreementId?: string;
}

/**
 * 把一轮 A2A 磋商结果写入 MemoryStore（episode namespace，active 无需人工确认）：
 * 持久上下文，`/why` 可查、跨重启可恢复。buyer 工具经 recordNegotiation 回调复用。
 */
async function rememberNegotiation(store: MemoryStore, input: NegotiationRecord): Promise<string> {
  const summary = [
    `A2A 磋商完成：negotiation ${input.negotiationId}，商家 ${input.catalogAgentId}`,
    `，${input.quantity} 件 ${input.sku}，报价 ${input.offerPriceMinor === undefined ? "?" : (input.offerPriceMinor / 100).toFixed(2)} 元/件`,
    `，条件价（量≥100）${input.dealPriceMinor === undefined ? "?" : (input.dealPriceMinor / 100).toFixed(2)} 元/件`,
    input.agreementId !== undefined ? `，agreement ${input.agreementId}` : "",
  ].join("");
  const outcome = store.remember({
    namespace: "episode",
    key: `a2a-negotiation:${input.negotiationId}`,
    value: {
      kind: "a2a_negotiation",
      negotiation_id: input.negotiationId,
      catalog_agent_id: input.catalogAgentId,
      sku: input.sku,
      quantity: input.quantity,
      offer_price_minor: input.offerPriceMinor,
      deal_price_minor: input.dealPriceMinor,
      agreement_id: input.agreementId,
    },
    source_kind: "observed",
    sensitivity: "normal",
    confidence: 1,
    explicit_user_statement: false,
    evidence: {
      source_type: "import",
      source_ref: input.negotiationId,
      summary,
    },
    actor: "system",
  });
  return outcome.kind === "conflict" ? outcome.existing.memory_id : outcome.memory.memory_id;
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

/**
 * Map a buyer task's intent/constraints into negotiation hints so the
 * autonomous loop counters toward the user's actual goal ("买 2 个、预算 120、
 * 砍到 100") instead of the profile defaults.
 */
function taskNegotiationHints(store: BuyerTaskStore, task: BuyerTask): DecisionHints {
  const hints: DecisionHints = {};
  if (task.intent.quantity !== undefined) hints.quantity_cap = task.intent.quantity;
  if (task.intent.target_unit_price !== undefined) {
    hints.buyer_target_unit_price = task.intent.target_unit_price;
  }
  if (task.constraints.max_unit_price !== undefined) {
    hints.buyer_max_unit_price = task.constraints.max_unit_price;
  }
  try {
    const budget = store.resolveBudget(task.constraints);
    if (budget !== undefined) hints.buyer_max_total_price = budget;
  } catch {
    // vault unavailable this run: fall back to the profile budget
  }
  return hints;
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
/profile <file.yaml>      加载并切换另一个 agent profile（buyer/merchant 等）
/register --agent-card-url <url> [--catalog <url>] [--domain <d>]
                          把本 merchant 注册进 agent catalog（buyer 发现用）
/help                      本帮助
/quit                      退出`;

/** 读会话 JSONL 中最后一条模型记录（model_change 或 assistant 消息的 provider/model）。 */
function sessionLastModel(file: string): { provider: string; modelId: string } | undefined {
  let last: { provider: string; modelId: string } | undefined;
  try {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (
        entry.type === "model_change" &&
        typeof entry.provider === "string" &&
        typeof entry.modelId === "string"
      ) {
        last = { provider: entry.provider, modelId: entry.modelId };
      } else if (
        entry.type === "message" &&
        entry.message !== null &&
        typeof entry.message === "object"
      ) {
        const m = entry.message as { role?: string; provider?: string; model?: string };
        if (m.role === "assistant" && typeof m.provider === "string" && typeof m.model === "string") {
          last = { provider: m.provider, modelId: m.model };
        }
      }
    }
  } catch {
    // 读不了就当作没有历史，不重置。
  }
  return last;
}

export class AgentKernel {
  readonly profile: AgentProfile;
  readonly principal: Principal;
  private readonly paths: AgentPaths;
  private readonly db: DatabaseSync;
  private readonly store: MemoryStore;
  private readonly session: Session;
  private readonly harness: AgentHarness;
  private briefing: string | undefined;
  /** 统一时钟（构造注入或墙钟；与 open() 的 clock 闭包同源语义）。 */
  private readonly clock: () => string;
  private chain: Promise<unknown> = Promise.resolve();
  private shutdownRequested = false;
  private closed = false;
  private readonly taskStore?: BuyerTaskStore;
  private readonly scheduler?: TaskScheduler;
  private readonly approvals?: WriteApprovalCandidateStore;
  /** v0.7.0 KTH：handoff 存储（open() 构造，buyer 角色注入）。 */
  private readonly handoffRuntime?: { ledger: HandoffEventStore; idempotency: HandoffIdempotencyStore };
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
  /** Negotiation conversations that reached consensus — the auto-follow must never re-open them. */
  private readonly settledNegotiations = new Set<string>();
  // 审查 P3：settled 集合只进不出（每共识会话一条 key 永驻内存）。网关已
  // 处理的消息不会再进 pending，旧 key 只防极端回滚重放——FIFO 上限截断
  // （超出后仅影响极端场景下的一次多余重新计数，幂等无商业效果）。
  private static readonly SETTLED_MAX_KEYS = 2000;

  private markSettled(key: string): void {
    this.settledNegotiations.add(key);
    if (this.settledNegotiations.size > AgentKernel.SETTLED_MAX_KEYS) {
      // Set 迭代序 = 插入序：从最旧开始删除
      for (const oldest of this.settledNegotiations) {
        this.settledNegotiations.delete(oldest);
        if (this.settledNegotiations.size <= AgentKernel.SETTLED_MAX_KEYS) break;
      }
    }
  }

  // 审查 P2-I：被网关权威门持续拒绝的消息（failClaim 后回 pending 队首，
  // 确定性决策每次 tick 重新 claim → 同一拒绝）——无退避会每 tick 无限
  // claim→fail 并饿死队尾 live 消息。连续失败达上限后进入冷却窗口，
  // 窗口内跳过，窗口后允许一次重试；成功/共识时清除。
  private readonly stalledNegotiations = new Map<
    string,
    { since: string; attempts: number }
  >();

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
    approvals?: WriteApprovalCandidateStore;
    handoffRuntime?: { ledger: HandoffEventStore; idempotency: HandoffIdempotencyStore };
    commerceClient?: CommerceClient;
    merchantClient?: MerchantClient;
    broker?: CredentialBroker;
    modeRef?: { value: AgentMode };
    pendingHooks?: Map<string, PendingActionHooks>;
    turnId: { current: string };
    now?: () => string;
  }) {
    this.profile = options.profile;
    this.paths = options.paths;
    this.clock = options.now ?? (() => new Date().toISOString());
    this.db = options.db;
    this.store = options.store;
    this.principal = options.principal;
    this.session = options.session;
    this.harness = options.harness;
    if (options.taskStore !== undefined) this.taskStore = options.taskStore;
    if (options.scheduler !== undefined) this.scheduler = options.scheduler;
    if (options.approvals !== undefined) this.approvals = options.approvals;
    if (options.handoffRuntime !== undefined) this.handoffRuntime = options.handoffRuntime;
    if (options.commerceClient !== undefined) this.commerceClient = options.commerceClient;
    if (options.merchantClient !== undefined) this.merchantClient = options.merchantClient;
    if (options.broker !== undefined) this.broker = options.broker;
    if (options.modeRef !== undefined) this.modeRef = options.modeRef;
    this.pendingHooks = options.pendingHooks ?? new Map();
    this.turnId = options.turnId;
  }

  static async open(options: AgentKernelOptions): Promise<AgentKernel> {
    const paths = options.paths ?? ensureAgentPaths(options.profile.agent_id);
    // 会话来自不同模型（如 fake→deepseek）时重置：旧模型的消息会让新模型首轮
    // 产生空响应（"模型没有返回内容"）。模型变更 = 新的对话历史。
    if (options.model !== undefined && existsSync(paths.mainSession)) {
      const sessionModel = sessionLastModel(paths.mainSession);
      if (
        sessionModel !== undefined &&
        (sessionModel.provider !== options.model.provider || sessionModel.modelId !== options.model.id)
      ) {
        rmSync(paths.mainSession, { force: true });
      }
    }
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

    const approvals = new WriteApprovalCandidateStore({ db, principalId: principal.principal_id, now: clock });
    let taskStore: BuyerTaskStore | undefined;
    let scheduler: TaskScheduler | undefined;
    let buyerTools: ReturnType<typeof buildBuyerTools> = [];
    let merchantTools: ReturnType<typeof buildMerchantTools> = [];
    let handoffRuntime: { ledger: HandoffEventStore; idempotency: HandoffIdempotencyStore } | undefined;
    if (options.profile.role === "buyer" && options.connector !== undefined) {
      taskStore = new BuyerTaskStore({ db, principalId: principal.principal_id, now: clock, vault });
      scheduler = new TaskScheduler({
        store: taskStore,
        connectors: [options.connector],
        now: clock,
      });
      // v0.7.0 KTH：handoff 存储（Ledger 事件 + 执行幂等）落在 agent data dir，
      // 注入 buyer 工具（handoff_agreement 工具挂载）。
      const handoffDir = path.dirname(paths.db);
      const handoffLedger = new HandoffEventStore({ dir: handoffDir, now: clock });
      const handoffIdempotency = new HandoffIdempotencyStore({ dir: handoffDir, now: clock });
      handoffRuntime = { ledger: handoffLedger, idempotency: handoffIdempotency };
      buyerTools = buildBuyerTools({
        store: taskStore,
        connector: options.connector,
        profile: options.profile,
        ...(options.commerceClient !== undefined ? { commerceClient: options.commerceClient } : {}),
        ...(options.broker !== undefined ? { broker: options.broker } : {}),
        ...(options.catalog !== undefined
          ? {
              catalog: options.catalog,
              // CD #27 wiring：buyer kernel 配置 catalog 时注入 KiwiCatalogSource，
              // search_listings / shortlist_listing 工具才挂载（历史教训：工具
              // 只在测试里可达，运行时从未注入——dead code）。
              catalogSource: new KiwiCatalogSource({ baseUrl: options.catalog }),
            }
          : {}),
        approvals,
        mode: () => modeRef.value,
        registerPending,
        now: clock,
        recordNegotiation: (input) => rememberNegotiation(store, input),
        handoff: { ledger: handoffLedger, idempotency: handoffIdempotency },
      });
    } else if (
      options.profile.role === "merchant" &&
      options.merchantClient !== undefined &&
      options.broker !== undefined
    ) {
      merchantTools = buildMerchantTools({
        profile: options.profile,
        merchantClient: options.merchantClient,
        // Negotiation token (commerceClient) is optional: absent → 磋商工具
        // fail closed，目录/库存只读与审批式写工具照常可用（见 §15.3/§15.4）。
        ...(options.commerceClient !== undefined ? { commerceClient: options.commerceClient } : {}),
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
    // 强制使用 profile 指定的模型：pi-agent-core 会从 session 的 model_change
    // 记录恢复历史模型——同一 agent_id 换过模型（如 fake→deepseek）时，旧会话
    // 会把 fake 模型恢复回来覆盖新传入的 real 模型。显式 setModel 覆盖之。
    if (options.model !== undefined) {
      await harness.setModel(options.model);
    }

    const kernel = new AgentKernel({
      profile: options.profile,
      paths,
      db,
      store,
      principal,
      session,
      harness,
      approvals,
      ...(handoffRuntime !== undefined ? { handoffRuntime } : {}),
      modeRef,
      pendingHooks,
      turnId,
      now: clock,
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

  /**
   * v0.7.0 KTH：handoff 运行态摘要（/handoff 命令用）——候选生命周期 +
   * 交付观察状态，从 Ledger 事件投影（#17 用户可见目标与摘要、#18 可审计）。
   */
  get handoffSummary():
    | { enabled: false }
    | {
        enabled: true;
        candidates: Array<{
          candidate_id: string;
          negotiation_id: string;
          lifecycle: string;
          destination_type: string;
          destination_ref: string;
          display_summary: { merchant: string; summary: string };
        }>;
        handoffs: Array<{ handoff_id: string; delivery: string }>;
      } {
    if (this.handoffRuntime === undefined) return { enabled: false };
    const candidates: Array<{
      candidate_id: string;
      negotiation_id: string;
      lifecycle: string;
      destination_type: string;
      destination_ref: string;
      display_summary: { merchant: string; summary: string };
    }> = [];
    const handoffs: Array<{ handoff_id: string; delivery: string }> = [];
    for (const negotiationId of this.handoffRuntime.ledger.listNegotiations()) {
      const events = this.handoffRuntime.ledger.events(negotiationId);
      const seenCandidates = new Set<string>();
      const seenHandoffs = new Set<string>();
      for (const event of events) {
        if (event.handoff_candidate_id !== undefined && !seenCandidates.has(event.handoff_candidate_id)) {
          seenCandidates.add(event.handoff_candidate_id);
          const lifecycle = foldCandidateLifecycle(events.filter((e) => e.handoff_candidate_id === event.handoff_candidate_id));
          const candidateEvents = events.filter((e) => e.handoff_candidate_id === event.handoff_candidate_id);
          const created = candidateEvents.find((e) => e.event_kind === "handoff_candidate_created");
          const embedded =
            created?.outcome.kind === "ok"
              ? (created.outcome.result?.candidate as Record<string, unknown> | undefined)
              : undefined;
          candidates.push({
            candidate_id: event.handoff_candidate_id,
            negotiation_id: negotiationId,
            lifecycle: lifecycle ?? "UNKNOWN",
            destination_type:
              typeof embedded?.destination_type === "string" ? embedded.destination_type : "?",
            destination_ref: typeof embedded?.destination_ref === "string" ? embedded.destination_ref : "?",
            display_summary: (() => {
              const summary = embedded?.display_summary as Record<string, unknown> | undefined;
              return {
                merchant: typeof summary?.merchant === "string" ? summary.merchant : "?",
                summary: typeof summary?.summary === "string" ? summary.summary : "?",
              };
            })(),
          });
        }
        if (event.handoff_id !== undefined && !seenHandoffs.has(event.handoff_id)) {
          seenHandoffs.add(event.handoff_id);
          handoffs.push({
            handoff_id: event.handoff_id,
            delivery: deliveryState(events.filter((e) => e.handoff_id === event.handoff_id)) ?? "?",
          });
        }
      }
    }
    return { enabled: true, candidates, handoffs };
  }

  /** 模拟 OS/browser/deep-link handler 启动（LAUNCHED；不证明页面加载）。 */
  async launchHandoff(handoffId: string, negotiationId: string): Promise<string> {
    if (this.handoffRuntime === undefined) return "Handoff 未启用。";
    const events = this.handoffRuntime.ledger.events(negotiationId);
    const handoffEvents = events.filter((e) => e.handoff_id === handoffId);
    if (handoffEvents.length === 0) return `未知 handoff ${handoffId}（negotiation ${negotiationId}）。`;
    const candidateId = handoffEvents[0]?.handoff_candidate_id;
    if (candidateId === undefined) return "handoff 事件缺少候选引用。";
    const candidateEvents = events.filter((e) => e.handoff_candidate_id === candidateId);
    const created = candidateEvents.find((e) => e.event_kind === "handoff_candidate_created");
    const embedded =
      created?.outcome.kind === "ok"
        ? (created.outcome.result?.candidate as Record<string, unknown> | undefined)
        : undefined;
    if (embedded === undefined) return "候选文档缺失，无法启动。";
    const { validateHandoffCandidate } = await import("../handoff/index.js");
    const candidate = validateHandoffCandidate(embedded);
    recordLaunch({
      ledger: this.handoffRuntime.ledger,
      candidate,
      handoff_id: handoffId,
      identity: { sender_identity: candidate.buyer_identity_ref, counterparty_identity: candidate.merchant_identity_ref, actor: "buyer" },
      capability: { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" },
      now: () => new Date().toISOString(),
    });
    return `handoff ${handoffId} 已启动（LAUNCHED）——不证明页面加载。`;
  }

  /** 本地回调证据：handoff-open 演示（OPENED_CONFIRMED 证据门，KTH §9）。 */
  async confirmHandoffOpened(handoffId: string, negotiationId: string): Promise<string> {
    if (this.handoffRuntime === undefined) return "Handoff 未启用。";
    const events = this.handoffRuntime.ledger.events(negotiationId);
    const handoffEvents = events.filter((e) => e.handoff_id === handoffId);
    if (handoffEvents.length === 0) return `未知 handoff ${handoffId}（negotiation ${negotiationId}）。`;
    const candidateId = handoffEvents[0]?.handoff_candidate_id;
    if (candidateId === undefined) return "handoff 事件缺少候选引用。";
    const created = events
      .filter((e) => e.handoff_candidate_id === candidateId)
      .find((e) => e.event_kind === "handoff_candidate_created");
    const embedded =
      created?.outcome.kind === "ok"
        ? (created.outcome.result?.candidate as Record<string, unknown> | undefined)
        : undefined;
    if (embedded === undefined) return "候选文档缺失，无法确认。";
    const { validateHandoffCandidate } = await import("../handoff/index.js");
    const candidate = validateHandoffCandidate(embedded);
    recordOpenEvidence({
      ledger: this.handoffRuntime.ledger,
      candidate,
      handoff_id: handoffId,
      identity: { sender_identity: candidate.buyer_identity_ref, counterparty_identity: candidate.merchant_identity_ref, actor: "buyer" },
      capability: { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" },
      now: () => new Date().toISOString(),
      evidence: { kind: "local_callback", handoff_id: handoffId, at: new Date().toISOString() },
    });
    return `handoff ${handoffId} 已确认打开（OPENED_CONFIRMED，evidence=local_callback）。`;
  }

  get memoryStore(): MemoryStore {
    return this.store;
  }

  /** Buyer task store (undefined for merchant kernels). */
  get buyerTasks(): BuyerTaskStore | undefined {
    return this.taskStore;
  }

  /** WriteApprovalCandidate approval store (both roles; undefined only if unopened). */
  get actionCandidates(): WriteApprovalCandidateStore | undefined {
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

  /** Pending WriteApprovalCandidates awaiting /approve (fail closed on expiry). */
  listPendingApprovals(): ReturnType<WriteApprovalCandidateStore["listPending"]> {
    if (this.approvals === undefined) return [];
    const pending = this.approvals.listPending(); // 内部 expireDue：过期候选已标记 expired
    // 清理已终结候选的执行钩子闭包（评审项 P3-5）：expired/superseded/
    // executed/rejected 后的 hooks 不再需要，防内存无界增长。
    const live = new Set(pending.map((c) => c.candidate_id));
    for (const id of [...this.pendingHooks.keys()]) {
      if (!live.has(id)) this.pendingHooks.delete(id);
    }
    return pending;
  }

  /** 释放候选执行钩子闭包（评审项 P3-5；候选生命周期终结后调用）。 */
  private releasePending(candidateId: string): void {
    this.pendingHooks.delete(candidateId);
  }

  /**
   * Approve + execute a pending WriteApprovalCandidate. Execution re-reads the
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
    // manual 模式语义（评审项 P3-3）：manual = advice only（never executes）。
    // routeWriteCandidate 在 manual 分支仍注册执行钩子（供 /pending 显示与
    // /revise 重算），但批准路径必须拒绝——此前 /approve 绕过模式直接执行，
    // 与 operator 平面分叉（controller 对 advice_only 候选明确拒绝批准：
    // "manual 模式只提供建议，不自动提交"）。
    if (this.getMode() === "manual") {
      return {
        kind: "not_approvable",
        candidate,
        reason: "manual 模式只提供建议，不自动执行（/approve 拒绝 advice-only 候选）",
      };
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
    const outcome = await executeApprovedCandidate(this.approvals, candidateId, hooks);
    // 无论结果（executed / stale=superseded / expired），候选生命周期已终结，
    // 执行钩子不再需要——释放闭包防泄漏（评审项 P3-5）。
    if (outcome.kind !== "not_approvable") {
      this.releasePending(candidateId);
    }
    return outcome;
  }

  /** Reject a pending/advice-only WriteApprovalCandidate. Never executes. */
  rejectCandidate(candidateId: string): { ok: boolean; error?: string } {
    if (this.approvals === undefined) return { ok: false, error: "审批存储不可用" };
    const candidate = this.approvals.get(candidateId);
    if (candidate === undefined) return { ok: false, error: `未知审批候选 ${candidateId}` };
    if (candidate.status !== "pending_approval" && candidate.status !== "approved") {
      return { ok: false, error: `候选 ${candidateId} 状态为 ${candidate.status}，不可驳回` };
    }
    this.approvals.reject(candidateId);
    this.releasePending(candidateId);
    return { ok: true };
  }

  /**
   * Run one scheduler tick (buyer kernels only): due wakeups, tracking-rule
   * checks and notifications, all derived from the database (restart-safe).
   * Serialized with everything else the kernel does.
   */
  schedulerTick(budget: TickBudget = {}): Promise<TickResult> {
    return this.enqueue(async () => {
      // 惰性过期清扫（评审项 L1）：到期未执行的 handoff 候选落 expired 事件，
      // TUI /handoff 不再永久显示"从未获批/从未执行"。
      this.handoffRuntime?.ledger.sweepExpiredCandidates(this.clock());
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

  /** 惰性过期清扫入口（/handoff 渲染前调用；幂等，可重复调）。 */
  sweepHandoffCandidates(): number {
    if (this.handoffRuntime === undefined) return 0;
    return this.handoffRuntime.ledger.sweepExpiredCandidates(this.clock());
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
  negotiationAutoTick(): Promise<string | undefined> {
    // 与 schedulerTick 同级：整个 tick 必须进 kernel 串行链（enqueue）。此前
    // 被 chat-tui 定时器直接调用，可与最长 turn_timeout 的模型回合并发操作
    // 同一 pending conversation（双路同时 claim/提交同一磋商）。
    return this.enqueue(async () => this.negotiationAutoTickUnlocked());
  }

  private async negotiationAutoTickUnlocked(): Promise<string | undefined> {
    if (this.modeRef.value !== "autopilot") return undefined;
    if (this.commerceClient === undefined) return undefined;
    // Skip conversations already settled/at-consensus BEFORE claiming — the
    // stateless deterministic decision would otherwise re-counter the same
    // offer forever and re-open settled negotiations every tick.
    let pending: Awaited<ReturnType<CommerceClient["listPendingMessages"]>>;
    try {
      pending = await this.commerceClient.listPendingMessages();
    } catch {
      return undefined;
    }
    const settledKey = (message: { conversation_id: string; message_id: number }): string =>
      `${message.conversation_id}:${message.message_id}`;
    // 审查 P2-I：冷却窗口内的消息跳过（连续失败达上限后暂停自动处理）。
    const stalled = this.stalledNegotiations;
    const isStalled = (message: { conversation_id: string; message_id: number }): boolean => {
      const entry = stalled.get(settledKey(message));
      // 达到连续失败上限才进入冷却（上限前的失败继续重试计数）
      if (entry === undefined || entry.attempts < AUTOPILOT_MAX_SUBMIT_FAILURES) return false;
      const sinceMs = Date.parse(entry.since);
      const nowMs = Date.parse(this.clock());
      if (!Number.isFinite(sinceMs) || !Number.isFinite(nowMs)) return false;
      return nowMs - sinceMs < AUTOPILOT_STALL_COOLDOWN_MS;
    };
    if (pending.every((m) => this.settledNegotiations.has(settledKey(m)) || isStalled(m))) {
      return undefined;
    }

    // Never let an abandoned/settled message at the head of the pending list
    // starve a live message behind it. Skip by the composite
    // (conversation_id, message_id) key, never by bare message_id: message ids
    // are per-conversation, so a settled message must not suppress a live
    // message in another conversation that happens to share the same id.
    // A new message in the same conversation has a different key and remains
    // eligible.
    const settledKeys = new Set(this.settledNegotiations);
    const stalledKeys = new Set(
      [...stalled.entries()]
        .filter(([, entry]) => {
          if (entry.attempts < AUTOPILOT_MAX_SUBMIT_FAILURES) return false;
          const sinceMs = Date.parse(entry.since);
          const nowMs = Date.parse(this.clock());
          return (
            Number.isFinite(sinceMs) &&
            Number.isFinite(nowMs) &&
            nowMs - sinceMs < AUTOPILOT_STALL_COOLDOWN_MS
          );
        })
        .map(([key]) => key),
    );

    // Buyer: negotiate toward the linked task's goal (quantity / target unit
    // price / budget) instead of the profile defaults.
    let hints: DecisionHints | undefined;
    const firstPending = pending.find(
      (m) => !settledKeys.has(settledKey(m)) && !stalledKeys.has(settledKey(m)),
    );
    if (firstPending !== undefined && this.profile.role === "buyer" && this.taskStore !== undefined) {
      const link = this.taskStore.linkByConversation(firstPending.conversation_id);
      if (link !== undefined) {
        const task = this.taskStore.getTask(link.task_id);
        if (task !== undefined) hints = taskNegotiationHints(this.taskStore, task);
      }
    }

    const runner = new DeterministicNegotiationRunner(this.profile, this.commerceClient);
    const prepared = await runner
      .prepare({
        ...(hints !== undefined ? { hints } : {}),
        ...(settledKeys.size > 0 || stalledKeys.size > 0
          ? { skipKeys: new Set([...settledKeys, ...stalledKeys]) }
          : {}),
      })
      .catch(() => undefined);
    if (prepared === undefined) return undefined;
    const convId = prepared.binding.conversation_id;

    // Termination: STOP when the counterpart just accepted our offer — report
    // the consensus once and never re-open this conversation.
    if (prepared.counterpart_action === "accept_nonbinding") {
      this.markSettled(settledKey(prepared.binding));
      await runner.abandon(prepared, "counterpart accepted non-binding — consensus").catch(() => undefined);
      return `已达成共识（对方接受非绑定报价），磋商结束，不再继续。`;
    }
    if (this.settledNegotiations.has(settledKey(prepared.binding))) {
      await runner.abandon(prepared, "negotiation already settled").catch(() => undefined);
      return undefined;
    }

    const outcome = await runner.submit(prepared).catch(() => undefined);
    if (outcome === undefined) return "磋商处理失败（网关异常），下一轮自动重试。";
    const bindingKey = settledKey(prepared.binding);
    // 审查 P2-I：权威门确定性拒绝（settlement failed）→ 连续失败计数；
    // 达上限进入冷却窗口（窗口内跳过、窗口后重试一次），并清空"已结算"
    // 误记——被拒消息绝不进 settled 集合（那是共识终态语义）。
    if (outcome.settlement === "failed") {
      const prev = stalled.get(bindingKey);
      const attempts = (prev?.attempts ?? 0) + 1;
      if (attempts >= AUTOPILOT_MAX_SUBMIT_FAILURES) {
        stalled.set(bindingKey, { since: this.clock(), attempts });
        return (
          `已自动处理 ${convId}：连续 ${attempts} 次被网关拒绝` +
          `（${outcome.policy_result.public_reason}），暂停自动处理 ` +
          `${AUTOPILOT_STALL_COOLDOWN_MS / 60_000} 分钟（可手动 /approve 或改策略后重试）。`
        );
      }
      stalled.set(bindingKey, { since: this.clock(), attempts });
    } else {
      // 成功/已共识：清除冷却记录
      stalled.delete(bindingKey);
    }
    // Our own non-binding acceptance ends the negotiation.
    if (prepared.decision.action === "accept_nonbinding") {
      this.markSettled(bindingKey);
    }

    const counterpart =
      prepared.counterpart_message !== undefined
        ? `对方：「${prepared.counterpart_message.slice(0, 60)}」`
        : "";
    const proposal = prepared.decision.proposal;
    const offer =
      proposal !== undefined
        ? `，出价 ${proposal.unit_price}${proposal.currency ?? ""}×${proposal.quantity}`
        : "";
    const sent =
      prepared.decision.public_message !== ""
        ? `；已发「${prepared.decision.public_message.slice(0, 60)}」`
        : "";
    const detail =
      outcome.settlement === "failed" ? `（${outcome.policy_result.public_reason}）` : "";
    return (
      `已自动处理 ${convId}：${counterpart} → ` +
      `${prepared.decision.action}${offer} = ${outcome.policy_result.result}${sent}${detail}`
    );
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
  /**
   * 把一段上下文注入会话（不触发模型回复）：`/negotiate` 等确定性动作的结果
   * 写入 session（user 角色、带「系统记录」标记），下一轮用户提问时模型能看到
   * （消除"两个脑"）。
   */
  async injectContext(text: string): Promise<void> {
    await this.harness.appendMessage({
      role: "user",
      content: `[系统记录] ${text}`,
      timestamp: Date.now(),
    });
  }

  /**
   * 把一轮 A2A 磋商结果写入记忆（episode namespace，active 无需人工确认）：
   * 持久上下文，`/why` 可查、跨重启可恢复。
   */
  recordNegotiation(input: NegotiationRecord): Promise<string> {
    return rememberNegotiation(this.store, input);
  }

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
        case "/register":
          return { text: await this.handleRegister(arg), quit: false };
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
   * `/register`：把本 merchant 注册进 agent catalog（buyer 据此发现）。
   * 用法：/register --agent-card-url <url> [--catalog <url>] [--domain <d>]
   * agent-card-url 可来自 `kiwi agent serve` 的 A2A server（缺省 env KIWI_AGENT_CARD_URL）。
   * catalog 缺省 env KIWI_CATALOG_URL 或 http://127.0.0.1:8600。
   */
  private async handleRegister(arg: string): Promise<string> {
    const flagValue = (flag: string): string | undefined => {
      const idx = arg.indexOf(flag);
      if (idx === -1) return undefined;
      const rest = arg.slice(idx + flag.length).trim();
      const word = rest.split(/\s+/)[0] ?? "";
      return word !== "" && !word.startsWith("--") ? word : undefined;
    };

    const agentCardUrl = flagValue("--agent-card-url") ?? process.env.KIWI_AGENT_CARD_URL;
    if (agentCardUrl === undefined) {
      return (
        "需要 merchant A2A server 的 agent card URL。先运行 `kiwi agent serve --profile <merchant>`，" +
        "然后 /register --agent-card-url http://127.0.0.1:9000/.well-known/agent-card.json" +
        "（或设置环境变量 KIWI_AGENT_CARD_URL）。"
      );
    }
    const catalog = flagValue("--catalog") ?? process.env.KIWI_CATALOG_URL ?? "http://127.0.0.1:8600";
    const safeAgentId = this.profile.agent_id.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const domain =
      flagValue("--domain") ?? process.env.KIWI_CATALOG_DOMAIN ?? `merchant-${safeAgentId}.local`;
    const ucpProfileUrl = agentCardUrl.replace(/\/agent-card\.json$/, "/ucp");

    try {
      const result = await registerCatalogAgent({
        catalogBaseUrl: catalog,
        domain,
        agentCardUrl,
        ucpProfileUrl: ucpProfileUrl !== agentCardUrl ? ucpProfileUrl : undefined,
        merchantId: this.profile.agent_id,
        ownerTokenSecret: process.env.KIWI_CATALOG_OWNER_TOKEN_SECRET,
      });
      return `[注册] 已注册到 agent catalog ${catalog}：${result.catalogAgentId ?? "?"}（status=${result.status ?? "?"}）。buyer 可经 catalog 发现本 merchant。`;
    } catch (err) {
      return `[注册] 失败（A2A server 仍在运行）：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Resolve a user-facing approval target: a /pending index, an exact id, or a
   * UNIQUE prefix of a pending candidate (LLM flows truncate long UUIDs).
   * Ambiguous prefixes and out-of-range indices stay rejected.
   */
  private resolveApprovalId(input: string): string | undefined {
    if (this.approvals === undefined) return undefined;
    const pending = this.approvals.listPending();
    // 只把纯十进制当序号（评审项：Number("0x10")=16、Number("1e2")=100 会
    // 把进制/科学计数法输入解析成序号索引，误批非预期的候选）。
    const n = /^\d+$/.test(input) ? Number(input) : Number.NaN;
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
    // 等 enqueue 链（评审项 L4）：排队中的工具调用/命令/scheduler tick 全部
    // 落定后再关库——此前只等模型 harness 空闲，排队中的后续 work 在
    // db.close() 之后仍会执行（/profile 切换旧 kernel 的空窗），行为未定义。
    try {
      await this.chain;
    } catch {
      // 链上错误已各自 catch（this.chain 赋值时 catch），此处仅确保等待完成。
    }
    try {
      await this.harness.waitForIdle();
    } catch {
      // best-effort flush; closing the store is what must not be skipped
    }
    this.db.close();
  }
}
