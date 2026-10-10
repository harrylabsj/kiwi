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
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fs/atomic-write.js";
import { submitIdempotencyKey } from "../runtime/tools.js";
import type { CandidateBinding, StrategyDirective } from "./types.js";
import type { DecisionHints } from "../runtime/fake-model.js";
import { isPercentageAmount } from "./strategy.js";

/** A claimed turn with a generated, not-yet-submitted candidate decision. */
export interface PreparedCandidate {
  binding: CandidateBinding;
  decision: NegotiationDecision;
  /** Concise decision-summary lines (no chain-of-thought, no private numbers). */
  analysis: string[];
  conversation_status: string;
  /** Last counterpart public message, for the TUI transcript pane. */
  counterpart_message?: string;
  /** Last counterpart message's action, if any (for consensus detection). */
  counterpart_action?: NegotiationDecision["action"];
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
   * `skipKeys` excludes messages by their composite `${conversation_id}:
   * ${message_id}` key — used by the autopilot for settled negotiations so a
   * settled message in one conversation never suppresses a live message in
   * another conversation that happens to share the same numeric message_id.
   * `directives` are the applied session/turn strategy directives that guide
   * candidate generation (design §7) — the compiled hints never widen the
   * profile's HardPolicy, which the gates re-check at submit time.
   */
  prepare(options?: {
    skipMessageIds?: ReadonlySet<number>;
    skipKeys?: ReadonlySet<string>;
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
    // Numeric budget/floor hints only come from tighten/relax constraint
    // directives — a soft_preference mentioning 预算/底价 must not override.
    if (
      (directive.kind === "tighten" || directive.kind === "relax") &&
      !isPercentageAmount(directive.directive) &&
      /预算|budget/i.test(directive.directive)
    ) {
      const amount = /\d+(?:\.\d+)?/.exec(directive.directive);
      if (amount !== null) hints.buyer_max_total_price = Number(amount[0]);
    }
    if (
      (directive.kind === "tighten" || directive.kind === "relax") &&
      !isPercentageAmount(directive.directive) &&
      /底价|最低价|floor/i.test(directive.directive)
    ) {
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
  /**
   * review P1-4（A327 补充）：**持久 unknown 围栏目录**（0700/文件 0600）。
   * submit 网络异常（效果可能已落地）时把 (conversation, message, idem-key)
   * 原子写入 `<dir>/submit-unknown.jsonl`（writeFileAtomic：tmp+rename +
   * 文件/目录 fsync，写失败上抛 fail-closed，A336 返修）；prepare() 从此
   * 跳过这些消息——TTL 重挂/进程重启/其他健康会话都不得把它们重驱成新
   * 操作。授权对账（`clearUnknown`）为唯一解除路径。未配置时仅内存围栏
   * （进程内有效）。
   */
  unknownFenceDir?: string;
}

/** 持久 unknown 围栏条目。 */
interface UnknownFenceEntry {
  conversation_id: string;
  message_id: number;
  idempotency_key: string;
  reason: string;
  at: string;
}

/**
 * review P1-4 R1（A342 返修）：围栏持久化失败的**可识别类型化错误**。
 * kernel 每 tick 新建 runner——持久化失败被吞成普通 unknown 文案时，下一
 * tick 新 runner 空 Map + 旧文件无条目 + failed claim 可重领 = 再次 submit
 * 路径。kernel 据此类型 fail-closed 停机（不转普通 unknown 继续驱动）。
 */
export class UnknownFencePersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnknownFencePersistenceError";
  }
}

export class DeterministicNegotiationRunner implements NegotiationRunner {
  private readonly profile: AgentProfile;
  private readonly client: CommerceClient;
  private readonly heartbeatIntervalMs: number;
  private heartbeat?: ClaimHeartbeat;
  /** review P1-4（A327）：持久 unknown 围栏（进程内索引 + JSONL 落盘）。 */
  private readonly unknownFence = new Map<string, UnknownFenceEntry>();
  private readonly unknownFencePath?: string;

  constructor(profile: AgentProfile, client: CommerceClient, options?: DeterministicRunnerOptions) {
    this.profile = profile;
    this.client = client;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    if (options?.unknownFenceDir !== undefined) {
      this.unknownFencePath = path.join(options.unknownFenceDir, "submit-unknown.jsonl");
      this.loadUnknownFence();
    }
  }

