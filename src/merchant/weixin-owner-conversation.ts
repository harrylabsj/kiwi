/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { InboundMessage } from "../weixin/types.js";
import { ownerWeekdayDigest } from "./weixin-owner-digest.js";
import type { OwnerAgentDecision, WeixinOwnerAgent } from "./weixin-owner-agent.js";
import { OwnerInventoryError, ownerInventorySku, type OwnerInventoryObservation } from "./weixin-owner-inventory.js";

const RETENTION = 30 * 24 * 60 * 60_000;
const REPLY_TTL = 10 * 60_000;
const LIST_TTL = 30 * 60_000;
const MAX_TEXT = 1200;
const MAX_CONTEXT = 4096;
const AGENT_HISTORY_LIMIT = 4;
const AGENT_CALLS_PER_DAY = 60;
const DAY_MS = 24 * 60 * 60_000;
const AGENT_UNAVAILABLE = "Kiwi 暂时无法连接对话模型，请稍后重新发问。没有执行任何业务操作。";

/** 单个权威来源的最小询价事实，不携带客户正文、价格、身份或路由。 */
export interface OwnerInquiry {
  id: string;
  version: string;
  receivedAt: number;
  dueAt?: number;
  sku?: string;
  quantity?: number;
}

/** 区间统计的最小事实：仅计数，不携带询价 ID、SKU、身份或正文。 */
export interface OwnerRangeStats {
  /** 区间内最后买家入站落进范围的询价链路数。 */
  inquiries: number;
  /** 其中仍待商家回复的链路数。 */
  pending: number;
}

export interface OwnerInquirySource {
  list(): readonly OwnerInquiry[];
  get(id: string): OwnerInquiry | undefined;
  /** 按起始时间的咨询统计；未装配则区间/今日统计明确不可用，不得编造。 */
  rangeStats?(since: number): OwnerRangeStats;
}

export type FollowupStyle = "concise" | "warm";
export interface OwnerFollowupPreference {
  style: FollowupStyle | null;
  version: number;
  updated_at: string | null;
}

export interface WeixinOwnerConversationOptions {
  enabled: boolean;
  /** 显式开启仅配对店主的私聊回信。缺省仍为工作台预览。 */
  replyToOwner?: boolean;
  /** An independently opted-in model for owner private chat; never used in preview mode. */
  agent?: WeixinOwnerAgent;
  /** 尚有效的单实例管理员凭据代次；口令轮换、主体替换后必须改变。 */
  ownerRevision: (principalId: string) => string | undefined;
  source: OwnerInquirySource;
  /** 仅工作台预览可调用的现有精确目录读取；不装配则明确不可用。 */
  inventory?: (sku: string) => Promise<OwnerInventoryObservation>;
  /** 已配置且可信的工作台 origin（不是请求的 Host）。 */
  workbenchOrigin: string;
  timeZone?: string;
  /** 可选受限 Pi 起草器，输入只有已复核的公开规格及数量。 */
  compose?: (facts: Pick<OwnerInquiry, "sku" | "quantity">, signal: AbortSignal) => Promise<string>;
}

interface Binding {
  epoch: string;
  principal: string;
  revision: string;
  fingerprint: string;
  conversation: string;
}

type TurnState = "queued" | "previewed" | "ready" | "unknown" | "accepted" | "void";
interface Turn {
  seq: number;
  epoch: string;
  conversation: string;
  received: number;
  text: string | null;
  context: string | null;
  state: TurnState;
  reply: string | null;
}

interface DraftRow {
  id: string;
  epoch: string;
  principal: string;
  inquiry: string;
  source_version: string;
  version: number;
  body: string;
  created: number;
}

interface ListSnapshot {
  ref: string;
  queried?: number;
  items: OwnerInquiry[];
}

export class OwnerConversationError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "conflict" | "forbidden" | "unavailable", message: string) {
    super(message);
  }
}

/** 方向、时限、等待时长和并列次序均由服务器决定。 */
export function rankOwnerInquiries(items: readonly OwnerInquiry[], now: number): OwnerInquiry[] {
  const group = (i: OwnerInquiry) => i.dueAt === undefined ? 2 : i.dueAt <= now ? 0 : 1;
  return [...items].sort((a, b) => group(a) - group(b) ||
    (a.dueAt ?? 0) - (b.dueAt ?? 0) || a.receivedAt - b.receivedAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 3);
}

type OwnerIntent = OwnerAgentDecision | { kind: "greeting" | "unsupported" | "clarify_target" };

/** The model may interpret intent but cannot invent or silently change a draft target. */
function checkAgentTarget(intent: OwnerAgentDecision, text: string): OwnerIntent {
  if (intent.kind !== "draft" && intent.kind !== "explain") return intent;
  const ordinals = [...text.matchAll(/(?:第\s*([一二三123])\s*(?:笔|条|个|项)|(?<!\d)([123])\s*号)/g)];
  const refs = [...text.matchAll(/\bL-[a-f\d]{8}\b/gi)];
  const ordinal = ordinals[0]?.[1] ?? ordinals[0]?.[2] ?? "";
  const index = (["一", "二", "三"].includes(ordinal) ? "一二三".indexOf(ordinal) + 1 : Number(ordinal)) - 1;
  if (ordinals.length !== 1 || index !== intent.index || refs.length > 1 || refs[0]?.[0].toUpperCase() !== intent.ref) {
    return { kind: "clarify_target" };
  }
  return intent;
}

