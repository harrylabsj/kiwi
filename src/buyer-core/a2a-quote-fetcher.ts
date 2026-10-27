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

import { newNegotiationId } from "../negotiation/domain/identifiers.js";
import {
  A2AEndpointResolutionError,
  buildA2AClient,
  buildRfqEnvelope,
  envelopeToMessage,
  resolveA2aEndpoint,
} from "./a2a-knp.js";
import type { QuoteCandidateInput, QuoteFetcher, MerchantRecord } from "./service.js";

import { BuyerProtocolRecovery, ProtocolOperationUnknown, ProtocolOperationConflict, type ProtocolTaskContext, type ProtocolReply } from "./protocol-recovery.js";
import { BuyerReplyRejected } from "./receive-gate.js";

/**
 * WorkBuddy 访问配置在出站请求里的唯一用途：把签名地址映射成发送地址
 * （追加平台门禁参数）。实现方必须保证两者同源（B-08）。
 */
export interface MerchantAccessTransport {
  sendUrlFor(signUrl: string): string;
}

/**
 * 平台门禁不可用（配置缺失/会话被拒/目录不可达）。与"商家拒绝报价"是两件事：
 * 上层必须能分开归类，不能把它误报成商家业务拒绝（B-07）。
 */
export class MerchantAccessUnavailable extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "MerchantAccessUnavailable";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface MerchantAccessResolver {
  /** 按发现到的商家解析（主路径）。`null` 表示该商家不需要平台门禁参数。 */
  forMerchant(merchant: MerchantRecord): Promise<MerchantAccessTransport | null>;
  /** 按端点回源（协议恢复路径只知道端点）。 */
  forEndpoint(endpointUrl: string): Promise<MerchantAccessTransport | null>;
}

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
  protocolStateDir?: string;
  localBuyerAgentId?: string;
  now?: () => string;
  /**
   * 可选：WorkBuddy 平台门禁解析器。商家记录声明 `runtime_access` 时必须提供，
   * 且解析失败/为空一律 fail-closed（不静默降级为无码直连）。
   */
  merchantAccess?: MerchantAccessResolver;
}

/**
 * 从任意错误文本里抹掉分享参数（B-08）：即使某层错误带上了完整发送地址，
 * 落日志/回执的文本也不含分享码。与具体值无关，按参数名替换。
 */
