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

/**
 * review P1-2（返修）：KNP offer/counter_offer payload → 结构化报价事实。
 * 只接受完全合规的形状（money 安全整数 minor、quantity number>0、items 非空、
 * 币种存在）；任何字段不合规整体返回 undefined（调用方 fail-closed），绝不
 * 部分投影。
 */
export function projectOfferTerms(
  payload: unknown,
): import("./service.js").CandidateQuoteTerms | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as {
    terms?: unknown;
    proposed_terms?: unknown;
  };
  const terms = (p.terms ?? p.proposed_terms) as
    | {
        items?: Array<{
          sku?: unknown;
          quantity?: { value?: unknown; unit?: unknown };
          unit_price?: { amount_minor?: unknown; currency?: unknown };
        }>;
        total_price?: { amount_minor?: unknown; currency?: unknown };
        currency?: unknown;
      }
    | undefined;
  if (terms === undefined || typeof terms !== "object" || !Array.isArray(terms.items) || terms.items.length === 0) {
    return undefined;
  }
  // review P1-2（A316 补充校准）：币种不得投影为首行/top 单值——逐行收集
  // 各 item 币种与 total_price.currency，全部一致才接受；混币种（USD/CNY）
  // 整体返回 undefined（下游 fail-closed），绝不按首行币种授权。
  const lineCurrencies: string[] = [];
  const totalCurrency =
    typeof terms.total_price === "object" &&
    terms.total_price !== null &&
    typeof (terms.total_price as { currency?: unknown }).currency === "string"
      ? (terms.total_price as { currency: string }).currency
      : undefined;
  const items: import("./service.js").CandidateQuoteItem[] = [];
  for (const item of terms.items) {
    if (typeof item !== "object" || item === null) return undefined;
    const sku = item.sku;
    const qty = item.quantity?.value;
    const minor = item.unit_price?.amount_minor;
    if (typeof sku !== "string" || sku === "") return undefined;
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) return undefined;
    if (typeof minor !== "number" || !Number.isSafeInteger(minor) || minor < 0) return undefined;
    const lineCurrency = item.unit_price?.currency;
    if (typeof lineCurrency !== "string" || lineCurrency === "") return undefined;
    lineCurrencies.push(lineCurrency);
    items.push({
      sku,
      quantity_value: qty,
      ...(typeof item.quantity?.unit === "string" && item.quantity.unit !== ""
        ? { quantity_unit: item.quantity.unit }
        : {}),
      unit_price_minor: minor,
    });
  }
  const declaredCurrency =
    typeof terms.currency === "string" && terms.currency !== "" ? terms.currency : undefined;
  const uniform = lineCurrencies.every((c) => c === lineCurrencies[0]);
  if (!uniform || declaredCurrency === undefined) return undefined;
  const currency: string = declaredCurrency;
  if (currency !== lineCurrencies[0]) return undefined;
  if (totalCurrency !== undefined && totalCurrency !== currency) return undefined;
  let total: number;
  if (
    terms.total_price !== undefined &&
    typeof terms.total_price === "object" &&
    terms.total_price !== null &&
    typeof (terms.total_price as { amount_minor?: unknown }).amount_minor === "number" &&
    Number.isSafeInteger((terms.total_price as { amount_minor: number }).amount_minor)
  ) {
    total = (terms.total_price as { amount_minor: number }).amount_minor;
  } else {
    total = items.reduce((sum, it) => sum + it.unit_price_minor * it.quantity_value, 0);
  }
  if (!Number.isSafeInteger(total)) return undefined;
  return { currency, items, total_price_minor: total };
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
      // review P1-2（返修）：把 KNP offer 的结构化 terms 投影进候选——委托
      // 约束核验以此为唯一权威事实；投影失败（缺字段/非整数 minor/非法数量）
      // 则不携带 terms，下游带约束 accept 走 fail-closed。
      const terms = projectOfferTerms(reply.payload);
      return {
        merchant_id: merchantId,
        status: "succeeded",
        ...(terms !== undefined ? { terms } : {}),
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
