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
 * buyer 侧 A2A 磋商驱动（`/negotiate` 用）——经 agent catalog 发现目标 → fresh
 * resolve Agent Card → A2ADirectChannel → 脚本化 KNP 磋商
 * （RFQ→Offer→CounterOffer→ConditionalOffer→AcceptNonbinding→Agreement）。
 *
 * 确定性（不依赖 LLM）：与 a2a-agent.mjs 同一语义，供对话内 /negotiate 复用。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ShoppingCliCatalogSource } from "../discovery/catalog-source/index.js";
import { AgentDiscovery } from "../discovery/index.js";
import { selectChannelCandidate, A2ADirectChannel } from "../counterparty/index.js";
import type { ChannelHandle } from "../counterparty/index.js";
import { LedgerStore } from "../negotiation/ledger/index.js";
import { IdempotencyStore } from "../negotiation/idempotency/index.js";
import {
  newExchangeId,
  newMessageId,
  newNegotiationId,
  newOfferId,
} from "../negotiation/domain/identifiers.js";
import { finalizeEnvelope } from "../negotiation/domain/envelope.js";
import { contentDigest } from "../negotiation/jcs.js";
import { evaluateConditionalOffer } from "../negotiation/condition/evaluator.js";
import { detectLocale, type KiwiLocale } from "../i18n.js";

export const NEGOTIATE_CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";
export const NEGOTIATE_SKU = "sku-001";
export const NEGOTIATE_CURRENCY = "CNY";
export const NEGOTIATE_QUANTITY = 200;
export const NEGOTIATE_DEAL_PRICE_MINOR = 83_500;
export const NEGOTIATE_DELIVERY_BEFORE = "2026-08-20T18:00:00Z";

export interface NegotiateOptions {
  /** agent catalog base URL。 */
  catalog: string;
  /** 目标 catalog_agent_id；缺省取第一个可发现候选。 */
  catalogAgentId?: string;
  /** 订货量（缺省 200）。 */
  quantity?: number;
  /** 询价 SKU（缺省 sku-001）。买家任务驱动时取任务 intent 的 sku/category。 */
  sku?: string;
  /** 买方还价单价（minor 单位；缺省 835.00 分 = 83.50 元）。 */
  dealPriceMinor?: number;
  /** 要求交期（RFC3339；缺省 2026-08-20T18:00:00Z）。 */
  deliveryBefore?: string;
  /** 发送方身份（缺省 buyer:a2a-demo）。 */
  senderIdentity?: string;
}

export interface NegotiateResult {
  ok: boolean;
  negotiationId: string;
  catalogAgentId: string;
  agentCardUrl: string;
  steps: string[];
  agreement?: Record<string, unknown>;
  /** 磋商商业要点（自然语言渲染用）。 */
  facts?: {
    sku: string;
    quantity: number;
    offerPriceMinor?: number;
    dealPriceMinor?: number;
    deliveryBefore: string;
  };
  error?: string;
}

const minorPrice = (minor: number | undefined): string =>
  minor === undefined ? "?" : (minor / 100).toFixed(2);

/** 把一轮磋商结果渲染成人类可读的自然语言总结（跟随用户语言，缺省 detectLocale）。 */
export function summarizeNegotiation(
  result: NegotiateResult,
  locale: KiwiLocale = detectLocale(),
): string {
  const f = result.facts;
  const a = result.agreement;
  const sku = f?.sku ?? NEGOTIATE_SKU;
  const quantity = f?.quantity ?? NEGOTIATE_QUANTITY;
  const delivery = f?.deliveryBefore ?? NEGOTIATE_DELIVERY_BEFORE;
  const offerPrice = minorPrice(f?.offerPriceMinor);
  const dealPrice = minorPrice(f?.dealPriceMinor);
  const agreementId = String(a?.agreement_id ?? "");

  if (!result.ok) {
    return locale === "zh"
      ? `磋商失败：${result.error ?? "未知错误"}（可先 /discover 查看 catalog 里的 agent）`
      : `Negotiation failed: ${result.error ?? "unknown error"} (run /discover to list catalog agents)`;
  }
  if (locale === "zh") {
    return [
      `已完成一轮 A2A 磋商（negotiation ${result.negotiationId}）：`,
      `· 发现商家 ${result.catalogAgentId} 并验证其 Agent Card（${result.agentCardUrl}），确认在线可用`,
      `· 询价：采购 ${quantity} 件 ${sku}，要求 ${delivery} 前交货`,
      `· 商家首次报价：${offerPrice} 元/件`,
      `· 还价后商家给出条件价：总采购量 ≥ 100 件时按 ${dealPrice} 元/件成交`,
      `· 采购量满足条件，双方达成非绑定协议（agreement ${agreementId}）`,
      `协议性质：nonbinding — 不创建订单、不锁库存、不授权支付（§41 #25/#26/#27）`,
    ].join("\n");
  }
  return [
    `A round of A2A negotiation completed (negotiation ${result.negotiationId}):`,
    `· Discovered merchant ${result.catalogAgentId} and verified its Agent Card (${result.agentCardUrl}) — online and reachable`,
    `· RFQ: ${quantity} units of ${sku}, delivery by ${delivery}`,
    `· Merchant's initial offer: ${offerPrice} ${NEGOTIATE_CURRENCY}/unit`,
    `· After the counter, the merchant offered a conditional price: ${dealPrice} ${NEGOTIATE_CURRENCY}/unit when total quantity ≥ 100`,
    `· Quantity meets the condition; non-binding agreement reached (agreement ${agreementId})`,
    `Agreement is nonbinding — no order, no inventory reservation, no payment authorization (§41 #25/#26/#27)`,
  ].join("\n");
}

