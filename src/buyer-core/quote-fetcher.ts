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
 * MarketplaceQuoteFetcher —— 真实 RFQ fan-out（战略 v2.5 Phase 2 Supply 轨）。
 *
 * 对每个目标 Merchant，经 shopping-cli marketplace 创建定向会话（真实商品/
 * 库存/交付数据 + resident merchant agent 确定性回复），轮询拿真实回复，映射为
 * QuoteCandidateInput（含 provenance：merchant_reply_id / conversation_id）。
 *
 * 拒绝编造：Merchant 不可达 / 超时 / 协议错误 → failed + 可解释 failure
 * classification；绝不返回虚构报价。
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { QuoteCandidateInput, QuoteFetcher, MerchantRecord } from "./service.js";

export interface MarketplaceQuoteFetcherOptions {
  /** shopping-cli marketplace 根 URL（如 http://127.0.0.1:8765）。 */
  baseUrl: string;
  /** buyer bootstrap token（SHOPPING_BUYER_BOOTSTRAP_TOKEN）。 */
  buyerBootstrapToken: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ConversationResponse {
  ok: boolean;
  conversation?: {
    id?: string;
    status?: string;
  };
  buyer_token?: string;
}

interface ConversationDetail {
  ok: boolean;
  conversation?: {
    status?: string;
    messages?: Array<{ id?: number; sender?: string; text?: string; created_at?: string }>;
  };
}

interface MerchantReply {
  messageId: number;
  text: string;
}

const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 20_000;

export class MarketplaceQuoteFetcher implements QuoteFetcher {
  private readonly baseUrl: string;
  private readonly buyerBootstrapToken: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MarketplaceQuoteFetcherOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.buyerBootstrapToken = options.buyerBootstrapToken;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** 对每个 Merchant 独立发起真实 RFQ 并收集回复（部分失败语义）。 */
  async requestQuotes(intent: Record<string, unknown>, merchants: MerchantRecord[]): Promise<QuoteCandidateInput[]> {
    const buyerId = `buyer-${uuidv7()}`;
    const results = await Promise.all(
      merchants.map((merchant) => this.requestQuote(buyerId, intent, merchant)),
    );
    return results;
  }

  private async requestQuote(
    buyerId: string,
    intent: Record<string, unknown>,
    merchant: MerchantRecord,
  ): Promise<QuoteCandidateInput> {
    const { sku, text } = this.buildRfq(intent, merchant);
    try {
      const conversation = await this.createConversation(buyerId, merchant.merchant_id, sku, text);
      if (conversation.conversation?.id === undefined || conversation.buyer_token === undefined) {
        throw new Error(`marketplace did not return conversation/buyer_token for ${merchant.merchant_id}`);
      }
      const convId = conversation.conversation.id;
      const reply = await this.pollMerchantReply(convId, conversation.buyer_token);
      if (reply === undefined) {
        return {
          merchant_id: merchant.merchant_id,
          status: "failed",
          failure: { classification: "timeout", retryable: true, detail: `no merchant reply within ${this.timeoutMs}ms` },
        };
      }
      return {
        merchant_id: merchant.merchant_id,
        status: "succeeded",
        provenance: {
          merchant_reply_id: String(reply.messageId),
          negotiation_id: convId,
          source: "marketplace",
          reply_text: reply.text,
          // 会话 buyer_token：供后续磋商（claim→counter→complete）复用。
          // 作用域仅限该会话，属最小披露。
          buyer_token: conversation.buyer_token,
          // 该商家实际报价的 SKU（RFQ 用商家自有 SKU），磋商 proposal 复用。
          sku,
        },
      };
    } catch (error) {
      return {
        merchant_id: merchant.merchant_id,
        status: "failed",
        failure: {
          classification: "protocol_error",
          retryable: true,
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /**
   * 从 CommerceIntent 提取 sku 与 RFQ 文本（真实商品语义，不做虚构）。
   * 商家有 matching_skus（marketplace 商品 FTS 路由）时优先用商家自有 SKU——
   * 否则商家 agent 无法按文本匹配到自己的商品（SKU 是会话匹配键）。
   */
  private buildRfq(intent: Record<string, unknown>, merchant: MerchantRecord): { sku: string; text: string } {
    const items = Array.isArray(intent.items) ? (intent.items as Array<Record<string, unknown>>) : [];
    const first = items[0] ?? {};
    const query = typeof first.query === "string" ? first.query : "";
    const itemSku = typeof first.sku === "string" ? first.sku : "";
    const sku = merchant.matching_skus?.[0] ?? itemSku;
    const quantity = typeof first.quantity === "object" && first.quantity !== null
      ? String((first.quantity as Record<string, unknown>).value ?? "")
      : "";
    const itemText = query !== "" ? query : sku;
    const text = `采购 ${quantity} 个 ${itemText}（sku=${sku || "?"}），请报价与交期。`.trim();
    return { sku, text };
  }

  private async createConversation(
    buyerId: string,
    merchantId: string,
    sku: string,
    text: string,
  ): Promise<ConversationResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/conversations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.buyerBootstrapToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        buyer_id: buyerId,
        merchant_id: merchantId,
        sku,
        text,
        intent: "ask_price",
      }),
      // 连接挂起不阻塞 worker：单次请求硬超时（fail-closed，同仓库 safe-http）。
      signal: AbortSignal.timeout(this.pollIntervalMs + 8000),
    });
    if (!res.ok) {
      throw new Error(`marketplace /conversations ${res.status}`);
    }
    const data = (await res.json()) as ConversationResponse;
    if (data.ok !== true) {
      throw new Error(`marketplace rejected conversation: ${JSON.stringify(data)}`);
    }
    return data;
  }

  /** 轮询会话直到 merchant_agent 回复出现或超时。 */
  private async pollMerchantReply(
    conversationId: string,
    buyerToken: string,
  ): Promise<MerchantReply | undefined> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const reply = await this.readConversation(conversationId, buyerToken);
      if (reply !== undefined) return reply;
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  private async readConversation(
    conversationId: string,
    buyerToken: string,
  ): Promise<MerchantReply | undefined> {
    const res = await this.fetchImpl(`${this.baseUrl}/conversations/${conversationId}`, {
      headers: { authorization: `Bearer ${buyerToken}` },
      signal: AbortSignal.timeout(this.pollIntervalMs + 8000),
    });
    if (!res.ok) {
      throw new Error(`marketplace /conversations/${conversationId} ${res.status}`);
    }
    const data = (await res.json()) as ConversationDetail;
    const messages = data.conversation?.messages ?? [];
    const reply = [...messages]
      .reverse()
      .find((m) => m.sender === "merchant_agent" && typeof m.id === "number");
    if (reply === undefined) return undefined;
    return { messageId: reply.id as number, text: reply.text ?? "" };
  }
}
