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
 * A2AQuoteFetcher —— 经 A2A 直连 merchant 的真实 RFQ fan-out（战略 v2.5 Phase 2
 * 接线 A2A/UCP；buyer 只连 catalog 发现，磋商直连 merchant）。
 *
 * 对每个有 agent_card_url 的 Merchant：解析 agent card 的 JSONRPC 端点 → 构造 KNP
 * rfq envelope → A2AClient.sendMessage → 轮询 getTask 直到 merchant 回复 envelope。
 * 映射为 QuoteCandidateInput（provenance 含 offer_id/negotiation_id/reply_text/sku/
 * a2a_endpoint，供 A2ANegotiator 复用）。与 MarketplaceQuoteFetcher 相同的
 * per-merchant try/catch + 部分失败语义；拒绝编造，merchant 不可达 → failed +
 * 可解释 failure classification。
 */

import type { A2ATask } from "../a2a/client/types.js";
import { newNegotiationId } from "../negotiation/domain/identifiers.js";
import type { NegotiationEnvelope } from "../negotiation/domain/envelope.js";
import {
  buildA2AClient,
  buildRfqEnvelope,
  envelopeToMessage,
  extractKnpEnvelope,
  resolveA2aEndpoint,
} from "./a2a-knp.js";
import type { QuoteCandidateInput, QuoteFetcher, MerchantRecord } from "./service.js";

export interface A2AQuoteFetcherOptions {
  /** 允许打到私网/保留网段（SSRF 逃生门；本地试点直连时开）。 */
  allowPrivateRanges?: boolean;
  /** 跳过 DNS 保留网段复查（测试/本机直连）。 */
  skipDnsCheck?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** 出站 bearer（A2A 认证；服务器为 signature 时匿名放行可省）。 */
  bearerToken?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 20_000;

function utcNow(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstItem(intent: Record<string, unknown>): Record<string, unknown> {
  const items = Array.isArray(intent.items) ? (intent.items as Array<Record<string, unknown>>) : [];
  return items[0] ?? {};
}

function firstSku(intent: Record<string, unknown>): string {
  const first = firstItem(intent);
  if (typeof first.sku === "string" && first.sku !== "") return first.sku;
  if (typeof first.query === "string" && first.query !== "") return first.query;
  return "item-1";
}

function firstQuantity(intent: Record<string, unknown>): { value: number; unit?: string } {
  const qty = firstItem(intent).quantity;
  if (typeof qty === "object" && qty !== null) {
    const value = (qty as Record<string, unknown>).value;
    const unit = (qty as Record<string, unknown>).unit;
    if (typeof value === "number" && value > 0) {
      return { value, ...(typeof unit === "string" && unit !== "" ? { unit } : {}) };
    }
  }
  return { value: 1 };
}

function constraintsDeadline(intent: Record<string, unknown>): string | undefined {
  const constraints = intent.constraints;
  if (typeof constraints === "object" && constraints !== null) {
    const deadline = (constraints as Record<string, unknown>).deadline;
    if (typeof deadline === "string" && deadline !== "") return deadline;
  }
  return undefined;
}

export class A2AQuoteFetcher implements QuoteFetcher {
  private readonly allowPrivateRanges: boolean;
  private readonly skipDnsCheck: boolean;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly bearerToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpointCache = new Map<string, string>();

  constructor(options: A2AQuoteFetcherOptions = {}) {
    this.allowPrivateRanges = options.allowPrivateRanges ?? false;
    this.skipDnsCheck = options.skipDnsCheck ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** 对每个 Merchant 独立发起真实 RFQ 并收集回复（部分失败语义）。 */
  async requestQuotes(intent: Record<string, unknown>, merchants: MerchantRecord[]): Promise<QuoteCandidateInput[]> {
    return Promise.all(merchants.map((merchant) => this.requestQuote(intent, merchant)));
  }

  private async requestQuote(
    intent: Record<string, unknown>,
    merchant: MerchantRecord,
  ): Promise<QuoteCandidateInput> {
    const { merchant_id: merchantId, agent_card_url: agentCardUrl } = merchant;
    if (agentCardUrl === undefined || agentCardUrl === "") {
      return {
        merchant_id: merchantId,
        status: "failed",
        failure: {
          classification: "unreachable",
          retryable: true,
          detail: "merchant has no agent card URL",
        },
      };
    }
    try {
      const endpoint = await this.resolveEndpoint(agentCardUrl);
      const sku = merchant.matching_skus?.[0] ?? firstSku(intent);
      const negotiationId = newNegotiationId();
      const envelope = buildRfqEnvelope({
        negotiationId,
        sku,
        quantity: firstQuantity(intent),
        deliveryBefore: constraintsDeadline(intent),
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
      const reply = await this.waitForMerchantReply(client, task);
      if (reply === null) {
        return {
          merchant_id: merchantId,
          status: "failed",
          failure: {
            classification: "timeout",
            retryable: true,
            detail: `no merchant reply within ${this.timeoutMs}ms`,
          },
        };
      }
      const offerId =
        typeof reply.payload === "object" && reply.payload !== null
          ? (reply.payload as { offer_id?: unknown }).offer_id
          : undefined;
      return {
        merchant_id: merchantId,
        status: "succeeded",
        provenance: {
          ...(typeof offerId === "string" && offerId !== "" ? { offer_id: offerId } : {}),
          negotiation_id: negotiationId,
          merchant_reply_id: reply.message_id,
          source: "a2a",
          reply_text: JSON.stringify(reply),
          sku,
          a2a_endpoint: endpoint,
        },
      };
    } catch (error) {
      return {
        merchant_id: merchantId,
        status: "failed",
        failure: {
          classification: "protocol_error",
          retryable: true,
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /** 解析 agent card JSONRPC 端点（按 card URL 缓存；拒绝非 http(s)）。 */
  private async resolveEndpoint(agentCardUrl: string): Promise<string> {
    const cached = this.endpointCache.get(agentCardUrl);
    if (cached !== undefined) return cached;
    const endpoint = await resolveA2aEndpoint(this.fetchImpl, agentCardUrl, this.timeoutMs);
    this.endpointCache.set(agentCardUrl, endpoint);
    return endpoint;
  }

  /** 发送 RFQ 后轮询直到 merchant 回复 envelope（非 rfq action）或超时。 */
  private async waitForMerchantReply(
    client: ReturnType<typeof buildA2AClient>,
    initial: A2ATask,
  ): Promise<NegotiationEnvelope | null> {
    const direct = extractKnpEnvelope(initial);
    if (direct !== null && direct.action !== "rfq") return direct;
    const deadline = Date.now() + this.timeoutMs;
    let task = initial;
    for (;;) {
      await sleep(this.pollIntervalMs);
      task = await client.getTask(task.id);
      const envelope = extractKnpEnvelope(task);
      if (envelope !== null && envelope.action !== "rfq") return envelope;
      if (Date.now() >= deadline) return null;
    }
  }
}
