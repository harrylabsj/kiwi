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
 * Merchant Ops API（战略 v2.5 §7.6 / §7.7）。
 *
 * Host/Hermes 作为 Operator Console 查看 RFQ 队列、处理 human_required、批准
 * 异常报价、查看 Agreement/Analytics。Merchant Core 仍是状态权威；Ops 只投影
 * 状态与接收审批输入（§7.5 Intelligence & Ops Plane）。
 *
 * 命名空间隔离（§7.7）：本服务用 **merchant token** 认证（`kiwi.merchant.*`）；
 * 任何 Buyer token 不得访问 Merchant Ops，任何 Merchant Ops token 不得获得
 * Buyer Principal Memory。与 `kiwi.buyer.*`（Buyer Kit）完全分离。
 */

export interface MerchantOpsServiceOptions {
  baseUrl: string;
  /** 商家 API token（merchant 作用域，非 buyer token）。 */
  merchantToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RfqConversation {
  id: string;
  buyer_id: string;
  sku: string;
  status: string;
  next_actor: string;
  created_at: string;
  updated_at: string;
  last_sender: string;
  message_count?: number;
}

export interface HumanReviewConversation {
  id: string;
  buyer_id: string;
  status: string;
  reason?: string;
  created_at?: string;
}

export interface MerchantAnalytics {
  merchant_id: string;
  total_rfqs: number;
  pending_rfqs: number;
  completed_rfqs: number;
  human_review_count: number;
}

export class MerchantOpsService {
  private readonly baseUrl: string;
  private readonly merchantToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MerchantOpsServiceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.merchantToken = options.merchantToken;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** RFQ 队列：商家名下活跃会话（§7.6 查看 RFQ）。 */
  async listRfqQueue(merchantId: string): Promise<{ rfqs: RfqConversation[] }> {
    const data = await this.getJson<RfqConversation[] | { results?: RfqConversation[]; conversations?: RfqConversation[] }>(
      `/merchants/${encodeURIComponent(merchantId)}/conversations`,
    );
    const rfqs = Array.isArray(data)
      ? data
      : ((data.conversations ?? data.results) ?? []);
    return { rfqs };
  }

  /** human_required 会话（§7.6 处理人工审核）。 */
  async listHumanReview(merchantId: string): Promise<{ conversations: HumanReviewConversation[] }> {
    const data = await this.getJson<{ conversations?: HumanReviewConversation[] }>(
      `/merchants/${encodeURIComponent(merchantId)}/human-review`,
    );
    return { conversations: data.conversations ?? [] };
  }

  /** 处理 human_required：resolve 会话（商家运营决定）。 */
  async resolveReview(merchantId: string, conversationId: string, decision: string): Promise<{ ok: boolean }> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/conversations/${encodeURIComponent(conversationId)}/human-review/resolve`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.merchantToken}`, "content-type": "application/json" },
        body: JSON.stringify({ decision, merchant_id: merchantId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!res.ok) throw new Error(`resolve review ${res.status}`);
    const data = (await res.json()) as { ok?: boolean };
    return { ok: data.ok === true };
  }

  /** Analytics：RFQ 量、待办/完成、人工审核数（§7.6）。 */
  async analytics(merchantId: string): Promise<MerchantAnalytics> {
    const { rfqs } = await this.listRfqQueue(merchantId);
    const { conversations } = await this.listHumanReview(merchantId);
    return {
      merchant_id: merchantId,
      total_rfqs: rfqs.length,
      pending_rfqs: rfqs.filter((r) => r.status === "waiting_merchant").length,
      completed_rfqs: rfqs.filter((r) => r.status === "closed").length,
      human_review_count: conversations.length,
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.merchantToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`merchant ops ${path} ${res.status}`);
    return (await res.json()) as T;
  }
}
