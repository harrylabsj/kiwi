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
 * MarketplaceNegotiator —— 真实磋商（CounterOffer）经 shopping-cli marketplace。
 *
 * 复用电报会话：买家 claim 商家最新回复 → 提交 counter 决策（结构化 proposal，
 * 目标价来自 intent constraints 或当前报价折扣）→ complete claim → 轮询商家
 * （kiwi merchant runtime）对还价的回复。所有回复为真实商家文本，不编造。
 *
 * 前置：报价阶段（MarketplaceQuoteFetcher）把 conversation 的 buyer_token 存入
 * candidate provenance；本实现从 task candidates 读取磋商上下文。
 */

import type { NegotiationStep, Negotiator } from "./service.js";

export interface MarketplaceNegotiatorOptions {
  baseUrl: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 还价目标单价（minor/元）；缺省从意图 constraints.target_unit_price 或
   *  商家当前报价折扣（10%）推导。 */
  defaultDiscountRate?: number;
}

interface CandidateLike {
  merchant_id?: unknown;
  provenance?: { negotiation_id?: string; merchant_reply_id?: string; buyer_token?: string; reply_text?: string; sku?: string };
}

interface ConversationDetail {
  ok: boolean;
  conversation?: {
    status?: string;
    messages?: Array<{ id?: number; sender?: string; text?: string }>;
  };
}

const DEFAULT_POLL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 15_000;

export class MarketplaceNegotiator implements Negotiator {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly defaultDiscountRate: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MarketplaceNegotiatorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultDiscountRate = options.defaultDiscountRate ?? 0.1;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async negotiate(
    _taskId: string,
    intent: Record<string, unknown>,
    current: NegotiationStep,
    candidates: Array<Record<string, unknown>>,
  ): Promise<NegotiationStep> {
    const candidate = candidates.find(
      (c) => (c as CandidateLike).provenance?.negotiation_id !== undefined,
    ) as CandidateLike | undefined;
    if (candidate === undefined) {
      return { ...current, summary: `${current.summary}（无会话上下文，无法真实还价）` };
    }
    const { negotiation_id: convId, merchant_reply_id, buyer_token, sku } = candidate.provenance ?? {};
    if (convId === undefined || buyer_token === undefined || merchant_reply_id === undefined) {
      return { ...current, summary: `${current.summary}（会话上下文不完整，无法真实还价）` };
    }
    const messageId = Number(merchant_reply_id);
    if (!Number.isInteger(messageId)) {
      return { ...current, summary: `${current.summary}（商家回复引用无效）` };
    }

    try {
      const targetPrice = this.targetPrice(intent, candidate.provenance?.reply_text);
      const stockQty = parseStock(candidate.provenance?.reply_text);
      const claim = await this.claimMessage(buyer_token, convId, messageId);
      if (claim !== true) {
        return { ...current, summary: `${current.summary}（商家消息 ${messageId} 不可 claim）` };
      }
      const decisionOk = await this.submitCounter(buyer_token, convId, messageId, targetPrice, current.summary, sku, stockQty);
      if (decisionOk !== true) {
        return { ...current, summary: `${current.summary}（还价决策被拒）` };
      }
      await this.completeClaim(buyer_token, messageId);
      const reply = await this.pollMerchantReply(buyer_token, convId, messageId);
      if (reply !== undefined) {
        return { ...current, reply };
      }
      return { ...current, summary: `${current.summary}（商家处理中，未回还价）` };
    } catch (error) {
      return {
        ...current,
        summary: `${current.summary}（还价失败：${error instanceof Error ? error.message : String(error)}）`,
      };
    }
  }

  /** 目标单价：intent.constraints.target_unit_price → 当前报价×(1-discount)。 */
  private targetPrice(intent: Record<string, unknown>, replyText: string | undefined): number {
    const constraints = (intent.constraints ?? {}) as Record<string, unknown>;
    const explicit = constraints.target_unit_price;
    if (typeof explicit === "number" && explicit > 0) return explicit;
    if (typeof explicit === "string" && Number(explicit) > 0) return Number(explicit);
    const current = parseCurrentPrice(replyText);
    if (current !== undefined) return Number((current * (1 - this.defaultDiscountRate)).toFixed(2));
    return 0;
  }

  private async claimMessage(buyerToken: string, convId: string, messageId: number): Promise<boolean> {
    const res = await this.fetchImpl(`${this.baseUrl}/negotiation/claims`, {
      method: "POST",
      headers: { authorization: `Bearer ${buyerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ conversation_id: convId, message_id: messageId, idempotency_key: `nc-${messageId}-${Date.now()}` }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { claim?: { claimed?: boolean } };
    return data.claim?.claimed === true;
  }

  private async submitCounter(
    buyerToken: string,
    convId: string,
    messageId: number,
    targetPrice: number,
    summary: string,
    sku: string | undefined,
    stockQty: number,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const proposal = {
      sku: sku ?? "pilot-sku",
      quantity: 10,
      unit_price: targetPrice,
      currency: "CNY",
      // 库存快照须与服务端最新一致（stale_inventory 拒绝），从商家回复解析。
      stock: { status: "available", quantity: stockQty, observed_at: now, reserved: false },
      delivery: { eta_start: now, eta_end: now, fee: 0 },
      after_sales_policy_refs: [],
      valid_until: "2099-12-31T23:59:59Z",
    };
    const res = await this.fetchImpl(`${this.baseUrl}/negotiation/decisions`, {
      method: "POST",
      headers: { authorization: `Bearer ${buyerToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        idempotency_key: `nd-${messageId}-${Date.now()}`,
        decision: {
          protocol_version: "shopping.negotiation/0.1",
          conversation_id: convId,
          in_reply_to_message_id: messageId,
          action: "counter",
          open_issues: [],
          public_message: summary,
          reason_codes: ["price"],
          request_human_review: false,
          proposal,
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { policy_result?: { result?: string } };
    return data.policy_result?.result === "accepted";
  }

  private async completeClaim(buyerToken: string, messageId: number): Promise<void> {
    await this.fetchImpl(`${this.baseUrl}/negotiation/claims/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${buyerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ message_id: messageId, idempotency_key: `nc-${messageId}-${Date.now()}` }),
      signal: AbortSignal.timeout(8000),
    });
  }

  /** 轮询会话直到出现 merchant 对还价的新回复（晚于被还价消息）或超时。 */
  private async pollMerchantReply(
    buyerToken: string,
    convId: string,
    counterMessageId: number,
  ): Promise<string | undefined> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const res = await this.fetchImpl(`${this.baseUrl}/conversations/${convId}`, {
        headers: { authorization: `Bearer ${buyerToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = (await res.json()) as ConversationDetail;
        const reply = [...(data.conversation?.messages ?? [])]
          .reverse()
          .find((m) => m.sender === "merchant_agent" && (m.id ?? 0) > counterMessageId);
        if (reply !== undefined && reply.text !== undefined) return reply.text;
      }
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }
}

/** 从回复文本解析当前单价（如 "current price 189.00 CNY" / "单价 189"）。 */
function parseCurrentPrice(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const match = text.match(/current price ([\d.]+) CNY/i) ?? text.match(/单价 ([\d.]+)/);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** 从回复文本解析库存（如 "stock 180" / "库存 180"），供 proposal 快照对齐。 */
function parseStock(text: string | undefined): number {
  if (text === undefined) return 0;
  const match = text.match(/\b(?:stock|库存)\s+(\d+)/i);
  if (match === null) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
}
