import { McpError } from "./errors.js";
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
 * A2ANegotiator —— 经 A2A 直连 merchant 的真实磋商（CounterOffer，战略 v2.5
 * Phase 2 接线 A2A/UCP）。与 A2AQuoteFetcher 配套：读 candidate provenance
 * （negotiation_id / offer_id / merchant_reply_id / reply_text / sku /
 * a2a_endpoint），构造 KNP counter_offer envelope 直发 merchant，返回真实回复。
 *
 * 诚实失败：上下文缺失/商家不可达 → 追加可解释 summary，绝不编造还价结果。
 */

import {
  buildA2AClient,
  buildAcceptEnvelope,
  buildClarificationEnvelope,
  buildCounterEnvelope,
  envelopeToMessage,
} from "./a2a-knp.js";
import type { MerchantOffer, NegotiationStep, Negotiator } from "./service.js";
import type { A2AOutboundSigner, A2ATask } from "../a2a/client/types.js";
import { validateConditionalOffer, validateOffer } from "../negotiation/domain/objects.js";
import { evaluateConditionalOffer } from "../negotiation/condition/evaluator.js";
import { contentDigest } from "../negotiation/jcs.js";
import type { NegotiationEnvelope } from "../negotiation/domain/envelope.js";

import { BuyerProtocolRecovery, MerchantDeclined, ProtocolOperationUnknown, ProtocolOperationConflict, type ProtocolTaskContext } from "./protocol-recovery.js";
import { BuyerReplyRejected } from "./receive-gate.js";

export interface A2ANegotiatorOptions {
  /** 出站 HTTP Message Signature 签名器（B-05）：WorkBuddy 商家的业务身份。 */
  signer?: A2AOutboundSigner;
  allowPrivateRanges?: boolean;
  skipDnsCheck?: boolean;
  timeoutMs?: number;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
  protocolStateDir?: string;
  localBuyerAgentId?: string;
  /** 缺省还价折扣（现价×(1-discount)，无 intent 目标价时用）。 */
  defaultDiscountRate?: number;
  /** review P1-2（A319）：实际外发 counter 提案前的委托约束门。 */
  counterProposalGate?: CounterProposalGate;
  now?: () => string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_DISCOUNT_RATE = 0.1;

interface CandidateLike {
  candidate_id?: unknown;
  /** review P1-2（A325）：结构化商家身份（服务端写入，非 provenance 投影）。 */
  merchant_id?: unknown;
  status?: unknown;
  terms?: unknown;
  provenance?: {
    negotiation_id?: unknown;
    offer_id?: unknown;
    merchant_reply_id?: unknown;
    reply_text?: string;
    sku?: unknown;
    a2a_endpoint?: unknown;
    latest_terms_digest?: unknown;
    latest_agreed_terms?: unknown;
    latest_offer_type?: unknown;
  };
}

function utcNow(): string {
  return new Date().toISOString();
}

function intentQuantityUnit(intent: Record<string, unknown>): string | undefined {
  const items = Array.isArray(intent.items) ? (intent.items as Array<Record<string, unknown>>) : [];
  const qty = items[0]?.quantity;
  if (typeof qty === "object" && qty !== null) {
    const unit = (qty as Record<string, unknown>).unit;
    if (typeof unit === "string" && unit !== "") return unit;
  }
  return undefined;
}

function intentQuantity(intent: Record<string, unknown>): number {
  const items = Array.isArray(intent.items) ? (intent.items as Array<Record<string, unknown>>) : [];
  const qty = items[0]?.quantity;
  if (typeof qty === "object" && qty !== null) {
    const value = (qty as Record<string, unknown>).value;
    if (typeof value === "number" && value > 0) return value;
  }
  return 1;
}

function targetPriceMinor(
  intent: Record<string, unknown>,
  current: number | undefined,
  discountRate: number,
): number | undefined {
  const constraints = intent.constraints;
  if (typeof constraints === "object" && constraints !== null) {
    // 契约：target_unit_price 是 money 对象 {currency, amount_minor}（commerce-intent/1.0）。
    const raw = (constraints as Record<string, unknown>).target_unit_price;
    let value: number | undefined;
    if (typeof raw === "object" && raw !== null) {
      const minor = (raw as Record<string, unknown>).amount_minor;
      if (typeof minor === "number" && Number.isFinite(minor) && minor > 0) value = minor;
    } else if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      value = raw; // 宽松兼容：裸数字按 minor 处理
    } else if (typeof raw === "string" && Number.isFinite(Number(raw)) && Number(raw) > 0) {
      value = Number(raw);
    }
    if (value !== undefined) return value;
    // 没有显式 target 时，用委托预算/数量推导目标单价。此前直接按当前价
    // 打 10% 折扣：用户说"预算 ≤150"，实际发出去的还价却是 143.10，商家
    // 后台看到的与买方口径不一致（2026-10-30 保温杯会话）。
    const budget = (constraints as Record<string, unknown>).budget;
    if (typeof budget === "object" && budget !== null) {
      const amount = (budget as Record<string, unknown>).amount_minor;
      const quantity = intentQuantity(intent);
      if (typeof amount === "number" && Number.isFinite(amount) && amount > 0 && quantity > 0) {
        return Math.max(1, Math.floor(amount / quantity));
      }
    }
  }
  if (current !== undefined) return Math.round(current * (1 - discountRate) * 100) / 100;
  return undefined;
}

