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
 * 会话旁观（只读投影，WP11）。
 *
 * 与 workbench-service.scanLedger 同一事实源（A2A ledger，`<dataDir>/a2a`），
 * 但按「旁观」需求展开为两个视图：
 *   - list：分页（offset cursor）、按最近落账时间倒序、状态过滤
 *     （active=非终态 / agreement=已达成 / all）；
 *   - timeline：按时间线列出双方消息（询价/报价/还价/澄清/非绑定协议…），
 *     含相位迁移与交接（人工）标记。
 *
 * 隐私与 fencing（与 workbench-service 同红线）：
 *   - 买家侧只出现协议层身份（A2A sender identity），绝不拼接/推断私密联系方式；
 *   - 商家私有策略值（底价/折扣明细）不进入任何返回值；出站报价仅给出
 *     「由本节点规则引擎生成」的溯源说明，conditional_offer 事件自带的
 *     policy_digest（规则内容摘要，非数值）按账本事实透出；
 *   - 外部内容（买家问题 code、SKU 等）只作为数据返回；HTML 转义在页面层
 *     （page.ts esc()）完成，本层不产生 HTML。
 *
 * 账本不存在（目录为空/尚未创建）= 「没有磋商记录」，返回空列表；这与
 * workbench-service 的语义一致（ensureLedgerDir 会建目录，读取无副作用业务数据）。
 */

import { LedgerStore } from "../negotiation/ledger/index.js";
import { TERMINAL_PHASES } from "../negotiation/state/phase.js";
import { MerchantWorkbenchError } from "./workbench-service.js";

/** 状态过滤词表（与 intelligence getNegotiationDigest 的语义对齐）。 */
export const NEGOTIATION_STATUS_FILTERS = ["active", "agreement", "all"] as const;
export type NegotiationStatusFilter = (typeof NEGOTIATION_STATUS_FILTERS)[number];

export interface NegotiationListQuery {
  /** offset 游标（十进制字符串；上一页 next_cursor 原样回传）。 */
  cursor?: string;
  /** 页大小，clamp 1..100，缺省 20。 */
  limit?: number;
  status?: NegotiationStatusFilter;
}

/** 列表行（A2aNegotiationRow 超集：多一个 needs_attention）。 */
export interface NegotiationListViewItem {
  negotiation_id: string;
  phase: string;
  last_action: string;
  sku: string;
  quantity?: number;
  price_minor?: number;
  agreement: boolean;
  recorded_at: string;
  /** 非终态且最后一条消息是买家入站（等待商家回应）——运营上值得点开看。 */
  needs_attention: boolean;
}

export interface NegotiationListResult {
  total: number;
  items: NegotiationListViewItem[];
  next_cursor: string | null;
}

/** 时间线条目。kind=message 是双方消息；phase=相位迁移；handoff=人工交接事件。 */
export interface NegotiationTimelineEntry {
  at: string;
  kind: "message" | "phase" | "handoff";
  direction: "buyer" | "merchant" | null;
  action: string;
  /** 中文摘要（内容来自账本事实；转义在页面层）。 */
  summary: string;
  sku?: string;
  quantity?: number;
  unit_price_minor?: number;
  currency?: string;
  valid_until?: string;
  /** fulfillment_terms.delivery_before（报价时动态计算的交期承诺）。 */
  delivery_before?: string;
  /** 询价/澄清问题 code 原文（外部内容按数据透出；页面转义后展示）。 */
  questions?: string[];
  /**
   * 本步依据的规则溯源；null = 账本没有可依据的规则事实（页面显示「不可得」，
   * 不编造）。字符串只描述来源（如「本节点规则引擎自动生成」）或透出
   * conditional_offer 自带的 policy_digest，绝不含策略数值。
   */
  rule_summary: string | null;
  /** 该步是否把磋商带入人工处理（澄清等待 / 交接候选）。 */
  manual_review: boolean;
}

