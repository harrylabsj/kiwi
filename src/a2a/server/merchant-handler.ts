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
 * 生产 merchant A2A handler（`kiwi agent serve` 用）——脚本化 KNP 磋商：
 *
 *   rfq/inquiry → offer；offer → counter_offer（还价到 DEAL 价）；
 *   counter_offer → conditional_offer；clarification → 文字澄清应答；
 *   accept_nonbinding → agreement artifact（三副作用 flag 恒 false）；
 *   withdraw/decline/cancel → 文字确认。
 *
 * 每个出站回复落 merchant 侧 Ledger（append-only，§22）。这是 `kiwi agent serve`
 * 的确定性 merchant 行为；未来可替换为 LLM 驱动的 Negotiation Engine（同一 handler 接缝）。
 */

import type { CommerceDataSource } from "../../commerce/data-source.js";
import { LedgerStore } from "../../negotiation/ledger/index.js";
import {
  newAgreementId,
  newExchangeId,
  newMessageId,
  newOfferId,
} from "../../negotiation/domain/identifiers.js";
import { finalizeEnvelope } from "../../negotiation/domain/envelope.js";
import { contentDigest } from "../../negotiation/jcs.js";
import { evaluateConditionalOffer } from "../../negotiation/condition/evaluator.js";
import { toMinorUnits as losslessToMinorUnits } from "../../protocol/legacy-shopping-negotiation/money.js";
import {
  createNegotiationPhase,
  isTerminalPhase,
  transitionPhase,
  type NegotiationPhase,
  type NegotiationPhaseEvent,
  type NegotiationPhaseState,
} from "../../negotiation/state/phase.js";
import type { ProtocolErrorCode } from "../../negotiation/domain/common.js";
import type { A2AMessage, A2APart } from "../client/types.js";
import type {
  InboundNegotiationContext,
  NegotiationHandler,
  NegotiationHandlerResult,
} from "./types.js";

export const MERCHANT_CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";
export const MERCHANT_SKU = "SKU-001";
export const MERCHANT_CURRENCY = "CNY";
export const MERCHANT_OFFER_PRICE_MINOR = 85_000; // CNY 850.00
export const MERCHANT_DEAL_PRICE_MINOR = 83_500; // CNY 835.00
export const MERCHANT_QUANTITY = 200;
export const MERCHANT_DELIVERY_BEFORE = "2026-08-20T18:00:00Z";

export interface MerchantHandlerOptions {
  ledger: LedgerStore;
  now: () => string;
  sender: string;
  counterparty: string;
  /** rfq→offer 的初始报价（amount_minor）；缺省 85000。 */
  offerPriceMinor?: number;
  /** 真实商品源（接 shopping-cli /products/{sku} 等开放商品层）；缺省用内置演示价。 */
  productSource?: MerchantProductSource;
  /** 条件成交折扣百分比（deal = base × (1 - pct/100)）；缺省 5。 */
  dealDiscountPercent?: number;
}

/**
 * 真实商品源：给定 SKU 返回价目（shopping-cli 开放层/ERP/商品表均可接入）。
 * `price` 单位为**元**（major units，与 resolveProduct 的 `*100 → amount_minor`
 * 约定一致，也符合 shopping-cli wire 值；测试桩 `{price: 99}` → 9900 minor 同此）。
 */
export interface MerchantProductSource {
  getProduct(
    sku: string,
  ): Promise<{ price: number; currency: string; title?: string; stock?: number; handoff_destination?: string }>;
}

/**
 * 把 CommerceDataSource（v0.7.0 数据侧边界）适配成 MerchantProductSource。
 * price_minor（分）→ 元（major）转换在此完成，与接口"元"单位约定一致；
 * 未知 SKU → 抛错（resolveProduct 回退演示价，缺省行为不变）。
 */
