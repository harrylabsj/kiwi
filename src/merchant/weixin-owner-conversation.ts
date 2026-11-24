/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { InboundMessage } from "../weixin/types.js";
import { ownerWeekdayDigest } from "./weixin-owner-digest.js";
import { OwnerInventoryError, ownerInventorySku, type OwnerInventoryObservation } from "./weixin-owner-inventory.js";

const RETENTION = 30 * 24 * 60 * 60_000;
const REPLY_TTL = 10 * 60_000;
const LIST_TTL = 30 * 60_000;
const MAX_TEXT = 1200;
const MAX_CONTEXT = 4096;

/** 单个权威来源的最小询价事实，不携带客户正文、价格、身份或路由。 */
export interface OwnerInquiry {
  id: string;
  version: string;
  receivedAt: number;
  dueAt?: number;
  sku?: string;
  quantity?: number;
}

export interface OwnerInquirySource {
  list(): readonly OwnerInquiry[];
  get(id: string): OwnerInquiry | undefined;
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

type OwnerIntent = { kind: "list" | "greeting" | "blocked" | "private_lookup" | "unsupported" } |
  { kind: "repeat"; listOnly: boolean } | { kind: "draft" | "explain"; index: number; ref?: string };

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
        CREATE TABLE IF NOT EXISTS owner_followup_preference (
          principal TEXT PRIMARY KEY, style TEXT, version INTEGER NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS owner_reply_draft (
          id TEXT PRIMARY KEY, command_key TEXT NOT NULL UNIQUE, epoch TEXT NOT NULL, principal TEXT NOT NULL,
          inquiry TEXT NOT NULL, source_version TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL,
          created INTEGER NOT NULL, updated INTEGER NOT NULL
        );`);
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
    // 开放微信回信必须重新确认，不能沿用原先的仅工作台授权或接着发送预览队列。
    return revision && this.options.replyToOwner ? digest(["paired-owner-replies-v1", revision]) : revision;
  }

  private active(fingerprint: string): Binding | undefined {
    if (!this.options.enabled) return undefined;
    const row = this.binding();
    return row?.fingerprint === fingerprint && this.revisionFor(row.principal) === row.revision ? row : undefined;
  }

  /** 在轮询开始时固定授权，晚到的旧批次不能进入新会话。 */
  consent(fingerprint: string): string | undefined {
    return this.active(fingerprint)?.conversation;
  }

  bind(principal: string, fingerprint: string): void {
    if (!this.options.enabled) throw new OwnerConversationError("unavailable", "店主对话未启用。");
    this.atomic(() => {
      const revision = this.revisionFor(principal);
      if (!revision) throw new OwnerConversationError("forbidden", "当前店主身份不能授权对话。");
      this.revokeInTransaction();
      this.db.prepare("INSERT INTO owner_binding VALUES (1, ?, ?, ?, ?, ?)")
        .run(randomUUID(), principal, revision, fingerprint, randomUUID());
    });
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

  private async prepareTurn(fingerprint: string, binding: Binding, turn: Turn, signal: AbortSignal, previewOnly = false): Promise<void> {
    const text = turn.text ?? "";
    const intent = classify(text);
    const inventorySku = previewOnly ? ownerInventorySku(text) : undefined;
    let reply = "我可以帮你查待跟进询价、接着聊刚才的清单，或拟一份跟进草稿。你想先看什么？";
    let list: ListSnapshot | undefined;
    let ruleProposal: ReturnType<typeof ownerWeekdayDigest>;
    let draft: { item: OwnerInquiry; body: string; index: number } | undefined;
    try {
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
      reply = "暂时无法核实询价事实或生成回复，请到工作台查看后再试。没有发送给买家。";
    }
    if (signal.aborted) return;
    this.atomic(() => {
      if (this.active(fingerprint)?.conversation !== turn.conversation || this.now() - turn.received >= REPLY_TTL) return;
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
            : `第 ${draft.index + 1} 笔的普通跟进草稿，尚未发送给买家：\n${saved.body}\n如需编辑，可打开工作台的「微信通道 → 普通跟进草稿」。`;
        }
      }
      const state = previewOnly ? "previewed" : "ready";
      this.db.prepare(`UPDATE owner_turn SET state=?, reply=?, list=?, rule_proposal=?, text=NULL, context=? WHERE seq=? AND state='queued'`)
        .run(state, reply, list === undefined ? null : JSON.stringify(list), ruleProposal === undefined ? null : JSON.stringify(ruleProposal),
          previewOnly ? null : turn.context, turn.seq);
    });
  }

  private async inventoryPreview(sku: string): Promise<string> {
    if (this.options.inventory === undefined) return "此实例未接入精确库存来源，不能判断库存。";
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
    return this.db.prepare(`SELECT id, inquiry, version, created FROM owner_reply_draft WHERE principal=? ORDER BY created DESC, id LIMIT 20`)
      .all(principal) as Array<{ id: string; inquiry: string; version: number; created: number }>;
  }

  draft(principal: string, id: string): DraftRow & { current: boolean; publication: "not_configured" } {
    // 已独立落库的草稿保留；当前真实 owner 主体才可打开，旧绑定不能凭链接授权。
    if (!this.options.ownerRevision(principal)) throw new OwnerConversationError("forbidden", "当前主体不能查看草稿。");
    const row = this.db.prepare(`SELECT id, epoch, principal, inquiry, source_version, version, body, created
      FROM owner_reply_draft WHERE id=? AND principal=?`).get(id, principal) as DraftRow | undefined;
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

  private body(text: string): string {
    const body = text.trim();
    if (body.length === 0 || body.length > 600) throw new OwnerConversationError("invalid_input", "回复正文须为 1–600 个字符。");
    return body;
  }
}