/** 把 KNP terms 压成候选 `_quote_terms` 展示形状（金额只保留 minor）。 */
function normalizeQuoteTerms(terms: Record<string, unknown>): Record<string, unknown> {
  const rawItems = Array.isArray(terms.items) ? (terms.items as Array<Record<string, unknown>>) : [];
  const items = rawItems.map((item) => {
    const quantity = (item.quantity ?? {}) as Record<string, unknown>;
    const price = (item.unit_price ?? {}) as Record<string, unknown>;
    return {
      sku: typeof item.sku === "string" ? item.sku : undefined,
      quantity_value: typeof quantity.value === "number" ? quantity.value : undefined,
      quantity_unit: typeof quantity.unit === "string" ? quantity.unit : undefined,
      unit_price_minor: typeof price.amount_minor === "number" ? price.amount_minor : undefined,
    };
  });
  const currency = (() => {
    const first = rawItems[0]?.unit_price;
    const value = typeof first === "object" && first !== null ? (first as Record<string, unknown>).currency : undefined;
    return typeof value === "string" ? value : "CNY";
  })();
  const total = items.reduce(
    (sum, item) => sum + (item.unit_price_minor ?? 0) * (item.quantity_value ?? 0),
    0,
  );
  return { currency, items, total_price_minor: total };
}

function declineReasonFromTask(task: A2ATask | undefined): string | null {
  for (const part of task?.status?.message?.parts ?? []) {
    if (part.kind !== "data") continue;
    const data = part.data as Record<string, unknown> | undefined;
    if (data === undefined || data["decline"] !== true) continue;
    const reason = typeof data["reason_code"] === "string" ? data["reason_code"].trim() : "";
    return reason === "" ? "unspecified" : reason;
  }
  return null;
}

function extractAgreementFromTask(task: A2ATask | undefined): Record<string, unknown> | null {
  for (const artifact of task?.artifacts ?? []) {
    for (const part of artifact.parts ?? []) {
      if (part.kind === "data" && part.data?.["agreement"] !== undefined) {
        return part.data["agreement"] as Record<string, unknown>;
      }
    }
  }
  return null;
}

/**
 * 从商家回复中提取最新 offer-like 事实。
 *
 * `conditional_offer` 的成交口径是 evaluate 后的 terms（条件不命中时是
 * base_terms），不是无条件读 then_terms——与商家 accept 侧的校验保持同一
 * 求值路径，terms_digest 才能对齐。
 */