export function dataSourceProductSource(
  dataSource: CommerceDataSource,
): MerchantProductSource {
  return {
    async getProduct(sku: string) {
      const fact = await dataSource.getProduct(sku);
      if (fact === undefined || fact.price_minor === undefined || fact.currency === undefined) {
        throw new Error(`product source has no price for SKU ${sku}`);
      }
      return {
        price: fact.price_minor / 100,
        currency: fact.currency,
        ...(fact.title !== undefined ? { title: fact.title } : {}),
        ...(fact.stock !== undefined ? { stock: fact.stock } : {}),
      };
    },
  };
}

type EnvelopeSeed = Omit<
  Parameters<typeof finalizeEnvelope>[0],
  "capability" | "protocol_version" | "exchange_id" | "message_id"
> &
  Partial<Pick<Parameters<typeof finalizeEnvelope>[0], "exchange_id" | "message_id">>;

function seedEnvelope(seed: EnvelopeSeed): ReturnType<typeof finalizeEnvelope> {
  return finalizeEnvelope({
    capability: MERCHANT_CAPABILITY,
    protocol_version: "1.0",
    exchange_id: seed.exchange_id ?? newExchangeId(),
    message_id: seed.message_id ?? newMessageId(),
    ...seed,
  });
}

/** offer 有效期（审查 P3：此前 valid_until 硬编码 2099——§11 "Offer with
 *  valid_until MUST NOT be accepted after that timestamp" 永不生效，陈旧
 * 报价可被无限期接受）。24h 窗口，accept 时校验（offer_expired 拒绝）。 */
export const OFFER_VALIDITY_MS = 24 * 60 * 60 * 1000;

function offerTerms(
  opts: { sku?: string; priceMinor: number; quantity: number; currency?: string; handoff_destination?: string },
  now: string,
) {
  return {
    items: [
      {
        sku: opts.sku ?? MERCHANT_SKU,
        quantity: { value: opts.quantity, unit: "piece" },
        unit_price: { currency: opts.currency ?? MERCHANT_CURRENCY, amount_minor: opts.priceMinor },
      },
    ],
    fulfillment_terms: { delivery_before: MERCHANT_DELIVERY_BEFORE },
    // 商家声明的每商品成交入口（KTH handoff 目的地）：buyer 从 agreement 直读，
    // 不依赖 catalog 投影。
    ...(opts.handoff_destination !== undefined
      ? { handoff_destination: opts.handoff_destination }
      : {}),
    valid_until: new Date(Date.parse(now) + OFFER_VALIDITY_MS).toISOString(),
  };
}

function buildAgreement(input: {
  negotiation_id: string;
  accepted_offer_id: string;
  agreed_terms: unknown;
  created_at: string;
}): Record<string, unknown> {
  return {
    type: "accepted_nonbinding_agreement",
    agreement_id: newAgreementId(),
    negotiation_id: input.negotiation_id,
    accepted_offer_id: input.accepted_offer_id,
    agreed_terms: input.agreed_terms,
    terms_digest: contentDigest(input.agreed_terms as never),
    accepted_by: ["buyer", "merchant"],
    created_at: input.created_at,
    binding_effect: "nonbinding",
    creates_order: false,
    reserves_inventory: false,
    authorizes_payment: false,
  };
}

const textReply = (text: string, taskState: "working" | "completed" = "working"): NegotiationHandlerResult => ({
  kind: "accepted",
  taskState,
  message: {
    role: "agent",
    parts: [{ kind: "text", text }],
    // newMessageId 已带 msg_ 前缀（此前 msg_${newMessageId()} 产生
    // msg_msg_<uuid> 双重前缀，跨端对账隐患）。
    messageId: newMessageId(),
  },
});

/** 商业拒绝（offer 未知/已关闭/terms_digest 不匹配/终态重开）。
 * decline 消息由 pipeline 按 reason_code 自动构造。 */
const declineReply = (reasonCode: ProtocolErrorCode = "state_conflict"): NegotiationHandlerResult => ({
  kind: "declined",
  reasonCode,
  taskState: "completed",
});