export interface NegotiationTimelineView {
  negotiation_id: string;
  phase: string;
  agreement: boolean;
  sku: string;
  quantity?: number;
  price_minor?: number;
  /** 协议层买家身份（验签身份；匿名模式下可能是回退地址——与账本事实一致）。 */
  buyer_ref: string;
  recorded_at: string;
  needs_attention: boolean;
  timeline: NegotiationTimelineEntry[];
}

export interface NegotiationObserver {
  list(query: NegotiationListQuery): NegotiationListResult;
  timeline(negotiationId: string): NegotiationTimelineView;
}

export interface NegotiationObserverOptions {
  /** ledger 根目录（与 workbench-service a2aLedgerDir 同值：`<dataDir>/a2a`）。 */
  ledgerDir: string;
  now?: () => string;
}

/** KNP wire payload 的最小形状（摘要提取用；未知字段一律忽略）。 */
type WirePayload = {
  action?: string;
  created_at?: string;
  payload?: {
    inquiry?: { questions?: Array<{ code?: string }> };
    rfq?: { items?: Array<{ sku?: string; quantity?: { value?: number } }> };
    offer?: { terms?: TermsShape };
    counter_offer?: { proposed_terms?: TermsShape };
    conditional_offer?: {
      base_terms?: TermsShape;
      policy_digest?: string;
    };
    clarification?: { questions?: Array<{ code?: string }> };
  };
};

type TermsItem = {
  sku?: string;
  quantity?: { value?: number };
  unit_price?: { amount_minor?: number | string; currency?: string };
};

type TermsShape = {
  items?: TermsItem[];
  fulfillment_terms?: { delivery_before?: string };
  valid_until?: string;
};

/** 出站 offer-like 消息的规则溯源说明（不含策略数值——红线 6 / workbench-service 白名单）。 */
const AUTO_QUOTE_RULE_SUMMARY = "本节点报价规则引擎自动生成（规则数值属私有数据，不在旁观视图展示）";

