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
  ): Promise<{ price: number; currency: string; title?: string; stock?: number }>;
}

/**
 * 把 CommerceDataSource（v1.1 数据侧边界）适配成 MerchantProductSource。
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

function offerTerms(opts: { sku?: string; priceMinor: number; quantity: number; currency?: string }) {
  return {
    items: [
      {
        sku: opts.sku ?? MERCHANT_SKU,
        quantity: { value: opts.quantity, unit: "piece" },
        unit_price: { currency: opts.currency ?? MERCHANT_CURRENCY, amount_minor: opts.priceMinor },
      },
    ],
    fulfillment_terms: { delivery_before: MERCHANT_DELIVERY_BEFORE },
    valid_until: "2099-12-31T23:59:59Z",
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
  // 每 negotiation 已解析的真实商品价（sku → {priceMinor, currency}）。
  const priceBySku = new Map<string, { priceMinor: number; currency: string }>();

  /** 从真实商品源解析 SKU 价目；源不可用/查不到时回退演示价并返回注记。 */
  const resolveProduct = async (
    sku: string,
  ): Promise<{ priceMinor: number; currency: string; note?: string }> => {
    const cached = priceBySku.get(sku);
    if (cached !== undefined) return cached;
    if (options.productSource !== undefined) {
      try {
        const product = await options.productSource.getProduct(sku);
        const resolved = { priceMinor: Math.round(product.price * 100), currency: product.currency };
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

  return {
    name: "kiwi-agent-serve-merchant",
    async handle(ctx: InboundNegotiationContext): Promise<NegotiationHandlerResult> {
      const envelope = ctx.envelope;
      const negotiationId = envelope.negotiation_id;
      const inReplyTo = envelope.message_id;

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
          const { priceMinor, currency, note } = await resolveProduct(sku);
          const reply = seedEnvelope({
            negotiation_id: negotiationId,
            in_reply_to: inReplyTo,
            actor: "merchant",
            action: "offer",
            created_at: now(),
            payload: {
              type: "offer",
              offer_id: newOfferId(),
              terms: offerTerms({ sku, priceMinor, quantity, currency }),
            },
            ...(note !== undefined ? { public_message: note } : {}),
          });
          await appendSent(reply);
          return envelopeReply(reply);
        }
        case "offer": {
          // 商家还价：对 buyer 的 offer 回 counter_offer（真实商品价）。
          const buyerOffer = envelope.payload as { offer_id?: string; terms?: { items?: { sku?: string; quantity?: { value?: number } }[] } };
          const sku = buyerOffer.terms?.items?.[0]?.sku ?? MERCHANT_SKU;
          const quantity = buyerOffer.terms?.items?.[0]?.quantity?.value ?? MERCHANT_QUANTITY;
          const { priceMinor, currency, note } = await resolveProduct(sku);
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
              proposed_terms: offerTerms({ sku, priceMinor, quantity, currency }),
            },
            ...(note !== undefined ? { public_message: note } : {}),
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
          const { priceMinor, currency, note } = await resolveProduct(sku);
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
              base_terms: offerTerms({ sku, priceMinor, quantity, currency }),
              conditions: [
                {
                  when: { all: [{ field: "aggregate.total_quantity", op: "gte", value: 100 }] },
                  then_terms: offerTerms({ sku, priceMinor: dealPriceMinor, quantity, currency }),
                },
              ],
            },
            ...(note !== undefined ? { public_message: note } : {}),
          });
          conditionalByNegotiation.set(negotiationId, {
            conditional: reply.payload as unknown as Record<string, unknown>,
            quantity,
          });
          await appendSent(reply);
          return envelopeReply(reply);
        }
        case "clarification": {
          const field = (envelope.payload as { questions?: { field?: string }[] }).questions?.[0]?.field;
          return textReply(
            `Regarding "${field ?? "…"}": delivery before ${MERCHANT_DELIVERY_BEFORE}, payment terms negotiable (nonbinding).`,
          );
        }
        case "accept_nonbinding": {
          const stored = conditionalByNegotiation.get(negotiationId);
          const acceptedOfferId = (envelope.payload as { offer_id?: string }).offer_id ?? "";
          // 成交价必须来自本磋商已发出的 conditional_offer：无前置 conditional
          // 或 accept 的 offer_id 与所存 conditional 不匹配 → 用基础价成交
          // （无折扣），绝不发 DEAL 价。此前无前置时直接给 DEAL 价，任何 buyer
          // 在 conditional_offer 之前发 accept 即可拿到折扣价。
          const storedOfferId = (stored?.conditional as { offer_id?: string } | undefined)?.offer_id ?? "";
          const acceptedConditional =
            stored !== undefined && acceptedOfferId !== "" && acceptedOfferId === storedOfferId
              ? stored
              : undefined;
          const agreedTerms =
            acceptedConditional === undefined
              ? offerTerms({
                  priceMinor: (await resolveProduct(MERCHANT_SKU)).priceMinor,
                  quantity: MERCHANT_QUANTITY,
                })
              : evaluateConditionalOffer(acceptedConditional.conditional as never, {
                  "aggregate.total_quantity": acceptedConditional.quantity,
                });
          const agreement = buildAgreement({
            negotiation_id: negotiationId,
            accepted_offer_id: (envelope.payload as { offer_id: string }).offer_id,
            agreed_terms: agreedTerms,
            created_at: now(),
          });
          const artifactPart: A2APart = { kind: "data", data: { agreement } };
          const message: A2AMessage = {
            role: "agent",
            parts: [{ kind: "text", text: "Agreement reached (nonbinding)." }],
            messageId: newMessageId(),
          };
          return { kind: "accepted", taskState: "completed", artifactParts: [artifactPart], message };
        }
        case "withdraw":
          return textReply(`Withdrawn (scope=${(envelope.payload as { scope?: string }).scope ?? "offer"}).`);
        case "decline":
          return textReply(`Declined (scope=${(envelope.payload as { scope?: string }).scope ?? "offer"}).`);
        case "cancel":
          return textReply("Negotiation cancelled.");
        default:
          return { kind: "declined", reasonCode: "unsupported_action" };
      }
    },
  };
}