function merchantOfferFromReply(
  reply: NegotiationEnvelope,
  candidateId: string,
  quantityTotal: number,
): MerchantOffer | undefined {
  const type = (reply.payload as { type?: unknown } | undefined)?.type;
  let offerId: string | undefined;
  let agreed: Record<string, unknown> | undefined;
  const offerType: "offer" | "conditional_offer" | undefined =
    type === "offer" ? "offer" : type === "conditional_offer" ? "conditional_offer" : undefined;
  if (type === "offer") {
    const offer = validateOffer(reply.payload);
    offerId = offer.offer_id;
    agreed = offer.terms as unknown as Record<string, unknown>;
  } else if (type === "conditional_offer") {
    const conditional = validateConditionalOffer(reply.payload);
    offerId = conditional.offer_id;
    agreed = evaluateConditionalOffer(conditional, {
      "aggregate.total_quantity": quantityTotal,
    }) as unknown as Record<string, unknown>;
  }
  if (offerId === undefined || agreed === undefined || offerType === undefined) return undefined;
  // 统一成纯 JSON 对象再做 digest（validator 返回的对象可能带 undefined 字段）。
  const agreedTerms = JSON.parse(JSON.stringify(agreed)) as Record<string, unknown>;
  return {
    candidate_id: candidateId,
    offer_id: offerId,
    offer_type: offerType,
    reply_message_id: reply.message_id,
    terms: normalizeQuoteTerms(agreedTerms),
    agreed_terms: agreedTerms,
    terms_digest: contentDigest(agreedTerms),
    reply_text: JSON.stringify(reply),
  };
}

/**
 * review P1-2（A319 校准）：**实际外发 counter 提案**的门——在 sendMessage
 * 之前对最终结构化提案（币种/单位/数量/单价/合计）执行委托约束核验；
 * 返回非 undefined 即拒绝外发（附原因）。拒绝原因由调用方转为 delegation_denied。
 */
export interface CounterProposalForGate {
  merchant_id: string;
  sku: string;
  currency: string;
  quantity_value: number;
  quantity_unit?: string;
  unit_price_minor: number;
  total_price_minor: number;
}
export type CounterProposalGate = (
  proposal: CounterProposalForGate,
) => string | undefined;

export class A2ANegotiator implements Negotiator {
  private readonly allowPrivateRanges: boolean;
  private readonly skipDnsCheck: boolean;
  private readonly timeoutMs: number;
  private readonly bearerToken?: string;
  private readonly signer?: A2AOutboundSigner;
  private readonly defaultDiscountRate: number;
  private readonly fetchImpl?: typeof fetch;

  private readonly recovery?: BuyerProtocolRecovery;
  private readonly counterProposalGate: CounterProposalGate | undefined;
  private readonly now: () => string;

  constructor(options: A2ANegotiatorOptions = {}) {
    this.allowPrivateRanges = options.allowPrivateRanges ?? false;
    this.skipDnsCheck = options.skipDnsCheck ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.bearerToken = options.bearerToken;
    this.signer = options.signer;
    this.defaultDiscountRate = options.defaultDiscountRate ?? DEFAULT_DISCOUNT_RATE;
    this.fetchImpl = options.fetchImpl;
    this.counterProposalGate = options.counterProposalGate;
    this.now = options.now ?? utcNow;
    if(options.protocolStateDir && options.localBuyerAgentId)this.recovery=new BuyerProtocolRecovery(options.protocolStateDir,options.localBuyerAgentId,options.now);
  }