function monotonicNow(): () => string {
  let tick = 0;
  const base = Date.parse("2026-08-07T00:00:00.000Z");
  return () => {
    const t = new Date(base + tick);
    tick += 1;
    return t.toISOString();
  };
}

type EnvelopeSeed = Omit<
  Parameters<typeof finalizeEnvelope>[0],
  "capability" | "protocol_version" | "exchange_id" | "message_id"
> &
  Partial<Pick<Parameters<typeof finalizeEnvelope>[0], "exchange_id" | "message_id">>;

function seedEnvelope(seed: EnvelopeSeed): ReturnType<typeof finalizeEnvelope> {
  return finalizeEnvelope({
    capability: NEGOTIATE_CAPABILITY,
    protocol_version: "1.0",
    exchange_id: seed.exchange_id ?? newExchangeId(),
    message_id: seed.message_id ?? newMessageId(),
    ...seed,
  });
}

function rfqEnvelope(
  negotiationId: string,
  now: () => string,
  quantity: number,
  sku: string,
  deliveryBefore: string,
) {
  return seedEnvelope({
    negotiation_id: negotiationId,
    actor: "buyer",
    action: "rfq",
    created_at: now(),
    payload: {
      type: "rfq",
      items: [{ sku, quantity: { value: quantity, unit: "piece" } }],
      requested_terms: { delivery_before: deliveryBefore },
    },
  });
}

function counterEnvelope(
  negotiationId: string,
  now: () => string,
  inReplyTo: string,
  respondingToOfferId: string,
  quantity: number,
  sku: string,
  counterPriceMinor: number,
) {
  return seedEnvelope({
    negotiation_id: negotiationId,
    in_reply_to: inReplyTo,
    actor: "buyer",
    action: "counter_offer",
    created_at: now(),
    payload: {
      type: "counter_offer",
      offer_id: newOfferId(),
      responding_to_offer_id: respondingToOfferId,
      proposed_terms: {
        items: [
          {
            sku,
            quantity: { value: quantity, unit: "piece" },
            unit_price: { currency: NEGOTIATE_CURRENCY, amount_minor: counterPriceMinor },
          },
        ],
      },
    },
  });
}

function acceptEnvelope(negotiationId: string, now: () => string, inReplyTo: string, offerId: string, termsDigest: string) {
  return seedEnvelope({
    negotiation_id: negotiationId,
    in_reply_to: inReplyTo,
    actor: "buyer",
    action: "accept_nonbinding",
    created_at: now(),
    payload: { type: "accept_nonbinding", offer_id: offerId, terms_digest: termsDigest },
  });
}

function extractKnpEnvelope(task: { status?: { message?: { parts?: Array<{ kind: string; data?: Record<string, unknown> }> } } } | undefined) {
  const message = task?.status?.message;
  if (message === undefined) return null;
  for (const part of message.parts ?? []) {
    if (part.kind === "data" && part.data?.["knp_envelope"]) return part.data["knp_envelope"] as Record<string, unknown>;
  }
  return null;
}

