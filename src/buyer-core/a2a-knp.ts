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
 * A2A KNP 信封构造/提取助手（kiwi-buyer-mcp A2A 轨，战略 v2.5 §6.1）。
 *
 * buyer-core 的 A2AQuoteFetcher / A2ANegotiator 共用：KNP envelope 构造、
 * envelope→A2A message、从 A2A task 提取 merchant 回复 envelope、agent card
 * JSONRPC 端点解析。词表单一来源：capability/action 走 KNP 域，不发明平行常量。
 */

import { validateWireEnvelope } from "../negotiation/domain/envelope.js";
import { schemaError } from "../negotiation/domain/common.js";
import { A2AClient } from "../a2a/client/client.js";
import type { A2AMessage, A2ATask } from "../a2a/client/types.js";
import { NEGOTIATE_CAPABILITY } from "../a2a/negotiate.js";
import type { AgentCard } from "../discovery/agent-card/types.js";
import { KNP_PROTOCOL_VERSION } from "../negotiation/domain/common.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../negotiation/domain/envelope.js";
import {
  newExchangeId,
  newMessageId,
  newOfferId,
} from "../negotiation/domain/identifiers.js";

export interface RfqInput {
  negotiationId: string;
  sku: string;
  quantity: { value: number; unit?: string };
  deliveryBefore?: string;
  now: () => string;
}

/** 构造买家 RFQ envelope（§10：至少一个 item；digest 由 finalizeEnvelope 计算）。 */
export function buildRfqEnvelope(input: RfqInput): NegotiationEnvelope {
  return finalizeEnvelope({
    capability: NEGOTIATE_CAPABILITY,
    protocol_version: KNP_PROTOCOL_VERSION,
    negotiation_id: input.negotiationId,
    exchange_id: newExchangeId(),
    message_id: newMessageId(),
    actor: "buyer",
    action: "rfq",
    created_at: input.now(),
    payload: {
      type: "rfq",
      items: [
        {
          sku: input.sku,
          quantity: { value: input.quantity.value, unit: input.quantity.unit ?? "piece" },
        },
      ],
      ...(input.deliveryBefore !== undefined
        ? { requested_terms: { delivery_before: input.deliveryBefore } }
        : {}),
    },
  });
}

export interface CounterInput {
  negotiationId: string;
  /** 回应的商家消息 id（offer envelope 的 message_id）。 */
  inReplyTo: string;
  /** 回应的 offer_id（§6.4/§12 MUST 引用前一个 offer-like 对象）。 */
  respondingToOfferId: string;
  sku: string;
  quantity: number;
  quantityUnit?: string;
  counterPriceMinor: number;
  now: () => string;
}

/** 构造买家 counter_offer envelope（§12）。 */
export function buildCounterEnvelope(input: CounterInput): NegotiationEnvelope {
  return finalizeEnvelope({
    capability: NEGOTIATE_CAPABILITY,
    protocol_version: KNP_PROTOCOL_VERSION,
    negotiation_id: input.negotiationId,
    exchange_id: newExchangeId(),
    message_id: newMessageId(),
    in_reply_to: input.inReplyTo,
    actor: "buyer",
    action: "counter_offer",
    created_at: input.now(),
    payload: {
      type: "counter_offer",
      offer_id: newOfferId(),
      responding_to_offer_id: input.respondingToOfferId,
      proposed_terms: {
        items: [
          {
            sku: input.sku,
            quantity: { value: input.quantity, unit: input.quantityUnit ?? "piece" },
            unit_price: { currency: "CNY", amount_minor: input.counterPriceMinor },
          },
        ],
      },
    },
  });
}

/** KNP envelope → A2A message（data part 承载 knp_envelope；1.0 帧由 client 编码）。 */
export function envelopeToMessage(envelope: NegotiationEnvelope): A2AMessage {
  return {
    role: "agent",
    messageId: envelope.message_id,
    parts: [{ kind: "data", data: { knp_envelope: envelope } }],
  };
}