  async negotiate(
    taskId: string,
    intent: Record<string, unknown>,
    current: NegotiationStep,
    candidates: Array<Record<string, unknown>>,
    context?: ProtocolTaskContext,
  ): Promise<NegotiationStep> {
    if (current.action !== "counter_offer" && current.action !== "clarification") {
      throw new McpError("invalid_params", "invalid negotiation action");
    }
    const isClarification = current.action === "clarification";
    const hasClaim = isClarification ? false : (this.recovery?.hasCounterClaim(taskId, current.round) ?? false);
    const candidate = candidates.find(
      (c) => (c as CandidateLike).provenance?.a2a_endpoint !== undefined,
    ) as CandidateLike | undefined;
    if (candidate === undefined) {
      if(hasClaim)throw new ProtocolOperationUnknown();
      return { ...current, summary: `${current.summary}（无 A2A 会话上下文，无法${isClarification ? "澄清" : "真实还价"}）` };
    }
    const { negotiation_id, offer_id, merchant_reply_id, sku, a2a_endpoint } =
      candidate.provenance ?? {};
    if (
      a2a_endpoint === undefined ||
      negotiation_id === undefined ||
      merchant_reply_id === undefined ||
      (!isClarification && offer_id === undefined)
    ) {
      if(hasClaim)throw new ProtocolOperationUnknown();
      return { ...current, summary: `${current.summary}（A2A 会话上下文不完整，无法${isClarification ? "澄清" : "真实还价"}）` };
    }
    const endpoint = String(a2a_endpoint);
    const negotiationId = String(negotiation_id);
    const offerId = offer_id === undefined ? "" : String(offer_id);
    const inReplyTo = String(merchant_reply_id);
    const itemSku = typeof sku === "string" && sku !== "" ? sku : "item-1";

    try {
      if (isClarification) {
        // 澄清不携带商业提案，不经过目标价/限额门；商家按问题作答后
        // 恢复原磋商相位，买家可继续 counter_offer。
        const questions =
          Array.isArray(current.questions) && current.questions.length > 0
            ? current.questions
            : [{ field: "general", reason: current.summary }];
        const client = buildA2AClient(endpoint, {
          bearerToken: this.bearerToken,
          ...(this.signer !== undefined ? { signer: this.signer } : {}),
          allowPrivateRanges: this.allowPrivateRanges,
          skipDnsCheck: this.skipDnsCheck,
          timeoutMs: this.timeoutMs,
          ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
        });
        if (!this.recovery || !context || context.taskId !== taskId) throw new ProtocolOperationUnknown();
        const result = await this.recovery.exchange({
          context,
          stage: "clarification",
          round: current.round,
          merchantId: String(candidate.merchant_id ?? ""),
          endpoint,
          negotiationId,
          binding: {
            intent,
            candidate,
            action: "clarification",
            questions,
            summary: current.summary,
          },
          build: (negId) =>
            buildClarificationEnvelope({
              negotiationId: negId,
              inReplyTo,
              questions,
              summary: current.summary,
              now: this.now,
            }),
          send: (wire) => client.sendMessage(envelopeToMessage(wire)),
          get: (id) => client.getTask(id),
          timeoutMs: this.timeoutMs,
          pollIntervalMs: 1000,
        });
        return { ...current, reply: JSON.stringify(result.reply) };
      }
      const verifiedQuote = this.recovery && context ? this.recovery.validatedQuote({
        context, negotiationId, merchantId: String(candidate.merchant_id ?? ""),
        endpoint, replyId: inReplyTo, offerId,
      }) : undefined;
      const verifiedPayload = verifiedQuote?.reply.payload;
      const verifiedItem = verifiedPayload?.type === "offer" ? verifiedPayload.terms.items?.[0]
        : verifiedPayload?.type === "counter_offer" ? verifiedPayload.proposed_terms.items?.[0] : undefined;
      if (verifiedItem && (verifiedItem.sku !== itemSku || verifiedItem.quantity.value !== intentQuantity(intent) ||
          verifiedItem.quantity.unit !== (intentQuantityUnit(intent) ?? "piece"))) throw new ProtocolOperationConflict();
      const currentPrice = verifiedItem?.unit_price?.amount_minor;
      const target = targetPriceMinor(intent, currentPrice, this.defaultDiscountRate);
      if (target === undefined) {
        if(hasClaim)throw new ProtocolOperationUnknown();
        return { ...current, summary: `${current.summary}（无目标价可还：意图无 target_unit_price 且商家回复无单价）` };
      }
      const envelope = buildCounterEnvelope({
        negotiationId,
        inReplyTo,
        respondingToOfferId: offerId,
        sku: itemSku,
        quantity: intentQuantity(intent),
        quantityUnit: intentQuantityUnit(intent),
        counterPriceMinor: target,
        summary: current.summary,
        now: this.now,
      });
      // review P1-2（A319 校准）：对**实际外发提案**执行委托约束门——不是只
      // 筛旧候选。拒绝即零 wire（不 sendMessage），原因透出给上层转
      // delegation_denied。安全 minor 由门内核验（非整数/负数拒绝）。
      if (this.counterProposalGate !== undefined) {
        // review P1-2（A327 校准）：quantity/unit 从**真实外发 wire**
        // （buildCounterEnvelope 产物）读取——intent 的
        // unit 只是来源，wire 不一致时门按实际外发事实判定（声明限额单位
        // 与 wire unit 不一致 → 拒绝），不按 intent 假设放行。
        const counterPayload = envelope.payload as {
          proposed_terms?: {
            currency?: unknown;
            items?: Array<{
              unit_price?: { amount_minor?: unknown; currency?: unknown };
              quantity?: { value?: unknown; unit?: unknown };
            }>;
          };
        };
        const wireItem = counterPayload.proposed_terms?.items?.[0];
        const counterMinor = wireItem?.unit_price?.amount_minor;
        const counterCurrency =
          typeof counterPayload.proposed_terms?.currency === "string"
            ? (counterPayload.proposed_terms.currency as string)
            : typeof wireItem?.unit_price?.currency === "string"
              ? (wireItem.unit_price as { currency: string }).currency
              : "CNY";
        const wireQty = wireItem?.quantity?.value;
        const wireUnit = wireItem?.quantity?.unit;
        const quantityValue = typeof wireQty === "number" && wireQty > 0 ? wireQty : intentQuantity(intent);
        const unitMinor = typeof counterMinor === "number" ? counterMinor : target;
        const gateVerdict = this.counterProposalGate({
          // review P1-2（A325 收口）：商家身份用**结构化候选字段**
          // candidate.merchant_id——provenance 是不可信回复投影，不得替代
          // 已选商家身份。
          merchant_id: String(candidate.merchant_id ?? ""),
          sku: itemSku,
          currency: counterCurrency,
          quantity_value: quantityValue,
          // review P1-2（A327）：unit 取**实际外发 wire 值**——声明限额单位
          // 与 wire 不一致时门拒绝（不削守卫；相容界内才放行）。
          quantity_unit: typeof wireUnit === "string" && wireUnit !== "" ? wireUnit : intentQuantityUnit(intent),
          unit_price_minor: unitMinor,
          total_price_minor: unitMinor * quantityValue,
        });
        if (gateVerdict !== undefined) {
          if(hasClaim)throw new ProtocolOperationUnknown();
          return { ...current, summary: `${current.summary}（counter 被委托约束阻断：${gateVerdict}）` };
        }
      }
      const client = buildA2AClient(endpoint, {
        bearerToken: this.bearerToken,
        ...(this.signer !== undefined ? { signer: this.signer } : {}),
        allowPrivateRanges: this.allowPrivateRanges,
        skipDnsCheck: this.skipDnsCheck,
        timeoutMs: this.timeoutMs,
        ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      });
      if(!this.recovery || !context || context.taskId!==taskId)throw new ProtocolOperationUnknown();
      const result=await this.recovery.exchange({
        context,stage:"counter",round:current.round,merchantId:String(candidate.merchant_id??""),endpoint,negotiationId,
        binding:{intent,candidate,proposal:(envelope.payload as {proposed_terms?:unknown}).proposed_terms,respondingToOfferId:offerId,action:current.action,summary:current.summary},
        build:()=>envelope,send:wire=>client.sendMessage(envelopeToMessage(wire)),get:id=>client.getTask(id),timeoutMs:this.timeoutMs,pollIntervalMs:1000,
      });
      const merchantOffer = merchantOfferFromReply(
        result.reply,
        String(candidate.candidate_id ?? ""),
        intentQuantity(intent),
      );
      return {
        ...current,
        reply: JSON.stringify(result.reply),
        ...(merchantOffer !== undefined ? { merchant_offer: merchantOffer } : {}),
      };
    } catch (error) {
      // B2：approval_required 不是终态拒绝，而是"商家需人工审批"。把它
      // 作为一次可解释的磋商结果记录（round 递增），买家稍后重试时用新的
      // 恢复槽位真实重发，命中商家批准的一次性授权价。其余拒绝仍按终态抛错。
      if (error instanceof MerchantDeclined && error.reasonCode === "approval_required") {
        return {
          ...current,
          summary: `${current.summary}（商家需人工审批：还价已登记，等商家批准后再重试；不要连续提交，每次重试都会消耗一轮委托）`,
        };
      }
      if(error instanceof ProtocolOperationUnknown || error instanceof ProtocolOperationConflict || error instanceof BuyerReplyRejected)throw error;
      if(hasClaim)throw new ProtocolOperationUnknown();
      return {
        ...current,
        summary: `${current.summary}（${isClarification ? "澄清" : "还价"}失败：${error instanceof Error ? error.message : String(error)}）`,
      };
    }
  }