function redactShareParameter(text: string): string {
  return text.replace(/([?&])sharecode=[^&\s"'#]*/gi, "$1sharecode=<redacted>");
}

const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 20_000;

function utcNow(): string {
  return new Date().toISOString();
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
  const validCurrency = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Z]{3}$/.test(value);
  let totalCurrency: string | undefined;
  if (terms.total_price !== undefined) {
    if (typeof terms.total_price !== "object" || terms.total_price === null ||
        !validCurrency(terms.total_price.currency)) return undefined;
    totalCurrency = terms.total_price.currency;
  }
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
    if (!validCurrency(lineCurrency)) return undefined;
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
  const uniform = lineCurrencies.every((c) => c === lineCurrencies[0]);
  if (!uniform) return undefined;
  // TermSet need not duplicate the currency already carried by every Money.
  // Infer only after all lines have been checked, never from the first alone.
  const hasDeclaredCurrency = Object.hasOwn(terms, "currency");
  if (hasDeclaredCurrency && !validCurrency(terms.currency)) return undefined;
  const currency = hasDeclaredCurrency ? terms.currency as string : lineCurrencies[0]!;
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
  private readonly rpcFetchImpl?: typeof fetch;
  private readonly recovery?: BuyerProtocolRecovery;
  private readonly merchantAccess?: MerchantAccessResolver;
  private readonly endpointCache = new Map<string, string>();
  private readonly now: () => string;

  constructor(options: A2AQuoteFetcherOptions = {}) {
    this.allowPrivateRanges = options.allowPrivateRanges ?? false;
    this.skipDnsCheck = options.skipDnsCheck ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.bearerToken = options.bearerToken;
    this.now = options.now ?? utcNow;
    // Card reads retain their existing fetch seam. Only an explicit custom
    // transport may replace the A2A client's pinned RPC default.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.rpcFetchImpl = options.fetchImpl;
    this.merchantAccess = options.merchantAccess;
    if (options.protocolStateDir && options.localBuyerAgentId) this.recovery = new BuyerProtocolRecovery(options.protocolStateDir, options.localBuyerAgentId, options.now);
  }

  /** 对每个 Merchant 独立发起真实 RFQ 并收集回复（部分失败语义）。 */
  async requestQuotes(intent: Record<string, unknown>, merchants: MerchantRecord[], context?: ProtocolTaskContext): Promise<QuoteCandidateInput[]> {
    return Promise.all(merchants.map((merchant) => this.requestQuote(intent, merchant, context)));
  }

  private async requestQuote(
    intent: Record<string, unknown>,
    merchant: MerchantRecord,
    context?: ProtocolTaskContext,
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
      const access = await this.accessForMerchant(merchant);
      const endpoint = await this.resolveEndpoint(agentCardUrl, access);
      const sku = merchant.matching_skus?.[0] ?? firstSku(intent);
      const negotiationId = newNegotiationId();
      const envelope = buildRfqEnvelope({
        negotiationId,
        sku,
        quantity: firstQuantity(intent),
        deliveryBefore: constraintsDeadline(intent),
        now: this.now,
      });
      const client = buildA2AClient(endpoint, {
        // WorkBuddy 路径不发送标准 Bearer：平台会改写 Authorization（G0 §1.1.3），
        // 继续附带只会让上层误以为认证已生效。业务认证走签名（B-05/B-06）。
        bearerToken: access === null ? this.bearerToken : undefined,
        allowPrivateRanges: this.allowPrivateRanges,
        skipDnsCheck: this.skipDnsCheck,
        timeoutMs: this.timeoutMs,
        ...(access !== null ? { sendUrl: access.sendUrlFor(endpoint) } : {}),
        ...(this.rpcFetchImpl !== undefined ? { fetchImpl: this.rpcFetchImpl } : {}),
      });
      if (!this.recovery || !context) throw new ProtocolOperationUnknown();
      const exchange = await this.recovery.exchange({
        context, stage: "rfq", round: 0, merchantId, endpoint,
        binding: { intent, merchant, payload: envelope.payload },
        build: (id) => buildRfqEnvelope({ negotiationId:id, sku, quantity:firstQuantity(intent), deliveryBefore:constraintsDeadline(intent), now:()=>context.createdAt }),
        send: (wire) => client.sendMessage(envelopeToMessage(wire)),
        get: (id) => client.getTask(id), timeoutMs:this.timeoutMs, pollIntervalMs:this.pollIntervalMs,
      });
      return this.project(exchange);
    } catch (error) {
      if (error instanceof A2AEndpointResolutionError) {
        const denied = error.httpStatus === 401 || error.httpStatus === 403;
        return {
          merchant_id: merchantId,
          status: "failed",
          failure: {
            // 平台门禁/认证拒绝（401/403）与"商家不可达"必须分开：前者换码
            // 或补认证后重试，后者是网络/服务问题（B-07）。
            classification: denied ? "access_denied" : "unreachable",
            retryable: !denied,
            detail: redactShareParameter(error.message),
          },
        };
      }
      if (error instanceof MerchantAccessUnavailable) {
        return {
          merchant_id: merchantId,
          status: "failed",
          failure: {
            classification: "access_unavailable",
            retryable: error.retryable,
            detail: redactShareParameter(`${error.code}: ${error.message}`),
          },
        };
      }
      return {
        merchant_id: merchantId,
        status: "failed",
        failure: {
          classification: "protocol_error",
          retryable: !(error instanceof ProtocolOperationUnknown || error instanceof ProtocolOperationConflict || error instanceof BuyerReplyRejected),
          detail: redactShareParameter(
            error instanceof BuyerReplyRejected ? error.reason : error instanceof Error ? error.message : String(error),
          ),
        },
      };
    }
  }

  private project({reply,wire,endpoint,merchantId}:ProtocolReply):QuoteCandidateInput {
    if (!["offer", "counter_offer"].includes(reply.action)) return {
      merchant_id: merchantId, status: "failed", failure: {
        classification: "protocol_error",
        retryable: false, detail: `unsupported_quote_reply:${reply.action}`,
      },
    };
    const offerId=(reply.payload as {offer_id?:unknown}).offer_id;
    const sku=(wire.payload as {items?:Array<{sku?:string}>}).items?.[0]?.sku;
    const terms=projectOfferTerms(reply.payload);
    return {merchant_id:merchantId,status:"succeeded",...(terms?{terms}:{}),provenance:{...(typeof offerId==="string"?{offer_id:offerId}:{}),negotiation_id:wire.negotiation_id,merchant_reply_id:reply.message_id,source:"a2a",reply_text:JSON.stringify(reply),sku,a2a_endpoint:endpoint}};
  }
  async recoverQuotes(context:ProtocolTaskContext):Promise<QuoteCandidateInput[]> {
    if(!this.recovery)throw new ProtocolOperationUnknown();
    const results=await this.recovery.recover(context,async (endpoint,id)=>{
      // 恢复路径只知道端点：用按 origin 的映射继续带码（B-04：不是只对首次请求有效）。
      const access=this.merchantAccess===undefined?null:await this.merchantAccess.forEndpoint(endpoint);
      return buildA2AClient(endpoint,{
        bearerToken:this.bearerToken,allowPrivateRanges:this.allowPrivateRanges,skipDnsCheck:this.skipDnsCheck,timeoutMs:this.timeoutMs,
        ...(access!==null?{sendUrl:access.sendUrlFor(endpoint)}:{}),
        ...(this.rpcFetchImpl!==undefined?{fetchImpl:this.rpcFetchImpl}:{}),
      }).getTask(id);
    },this.timeoutMs,this.pollIntervalMs);
    return results.map(result=>this.project(result));
  }

  /**
   * 平台门禁解析：声明了 `runtime_access` 的商家必须有可用的发送地址，
   * 否则 fail-closed（抛出被 requestQuote 归类为 access_unavailable）。
   */
  private async accessForMerchant(
    merchant: MerchantRecord,
  ): Promise<MerchantAccessTransport | null> {
    if (merchant.runtime_access === undefined) return null;
    if (this.merchantAccess === undefined) {
      throw new MerchantAccessUnavailable(
        "ACCESS_RESOLVER_MISSING",
        "merchant requires a platform access configuration but no resolver is configured",
      );
    }
    let transport: MerchantAccessTransport | null;
    try {
      transport = await this.merchantAccess.forMerchant(merchant);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const transient = code === "request_failed" || code === "request_timeout";
      throw new MerchantAccessUnavailable(
        typeof code === "string" ? code.toUpperCase() : "ACCESS_UNAVAILABLE",
        error instanceof Error ? error.message : "merchant platform access lookup failed",
        transient,
      );
    }
    if (transport === null) {
      throw new MerchantAccessUnavailable(
        "ACCESS_NOT_CONFIGURED",
        "merchant platform access configuration is unavailable",
      );
    }
    return transport;
  }

  /** 解析 agent card JSONRPC 端点（按 card URL 缓存；拒绝非 http(s)）。 */
  private async resolveEndpoint(
    agentCardUrl: string,
    access: MerchantAccessTransport | null = null,
  ): Promise<string> {
    const cacheKey = `${access === null ? "" : "access:"}${agentCardUrl}`;
    const cached = this.endpointCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const endpoint = await resolveA2aEndpoint(
      this.fetchImpl,
      agentCardUrl,
      this.timeoutMs,
      access === null ? undefined : (url) => access.sendUrlFor(url),
    );
    this.endpointCache.set(cacheKey, endpoint);
    return endpoint;
  }

}
