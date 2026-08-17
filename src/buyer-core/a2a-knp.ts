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
            quantity: { value: input.quantity, unit: "piece" },
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
export function extractKnpEnvelope(task: A2ATask | null | undefined): NegotiationEnvelope | null {
  const message = task?.status?.message;
  if (message === undefined) return null;
  for (const part of message.parts) {
    if (part.kind === "data") {
      const data = part.data;
      if (data !== null && typeof data === "object" && data["knp_envelope"] !== undefined) {
        return data["knp_envelope"] as NegotiationEnvelope;
      }
    }
  }
  return null;
}

export interface A2AClientBuildOptions {
  bearerToken?: string;
  allowPrivateRanges?: boolean;
  skipDnsCheck?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 构造 A2A client（可选中认证/SSRF 逃生门）。 */
export function buildA2AClient(endpoint: string, opts: A2AClientBuildOptions): A2AClient {
  return new A2AClient({
    url: endpoint,
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
export async function resolveA2aEndpoint(
  fetchImpl: typeof fetch,
  agentCardUrl: string,
  timeoutMs: number,
): Promise<string> {
  const res = await fetchImpl(agentCardUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`agent card HTTP ${res.status}`);
  const card = (await res.json()) as Partial<AgentCard>;
  const jsonrpc =
    card.supportedInterfaces?.find((si) => si.protocolBinding === "JSONRPC")?.url ?? card.url;
  if (typeof jsonrpc !== "string" || jsonrpc === "") {
    throw new Error("agent card has no JSONRPC endpoint");
  }
  const parsed = new URL(jsonrpc);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`unsupported endpoint scheme ${parsed.protocol}`);
  }
  return jsonrpc;
}