  /**
   * 把买方的接受真正发给商家（KNP §15）。
   *
   * 此前 accept 只在本地生成 agreement：商家账本停在 OFFER_OPEN，24h 后被
   * 过期 job 标成 EXPIRED，且商家后台看不到"已达成"。这里要求商家返回
   * agreement artifact，并核对其 negotiation/offer/terms_digest 与本次接受
   * 完全一致；不一致视为结果未知（不伪造本地协议）。
   */
  async acceptNonbinding(input: {
    taskId: string;
    candidate: Record<string, unknown>;
    summary?: string;
  }): Promise<{ agreement: Record<string, unknown> }> {
    const candidate = input.candidate as CandidateLike;
    const provenance = candidate.provenance ?? {};
    const endpoint = typeof provenance.a2a_endpoint === "string" ? provenance.a2a_endpoint : "";
    const negotiationId =
      typeof provenance.negotiation_id === "string" ? provenance.negotiation_id : "";
    const offerId = typeof provenance.offer_id === "string" ? provenance.offer_id : "";
    const inReplyTo =
      typeof provenance.merchant_reply_id === "string" ? provenance.merchant_reply_id : "";
    const termsDigest =
      typeof provenance.latest_terms_digest === "string" ? provenance.latest_terms_digest : "";
    if (provenance.latest_offer_type !== "conditional_offer") {
      throw new McpError(
        "invalid_params",
        "商家最新回复不是 conditional_offer，无法通过 accept_nonbinding 成交",
      );
    }
    if (
      endpoint === "" ||
      negotiationId === "" ||
      offerId === "" ||
      inReplyTo === "" ||
      termsDigest === ""
    ) {
      throw new McpError(
        "invalid_params",
        "候选缺少可接受的最新商家报价（A2A endpoint / offer_id / reply id / terms digest）",
      );
    }
    const envelope = buildAcceptEnvelope({
      negotiationId,
      inReplyTo,
      offerId,
      termsDigest,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      now: this.now,
    });
    const client = buildA2AClient(endpoint, {
      bearerToken: this.bearerToken,
      ...(this.signer !== undefined ? { signer: this.signer } : {}),
      allowPrivateRanges: this.allowPrivateRanges,
      skipDnsCheck: this.skipDnsCheck,
      timeoutMs: this.timeoutMs,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
    });
    let task;
    try {
      task = await client.sendMessage(envelopeToMessage(envelope));
    } catch {
      // 发送结果未知：不得生成"已成交"的本地协议。
      throw new ProtocolOperationUnknown();
    }
    const decline = declineReasonFromTask(task);
    if (decline !== null) throw new MerchantDeclined(decline);
    const agreement = extractAgreementFromTask(task);
    if (agreement === null) throw new ProtocolOperationUnknown();
    const acceptedOffer = agreement["accepted_offer_id"];
    const acceptedDigest = agreement["terms_digest"];
    const acceptedBy = agreement["accepted_by"];
    if (
      agreement["negotiation_id"] !== negotiationId ||
      acceptedOffer !== offerId ||
      acceptedDigest !== termsDigest ||
      !Array.isArray(acceptedBy) ||
      !acceptedBy.includes("buyer") ||
      !acceptedBy.includes("merchant")
    ) {
      throw new McpError(
        "internal_error",
        "商家 agreement artifact 与本次接受条款不一致，需人工对账",
        { reconciliation_required: true },
      );
    }
    return { agreement };
  }

}