const CN_DAYS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 区间天数只取店主明确给出的 1–30，超出范围不猜、回落为不支持。 */
function parseOwnerDays(text: string): number | undefined {
  if (/^[0-9]{1,2}$/.test(text)) {
    const n = Number(text);
    return n >= 1 && n <= 30 ? n : undefined;
  }
  return CN_DAYS[text];
}

/** 只把边界明确的自然语言意图映射到业务能力，不执行正式操作。 */
function classify(text: string): OwnerIntent {
  // 「先别发」是草稿限制，不应被误读为拒绝起草或发送授权。
  const request = text.replace(/(?:先)?(?:别|不要|不用|不必|无需)(?:发送|发)(?:给买家|给客户)?(?=[。！？!?，,；;\s]|$)/g, " ");
  if (/不要|别(?:再|给|起草)|不用|不必|别发|无需|报价|改价|退款|赔付|改地址|下单|付款|发送|发给|群发|发出去|直接发|替我回复|直接回复|批准|审批|改库存/.test(request)) {
    return { kind: "blocked" };
  }
  const matches = [...request.matchAll(/第\s*([一二三123])\s*(?:笔|条|个)/g)];
  const refs = [...request.matchAll(/\bL-[a-f\d]{8}\b/gi)];
  const why = /为什么|为何|什么原因|怎么排|排序理由/.test(request);
  if (matches.length === 1 && refs.length <= 1 && (why || /起草|草稿|拟|写(?:个|一份|一条)?(?:回复|回信)/.test(request))) {
    const n = matches[0]?.[1] ?? "";
    const ref = refs[0]?.[0];
    return { kind: why ? "explain" : "draft", index: ("一二三".includes(n) ? "一二三".indexOf(n) + 1 : Number(n)) - 1,
      ...(ref !== undefined ? { ref: ref.toUpperCase() } : {}) };
  }
  if (!/起草|草稿/.test(request) && (/询[价盘]|待回复/.test(request) && /今天|哪些|哪几|哪[三3]|优先|待回复|最该|排行/.test(request) ||
    /(?:今天|现在).*(?:有什么|哪些|哪几|要|待).*(?:跟进|处理|回复)/.test(request))) return { kind: "list" };
  if (/^(?:(?:把)?(?:刚才|上一条|上次)(?:的)?(?:清单|回复|结果)?(?:再说一遍|是什么|是啥|给我看看|给我复述一下)|(?:刚才|上次)(?:聊|说)到哪[里儿]?|再说一遍|你刚才说了什么)[。！？!?\s]*$/.test(request)) {
    return { kind: "repeat", listOnly: request.includes("清单") };
  }
  if (/^(?:你好|您好|在吗|嗨|hi|hello|你是谁|你是做什么的|你能做什么|你可以帮我做什么)[。！？!?\s]*$/i.test(request)) return { kind: "greeting" };
  if (/库存|订单|询价详情|客户资料|联系方式|成交|付款状态|退款状态/.test(request)) return { kind: "private_lookup" };
  const daysText = /(?:最近|过去|近)\s*([0-9]{1,2}|[一二两三四五六七八九十])\s*天/.exec(request)?.[1];
  const days = daysText !== undefined ? parseOwnerDays(daysText) : undefined;
  if (days !== undefined && /咨询|询价|客户|买家|商机/.test(request)) return { kind: "range", days };
  if (/(?:这周|本周|这一周|上个?周|上个?星期)/.test(request) && /咨询|询价|客户|买家|商机/.test(request)) return { kind: "range", days: 7 };
  if (/今天|今日/.test(request) && /咨询|询价|买家|客户|新增/.test(request)) return { kind: "today" };
  return { kind: "unsupported" };
}

