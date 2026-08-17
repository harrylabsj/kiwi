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

import type { A2ATask } from "../a2a/client/types.js";
import type { NegotiationEnvelope } from "../negotiation/domain/envelope.js";
import {
  buildA2AClient,
  buildCounterEnvelope,
  envelopeToMessage,
  extractKnpEnvelope,
} from "./a2a-knp.js";
import type { NegotiationStep, Negotiator } from "./service.js";

export interface A2ANegotiatorOptions {
  allowPrivateRanges?: boolean;
  skipDnsCheck?: boolean;
  timeoutMs?: number;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
  /** 缺省还价折扣（现价×(1-discount)，无 intent 目标价时用）。 */
  defaultDiscountRate?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_DISCOUNT_RATE = 0.1;

interface CandidateLike {
  provenance?: {
    negotiation_id?: unknown;
    offer_id?: unknown;
    merchant_reply_id?: unknown;
    reply_text?: string;
    sku?: unknown;
    a2a_endpoint?: unknown;
  };
}

function utcNow(): string {
  return new Date().toISOString();
}

/** 从 offer envelope JSON（provenance.reply_text）解析商家单价（minor/元）。 */
function parseOfferPriceMinor(replyText: string | undefined): number | undefined {
  if (replyText === undefined || replyText === "") return undefined;
  try {
    const envelope = JSON.parse(replyText) as { payload?: { terms?: { items?: Array<{ unit_price?: { amount_minor?: unknown } }> } } };
    const minor = envelope.payload?.terms?.items?.[0]?.unit_price?.amount_minor;
    return typeof minor === "number" && Number.isFinite(minor) ? minor : undefined;
  } catch {
    return undefined;
  }
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
  }
  if (current !== undefined) return Math.round(current * (1 - discountRate) * 100) / 100;
  return undefined;
}

export class A2ANegotiator implements Negotiator {
  private readonly allowPrivateRanges: boolean;
  private readonly skipDnsCheck: boolean;
  private readonly timeoutMs: number;
  private readonly bearerToken?: string;
  private readonly defaultDiscountRate: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: A2ANegotiatorOptions = {}) {
    this.allowPrivateRanges = options.allowPrivateRanges ?? false;
    this.skipDnsCheck = options.skipDnsCheck ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.bearerToken = options.bearerToken;
    this.defaultDiscountRate = options.defaultDiscountRate ?? DEFAULT_DISCOUNT_RATE;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async negotiate(
    _taskId: string,
    intent: Record<string, unknown>,
    current: NegotiationStep,
    candidates: Array<Record<string, unknown>>,
  ): Promise<NegotiationStep> {
    const candidate = candidates.find(
      (c) => (c as CandidateLike).provenance?.a2a_endpoint !== undefined,
    ) as CandidateLike | undefined;
    if (candidate === undefined) {
      return { ...current, summary: `${current.summary}（无 A2A 会话上下文，无法真实还价）` };
    }
    const { negotiation_id, offer_id, merchant_reply_id, reply_text, sku, a2a_endpoint } =
      candidate.provenance ?? {};
    if (
      a2a_endpoint === undefined ||
      negotiation_id === undefined ||
      offer_id === undefined ||
      merchant_reply_id === undefined
    ) {
      return { ...current, summary: `${current.summary}（A2A 会话上下文不完整，无法真实还价）` };
    }
    const endpoint = String(a2a_endpoint);
    const negotiationId = String(negotiation_id);
    const offerId = String(offer_id);
    const inReplyTo = String(merchant_reply_id);
    const itemSku = typeof sku === "string" && sku !== "" ? sku : "item-1";

    try {
      const currentPrice = parseOfferPriceMinor(reply_text);
      const target = targetPriceMinor(intent, currentPrice, this.defaultDiscountRate);
      if (target === undefined) {
        return { ...current, summary: `${current.summary}（无目标价可还：意图无 target_unit_price 且商家回复无单价）` };
      }
      const envelope = buildCounterEnvelope({
        negotiationId,
        inReplyTo,
        respondingToOfferId: offerId,
        sku: itemSku,
        quantity: intentQuantity(intent),
        counterPriceMinor: target,
        now: utcNow,
      });
      const client = buildA2AClient(endpoint, {
        bearerToken: this.bearerToken,
        allowPrivateRanges: this.allowPrivateRanges,
        skipDnsCheck: this.skipDnsCheck,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
      });
      const task = await client.sendMessage(envelopeToMessage(envelope));
      const reply = await this.waitForMerchantReply(client, task, envelope.message_id);
      if (reply === null) {
        return { ...current, summary: `${current.summary}（商家处理中，未回还价）` };
      }
      return { ...current, reply: JSON.stringify(reply) };
    } catch (error) {
      return {
        ...current,
        summary: `${current.summary}（还价失败：${error instanceof Error ? error.message : String(error)}）`,
      };
    }
  }

  /** 轮询直到 merchant 回复 envelope 出现（排除自家 outbound 回声）或超时。 */
  private async waitForMerchantReply(
    client: ReturnType<typeof buildA2AClient>,
    initial: A2ATask,
    outboundMessageId: string,
  ): Promise<NegotiationEnvelope | null> {
    const deadline = Date.now() + this.timeoutMs;
    let task = initial;
    for (;;) {
      const envelope = extractKnpEnvelope(task);
      if (envelope !== null && envelope.message_id !== outboundMessageId) return envelope;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      task = await client.getTask(task.id);
    }
  }
}