  /** 启动时加载持久 unknown 围栏（读失败/坏行 fail-closed，见下）。 */
  /**
   * review P1-4（A331 收口）：读失败/坏行 **fail-closed**——unknown 条目丢失
   * 即丢屏障，宁可拒绝会话恢复也不能静默放行重驱。整文件不可读或单行损坏
   * → 抛错（指向对账修复），不以静默跳过代 fail-closed。
   */
  private loadUnknownFence(): void {
    if (this.unknownFencePath === undefined || !existsSync(this.unknownFencePath)) return;
    let lines: string[];
    try {
      lines = readFileSync(this.unknownFencePath, "utf-8").split("\n");
    } catch (err) {
      throw new Error(
        `unknown fence file unreadable (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    for (const line of lines) {
      if (line.trim() === "") continue;
      let entry: UnknownFenceEntry;
      try {
        entry = JSON.parse(line) as UnknownFenceEntry;
      } catch (err) {
        throw new Error(
          `unknown fence file has a corrupted line (fail-closed; reconcile the fence file): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      if (
        typeof entry.conversation_id !== "string" ||
        typeof entry.message_id !== "number" ||
        typeof entry.idempotency_key !== "string"
      ) {
        throw new Error(
          "unknown fence file has a malformed entry (fail-closed; reconcile the fence file)",
        );
      }
      this.unknownFence.set(this.unknownKey(entry.conversation_id, entry.message_id), entry);
    }
  }

  private unknownKey(conversationId: string, messageId: number): string {
    return `${conversationId}:${messageId}`;
  }

  /**
   * review P1-4（A336 返修）：持久记录 unknown——复用既有原子写架构
   * （writeFileAtomic：tmp+rename、文件 fsync + 目录 fsync、0600/0700），
   * 部分写不落可见文件；**写失败/目录同步失败上抛（fail-closed）**。
   * 旧实现 appendFileSync 无 fsync 且 catch 吞错——「Map 先写、失败吞掉、
   * 重启空 Map 放行重驱」（A334 实证与 A331 报告不符）。内存围栏在落盘前
   * 先立：即使本进程磁盘已坏，本进程也绝不重驱；上抛让调用方明确知道
   * 持久化未保证（重启屏障缺失须对账修复存储）。
   */
  private recordUnknownFence(binding: { conversation_id: string; message_id: number; idempotency_key: string }, reason: string): void {
    const key = this.unknownKey(binding.conversation_id, binding.message_id);
    const entry: UnknownFenceEntry = {
      conversation_id: binding.conversation_id,
      message_id: binding.message_id,
      idempotency_key: binding.idempotency_key,
      reason: reason.slice(0, 400),
      at: new Date().toISOString(),
    };
    this.unknownFence.set(key, entry);
    if (this.unknownFencePath === undefined) return;
    this.persistUnknownFence();
  }

  /** 全量重写围栏文件（原子替换）；失败抛 AtomicWriteError，调用方不得吞。 */
  private persistUnknownFence(): void {
    if (this.unknownFencePath === undefined) return;
    const content = [...this.unknownFence.values()]
      .map((e) => JSON.stringify(e))
      .join("\n");
    writeFileAtomic(this.unknownFencePath, content === "" ? "" : `${content}\n`, { mode: 0o600 });
  }

  /**
   * review P1-4（A331）：暴露围栏键集（conversation:message）——只读内省
   * 视图（测试/诊断用）。kernel 的 hints 绑定自 A336 起改由 prepare 的
   * hintsFor 回调按实际选中目标现产，不再消费本视图。
   */
  getUnknownFenceKeys(): ReadonlySet<string> {
    return new Set(this.unknownFence.keys());
  }

  /**
   * 授权对账完成后显式解除围栏（唯一解除路径；重写文件去掉该条）。
   *
   * review P1-4（A336 返修）：先持久化「解除后」的内容、成功才改内存——
   * 重写失败**上抛**且条目保持围栏（保守方向），不以内存已解除冒充已恢复。
   * 注意：本方法当前无生产权威对账 caller（明确限制保持）——缺事实不解除，
   * 调用方必须先完成网关侧对账再调用。
   */
  clearUnknown(conversationId: string, messageId: number): boolean {
    const key = this.unknownKey(conversationId, messageId);
    if (!this.unknownFence.has(key)) return false;
    if (this.unknownFencePath !== undefined) {
      const remaining = [...this.unknownFence.values()].filter(
        (e) => this.unknownKey(e.conversation_id, e.message_id) !== key,
      );
      const content = remaining.map((e) => JSON.stringify(e)).join("\n");
      writeFileAtomic(this.unknownFencePath, content === "" ? "" : `${content}\n`, { mode: 0o600 });
    }
    this.unknownFence.delete(key);
    return true;
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
    skipKeys?: ReadonlySet<string>;
    directives?: readonly StrategyDirective[];
    /** Direct hints (e.g. task-derived quantity/target/budget), merged over directives. */
    hints?: DecisionHints;
    /**
     * review P1-4（A336 返修）：由**实际选中的目标**现产 hints 的回调——
     * 调用方（kernel）第一次 list 与本方法第二次 list 之间 pending 可变，
     * 静态预取 hints 会串用到别的会话（B hints→C 实证）。回调在本方法
     * 选定 target 后、生成 decision 前调用，hints 与实际
     * (conversation, message, task) 强绑定。合并顺序在静态 hints 之后
     * （实际目标现产值优先）。
     */
    hintsFor?: (target: { conversation_id: string; message_id: number }) => DecisionHints | undefined;
  }): Promise<PreparedCandidate | undefined> {
    const pending = await this.client.listPendingMessages();
    // Skip by full (conversation_id, message_id) key, not bare message_id:
    // message ids are per-conversation, so a settled/rejected message must
    // never suppress a live message in another conversation with the same id.
    const target = pending.find(
      (m) =>
        options?.skipMessageIds?.has(m.message_id) !== true &&
        options?.skipKeys?.has(`${m.conversation_id}:${m.message_id}`) !== true &&
        // review P1-4（A327 补充）：持久 unknown 围栏——prepare 不重新列出
        // 「结果未知」的消息（含重启后从围栏文件加载的条目）。
        !this.unknownFence.has(this.unknownKey(m.conversation_id, m.message_id)),
    );
    if (!target) return undefined;

    const idem = idempotencyKey(this.profile.agent_id, target.message_id, PROTOCOL_VERSION);
    const claim = await this.client.claimMessage({
      conversation_id: target.conversation_id,
      message_id: target.message_id,
      idempotency_key: idem,
    });
    if (!claim.claimed) return undefined;

    // Any failure AFTER the claim must release it — a stuck processing claim
    // would silently block this message from ever being re-pending.
    const release = (err: unknown): never => {
      void this.client
        .abandonClaim({
          message_id: target.message_id,
          idempotency_key: idem,
          error: `prepare failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        .catch(() => undefined);
      throw err;
    };

    const snapshot = await this.client
      .getNegotiationSnapshot({
        conversation_id: target.conversation_id,
        message_id: target.message_id,
      })
      .catch(release);

    // review 2-13（A316 校准）：snapshot 成功后的 decision/analysis 段抛错
    // 同样释放 claim（此前只兜 getNegotiationSnapshot——A315 精确 fault 实证
    // analysis 阶段故障使 claim 永久 processing）。此段纯本地、无外发效果，
    // abandon 安全。
    // review P1-4 R2（A342 返修）：hints 现产（hintsFor 回调读取
    // taskStore/Vault，可同步抛错）与 clamp 必须纳入**同一** pre-send 释放
    // 保护段——此前回调在 try 之外，异常时 claim 已取得却不 release（卡
    // processing，2-13 回归破坏）。效果未开始 → release（abandon），不落
    // unknown 围栏、零 submit。
    let decision!: ReturnType<typeof deterministicMerchantDecision>;
    try {
      // Seed with the profile's private floor so the merchant decision always
      // knows its floor (convergence: accept a counter at/above the floor).
      const profileHints: DecisionHints = {};
      if (
        this.profile.role === "merchant" &&
        this.profile.merchant_policy?.min_unit_price_private !== undefined
      ) {
        profileHints.merchant_min_unit_price = this.profile.merchant_policy.min_unit_price_private;
      }
      const hints = clampHintsToHardPolicy(
        this.profile,
        {
          ...profileHints,
          ...compileDirectiveHints(options?.directives ?? []),
          ...options?.hints,
          // review P1-4（A336）：实际目标现产 hints 最后合并（优先于静态预取）。
          ...options?.hintsFor?.(target),
        },
      );
      decision =
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
    } catch (err) {
      release(err);
    }

    // review 2-13（A316 补充校准）：snapshot 之后的 messages 提取 /
    // buildAnalysis 构建同样在释放保护段内——任一内部故障都安全释放 claim
    //（此段纯本地、无外发效果）。
    let prepared!: PreparedCandidate;
    try {
      const counterpart = [...snapshot.messages]
        .reverse()
        .find((m) => m.sender_role !== snapshot.role);

      prepared = {
        binding: {
          conversation_id: target.conversation_id,
          message_id: target.message_id,
          idempotency_key: idem,
        },
        decision,
        analysis: buildAnalysis(this.profile, snapshot, decision),
        conversation_status: snapshot.conversation.status,
      };
      if (counterpart !== undefined) {
        prepared.counterpart_message = counterpart.public_message;
        if (counterpart.action !== undefined) prepared.counterpart_action = counterpart.action;
      }
    } catch (err) {
      release(err);
    }
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

    // review P1-4（A316 校准）：submit 网络异常 ≠ 纯失败——效果可能已落地
    //（effects-1-then-lost-response）。把 claim 以 **unknown 语义**持久置为
    // failed（failClaim 承载 marker，替代盲目 abandon/放任 TTL 重驱）：
    // failed claim 不再被本会话/其他健康会话/TTL 重领，原 idempotency key
    // 与 decision 保留在网关幂等表，恢复须显式对账。
    let result: Awaited<ReturnType<typeof this.client.submitNegotiationDecision>>;
    try {
      result = await this.client.submitNegotiationDecision({
        decision,
        idempotency_key: submitIdempotencyKey(binding.idempotency_key, decision),
      });
    } catch (err) {
      const reason =
        "submit result unknown: request may have landed (effects possible); " +
        "reconcile with original idempotency key before any retry — " +
        `${err instanceof Error ? err.message : String(err)}`;
      // review P1-4（A331 收口）：持久围栏**先于** failClaim——网关阻塞/
      // 故障会扩大未知窗口，本地权威落盘不得排在可能失败的 await 之后。
      // review P1-4（A336 返修）：落盘失败**上抛**（fsync + 原子写，见
      // recordUnknownFence）——失败仍 best-effort failClaim 打 unknown
      // 标记，但以围栏持久化失败为主错误抛出，不得吞成「重启空 Map 放行」。
      try {
        this.recordUnknownFence(binding, reason);
      } catch (fenceErr) {
        await this.client
          .failClaim({
            message_id: binding.message_id,
            idempotency_key: binding.idempotency_key,
            error: reason,
          })
          .catch(() => undefined);
        // review P1-4 R1（A342）：类型化上抛——kernel 据此 fail-closed 停机，
        // 不吞成普通 unknown 文案让下一 tick 新 runner 空 Map 重驱。
        throw new UnknownFencePersistenceError(
          `unknown fence persistence failed (fail-closed; reconcile storage before any retry): ` +
            `${fenceErr instanceof Error ? fenceErr.message : String(fenceErr)}; ` +
            `original submit error: ${err instanceof Error ? err.message : String(err)}`,
          { cause: fenceErr },
        );
      }
      await this.client
        .failClaim({
          message_id: binding.message_id,
          idempotency_key: binding.idempotency_key,
          error: reason,
        })
        .catch(() => undefined);
      throw err;
    }

    if (result.result === "accepted" || result.result === "human_required") {
      // review P1-4（A336 返修）：效果已落地（网关 accepted / 转人工）后
      // completeClaim 失败 = **确认未知**——与 submit 异常同层：持久围栏后
      // 上抛，不得成为下一 tick 重驱（不能只 submit 抛错才 fence）。效果
      // 未开始的失败（本地门未过 / 网关 policy rejected）不落围栏（不泛封）。
      try {
        await this.client.completeClaim({
          message_id: binding.message_id,
          idempotency_key: binding.idempotency_key,
        });
      } catch (err) {
        const reason =
          "claim completion unknown after gateway-accepted decision: effect has landed, " +
          "settlement confirmation failed; reconcile before any retry — " +
          `${err instanceof Error ? err.message : String(err)}`;
        // review P1-4 R1（A342）：此处落盘失败同样类型化上抛（重驱风险与
        // submit 路径同形），由 kernel fail-closed 停机。
        try {
          this.recordUnknownFence(binding, reason);
        } catch (fenceErr) {
          throw new UnknownFencePersistenceError(
            `unknown fence persistence failed after gateway-accepted decision (fail-closed): ` +
              `${fenceErr instanceof Error ? fenceErr.message : String(fenceErr)}; ` +
              `original completion error: ${err instanceof Error ? err.message : String(err)}`,
            { cause: fenceErr },
          );
        }
        throw err;
      }
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

  /** 审查 BUG-08：对方已接受 = 本消息已处理的终态——以 completeClaim 权威
   *  结算。abandon 的语义是释放 claim 允许重领，此前 accept 后 abandon 靠
   *  进程内存 settled 集合遮挡，重启后消息再次进入处理（重复 claim/快照/
   *  通知）。Best-effort：失败由网关 stale TTL 兜底。 */
  async complete(prepared: Pick<PreparedCandidate, "binding">): Promise<void> {
    try {
      await this.client.completeClaim({
        message_id: prepared.binding.message_id,
        idempotency_key: prepared.binding.idempotency_key,
      });
    } catch {
      // Complete must never mask the operator-facing outcome.
    }
  }
}