function digest(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

export function bindingFingerprint(account: string, bot: string, token: string, savedAt: string): string {
  return digest([account, bot, token, savedAt]);
}

/** 工作台微信单写者锁之下的独立版本化存储，旧构建不需要认识此文件。 */
export class WeixinOwnerConversation {
  private readonly db: DatabaseSync;
  private readonly formatter: Intl.DateTimeFormat;
  private lastPurge = -Infinity;
  private agentCall: { conversation: string; abort: AbortController } | undefined;

  constructor(file: string, private readonly options: WeixinOwnerConversationOptions, private readonly now: () => number) {
    this.formatter = new Intl.DateTimeFormat("zh-CN", { timeZone: options.timeZone ?? "Asia/Shanghai", dateStyle: "short", timeStyle: "short", hour12: false });
    closeSync(openSync(file, "a", 0o600));
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS owner_binding (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1), epoch TEXT NOT NULL,
          principal TEXT NOT NULL, revision TEXT NOT NULL, fingerprint TEXT NOT NULL, conversation TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS owner_turn (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, epoch TEXT NOT NULL, conversation TEXT NOT NULL,
          message_key TEXT NOT NULL UNIQUE, received INTEGER NOT NULL,
          text TEXT, context TEXT, state TEXT NOT NULL, reply TEXT, list TEXT, rule_proposal TEXT
        );
        CREATE INDEX IF NOT EXISTS owner_turn_dispatch ON owner_turn (conversation, state, seq);
        CREATE TABLE IF NOT EXISTS owner_agent_turn (
          seq INTEGER PRIMARY KEY REFERENCES owner_turn(seq) ON DELETE CASCADE,
          requested INTEGER NOT NULL, history_reply INTEGER CHECK (history_reply IN (0, 1))
        );
        CREATE INDEX IF NOT EXISTS owner_agent_turn_requested ON owner_agent_turn (requested);
        CREATE TABLE IF NOT EXISTS owner_followup_preference (
          principal TEXT PRIMARY KEY, style TEXT, version INTEGER NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS owner_reply_draft (
          id TEXT PRIMARY KEY, command_key TEXT NOT NULL UNIQUE, epoch TEXT NOT NULL, principal TEXT NOT NULL,
          inquiry TEXT NOT NULL, source_version TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL,
          created INTEGER NOT NULL, updated INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS owner_reply_draft_discard (
          id TEXT PRIMARY KEY REFERENCES owner_reply_draft(id), discarded INTEGER NOT NULL
        );`);
      // 新版绑定可在模型授权失效时保留回信授权。只切换活跃会话，不删除历史或草稿。
      this.atomic(() => {
        const row = this.binding();
        if (row === undefined || !row.revision.includes(":")) return;
        const owner = this.options.ownerRevision(row.principal);
        if (!owner) return;
        const local = digest(["paired-owner-replies-v1", owner]);
        if (row.revision.startsWith(`${local}:`) && /^[a-f0-9]{64}$/.test(row.revision.slice(local.length + 1)) &&
            this.consentedAgent(row) === undefined) {
          this.db.prepare("UPDATE owner_binding SET revision = ?, conversation = ? WHERE singleton = 1")
            .run(local, randomUUID());
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private atomic<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private binding(): Binding | undefined {
    return this.db.prepare("SELECT epoch, principal, revision, fingerprint, conversation FROM owner_binding WHERE singleton = 1").get() as Binding | undefined;
  }

  private revisionFor(principal: string): string | undefined {
    const revision = this.options.ownerRevision(principal);
    if (!revision || !this.options.replyToOwner) return revision;
    return digest(["paired-owner-replies-v1", revision]);
  }

  /** 每次推理单独校验当轮绑定的模型数据授权，不能用微信回信授权替代。 */
  private consentedAgent(row: Binding): Extract<WeixinOwnerAgent, { state: "configured" }> | undefined {
    const agent = this.options.agent;
    if (!this.options.replyToOwner || agent?.state !== "configured") return undefined;
    const owner = this.options.ownerRevision(row.principal);
    const local = this.revisionFor(row.principal);
    if (!owner || !local) return undefined;
    // 旧版将两类授权存成一个摘要，仅在原模型仍匹配时兼容。
    return row.revision === `${local}:${agent.consent}` ||
      row.revision === digest(["paired-owner-agent-v1", owner, agent.consent]) ? agent : undefined;
  }

  private active(fingerprint: string): Binding | undefined {
    if (!this.options.enabled) return undefined;
    const row = this.binding();
    if (row?.fingerprint !== fingerprint) return undefined;
    const revision = this.revisionFor(row.principal);
    if (!revision) return undefined;
    const separated = this.options.replyToOwner && row.revision.startsWith(`${revision}:`) &&
      /^[a-f0-9]{64}$/.test(row.revision.slice(revision.length + 1));
    return row.revision === revision || separated || this.consentedAgent(row) !== undefined ? row : undefined;
  }

  /** 在轮询开始时固定授权，晚到的旧批次不能进入新会话。 */
  consent(fingerprint: string): string | undefined {
    return this.active(fingerprint)?.conversation;
  }

  bind(principal: string, fingerprint: string, modelConsent?: string): void {
    if (!this.options.enabled) throw new OwnerConversationError("unavailable", "店主对话未启用。");
    this.atomic(() => {
      const revision = this.revisionFor(principal);
      if (!revision) throw new OwnerConversationError("forbidden", "当前店主身份不能授权对话。");
      if (modelConsent !== undefined && (!this.options.replyToOwner || this.options.agent?.state !== "configured" ||
          this.options.agent.consent !== modelConsent)) throw new OwnerConversationError("conflict", "模型授权已变化。");
      const active = this.active(fingerprint);
      if (active?.principal === principal && modelConsent !== undefined) {
        if (this.consentedAgent(active) !== undefined) return;
        // An additional data consent changes the message epoch for admission without deleting the prior chat.
        this.db.prepare("UPDATE owner_binding SET revision = ?, conversation = ? WHERE singleton = 1")
          .run(`${revision}:${modelConsent}`, randomUUID());
        return;
      }
      this.revokeInTransaction();
      this.db.prepare("INSERT INTO owner_binding VALUES (1, ?, ?, ?, ?, ?)")
        .run(randomUUID(), principal, modelConsent === undefined ? revision : `${revision}:${modelConsent}`, fingerprint, randomUUID());
    });
  }

  stopModel(principal: string, fingerprint: string): void {
    this.atomic(() => {
      const binding = this.active(fingerprint);
      if (binding?.principal !== principal || !this.options.replyToOwner) {
        throw new OwnerConversationError("forbidden", "当前店主没有活动的微信对话。");
      }
      this.removeModelConsent(binding, this.revisionFor(principal)!);
    });
  }

  private removeModelConsent(binding: Binding, revision: string): void {
    if (binding.revision === revision) return;
    if (this.agentCall?.conversation === binding.conversation) this.agentCall.abort.abort();
    this.db.prepare("UPDATE owner_binding SET revision = ?, conversation = ? WHERE singleton = 1")
      .run(revision, randomUUID());
  }

  revoke(): void {
    this.atomic(() => this.revokeInTransaction());
  }

  private revokeInTransaction(): void {
    const current = this.binding();
    if (current !== undefined) this.clearTurns(current.conversation);
    this.db.exec("DELETE FROM owner_binding");
  }

  private clearTurns(conversation: string): void {
    if (this.agentCall?.conversation === conversation) this.agentCall.abort.abort();
    this.db.prepare(`UPDATE owner_turn SET text = NULL, context = NULL, reply = NULL, list = NULL, rule_proposal = NULL,
      state = CASE WHEN state IN ('queued', 'ready') THEN 'void' ELSE state END WHERE conversation = ?`).run(conversation);
  }

  clear(principal: string, fingerprint: string): void {
    this.atomic(() => {
      const binding = this.active(fingerprint);
      if (binding?.principal !== principal) throw new OwnerConversationError("forbidden", "当前店主没有活动对话。");
      this.clearTurns(binding.conversation);
      this.db.prepare("UPDATE owner_binding SET conversation = ? WHERE singleton = 1").run(randomUUID());
    });
  }

  status(principal: string, fingerprint: string | undefined) {
    const binding = fingerprint === undefined ? undefined : this.active(fingerprint);
    const last = this.db.prepare(`SELECT state, received FROM owner_turn WHERE epoch = ? ORDER BY seq DESC LIMIT 1`)
      .get(binding?.principal === principal ? binding.epoch : "");
    const unknown = this.db.prepare("SELECT COUNT(*) count FROM owner_turn WHERE epoch = ? AND state = 'unknown'")
      .get(binding?.principal === principal ? binding.epoch : "") as { count: number };
    const preview = this.db.prepare("SELECT reply, rule_proposal FROM owner_turn WHERE conversation = ? AND state = 'previewed' ORDER BY seq DESC LIMIT 1")
      .get(binding?.principal === principal ? binding.conversation : "");
    return { enabled: this.options.enabled, authorized: binding?.principal === principal,
      ...(this.options.replyToOwner ? { model_authorized: binding?.principal === principal && this.consentedAgent(binding) !== undefined } : {}),
      delivery: this.options.replyToOwner ? "paired_owner" as const : "workbench_only" as const,
      last_result: last?.state ?? null, last_received_at: last?.received ?? null, unknown_count: unknown.count,
      preview: preview?.reply ?? null,
      rule_proposal: typeof preview?.rule_proposal === "string" ? JSON.parse(preview.rule_proposal) as ReturnType<typeof ownerWeekdayDigest> : null };
  }

  /** 整批入库。调用方在本方法成功返回后才推进游标。 */
  admit(fingerprint: string, account: string, messages: readonly InboundMessage[], expectedConsent: string | undefined): void {
    const now = this.now();
    const purge = now - this.lastPurge >= 60_000;
    this.atomic(() => {
      if (purge) {
        this.db.prepare("DELETE FROM owner_turn WHERE received < ?").run(now - RETENTION);
        this.db.prepare("UPDATE owner_turn SET text=NULL WHERE state IN ('accepted', 'unknown') AND received<=? AND text IS NOT NULL")
          .run(now - LIST_TTL);
        this.db.prepare(`UPDATE owner_turn SET state = 'void', text = NULL, context = NULL, reply = NULL
          WHERE state IN ('queued', 'ready') AND received <= ?`).run(now - REPLY_TTL);
      }
      const row = this.active(fingerprint);
      if (row === undefined) {
        if (this.binding() !== undefined) this.revokeInTransaction();
        return;
      }
      if (row.conversation !== expectedConsent) return;
      const insert = this.db.prepare(`INSERT INTO owner_turn (epoch, conversation, message_key, received, text, context, state)
        VALUES (?, ?, ?, ?, ?, ?, 'queued') ON CONFLICT(message_key) DO NOTHING`);
      for (const input of messages) {
        const text = input.text.trim();
        if (input.direct_text !== true || input.from_user_id !== account || text === "" || text.startsWith("/") ||
            text.length > MAX_TEXT || input.message_id.trim() === "" || input.message_id.length > 128 ||
            input.context_token === "" || input.context_token.length > MAX_CONTEXT) continue;
        insert.run(row.epoch, row.conversation, digest([fingerprint, account, input.message_id]), now, text, input.context_token);
      }
    });
    if (purge) this.lastPurge = now;
  }

  private next(binding: Binding): Turn | undefined {
    return this.db.prepare(`SELECT seq, epoch, conversation, received, text, context, state, reply FROM owner_turn
      WHERE conversation = ? AND state IN ('queued', 'ready') ORDER BY seq LIMIT 1`).get(binding.conversation) as Turn | undefined;
  }

  /** 在工作台本地准备回复，不调用微信发送接口。 */
  async prepare(fingerprint: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const binding = this.active(fingerprint);
      if (binding === undefined) return;
      const turn = this.db.prepare(`SELECT seq, epoch, conversation, received, text, context, state, reply FROM owner_turn
        WHERE conversation = ? AND state = 'queued' ORDER BY seq LIMIT 1`).get(binding.conversation) as Turn | undefined;
      if (turn === undefined) return;
      if (this.now() - turn.received >= REPLY_TTL) {
        this.db.prepare("UPDATE owner_turn SET state='void', text=NULL, context=NULL WHERE seq=?").run(turn.seq);
        continue;
      }
      await this.prepareTurn(fingerprint, binding, turn, signal, true);
    }
  }

  /** 仅回复触发本轮的配对店主；发送未知先持久化，不能自动补发。 */
  async process(fingerprint: string, signal: AbortSignal, send: (input: { text: string; context: string }) => Promise<void>): Promise<void> {
    if (this.options.replyToOwner !== true) return;
    while (!signal.aborted) {
      const binding = this.active(fingerprint);
      if (binding === undefined) return;
      const turn = this.next(binding);
      if (turn === undefined) return;
      if (this.now() - turn.received >= REPLY_TTL) {
        this.db.prepare("UPDATE owner_turn SET state='void', text=NULL, context=NULL, reply=NULL WHERE seq=?").run(turn.seq);
        continue;
      }
      if (turn.state === "queued") {
        await this.prepareTurn(fingerprint, binding, turn, signal);
        continue;
      }
      // 无 await：同进程解绑/清理不能在检查与调用之间插入。落 unknown 后崩溃也不重发。
      if (this.active(fingerprint)?.conversation !== turn.conversation || signal.aborted || turn.reply === null || turn.context === null) return;
      this.db.prepare("UPDATE owner_turn SET state='unknown', context=NULL WHERE seq=? AND state='ready'").run(turn.seq);
      await send({ text: turn.reply, context: turn.context });
      this.db.prepare("UPDATE owner_turn SET state='accepted' WHERE seq=? AND state='unknown'").run(turn.seq);
    }
  }

  private async decideWithAgent(agent: Extract<WeixinOwnerAgent, { state: "configured" }>, binding: Binding, turn: Turn,
    text: string, signal: AbortSignal): Promise<{ intent: OwnerIntent; usedModel: boolean }> {
    const started = this.now();
    if (this.db.prepare("SELECT 1 FROM owner_agent_turn WHERE seq=?").get(turn.seq)) {
      return { intent: { kind: "reply", text: "这条消息的模型请求结果未能确认，未自动重试。请重新发送问题。" }, usedModel: false };
    }
    const budget = this.db.prepare("SELECT COUNT(*) n FROM owner_agent_turn WHERE requested>?").get(started - DAY_MS) as { n: number };
    if (budget.n >= AGENT_CALLS_PER_DAY) {
      return { intent: { kind: "reply", text: "Kiwi 的对话模型已达到使用上限，请晚些再试。" }, usedModel: false };
    }
    const history = this.db.prepare(`SELECT t.text AS question,
      CASE WHEN a.history_reply=1 THEN substr(t.reply, 1, 600) ELSE '上一轮由 Kiwi 本机处理，业务数据不会提供给模型。' END AS answer
      FROM owner_agent_turn a JOIN owner_turn t USING(seq)
      WHERE t.conversation=? AND t.seq<? AND t.state='accepted' AND t.received>?
        AND t.text IS NOT NULL AND t.reply IS NOT NULL AND a.history_reply IS NOT NULL
      ORDER BY t.seq DESC LIMIT ?`).all(binding.conversation, turn.seq, started - LIST_TTL, AGENT_HISTORY_LIMIT) as Array<{ question: string; answer: string }>;
    // Reserve in SQLite before the provider call. A crash after this point cannot bill the same message again.
    this.db.prepare("INSERT INTO owner_agent_turn (seq, requested) VALUES (?, ?)").run(turn.seq, started);
    const call = { conversation: binding.conversation, abort: new AbortController() };
    this.agentCall = call;
    try {
      const response = await agent.decide({ text, history: [...history].reverse() }, AbortSignal.any([signal, call.abort.signal]));
      return { intent: checkAgentTarget(response, text), usedModel: true };
    } finally {
      if (this.agentCall === call) this.agentCall = undefined;
    }
  }

  private async prepareTurn(fingerprint: string, binding: Binding, turn: Turn, signal: AbortSignal, previewOnly = false): Promise<void> {
    const text = turn.text ?? "";
    const agent = previewOnly ? undefined : this.consentedAgent(binding);
    const inventorySku = previewOnly ? ownerInventorySku(text) : undefined;
    let reply = "这超出了我目前能核实的范围，没有执行任何查询。我可以帮你查当前待跟进的询价、按区间统计咨询（比如「过去 7 天」）、接着聊刚才的清单，或拟一份跟进草稿。";
    let list: ListSnapshot | undefined;
    let ruleProposal: ReturnType<typeof ownerWeekdayDigest>;
    let draft: { item: OwnerInquiry; body: string; index: number } | undefined;
    let historyReply: number | null = null;
    let modelResponded = false;
    try {
      let intent: OwnerIntent;
      if (agent?.state === "configured") {
        const decision = await this.decideWithAgent(agent, binding, turn, text, signal);
        if (signal.aborted || this.active(fingerprint)?.conversation !== turn.conversation || this.now() - turn.received >= REPLY_TTL) return;
        ({ intent, usedModel: modelResponded } = decision);
        // Later model turns get only free-form replies, not rendered business facts.
        if (modelResponded) historyReply = intent.kind === "reply" ? 1 : 0;
      } else intent = classify(text);
      if (previewOnly) ruleProposal = ownerWeekdayDigest(turn.text ?? "", this.options.timeZone ?? "Asia/Shanghai", this.now());
      if (inventorySku !== undefined) {
        reply = await this.inventoryPreview(inventorySku);
      } else if (ruleProposal !== undefined) {
        reply = "已准备工作日报表建议。请在工作台核对日程、范围和投递方式；确认前不启用。";
      } else if (previewOnly && /大额报价|报价.*(?:找我|先确认|先审批)/.test(turn.text ?? "")) {
        reply = "当前报价策略未装配按金额、币种和范围配置审批人的规则。未更改任何政策，请通过工作台核实。";
      } else if (previewOnly && intent.kind === "unsupported" && /(?:偏好|语气|简洁|热情).*(?:回复|跟进)|(?:回复|跟进).*(?:偏好|语气|简洁|热情)/.test(turn.text ?? "")) {
        const style = this.preference(binding.principal).style;
        reply = "当前普通跟进语气：" + (style === "concise" ? "简洁" : style === "warm" ? "友好" : "默认") + "。请在工作台明确设置或撤回，聊天不直接更改偏好。";
      } else if (intent.kind === "reply") {
        reply = intent.text;
      } else if (intent.kind === "today") {
        reply = this.countReply("今天", this.startOfDay(this.now()));
      } else if (intent.kind === "range") {
        reply = this.countReply(`过去 ${intent.days} 天`, this.now() - intent.days * DAY_MS);
      } else if (intent.kind === "clarify_target") {
        reply = "我还不能确定你指哪一笔。请告诉我清单中的序号；如果有多份清单，也请带上清单号。";
      } else if (intent.kind === "greeting") {
        reply = "你好，我是你的 Kiwi 商家智能体。可以直接跟我说「今天有什么要跟进的？」或者问我刚才聊到哪里。不用记命令。";
      } else if (intent.kind === "blocked") {
        reply = "我不会通过聊天发送买家消息、确认报价或修改经营规则。你可以先让我起草；正式操作请到商家工作台核对。";
      } else if (intent.kind === "private_lookup") {
        reply = "这个问题需要核对商家私有详情。请在工作台查看，我不会凭聊天猜数字或状态。";
      } else if (intent.kind === "repeat") {
        if (previewOnly) reply = "这里只记录工作台预览。请在工作台看上次结果，或在微信重新查询。";
        else {
          const previous = this.db.prepare(`SELECT state, reply FROM owner_turn WHERE conversation=? AND seq<?
            AND state IN ('accepted', 'unknown') AND received>? AND (? = 0 OR list IS NOT NULL) ORDER BY seq DESC LIMIT 1`)
            .get(binding.conversation, turn.seq, this.now() - LIST_TTL, intent.listOnly ? 1 : 0);
          reply = previous?.state === "accepted" && typeof previous.reply === "string"
            ? previous.reply : "没有可复述的近期回复，或者上次回信的结果还不确定。你可以重新问我。";
        }
      } else if (intent.kind === "list") {
        const queried = this.now();
        const pending = this.options.source.list();
        const items = rankOwnerInquiries(pending, queried);
        if (items.length === 0) reply = previewOnly
          ? `截至 ${this.formatter.format(queried)}，已接入的 A2A 询价视图没有待回复项。`
          : "已接入的询价来源目前没有待跟进项。";
        else {
          list = { ref: `L-${randomUUID().slice(0, 8).toUpperCase()}`, queried, items };
          // 微信只给店主序号和排序原因。权威 ID、SKU 和实际时间仅留在本地工作台。
          reply = previewOnly
            ? `A2A 待回复 · ${this.formatter.format(queried)} · ${list.ref}\n` +
              items.map((item, i) => `${i + 1}. ${item.sku ?? "未标 SKU"} · ${item.id.slice(0, 80)} · ${item.dueAt === undefined ? "无明确截止，按等待排序" : `${item.dueAt <= queried ? "已超期" : "截止"} ${this.formatter.format(item.dueAt)}`} · 等待自 ${this.formatter.format(item.receivedAt)}`).join("\n")
            : `有 ${pending.length} 笔待跟进询价${items.length < pending.length ? `，先列优先的 ${items.length} 笔` : ""} · 清单 ${list.ref}\n` + items.map((item, i) =>
              `${i + 1}. ${item.dueAt === undefined ? "按等待时长排序" : item.dueAt <= queried ? "已超期，优先跟进" : "有明确截止时间"}`).join("\n") +
              "\n可以直接说「第二笔帮我拟一下，先别发」。";
        }
      } else if (intent.kind === "draft" || intent.kind === "explain") {
        const lists = this.db.prepare(`SELECT list, state FROM owner_turn WHERE conversation = ? AND list IS NOT NULL
          AND state IN ('accepted', 'unknown', ?) AND received > ? ORDER BY seq DESC`)
          .all(binding.conversation, previewOnly ? "previewed" : "accepted", this.now() - LIST_TTL) as Array<{ list: string; state: TurnState }>;
        const candidates = lists.map((row) => ({ ...row, snapshot: JSON.parse(row.list) as ListSnapshot }));
        const matching = intent.ref === undefined ? candidates : candidates.filter((row) => row.snapshot.ref === intent.ref);
        // 包括短清单号碰撞：即使显式引用，也只在恰好匹配一份时解析。
        const candidate = matching.length === 1 ? matching[0] : undefined;
        const selected = intent.ref !== undefined || candidate?.state === "accepted" ? candidate : undefined;
        const previous = selected?.snapshot.items[intent.index];
        if (previous === undefined) {
          reply = candidates.length === 0 ? "没有可续接的清单，请重新查询。" :
            "未能确认是哪一笔。请带上你看到的清单号和序号，或重新查询后引用新清单号。";
        } else {
          const current = this.options.source.get(previous.id);
          if (current === undefined || current.version !== previous.version) reply = "这笔询价已不再待回复，或事实已变化。请重新查询后明确选择。";
          else if (intent.kind === "explain") {
            const queried = selected?.snapshot.queried;
            const reason = previous.dueAt === undefined ? "没有明确截止时间，按等待时长排在这一位。" :
              queried !== undefined && previous.dueAt <= queried ? "查询时已超期，所以优先跟进。" : "有明确截止，按到期顺序安排。";
            reply = `清单里第 ${intent.index + 1} 笔：${reason}`;
          } else {
            const item = current;
            const style = this.preference(binding.principal).style;
            const template = style === "concise" ? "您好，询价已收到，正在核对。如有补充，欢迎告知。" :
              style === "warm" ? "您好，感谢您发来询价！我会仔细核对这笔需求，有新增要求也欢迎随时补充。" :
              "您好，感谢您的询价。我正在核对这笔需求；如果您的需求有更新，欢迎补充说明。";
            const body = !previewOnly || this.options.compose === undefined
              ? template
              : await this.options.compose({ ...(item.sku !== undefined ? { sku: item.sku } : {}),
                ...(item.quantity !== undefined ? { quantity: item.quantity } : {}) }, signal);
            draft = { item, body: this.body(body), index: intent.index };
          }
        }
      }
    } catch {
      reply = agent?.state === "configured" && !modelResponded ? AGENT_UNAVAILABLE :
        "暂时无法核实询价事实或生成回复，请到工作台查看后再试。没有发送给买家。";
    }
    if (signal.aborted) return;
    this.atomic(() => {
      if (this.active(fingerprint)?.conversation !== turn.conversation || this.now() - turn.received >= REPLY_TTL) return;
      if (historyReply !== null) this.db.prepare("UPDATE owner_agent_turn SET history_reply=? WHERE seq=?").run(historyReply, turn.seq);
      if (draft !== undefined) {
        let current: OwnerInquiry | undefined;
        try { current = this.options.source.get(draft.item.id); } catch { /* 无事实则不落草稿 */ }
        if (current?.version !== draft.item.version) reply = "询价事实已变化或不可用，请重新查询后再试。";
        else {
          const key = digest([turn.epoch, turn.seq, "followup", draft.item.id]);
          const id = randomUUID();
          this.db.prepare(`INSERT INTO owner_reply_draft VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT(command_key) DO NOTHING`).run(id, key, binding.epoch, binding.principal,
            draft.item.id, draft.item.version, draft.body, this.now(), this.now());
          const saved = this.db.prepare("SELECT id, body FROM owner_reply_draft WHERE command_key=?").get(key) as { id: string; body: string };
          const href = new URL(`/merchant/?weixin_draft=${saved.id}`, this.options.workbenchOrigin);
          reply = previewOnly
            ? `普通跟进草稿已保存，尚未发送给买家。\n${saved.body}\n工作台预览：${href.href}`
            : `第 ${draft.index + 1} 笔的普通跟进草稿，尚未发送给买家：\n${saved.body}\n可以在本实例 /merchant/weixin 的「草稿」区核对或编辑。`;
        }
      }
      const state = previewOnly ? "previewed" : "ready";
      this.db.prepare(`UPDATE owner_turn SET state=?, reply=?, list=?, rule_proposal=?, text=?, context=? WHERE seq=? AND state='queued'`)
        .run(state, reply, list === undefined ? null : JSON.stringify(list), ruleProposal === undefined ? null : JSON.stringify(ruleProposal),
          historyReply === null ? null : text, previewOnly ? null : turn.context, turn.seq);
    });
  }

  /** 计数口径的统计回复：区间词与起点由本机决定，回复只含计数，不含 ID/SKU/身份。 */
  private countReply(label: string, since: number): string {
    const stats = this.options.source.rangeStats?.(since);
    if (stats === undefined) return `此实例未接入按时间的咨询统计来源，不能给出${label}的数字。`;
    const scope = "仅覆盖已接入的 A2A 询价链路，不含其他渠道；明细请在工作台核对。";
    return stats.inquiries === 0
      ? `${label}没有买家咨询进入询价链路。${scope}`
      : `${label}有 ${stats.inquiries} 笔买家咨询进入询价链路，其中 ${stats.pending} 笔仍待回复。${scope}`;
  }

  /** 「今天」起点按对话时区的本地零点；用墙钟回推偏移，不假定宿主时区。 */
  private startOfDay(nowMs: number): number {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: this.options.timeZone ?? "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false }).formatToParts(nowMs);
    const take = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const offset = Date.UTC(take("year"), take("month") - 1, take("day"), take("hour"), take("minute"), take("second")) - nowMs;
    return Date.UTC(take("year"), take("month") - 1, take("day")) - offset;
  }

  private async inventoryPreview(sku: string): Promise<string> {    if (this.options.inventory === undefined) return "此实例未接入精确库存来源，不能判断库存。";
    try {
      const result = await this.options.inventory(sku);
      const listing = result.listingPaused === null ? "销售状态未核实" : result.listingPaused ? "已暂停销售" : "未暂停销售";
      return `精确商品目录 · ${result.sku}\n目录库存：${result.stock}（${listing}）\n读取于 ${this.formatter.format(result.observedAt)}，不是上游库存更新时间或供货承诺。`;
    } catch (error) {
      if (error instanceof OwnerInventoryError && error.code === "not_found") return `精确商品目录中未找到 ${sku}，不能判为零库存。`;
      if (error instanceof OwnerInventoryError && error.code === "stock_unknown") return `精确商品目录未提供 ${sku} 的有效库存，不能判为零库存。`;
      return "暂时无法核实精确库存来源。未使用旧记录或可用性提示替代。";
    }
  }

  preference(principal: string): OwnerFollowupPreference {
    if (!this.options.ownerRevision(principal)) throw new OwnerConversationError("forbidden", "当前主体不能查看店主偏好。");
    return this.db.prepare("SELECT style, version, updated_at FROM owner_followup_preference WHERE principal=?")
      .get(principal) as OwnerFollowupPreference | undefined ?? { style: null, version: 0, updated_at: null };
  }

  setPreference(principal: string, expectedVersion: number, style: FollowupStyle | null): OwnerFollowupPreference {
    return this.atomic(() => {
      const current = this.preference(principal);
      if (current.version !== expectedVersion) throw new OwnerConversationError("conflict", "偏好版本已变化，请重新查看。");
      if (style !== null && style !== "concise" && style !== "warm") throw new OwnerConversationError("invalid_input", "不支持的跟进语气。");
      const result = { style, version: current.version + 1, updated_at: new Date(this.now()).toISOString() };
      this.db.prepare(`INSERT INTO owner_followup_preference VALUES (?, ?, ?, ?)
        ON CONFLICT(principal) DO UPDATE SET style=excluded.style, version=excluded.version, updated_at=excluded.updated_at`)
        .run(principal, result.style, result.version, result.updated_at);
      return result;
    });
  }

  listDrafts(principal: string): Array<{ id: string; inquiry: string; version: number; created: number }> {
    if (!this.options.ownerRevision(principal)) throw new OwnerConversationError("forbidden", "当前主体不能查看草稿。");
    return this.db.prepare(`SELECT id, inquiry, version, created FROM owner_reply_draft d WHERE principal=?
      AND NOT EXISTS (SELECT 1 FROM owner_reply_draft_discard x WHERE x.id=d.id) ORDER BY created DESC, id LIMIT 20`)
      .all(principal) as Array<{ id: string; inquiry: string; version: number; created: number }>;
  }

  draft(principal: string, id: string): DraftRow & { current: boolean; publication: "not_configured" } {
    // 已独立落库的草稿保留；当前真实 owner 主体才可打开，旧绑定不能凭链接授权。
    if (!this.options.ownerRevision(principal)) throw new OwnerConversationError("forbidden", "当前主体不能查看草稿。");
    const row = this.db.prepare(`SELECT id, epoch, principal, inquiry, source_version, version, body, created
      FROM owner_reply_draft d WHERE id=? AND principal=?
      AND NOT EXISTS (SELECT 1 FROM owner_reply_draft_discard x WHERE x.id=d.id)`).get(id, principal) as DraftRow | undefined;
    if (row === undefined) throw new OwnerConversationError("not_found", "未找到回复草稿。");
    let current = false;
    try { current = this.options.source.get(row.inquiry)?.version === row.source_version; } catch { /* 不可读不代表仍有效 */ }
    return { ...row, current, publication: "not_configured" };
  }

  edit(principal: string, id: string, version: number, body: string) {
    return this.atomic(() => {
      const row = this.draft(principal, id);
      if (row.version !== version || !row.current) throw new OwnerConversationError("conflict", "草稿或事实已变化，请重新查看。");
      const text = this.body(body);
      this.db.prepare("UPDATE owner_reply_draft SET body=?, version=version+1, updated=? WHERE id=?").run(text, this.now(), id);
      return { ...row, body: text, version: version + 1 };
    });
  }

  /** 放弃仅在已登录的店主页面执行：保留原始记录，不发送或删除正文。 */
  discardDraft(principal: string, id: string, version: number): void {
    this.atomic(() => {
      if (!this.options.ownerRevision(principal)) throw new OwnerConversationError("forbidden", "当前主体不能放弃草稿。");
      const row = this.db.prepare("SELECT version FROM owner_reply_draft WHERE id=? AND principal=?").get(id, principal);
      if (row === undefined) throw new OwnerConversationError("not_found", "未找到回复草稿。");
      if (row.version !== version) throw new OwnerConversationError("conflict", "草稿版本已变化，请重新查看。");
      this.db.prepare("INSERT INTO owner_reply_draft_discard (id, discarded) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").run(id, this.now());
    });
  }

  private body(text: string): string {
    const body = text.trim();
    if (body.length === 0 || body.length > 600) throw new OwnerConversationError("invalid_input", "回复正文须为 1–600 个字符。");
    return body;
  }
}
