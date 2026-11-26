/** Copyright 2026 harrylabsj; SPDX-License-Identifier: Apache-2.0 */
import type { A2AClient } from "../a2a/client/client.js";
import { finalizeEnvelope } from "../negotiation/domain/envelope.js";
import { newExchangeId, newMessageId, newNegotiationId } from "../negotiation/domain/identifiers.js";

export interface BuyerFollowupView {
  case_ref: string;
  sku: string;
  topic: string;
  status: "pending" | "in_progress" | "answered" | "closed_without_answer" | "expired";
  answer?: string;
  as_of: string;
}

/** 使用原商家连接与原买家签名身份；回执不是承载权限的令牌。 */
export async function readBuyerFollowup(
  client: Pick<A2AClient, "sendMessage">,
  original: { case_ref: string; negotiation_id: string },
  now: () => string = () => new Date().toISOString(),
): Promise<BuyerFollowupView | undefined> {
  if (!/^qa_[a-f0-9]{32}$/u.test(original.case_ref) || original.negotiation_id.length === 0 || original.negotiation_id.length > 240) return undefined;
  const envelope = finalizeEnvelope({
    protocol_version: "1.0", capability: "com.harrylabsj.kiwi.shopping.negotiation",
    negotiation_id: newNegotiationId(), exchange_id: newExchangeId(), message_id: newMessageId(),
    actor: "buyer", action: "inquiry", created_at: now(),
    payload: { type: "inquiry", subject: { kiwi_buyer_followup: { version: 1, case_ref: original.case_ref, negotiation_id: original.negotiation_id } } },
  });
  const task = await client.sendMessage({ role: "user", messageId: envelope.message_id, parts: [{ kind: "data", data: { knp_envelope: envelope } }] });
  const parts = task.artifacts?.flatMap((artifact) => artifact.parts)
    .filter((part) => part.kind === "data" && part.data.type === "kiwi_buyer_followup") ?? [];
  const part = parts[0];
  if (parts.length !== 1 || part?.kind !== "data") return undefined;
  const data = part.data;
  if (data.version !== 1 || data.case_ref !== original.case_ref || typeof data.sku !== "string" || typeof data.topic !== "string" ||
      typeof data.as_of !== "string" || !Number.isFinite(Date.parse(data.as_of))) return undefined;
  const state = data.status;
  if (state !== "pending" && state !== "in_progress" && state !== "answered" && state !== "closed_without_answer" && state !== "expired") return undefined;
  if (state === "answered" ? typeof data.answer !== "string" || data.answer.length === 0 || data.answer.length > 600 : data.answer !== undefined) return undefined;
  return { case_ref: original.case_ref, sku: data.sku, topic: data.topic, status: state, as_of: data.as_of,
    ...(typeof data.answer === "string" ? { answer: data.answer } : {}) };
}
