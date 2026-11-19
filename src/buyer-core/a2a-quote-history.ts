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
 * 面向指定商家的已签名报价历史查询（买家识别与交易回执 · K2，设计 §2.4）。
 *
 * “沿用上次规格”的前置步骤：先解析目标商家，再按本店授权查上次已发报价。
 * 通过已签名的 A2A SendMessage 承载双方显式支持的查询扩展：
 * - 请求：KNP `inquiry` + `subject.kiwi_history_query`（版本化扩展），
 *   委托声明在 message metadata（请求体签名覆盖）。
 * - 响应：`clarification_response` envelope（摘要）+ data part
 *   `kiwi_quote_history`（结构化候选及来源）。
 *
 * 失败语义（设计红线）：扩展不被支持 / 未授权 / 无记录 → 返回
 * `unavailable`，调用方退回澄清——绝不能把目录第一项、搜索词或历史报价
 * 当作本次选择。唯一匹配才可用于生成正式 RFQ（本次数量）。
 */

import type { A2ATask } from "../a2a/client/types.js";
import { finalizeEnvelope, validateWireEnvelope, type NegotiationEnvelope } from "../negotiation/domain/envelope.js";
import { newExchangeId, newMessageId, newNegotiationId } from "../negotiation/domain/identifiers.js";
import { NEGOTIATE_CAPABILITY } from "../a2a/negotiate.js";
import { extractKnpEnvelope } from "./a2a-knp.js";

/** 买方委托声明（随请求体签名覆盖的 message metadata 发送）。 */
export interface DelegationMetadata {
  type: "kiwi.quote-history-delegation";
  version: number;
  merchant_id: string;
  purpose: "quote_history";
  delegation_id: string;
  issued_at: string;
  expires_at: string;
  buyer_agent_id?: string;
  [key: string]: unknown;
}

export interface QuoteHistoryDelegationOptions {
  merchantIds?: string[];
  ttlDays?: number;
  buyerAgentId?: string;
  /** Increase only for a newly authorized delegation. */
  version?: number;
}

export function quoteHistoryDelegationFromEnv(env: Record<string, string | undefined>): QuoteHistoryDelegationOptions | undefined {
  if (env.KIWI_QUOTE_HISTORY_DELEGATION !== "true") return undefined;
  const configuredVersion = env.KIWI_QUOTE_HISTORY_DELEGATION_VERSION;
  if (configuredVersion === undefined) return {};
  const version = Number(configuredVersion);
  if (!/^[1-9][0-9]*$/.test(configuredVersion) || !Number.isSafeInteger(version)) {
    throw new Error("KIWI_QUOTE_HISTORY_DELEGATION_VERSION must be a positive safe integer");
  }
  return { version };
}

/** 每任务稳定的委托派生输入（重试恒定；任务变化才变化）。 */
export function buildDelegationMetadata(input: {
  merchantId: string;
  buyerAgentId?: string;
  issuedAt: string;
  ttlDays?: number;
  version?: number;
  now: () => string;
}): DelegationMetadata {
  const ttlDays = input.ttlDays ?? 90;
  const version = input.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("invalid quote history delegation version");
  const issuedMs = Date.parse(input.issuedAt);
  const issuedAt = Number.isFinite(issuedMs) ? new Date(issuedMs).toISOString() : input.now();
  const expiresMs = (Number.isFinite(issuedMs) ? issuedMs : Date.parse(input.now())) + ttlDays * 86_400_000;
  return {
    type: "kiwi.quote-history-delegation",
    version,
    merchant_id: input.merchantId,
    purpose: "quote_history",
    delegation_id: `deleg-${input.merchantId}`,
    issued_at: issuedAt,
    expires_at: new Date(expiresMs).toISOString(),
    ...(input.buyerAgentId !== undefined && input.buyerAgentId !== ""
      ? { buyer_agent_id: input.buyerAgentId }
      : {}),
  };
}

export interface QuoteHistoryCandidate {
  negotiation_id: string;
  offer_id: string;
  offer_version: number;
  sku: string;
  quantity: number;
  unit: string;
  price: { currency: string; amount_minor: number };
  terms_digest: string;
  spec: Record<string, unknown>;
  quoted_at: string;
  valid_until?: string;
}