function extractAgreement(task: { artifacts?: Array<{ parts?: Array<{ kind: string; data?: Record<string, unknown> }> }> } | undefined) {
  for (const artifact of task?.artifacts ?? []) {
    for (const part of artifact.parts ?? []) {
      if (part.kind === "data" && part.data?.["agreement"]) return part.data["agreement"] as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * 与 catalog 中发现的一个 agent 完成一轮确定性磋商（RFQ→…→Agreement）。
 * 失败返回 `{ ok: false, error }`，不抛错（供对话内命令友好报告）。
 */
export async function negotiateWithAgent(options: NegotiateOptions): Promise<NegotiateResult> {
  const quantity = options.quantity ?? NEGOTIATE_QUANTITY;
  const sku = options.sku ?? NEGOTIATE_SKU;
  const counterPriceMinor = options.dealPriceMinor ?? NEGOTIATE_DEAL_PRICE_MINOR;
  const deliveryBefore = options.deliveryBefore ?? NEGOTIATE_DELIVERY_BEFORE;
  const senderIdentity = options.senderIdentity ?? "buyer:a2a-demo";
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-negotiate-"));
  const now = monotonicNow();
  const ledger = new LedgerStore({ dir, now });
  const idempotency = new IdempotencyStore({ dir, now });
  const steps: string[] = [];
  let handle: ChannelHandle | null = null;
  const negotiationId = newNegotiationId();

  try {
    // 1. 发现：catalog 候选 → fresh resolve Agent Card（includeBlocked：本地 rejected 也纳入）。
    const source = new ShoppingCliCatalogSource({ baseUrl: options.catalog });
    const discovery = new AgentDiscovery({ catalog: { source, includeBlocked: true } });
    const resolved = await discovery.resolveViaCatalog();
    if (resolved.length === 0) {
      return { ok: false, negotiationId, catalogAgentId: "", agentCardUrl: "", steps, error: "catalog 里没有可发现的 agent" };
    }
    const target =
      options.catalogAgentId === undefined
        ? resolved[0]
        : resolved.find((r) => r.candidate.catalog_agent_id === options.catalogAgentId);
    if (target === undefined) {
      return {
        ok: false,
        negotiationId,
        catalogAgentId: options.catalogAgentId ?? "",
        agentCardUrl: "",
        steps,
        error: `catalog 里找不到 ${options.catalogAgentId ?? ""}（可用 /discover 查看）`,
      };
    }
    const catalogAgentId = target.candidate.catalog_agent_id;
    const agentCardUrl = target.candidate.discovery?.agent_card_url ?? "";
    steps.push(`discover ${catalogAgentId}`);
    steps.push(`resolve ${agentCardUrl}`);

    // 2. 通道：a2a-direct 优先。
    const channelCandidate = selectChannelCandidate(target.profile);
    if (channelCandidate === null || channelCandidate.url === undefined) {
      return { ok: false, negotiationId, catalogAgentId, agentCardUrl, steps, error: "无 a2a-direct 通道候选" };
    }
    const channel = new A2ADirectChannel({ url: channelCandidate.url, ledger, idempotency, now });
    handle = await channel.open({
      negotiation_id: negotiationId,
      sender_identity: senderIdentity,
      identity: target.profile.identity,
    });
    const send = async (envelope: ReturnType<typeof finalizeEnvelope>) =>
      handle!.send({ envelope, ref: { negotiation_id: negotiationId } });

    // 3. RFQ → Offer。
    const rfq = rfqEnvelope(negotiationId, now, quantity, sku, deliveryBefore);
    steps.push(`rfq`);
    const offerRes = await send(rfq);
    const offer = extractKnpEnvelope(offerRes.task);
    if (offer === null || offer.action !== "offer") {
      return { ok: false, negotiationId, catalogAgentId, agentCardUrl, steps, error: "未收到 offer 回复" };
    }
    const offerPayload = offer.payload as { offer_id?: string; terms?: { items?: Array<{ unit_price?: { amount_minor?: number } }> } };
    if (offerPayload.offer_id === undefined) {
      return { ok: false, negotiationId, catalogAgentId, agentCardUrl, steps, error: "offer 缺 offer_id" };
    }
    const offerPriceMinor = offerPayload.terms?.items?.[0]?.unit_price?.amount_minor;
    steps.push(`offer ${offerPayload.offer_id}`);

    // 4. CounterOffer → ConditionalOffer。
    const counter = counterEnvelope(
      negotiationId,
      now,
      (offer.message_id as string) ?? "",
      offerPayload.offer_id,
      quantity,
      sku,
      counterPriceMinor,
    );
    steps.push(`counter_offer`);
    const condRes = await send(counter);
    const conditional = extractKnpEnvelope(condRes.task);
    if (conditional === null || conditional.action !== "conditional_offer") {
      return { ok: false, negotiationId, catalogAgentId, agentCardUrl, steps, error: "未收到 conditional_offer 回复" };
    }
    const conditionalPayload = conditional.payload as {
      offer_id?: string;
      conditions?: Array<{ then_terms?: { items?: Array<{ unit_price?: { amount_minor?: number } }> } }>;
    };
    steps.push(`conditional_offer ${conditionalPayload.offer_id ?? ""}`);
    const dealPriceMinor = conditionalPayload.conditions?.[0]?.then_terms?.items?.[0]?.unit_price?.amount_minor;

    // 5. 确定性求值 → AcceptNonbinding → Agreement。
    const agreedTerms = evaluateConditionalOffer(conditionalPayload as never, {
      "aggregate.total_quantity": quantity,
    });
    const accept = acceptEnvelope(
      negotiationId,
      now,
      (conditional.message_id as string) ?? "",
      conditionalPayload.offer_id ?? "",
      contentDigest(agreedTerms as never),
    );
    steps.push(`accept_nonbinding`);
    const acceptRes = await send(accept);
    const agreement = extractAgreement(acceptRes.task);
    if (agreement === null) {
      return { ok: false, negotiationId, catalogAgentId, agentCardUrl, steps, error: "未收到 agreement artifact" };
    }
    steps.push(`agreement ${String(agreement.agreement_id ?? "")}`);
    return {
      ok: true,
      negotiationId,
      catalogAgentId,
      agentCardUrl,
      steps,
      agreement,
      facts: {
        sku,
        quantity,
        offerPriceMinor,
        dealPriceMinor,
        deliveryBefore,
      },
    };
  } catch (err) {
    return {
      ok: false,
      negotiationId,
      catalogAgentId: "",
      agentCardUrl: "",
      steps,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await handle?.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}