const ACTION_LABELS: Readonly<Record<string, string>> = {
  inquiry: "询价",
  rfq: "询价（含明细）",
  offer: "报价",
  counter_offer: "还价",
  conditional_offer: "条件报价",
  clarification: "澄清请求",
  clarification_response: "澄清答复",
  accept_nonbinding: "接受非绑定协议",
  decline: "婉拒",
  withdraw: "撤回",
  cancel: "取消",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function termsOf(wire: WirePayload | undefined): TermsShape | undefined {
  return (
    wire?.payload?.offer?.terms ??
    wire?.payload?.counter_offer?.proposed_terms ??
    wire?.payload?.conditional_offer?.base_terms
  );
}

function firstItem(terms: TermsShape | undefined): TermsItem | undefined {
  return terms?.items?.[0];
}

/** 单条磋商的账本扫描结果（列表行与时间线共用一趟遍历）。 */
interface NegotiationFacts {
  row: NegotiationListViewItem;
  buyerRef: string;
  timeline: NegotiationTimelineEntry[];
}

function scanNegotiation(
  ledger: LedgerStore,
  negotiationId: string,
): NegotiationFacts | undefined {
  const events = ledger.events(negotiationId).map((event) => ledger.resolvePayload(event));
  if (events.length === 0) return undefined;
  const row: NegotiationListViewItem = {
    negotiation_id: negotiationId,
    phase: "OPEN",
    last_action: "",
    sku: "",
    agreement: false,
    recorded_at: "",
    needs_attention: false,
  };
  let buyerRef = "";
  let lastInboundAt = "";
  let lastInboundAction = "";
  let lastOutboundAt = "";
  const timeline: NegotiationTimelineEntry[] = [];
  for (const event of events) {
    if (event.recorded_at > row.recorded_at) row.recorded_at = event.recorded_at;
    if (event.identity.counterparty_identity !== "") buyerRef = event.identity.counterparty_identity;
    if (event.state_transition?.to_phase !== undefined) {
      row.phase = event.state_transition.to_phase;
      if (row.phase === "AGREEMENT_REACHED") row.agreement = true;
      timeline.push({
        at: event.recorded_at,
        kind: "phase",
        direction: null,
        action: `phase→${event.state_transition.to_phase}`,
        summary: `磋商进入相位 ${event.state_transition.to_phase}`,
        rule_summary: null,
        manual_review: event.state_transition.to_phase === "AWAITING_CLARIFICATION",
      });
    }
    if (event.event_kind === "handoff_candidate_created") {
      timeline.push({
        at: event.recorded_at,
        kind: "handoff",
        direction: null,
        action: "handoff_candidate_created",
        summary: "生成交接候选，等待商家人工处理",
        rule_summary: null,
        manual_review: true,
      });
    }
    if (event.event_kind !== "message_sent" && event.event_kind !== "message_received") continue;
    const inbound = event.event_kind === "message_received";
    const wire = event.wire_payload as WirePayload | undefined;
    const action = wire?.action ?? "";
    if (action !== "") row.last_action = action;
    const terms = termsOf(wire);
    const item = firstItem(terms);
    if (item?.sku !== undefined && item.sku !== "") {
      row.sku = item.sku;
      if (item.quantity?.value !== undefined) row.quantity = item.quantity.value;
      if (item.unit_price?.amount_minor !== undefined) {
        row.price_minor = Number(item.unit_price.amount_minor);
      }
    }
    if (inbound) {
      lastInboundAt = event.recorded_at;
      lastInboundAction = action;
    } else if (event.recorded_at >= lastOutboundAt) {
      lastOutboundAt = event.recorded_at;
    }
    const questionCodes: string[] = [];
    const questions = wire?.payload?.inquiry?.questions ?? wire?.payload?.clarification?.questions;
    if (questions !== undefined) {
      for (const question of questions) {
        if (typeof question?.code === "string" && question.code !== "") {
          questionCodes.push(question.code);
        }
      }
    }
    const summaryParts: string[] = [actionLabel(action)];
    if (item?.sku !== undefined && item.sku !== "") {
      summaryParts.push(`SKU ${item.sku}`);
      if (item.quantity?.value !== undefined) summaryParts.push(`数量 ${item.quantity.value}`);
      if (item.unit_price?.amount_minor !== undefined) {
        summaryParts.push(`单价 ${item.unit_price.amount_minor}（最小币单位）`);
      }
    }
    if (questionCodes.length > 0) {
      summaryParts.push(`问题 ${questionCodes.length} 条（${questionCodes.slice(0, 3).join("；")}）`);
    }
    timeline.push({
      at: event.recorded_at,
      kind: "message",
      direction: inbound ? "buyer" : "merchant",
      action,
      summary: summaryParts.join("，"),
      ...(questionCodes.length > 0 ? { questions: questionCodes } : {}),
      ...(item?.sku !== undefined && item.sku !== "" ? { sku: item.sku } : {}),
      ...(item?.quantity?.value !== undefined ? { quantity: item.quantity.value } : {}),
      ...(item?.unit_price?.amount_minor !== undefined
        ? { unit_price_minor: Number(item.unit_price.amount_minor) }
        : {}),
      ...(item?.unit_price?.currency !== undefined ? { currency: item.unit_price.currency } : {}),
      ...(terms?.valid_until !== undefined ? { valid_until: terms.valid_until } : {}),
      ...(terms?.fulfillment_terms?.delivery_before !== undefined
        ? { delivery_before: terms.fulfillment_terms.delivery_before }
        : {}),
      rule_summary: !inbound && ["offer", "counter_offer", "conditional_offer"].includes(action)
        ? wire?.payload?.conditional_offer?.policy_digest !== undefined
          ? `规则引擎自动生成（policy_digest ${wire.payload.conditional_offer.policy_digest}）`
          : AUTO_QUOTE_RULE_SUMMARY
        : null,
      manual_review: false,
    });
  }
  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const awaitingMerchant =
    lastInboundAt !== "" &&
    lastInboundAt > lastOutboundAt &&
    ["offer", "counter_offer", "clarification"].includes(lastInboundAction);
  row.needs_attention =
    !(TERMINAL_PHASES as readonly string[]).includes(row.phase) && awaitingMerchant;
  // 人工标记回填：把磋商带入 AWAITING_CLARIFICATION 的那条买家消息（其后
  // 首条出站澄清答复之前的最后一条入站消息）标记 manual_review。
  let pendingHuman = false;
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const entry = timeline[i] ?? timeline.at(i);
    if (entry === undefined) continue;
    if (entry.kind === "phase" && entry.action === "phase→AWAITING_CLARIFICATION") {
      pendingHuman = true;
      continue;
    }
    if (entry.kind === "message" && entry.direction === "merchant") pendingHuman = false;
    if (pendingHuman && entry.kind === "message" && entry.direction === "buyer") {
      entry.manual_review = true;
      pendingHuman = false;
    }
  }
  return { row, buyerRef, timeline };
}