const envelopeReply = (reply: ReturnType<typeof finalizeEnvelope>): NegotiationHandlerResult => ({
  kind: "accepted",
  taskState: "working",
  message: {
    role: "agent",
    parts: [{ kind: "data", data: { knp_envelope: reply } }],
    messageId: reply.message_id,
  },
});

/** 构造生产 merchant KNP handler。 */
export function createMerchantHandler(
  options: MerchantHandlerOptions,
): NegotiationHandler {
  const { ledger, now, sender, counterparty } = options;
  const offerPriceMinor = options.offerPriceMinor ?? MERCHANT_OFFER_PRICE_MINOR;
  const conditionalByNegotiation = new Map<string, { conditional: Record<string, unknown>; quantity: number }>();
  // 审查 P2-D：终态（AGREEMENT_REACHED / WITHDRAWN / DECLINED / CANCELLED）
  // 不得以同一 negotiation_id 重开（§17.4/§21.2）——运行时此前无任何终态
  // 守卫：连发两份 accept 可产出两份 agreement、withdraw 后可再次成交。
  const closedNegotiations = new Set<string>();
  // 每 negotiation 的相位机状态（审查 BUG-10：完整状态含 active_offer_id /
  // resume_phase——此前只记 OPEN→终态的最小轨迹，中间相位由
  // conditionalByNegotiation 隐式表达，规范转换表不是接收消息的权威门）。
  const phaseStateByNegotiation = new Map<string, NegotiationPhaseState>();
  // 产生商业承诺的动作：终态后一律拒绝；text-only（clarification）放行。
  const COMMERCIAL_ACTIONS = new Set([
    "inquiry",
    "rfq",
    "offer",
    "counter_offer",
    "conditional_offer",
    "accept_nonbinding",
  ]);

  /** 审查 BUG-10：把入站 action 映射到相位机事件并推进；非法转换（不在
   *  转换表内的组合）fail-closed 返回 false（调用方 decline state_conflict）。
   *  clarification 由商家的结构化 clarification_response 应答同轮恢复，
   *  相位净不变。相位变化（含中间相位 OFFER_OPEN）落 state_transition 事件，
   *  重启可完整重建。 */
  const advancePhase = async (
    negotiationId: string,
    event: NegotiationPhaseEvent,
  ): Promise<boolean> => {
    const state = phaseStateByNegotiation.get(negotiationId) ?? createNegotiationPhase(negotiationId);
    let next: NegotiationPhaseState;
    try {
      next = transitionPhase(state, event);
    } catch {
      return false;
    }
    phaseStateByNegotiation.set(negotiationId, next);
    if (next.phase !== state.phase) {
      await appendPhaseTransition(negotiationId, next.phase, state.phase);
    }
    return true;
  };

  /** 入站 action → 相位机事件（inquiry/rfq 是起始动作，无转换）。 */
  const actionToPhaseEvent = (
    envelope: { action: string; payload?: unknown },
  ): NegotiationPhaseEvent | undefined => {
    const offerId = String((envelope.payload as { offer_id?: unknown } | undefined)?.offer_id ?? "");
    switch (envelope.action) {
      case "offer":
        return { type: "offer", offer_id: offerId };
      case "counter_offer":
        return { type: "counter_offer", offer_id: offerId };
      case "conditional_offer":
        return { type: "conditional_offer", offer_id: offerId };
      case "clarification":
        return { type: "clarification" };
      case "clarification_response":
        // 对称路径（方案B）：商家为提问方时，买家的应答经 restore 边弹回相位；
        // 非 AWAITING_CLARIFICATION 时相位机 fail-closed（state_conflict）。
        return { type: "clarification_response" };
      case "accept_nonbinding":
        return { type: "accept_nonbinding", offer_id: offerId };
      case "withdraw":
        return { type: "withdraw", scope: (envelope.payload as { scope?: string } | undefined)?.scope === "negotiation" ? "negotiation" : "offer" };
      case "decline":
        return { type: "decline", scope: (envelope.payload as { scope?: string } | undefined)?.scope === "negotiation" ? "negotiation" : "offer" };
      case "cancel":
        return { type: "cancel" };
      default:
        return undefined;
    }
  };

  /** 落 state_transition 事件并推进本机相位（recovery.deriveLocalPhase 消费）。
   *  fromPhase 必须显式传入——调用方若已把 next 写入 map 再读，from 会变成
   *  已推进的值（审查 BUG-10 实现注记）。 */
  const appendPhaseTransition = async (
    negotiationId: string,
    toPhase: NegotiationPhase,
    fromPhase?: NegotiationPhase,
  ): Promise<void> => {
    const current = phaseStateByNegotiation.get(negotiationId);
    const effectiveFrom = fromPhase ?? current?.phase ?? "OPEN";
    phaseStateByNegotiation.set(negotiationId, { ...(current ?? createNegotiationPhase(negotiationId)), phase: toPhase });
    await ledger.append({
      event_kind: "state_transition",
      negotiation_id: negotiationId,
      state_transition: { from_phase: effectiveFrom, to_phase: toPhase },
      identity: {
        sender_identity: sender,
        counterparty_identity: counterparty,
        actor: "merchant",
      },
      capability: { capability: MERCHANT_CAPABILITY, protocol_version: "1.0" },
      outcome: { kind: "ok" },
      occurred_at: now(),
    });
  };
  // 每 negotiation 已解析的真实商品价（sku → {priceMinor, currency}），带
  // TTL（评审项 L3：此前永久累积、价格永不刷新——长驻 merchant 节点内存
  // 单调增长且价目陈旧）。
  const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;
  const priceBySku = new Map<string, { priceMinor: number; currency: string; at: number }>();

  /** 从真实商品源解析 SKU 价目；源不可用/查不到时回退演示价并返回注记。 */
  const resolveProduct = async (
    sku: string,
  ): Promise<{ priceMinor: number; currency: string; note?: string; handoff_destination?: string }> => {
    const cached = priceBySku.get(sku);
    if (cached !== undefined) {
      if (Date.parse(now()) - cached.at <= PRICE_CACHE_TTL_MS) return cached;
      priceBySku.delete(sku); // TTL 过期：重新解析（价格会变）
    }
    if (options.productSource !== undefined) {
      try {
        const product = await options.productSource.getProduct(sku);
        // 审查 BUG-04：major→minor 必须 lossless——Math.round 会把 19.995
        // 静默改写为 1999/2000 进入报价（P2-P 已修数据源路径，此处是生产
        // merchant handler 的剩余舍入点）。无法精确表达 → fail-closed
        // （抛错 → resolveProduct 回退演示价并注记）。
        const converted = losslessToMinorUnits(product.price, 2);
        if (!converted.lossless) {
          throw new Error(
            `商品源价格 ${product.price} 超出 ${MERCHANT_CURRENCY} 两位小数精度（lossy）`,
          );
        }
        const resolved = {
          priceMinor: converted.amount_minor,
          currency: product.currency,
          at: Date.parse(now()),
          ...(product.handoff_destination !== undefined
            ? { handoff_destination: product.handoff_destination }
            : {}),
        };
        priceBySku.set(sku, resolved);
        return resolved;
      } catch {
        // 失败回退**不写缓存**：一次性故障（超时/重启）不得让该 SKU 从此
        // 永久按演示价报价（长驻进程里源恢复后价格仍错）。下一轮重试真实源。
        return {
          priceMinor: offerPriceMinor,
          currency: MERCHANT_CURRENCY,
          note: `商品源不可用（${sku}），本回合使用演示价`,
        };
      }
    }
    return { priceMinor: offerPriceMinor, currency: MERCHANT_CURRENCY };
  };

  const appendSent = async (reply: ReturnType<typeof finalizeEnvelope>): Promise<void> => {
    await ledger.append({
      event_kind: "message_sent",
      negotiation_id: reply.negotiation_id,
      exchange_id: reply.exchange_id,
      message_id: reply.message_id,
      in_reply_to: reply.in_reply_to,
      identity: {
        sender_identity: sender,
        counterparty_identity: counterparty,
        actor: reply.actor,
      },
      capability: {
        capability: reply.capability,
        protocol_version: reply.protocol_version,
      },
      wire_digest: reply.digest,
      wire_payload: reply as unknown as Record<string, unknown>,
      outcome: { kind: "ok" },
      occurred_at: reply.created_at,
    });
  };

  // 审查 BUG-03：从持久 Ledger 恢复状态（必须在 return 之前执行）——重启后
  // 终态不得重开、已发出的 conditional offer 必须继续可被接受（此前
  // conditionalByNegotiation / closedNegotiations / phaseStateByNegotiation 纯内存，
  // 重启全丢：已终态 negotiation 可重新打开、已发 offer 返回 offer_unknown）。
  for (const negotiationId of ledger.listNegotiations()) {
    const events = ledger.events(negotiationId);
    let phase: NegotiationPhase = "OPEN";
    for (const event of events) {
      if (event.state_transition?.to_phase !== undefined) {
        phase = event.state_transition.to_phase;
      }
    }
    // 审查 P1-07（跨重启残留，独立验收发现）：终态相位同样必须恢复——相位
    // 取自链上 state_transition 事实（非臆造）。否则 cancel/withdraw/decline
    // 不在 COMMERCIAL_ACTIONS、重启后 advancePhase 从全新 OPEN 状态推进：
    // 重放的 cancel 被当作新动作接受，并落 from_phase 伪造为 OPEN 的幻影
    // 终态转换。恢复后由相位机 fail-closed（state_conflict），与进程内一致。
    phaseStateByNegotiation.set(negotiationId, {
      negotiation_id: negotiationId,
      phase,
    });
    if (isTerminalPhase(phase)) {
      closedNegotiations.add(negotiationId);
      continue; // 终态后 conditional 已删除，不恢复
    }
    // 恢复最后发出的 conditional_offer（message_sent 事件携带完整 envelope）
    let lastConditional: { conditional: Record<string, unknown>; quantity: number } | undefined;
    for (const event of events) {
      if (event.event_kind !== "message_sent") continue;
      const envelope = event.wire_payload as
        | { action?: string; payload?: Record<string, unknown> }
        | undefined;
      if (envelope?.action !== "conditional_offer") continue;
      const payload = envelope.payload as
        | {
            offer_id?: string;
            base_terms?: { items?: Array<{ quantity?: { value?: number } }> };
          }
        | undefined;
      if (payload?.offer_id === undefined) continue;
      lastConditional = {
        conditional: envelope.payload as Record<string, unknown>,
        quantity: payload.base_terms?.items?.[0]?.quantity?.value ?? MERCHANT_QUANTITY,
      };
    }
    if (lastConditional !== undefined) {
      conditionalByNegotiation.set(negotiationId, lastConditional);
    }
  }
  return {
    name: "kiwi-agent-serve-merchant",
    async handle(ctx: InboundNegotiationContext): Promise<NegotiationHandlerResult> {
      const envelope = ctx.envelope;
      const negotiationId = envelope.negotiation_id;
      const inReplyTo = envelope.message_id;

      // 审查 P2-D：终态不得以同一 negotiation_id 重开（§17.4/§21.2）。
      if (closedNegotiations.has(negotiationId) && COMMERCIAL_ACTIONS.has(envelope.action)) {
        return declineReply("state_conflict");
      }

      // 审查 BUG-10：每个入站 action 经规范转换表推进相位——非法转换
      // fail-closed（state_conflict）。accept 的推进在 §15 校验通过后
      // （见 accept 分支：被拒的 accept 不得进入 AGREEMENT_REACHED）。
      const phaseEvent = actionToPhaseEvent(envelope);
      const isAcceptAction = envelope.action === "accept_nonbinding";
      if (phaseEvent !== undefined && !isAcceptAction) {
        const advanced = await advancePhase(negotiationId, phaseEvent);
        if (!advanced) {
          return declineReply("state_conflict");
        }
      }

      switch (envelope.action) {
        case "inquiry": {
          // 入站消息由 A2A pipeline 统一落 message_received（§22）；这里不再
          // 重复落账——此前 appendSent(envelope) 把买家的 inquiry 记为 merchant
          // 自己"发送"（sender=merchant），审计语义错位且重复。
          return textReply(
            `We carry ${MERCHANT_SKU} at ${(offerPriceMinor / 100).toFixed(2)} ${MERCHANT_CURRENCY}/piece; ask for delivery details.`,
          );
        }
        case "rfq": {
          const payload = envelope.payload as {
            items?: { sku?: string; quantity?: { value?: number } }[];
          };
          const sku = payload.items?.[0]?.sku ?? MERCHANT_SKU;
          const quantity = payload.items?.[0]?.quantity?.value ?? MERCHANT_QUANTITY;
          const { priceMinor, currency, note, handoff_destination } = await resolveProduct(sku);
          const reply = seedEnvelope({
            negotiation_id: negotiationId,
            in_reply_to: inReplyTo,
            actor: "merchant",
            action: "offer",
            created_at: now(),
            payload: {
              type: "offer",
              offer_id: newOfferId(),
              terms: offerTerms({ sku, priceMinor, quantity, currency, handoff_destination }, now()),
            },
            ...(note !== undefined ? { public_message: note } : {}),
          });
          // 审查 BUG-10：merchant 侧相位由自己的出站动作推进——rfq 的 offer
          // 回复是 OPEN→OFFER_OPEN 的边（入站侧 rfq 是起始动作无事件）。
          await advancePhase(negotiationId, {
            type: "offer",
            offer_id: String((reply.payload as { offer_id?: unknown }).offer_id ?? ""),
          });
          await appendSent(reply);
          return envelopeReply(reply);
        }
        case "offer": {
          // 商家还价：对 buyer 的 offer 回 counter_offer（真实商品价）。
          const buyerOffer = envelope.payload as { offer_id?: string; terms?: { items?: { sku?: string; quantity?: { value?: number } }[] } };
          const sku = buyerOffer.terms?.items?.[0]?.sku ?? MERCHANT_SKU;
          const quantity = buyerOffer.terms?.items?.[0]?.quantity?.value ?? MERCHANT_QUANTITY;
          const { priceMinor, currency, note, handoff_destination } = await resolveProduct(sku);
          const reply = seedEnvelope({
            negotiation_id: negotiationId,
            in_reply_to: inReplyTo,
            actor: "merchant",
            action: "counter_offer",
            created_at: now(),
            payload: {
              type: "counter_offer",
              offer_id: newOfferId(),
              responding_to_offer_id: buyerOffer.offer_id ?? "",
              proposed_terms: offerTerms({ sku, priceMinor, quantity, currency, handoff_destination }, now()),
            },
            ...(note !== undefined ? { public_message: note } : {}),
          });
          await advancePhase(negotiationId, {
            type: "counter_offer",
            offer_id: String((reply.payload as { offer_id?: unknown }).offer_id ?? ""),
          });
          await appendSent(reply);
          return envelopeReply(reply);
        }
        case "counter_offer": {
          const counter = envelope.payload as {
            proposed_terms?: { items?: { sku?: string; quantity?: { value?: number } }[] };
            offer_id?: string;
          };
          const sku = counter.proposed_terms?.items?.[0]?.sku ?? MERCHANT_SKU;
          const quantity = counter.proposed_terms?.items?.[0]?.quantity?.value ?? MERCHANT_QUANTITY;
          const { priceMinor, currency, note, handoff_destination } = await resolveProduct(sku);
          // 条件成交价 = base × (1 - 折扣%)：批量确实更便宜。
          const discountPercent = options.dealDiscountPercent ?? 5;
          const dealPriceMinor = Math.round((priceMinor * (100 - discountPercent)) / 100);
          const reply = seedEnvelope({
            negotiation_id: negotiationId,
            in_reply_to: inReplyTo,
            actor: "merchant",
            action: "conditional_offer",
            created_at: now(),
            payload: {
              type: "conditional_offer",
              offer_id: newOfferId(),
              responding_to_offer_id: counter.offer_id,
              base_terms: offerTerms({ sku, priceMinor, quantity, currency, handoff_destination }, now()),
              conditions: [
                {
                  when: { all: [{ field: "aggregate.total_quantity", op: "gte", value: 100 }] },
                  then_terms: offerTerms(
                    { sku, priceMinor: dealPriceMinor, quantity, currency, handoff_destination },
                    now(),
                  ),
                },
              ],
            },
            ...(note !== undefined ? { public_message: note } : {}),
          });
          conditionalByNegotiation.set(negotiationId, {
            conditional: reply.payload as unknown as Record<string, unknown>,
            quantity,
          });
          await advancePhase(negotiationId, {
            type: "conditional_offer",
            offer_id: String((reply.payload as { offer_id?: unknown }).offer_id ?? ""),
          });
          await appendSent(reply);
          return envelopeReply(reply);
        }
        case "clarification": {
          const questions = (envelope.payload as { questions?: { field?: string }[] }).questions ?? [];
          // 方案B（协议完整）：商家的应答是结构化 clarification_response
          // envelope（§8.2），in_reply_to 引用被回答的澄清消息（§8.5/§14
          // 强制，finalizeEnvelope 校验）。payload 形状规范未冻结（§14），
          // 携带 answers 便于对端结构化消费；人类可读文本走 public_message。
          const reply = seedEnvelope({
            negotiation_id: negotiationId,
            in_reply_to: inReplyTo,
            actor: "merchant",
            action: "clarification_response",
            created_at: now(),
            payload: {
              type: "clarification_response",
              answers: questions.map((q) => ({
                field: q.field ?? "…",
                answer: `delivery before ${MERCHANT_DELIVERY_BEFORE}, payment terms negotiable (nonbinding)`,
              })),
            },
            public_message: `delivery before ${MERCHANT_DELIVERY_BEFORE}, payment terms negotiable (nonbinding).`,
          });
          // 出站应答即恢复（restore 边，§21.2）：顶层推进已把相位挂到
          // AWAITING_CLARIFICATION，clarification_response 同轮弹回
          // resume_phase（OFFER_OPEN/OPEN），否则「问一句再 accept」的
          // happy path 会被相位机永久 state_conflict。恢复失败 fail-closed。
          const restored = await advancePhase(negotiationId, { type: "clarification_response" });
          if (!restored) {
            return declineReply("state_conflict");
          }
          await appendSent(reply);
          return envelopeReply(reply);
        }
        case "accept_nonbinding": {
          const stored = conditionalByNegotiation.get(negotiationId);
          const acceptPayload = envelope.payload as { offer_id?: string; terms_digest?: string };
          const acceptedOfferId = acceptPayload.offer_id ?? "";
          // 成交价必须来自本磋商已发出的 conditional_offer：无前置 conditional
          // 或 accept 的 offer_id 与所存 conditional 不匹配 → 拒绝成交。此前
          // 无前置时回退基础价照样产出 agreement，从未发出的 offer_id 也照样
          // 成交（agreement 指向不存在的 offer，审计溯源断裂）。
          const storedOfferId = (stored?.conditional as { offer_id?: string } | undefined)?.offer_id ?? "";
          const acceptedConditional =
            stored !== undefined && acceptedOfferId !== "" && acceptedOfferId === storedOfferId
              ? stored
              : undefined;
          if (acceptedConditional === undefined) {
            return declineReply("offer_unknown");
          }
          // KNP §15（审查 P2-C，实验复现）：terms_digest 必须是 agreed terms
          // 的 canonical digest——错误 digest 此前也产出 agreement。任一检查
          // 失败都不得创建 agreement。
          const agreedTerms = evaluateConditionalOffer(acceptedConditional.conditional as never, {
            "aggregate.total_quantity": acceptedConditional.quantity,
          });
          // 审查 P3：§11 offer 过期校验——valid_until 已过 → 拒绝（此前
          // valid_until 硬编码 2099 永不生效，陈旧报价可被无限期接受）。
          const validUntil = (agreedTerms as { valid_until?: string } | undefined)?.valid_until;
          if (validUntil !== undefined) {
            const validUntilMs = Date.parse(validUntil);
            const nowMs = Date.parse(now());
            if (!Number.isFinite(validUntilMs) || !Number.isFinite(nowMs) || validUntilMs < nowMs) {
              return declineReply("offer_expired");
            }
          }
          const presentedDigest = acceptPayload.terms_digest ?? "";
          if (presentedDigest === "" || presentedDigest !== contentDigest(agreedTerms as never)) {
            return declineReply("terms_digest_mismatch");
          }
          // 审查 P1-C：相位机是权威守卫——§15 校验通过后、构建协议之前先
          // 推进相位并检查返回值（BUG-10 语义不变：被拒的 accept 不得进入
          // AGREEMENT_REACHED）。推进失败（如 AWAITING_CLARIFICATION 下直接
          // accept）fail-closed：不返回协议、不进 closedNegotiations、不删
          // conditional，无任何终态副作用——此前忽略返回值，协议照发但相位
          // 机拒绝推进；进程内 closedNegotiations 挡住二次 accept，重启恢复
          // 后相位重建为 AWAITING_CLARIFICATION，二次 accept 产出重复协议。
          const advanced = await advancePhase(negotiationId, {
            type: "accept_nonbinding",
            offer_id: acceptedOfferId,
          });
          if (!advanced) {
            return declineReply("state_conflict");
          }
          const agreement = buildAgreement({
            negotiation_id: negotiationId,
            accepted_offer_id: acceptedOfferId,
            agreed_terms: agreedTerms,
            created_at: now(),
          });
          const artifactPart: A2APart = { kind: "data", data: { agreement } };
          const message: A2AMessage = {
            role: "agent",
            parts: [{ kind: "text", text: "Agreement reached (nonbinding)." }],
            messageId: newMessageId(),
          };
          // 协商终态：conditional 不再需要（评审项 L3：此前永久累积）。
          conditionalByNegotiation.delete(negotiationId);
          closedNegotiations.add(negotiationId);
          return { kind: "accepted", taskState: "completed", artifactParts: [artifactPart], message };
        }
        case "withdraw": {
          const scope = (envelope.payload as { scope?: string }).scope ?? "offer";
          conditionalByNegotiation.delete(negotiationId);
          // scope=offer 只关 offer 不终局（相位机 OFFER_OPEN→OPEN）；scope=
          // negotiation 才进入 WITHDRAWN 终态。
          if (scope !== "offer") {
            closedNegotiations.add(negotiationId);
            await advancePhase(negotiationId, { type: "withdraw", scope: "negotiation" });
          }
          return textReply(`Withdrawn (scope=${scope}).`);
        }
        case "decline": {
          const scope = (envelope.payload as { scope?: string }).scope ?? "offer";
          conditionalByNegotiation.delete(negotiationId);
          if (scope !== "offer") {
            closedNegotiations.add(negotiationId);
            await advancePhase(negotiationId, { type: "decline", scope: "negotiation" });
          }
          return textReply(`Declined (scope=${scope}).`);
        }
        case "cancel":
          conditionalByNegotiation.delete(negotiationId);
          closedNegotiations.add(negotiationId);
          await advancePhase(negotiationId, { type: "cancel" });
          return textReply("Negotiation cancelled.");
        default:
          return { kind: "declined", reasonCode: "unsupported_action" };
      }
    },
  };

}