/** 从 A2A task 提取最新 KNP envelope（只认 data part 的 knp_envelope，fail-closed）。 */
export function extractKnpEnvelope(
  task: A2ATask | null | undefined,
  request?: NegotiationEnvelope,
): NegotiationEnvelope | null {
  const message = task?.status?.message;
  if (message === undefined) return null;
  for (const part of message.parts) {
    if (part.kind === "data") {
      const data = part.data;
      if (data !== null && typeof data === "object" && data["knp_envelope"] !== undefined) {
        const wire = validateWireEnvelope(data["knp_envelope"]);
        if (request !== undefined) {
          if (wire.message_id === request.message_id) {
            if (wire.digest !== request.digest) throw schemaError("/message_id", "outbound echo changed content");
          } else if (wire.actor !== "merchant" || wire.negotiation_id !== request.negotiation_id ||
                     wire.capability !== request.capability || wire.in_reply_to !== request.message_id) {
            throw schemaError("/in_reply_to", "merchant reply is not bound to the outgoing request");
          }
        }
        return wire;
      }
    }
  }
  return null;
}

export interface A2AClientBuildOptions {
  /** 网关访问 cookie 复用（WorkBuddy sharecode 通道）。 */
  cookieJar?: import("../a2a/access/gateway-cookie-jar.js").GatewayCookieJar;
  bearerToken?: string;
  /** 出站 HTTP Message Signature（RFC 9421）签名器；WorkBuddy 路径的业务认证。 */
  signer?: import("../a2a/client/types.js").A2AOutboundSigner;
  /** WorkBuddy 适配：实际发送地址（签名仍覆盖 endpoint）。 */
  sendUrl?: string;
  allowPrivateRanges?: boolean;
  skipDnsCheck?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 构造 A2A client（可选中认证/SSRF 逃生门）。 */
export function buildA2AClient(endpoint: string, opts: A2AClientBuildOptions): A2AClient {
  return new A2AClient({
    url: endpoint,
    ...(opts.signer !== undefined ? { signer: opts.signer } : {}),
    ...(opts.cookieJar !== undefined ? { cookieJar: opts.cookieJar } : {}),
    ...(opts.sendUrl !== undefined ? { sendUrl: opts.sendUrl } : {}),
    timeoutMs: opts.timeoutMs,
    allowPrivateRanges: opts.allowPrivateRanges,
    skipDnsCheck: opts.skipDnsCheck,
    ...(opts.bearerToken !== undefined && opts.bearerToken !== ""
      ? { headers: { authorization: `Bearer ${opts.bearerToken}` } }
      : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

/**
 * 解析 agent card 的 JSONRPC 端点。
 *
 * A2AClient POST 到 binding 端点（a2aPath），不能直接打 `.well-known/agent-card.json`
 * （server 对 card 路径的 POST 返回 404）。取 supportedInterfaces 中
 * protocolBinding=JSONRPC 的 url，回退 card.url；拒绝非 http(s)。
 */
/**
 * agent card 解析失败：携带远端 HTTP 状态（若有），供上层区分"平台门禁拒绝"
 * 与"商家不可达"。`httpStatus` 是诊断分类用，不反射响应体。
 */
export class A2AEndpointResolutionError extends Error {
  readonly httpStatus?: number;

  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = "A2AEndpointResolutionError";
    this.httpStatus = httpStatus;
  }
}

export async function resolveA2aEndpoint(
  fetchImpl: typeof fetch,
  agentCardUrl: string,
  timeoutMs: number,
  /**
   * 可选：把 card URL 映射成实际发送地址（WorkBuddy 网关要求带分享参数）。
   * 只影响 GET card 的发送地址；返回的端点仍是**不带码**的签名地址。
   */
  decorateUrl?: (url: string) => string,
): Promise<string> {
  const wireUrl = decorateUrl === undefined ? agentCardUrl : decorateUrl(agentCardUrl);
  const res = await fetchImpl(wireUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    // 与其它出站一致：绝不跟随重定向（3xx 可能把分享参数转发给第三方）。
    redirect: "manual",
  });
  if (!res.ok) throw new A2AEndpointResolutionError(`agent card HTTP ${res.status}`, res.status);
  const card = (await res.json()) as Partial<AgentCard>;
  const jsonrpc =
    card.supportedInterfaces?.find((si) => si.protocolBinding === "JSONRPC")?.url ?? card.url;
  if (typeof jsonrpc !== "string" || jsonrpc === "") {
    throw new A2AEndpointResolutionError("agent card has no JSONRPC endpoint");
  }
  const parsed = new URL(jsonrpc);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new A2AEndpointResolutionError(`unsupported endpoint scheme ${parsed.protocol}`);
  }
  return jsonrpc;
}