export type QuoteHistoryResult =
  | { status: "ok"; candidates: QuoteHistoryCandidate[] }
  /** 未授权/扩展不支持/商家未回应/响应形状不符——退回澄清，不猜。 */
  | { status: "unavailable"; reason: string };

/** 构造历史查询 envelope（KNP inquiry + 版本化 subject 扩展）。 */
export function buildHistoryQueryEnvelope(input: {
  negotiationId?: string;
  skus?: string[];
  limit?: number;
  now: () => string;
}): NegotiationEnvelope {
  return finalizeEnvelope({
    capability: NEGOTIATE_CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: input.negotiationId ?? newNegotiationId(),
    exchange_id: newExchangeId(),
    message_id: newMessageId(),
    actor: "buyer",
    action: "inquiry",
    created_at: input.now(),
    payload: {
      type: "inquiry",
      subject: {
        kiwi_history_query: {
          version: 1,
          ...(input.skus !== undefined && input.skus.length > 0 ? { skus: input.skus } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        },
      },
    },
  });
}

/** 从回复 task 解析结构化历史（clarification_response envelope + 数据 part）。 */
export function parseHistoryReply(task: A2ATask | null | undefined, request: NegotiationEnvelope): QuoteHistoryResult {
  if (task === undefined || task === null) {
    return { status: "unavailable", reason: "no_reply" };
  }
  let envelope: NegotiationEnvelope;
  try {
    const wire = extractKnpEnvelope(task, request);
    if (wire === null) return { status: "unavailable", reason: "no_envelope" };
    envelope = validateWireEnvelope(wire as unknown as Record<string, unknown>);
  } catch {
    return { status: "unavailable", reason: "reply_envelope_invalid" };
  }
  if (envelope.action !== "clarification_response" || envelope.actor !== "merchant") {
    return { status: "unavailable", reason: "reply_action_mismatch" };
  }
  const message = task.status?.message;
  if (message === undefined) return { status: "unavailable", reason: "no_message" };
  for (const part of message.parts) {
    if (part.kind !== "data") continue;
    const data = part.data;
    if (data === null || typeof data !== "object") continue;
    const candidate = data as Record<string, unknown>;
    if (candidate["type"] !== "kiwi_quote_history") continue;
    if (candidate["version"] !== 1) return { status: "unavailable", reason: "history_version_unsupported" };
    const hits = candidate["hits"];
    if (!Array.isArray(hits)) return { status: "unavailable", reason: "history_hits_invalid" };
    const parsed: QuoteHistoryCandidate[] = [];
    for (const hit of hits) {
      if (hit === null || typeof hit !== "object") continue;
      const entry = hit as Record<string, unknown>;
      const price = entry["price"];
      if (
        typeof entry["sku"] !== "string" ||
        typeof entry["offer_id"] !== "string" ||
        typeof entry["negotiation_id"] !== "string" ||
        price === null || typeof price !== "object" ||
        typeof (price as Record<string, unknown>)["currency"] !== "string" ||
        typeof (price as Record<string, unknown>)["amount_minor"] !== "number"
      ) {
        continue;
      }
      parsed.push({
        negotiation_id: entry["negotiation_id"] as string,
        offer_id: entry["offer_id"] as string,
        offer_version: typeof entry["offer_version"] === "number" ? entry["offer_version"] : 0,
        sku: entry["sku"] as string,
        quantity: typeof entry["quantity"] === "number" ? entry["quantity"] : 0,
        unit: typeof entry["unit"] === "string" ? entry["unit"] : "piece",
        price: {
          currency: (price as Record<string, unknown>)["currency"] as string,
          amount_minor: (price as Record<string, unknown>)["amount_minor"] as number,
        },
        terms_digest: typeof entry["terms_digest"] === "string" ? entry["terms_digest"] : "",
        spec:
          entry["spec"] !== null && typeof entry["spec"] === "object" && !Array.isArray(entry["spec"])
            ? (entry["spec"] as Record<string, unknown>)
            : {},
        quoted_at: typeof entry["quoted_at"] === "string" ? entry["quoted_at"] : "",
        ...(typeof entry["valid_until"] === "string" ? { valid_until: entry["valid_until"] as string } : {}),
      });
    }
    return { status: "ok", candidates: parsed };
  }
  return { status: "unavailable", reason: "history_data_part_missing" };
}