export function createNegotiationObserver(options: NegotiationObserverOptions): NegotiationObserver {
  const ledgerDir = options.ledgerDir;
  return {
    list(query: NegotiationListQuery): NegotiationListResult {
      const status = query.status ?? "all";
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 20) || 20, 1), 100);
      const offset =
        query.cursor !== undefined ? Number.parseInt(query.cursor, 10) : 0;
      if (query.cursor !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
        throw new MerchantWorkbenchError("validation", "negotiation cursor 必须是非负整数");
      }
      let ledger: LedgerStore;
      try {
        ledger = new LedgerStore({ dir: ledgerDir });
      } catch (err) {
        throw new MerchantWorkbenchError(
          "unavailable",
          `磋商账本不可读：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const facts: NegotiationFacts[] = [];
      for (const negotiationId of ledger.listNegotiations()) {
        const scanned = scanNegotiation(ledger, negotiationId);
        if (scanned === undefined) continue;
        if (status === "active" && (TERMINAL_PHASES as readonly string[]).includes(scanned.row.phase)) {
          continue;
        }
        if (status === "agreement" && !scanned.row.agreement) continue;
        facts.push(scanned);
      }
      facts.sort((a, b) =>
        a.row.recorded_at > b.row.recorded_at ? -1 : a.row.recorded_at < b.row.recorded_at ? 1 : 0,
      );
      return {
        total: facts.length,
        items: facts.slice(offset, offset + limit).map((fact) => fact.row),
        next_cursor: offset + limit < facts.length ? String(offset + limit) : null,
      };
    },
    timeline(negotiationId: string): NegotiationTimelineView {
      const id = String(negotiationId ?? "").trim();
      if (id === "") throw new MerchantWorkbenchError("validation", "negotiation_id 不能为空");
      let ledger: LedgerStore;
      try {
        ledger = new LedgerStore({ dir: ledgerDir });
      } catch (err) {
        throw new MerchantWorkbenchError(
          "unavailable",
          `磋商账本不可读：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const scanned = scanNegotiation(ledger, id);
      if (scanned === undefined) {
        throw new MerchantWorkbenchError("not_found", `未找到磋商 ${id}`);
      }
      return {
        negotiation_id: id,
        phase: scanned.row.phase,
        agreement: scanned.row.agreement,
        sku: scanned.row.sku,
        ...(scanned.row.quantity !== undefined ? { quantity: scanned.row.quantity } : {}),
        ...(scanned.row.price_minor !== undefined ? { price_minor: scanned.row.price_minor } : {}),
        buyer_ref: scanned.buyerRef,
        recorded_at: scanned.row.recorded_at,
        needs_attention: scanned.row.needs_attention,
        timeline: scanned.timeline,
      };
    },
  };
}
