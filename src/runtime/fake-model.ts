/**
 * Deterministic fake models — no network, no keys, fully reproducible.
 *
 * Two flavors:
 * - createScriptedFakeStreamFn: replays canned assistant messages (tests).
 * - createDeterministicStreamFn: tiny rule-based buyer/merchant "models"
 *   used by profiles with model.provider=fake. They read the snapshot from
 *   the tool result and produce a deterministic decision, enabling offline
 *   smoke runs of the full single-turn vertical slice for both roles.
 */

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import type { AgentProfile } from "../config/profile.js";
import {
  PROTOCOL_VERSION,
  type NegotiationDecision,
  type NegotiationSnapshot,
} from "../negotiation/types.js";
import { TOOL_GET_SNAPSHOT, TOOL_SUBMIT_DECISION } from "./tools.js";

export interface ScriptedFake {
  streamFn: StreamFn;
  handle: FauxProviderHandle;
}

/** Replay canned responses in order. Used by tests. */
export function createScriptedFakeStreamFn(responses: FauxResponseStep[]): ScriptedFake {
  const handle = fauxProvider({ models: [{ id: "fake-model", name: "fake-model" }] });
  handle.setResponses(responses);
  const streamFn: StreamFn = (model, context, options) =>
    handle.provider.streamSimple(model, context, options);
  return { streamFn, handle };
}

/** Extract the latest tool result text for a tool from the LLM context. */
function latestToolResultText(context: Context, toolName: string): string | undefined {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i];
    if (m && m.role === "toolResult" && m.toolName === toolName) {
      const first = m.content[0];
      if (first && first.type === "text") return first.text;
    }
  }
  return undefined;
}

/** Build the deterministic decision from a snapshot. Pure function. */
export function deterministicMerchantDecision(
  snapshot: NegotiationSnapshot,
  quoteTtlSeconds: number,
): NegotiationDecision {
  const p = snapshot.product;
  const buyerText = snapshot.messages
    .filter((m) => m.sender_role === "buyer")
    .map((m) => m.public_message)
    .join("\n");
  const qtyMatch = /(\d+)\s*(?:件|个|只|x\b)/i.exec(buyerText);
  const quantity = Math.min(Math.max(Number(qtyMatch?.[1] ?? 1), 1), snapshot.stock.quantity || 1);
  const validUntil = new Date(
    Date.parse(snapshot.stock.observed_at) + quoteTtlSeconds * 1000,
  ).toISOString();

  if (snapshot.stock.status === "out_of_stock") {
    return {
      protocol_version: PROTOCOL_VERSION,
      conversation_id: snapshot.conversation.id,
      in_reply_to_message_id: snapshot.in_reply_to_message_id,
      action: "decline",
      open_issues: ["out_of_stock"],
      public_message: "抱歉，该商品当前缺货，无法报价。",
      confidence: 0.99,
      reason_codes: ["out_of_stock"],
      request_human_review: false,
    };
  }

  return {
    protocol_version: PROTOCOL_VERSION,
    conversation_id: snapshot.conversation.id,
    in_reply_to_message_id: snapshot.in_reply_to_message_id,
    action: "counter",
    proposal: {
      sku: p.sku,
      quantity,
      unit_price: p.list_price,
      currency: p.currency,
      stock: {
        status: snapshot.stock.status,
        quantity: snapshot.stock.quantity,
        observed_at: snapshot.stock.observed_at,
        reserved: false,
      },
      delivery: {
        eta_start: snapshot.delivery.eta_start,
        eta_end: snapshot.delivery.eta_end,
        fee: snapshot.delivery.fee,
      },
      after_sales_policy_refs: snapshot.after_sales_policies.map((pol) => pol.ref),
      valid_until: validUntil,
    },
    open_issues: [...snapshot.open_issues],
    public_message: `可以按单价 ${p.list_price} ${p.currency} 提供 ${quantity} 件，报价 ${quoteTtlSeconds} 秒内有效。`,
    confidence: 0.9,
    reason_codes: ["within_policy", "inventory_observed"],
    request_human_review: false,
  };
}

/**
 * Rule-based fake merchant model for offline smoke runs. First call fetches
 * the snapshot; second call submits a deterministic decision derived from it.
 */
export function createDeterministicMerchantStreamFn(profile: AgentProfile): StreamFn {
  const handle = fauxProvider({
    models: [{ id: "fake-merchant-model", name: "fake-merchant-model" }],
  });
  const quoteTtl = profile.merchant_policy?.quote_ttl_seconds ?? 300;

  handle.setResponses([
    (context: Context) => {
      const snapshotText = latestToolResultText(context, TOOL_GET_SNAPSHOT);
      if (snapshotText === undefined) {
        return fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]);
      }
      const snapshot = JSON.parse(snapshotText) as NegotiationSnapshot;
      const decision = deterministicMerchantDecision(snapshot, quoteTtl);
      return fauxAssistantMessage([fauxToolCall(TOOL_SUBMIT_DECISION, { ...decision })]);
    },
    // Safety net if the first response was consumed by a retry.
    (context: Context) => {
      const snapshotText = latestToolResultText(context, TOOL_GET_SNAPSHOT);
      if (snapshotText === undefined) {
        return fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]);
      }
      const snapshot = JSON.parse(snapshotText) as NegotiationSnapshot;
      const decision = deterministicMerchantDecision(snapshot, quoteTtl);
      return fauxAssistantMessage([fauxToolCall(TOOL_SUBMIT_DECISION, { ...decision })]);
    },
  ]);

  return (model, context, options) => handle.provider.streamSimple(model, context, options);
}

/** Build the deterministic buyer decision from a snapshot. Pure function. */
export function deterministicBuyerDecision(
  snapshot: NegotiationSnapshot,
  policy: {
    max_total_price_private: number;
    acceptable_eta_latest: string;
    required_after_sales_terms: string[];
  },
): NegotiationDecision {
  const base = {
    protocol_version: PROTOCOL_VERSION,
    conversation_id: snapshot.conversation.id,
    in_reply_to_message_id: snapshot.in_reply_to_message_id,
  } as const;

  const proposal = snapshot.current_proposal;
  if (!proposal) {
    return {
      ...base,
      action: "ask",
      open_issues: ["no_proposal"],
      public_message: "请提供包含价格、配送与售后条款的完整报价。",
      confidence: 0.8,
      reason_codes: ["no_proposal"],
      request_human_review: false,
    };
  }

  const total = proposal.unit_price * proposal.quantity + proposal.delivery.fee;
  const etaOk = Date.parse(proposal.delivery.eta_end) <= Date.parse(policy.acceptable_eta_latest);
  const refs = new Set(proposal.after_sales_policy_refs);
  const termsOk = policy.required_after_sales_terms.every((t) => refs.has(t));
  if (total <= policy.max_total_price_private && etaOk && termsOk) {
    return {
      ...base,
      action: "accept_nonbinding",
      proposal,
      open_issues: [],
      public_message: "接受该报价，双方达成非约束性共识。",
      confidence: 0.9,
      reason_codes: ["within_policy"],
      request_human_review: false,
    };
  }

  // The offer does not fit the private constraints. Never reveal why in
  // numeric terms — escalate to a human instead of leaking the budget.
  return {
    ...base,
    action: "escalate",
    open_issues: ["offer_outside_constraints"],
    public_message: "该报价需要人工确认后才能继续。",
    confidence: 0.7,
    reason_codes: ["human_review"],
    request_human_review: true,
  };
}

/**
 * Rule-based fake buyer model for offline smoke runs. Reads the snapshot,
 * then deterministically accepts an acceptable offer or escalates.
 */
export function createDeterministicBuyerStreamFn(profile: AgentProfile): StreamFn {
  const handle = fauxProvider({
    models: [{ id: "fake-buyer-model", name: "fake-buyer-model" }],
  });
  const policy = profile.buyer_policy ?? {
    max_total_price_private: Number.POSITIVE_INFINITY,
    acceptable_eta_latest: "9999-12-31T23:59:59Z",
    required_after_sales_terms: [],
  };

  const respond = (context: Context) => {
    const snapshotText = latestToolResultText(context, TOOL_GET_SNAPSHOT);
    if (snapshotText === undefined) {
      return fauxAssistantMessage([fauxToolCall(TOOL_GET_SNAPSHOT, {})]);
    }
    const snapshot = JSON.parse(snapshotText) as NegotiationSnapshot;
    const decision = deterministicBuyerDecision(snapshot, policy);
    return fauxAssistantMessage([fauxToolCall(TOOL_SUBMIT_DECISION, { ...decision })]);
  };
  // Second entry is a safety net if the first response was consumed by a retry.
  handle.setResponses([respond, respond]);

  return (model, context, options) => handle.provider.streamSimple(model, context, options);
}

/** Role-dispatching deterministic fake: merchant or buyer, driven by the profile. */
export function createDeterministicStreamFn(profile: AgentProfile): StreamFn {
  return profile.role === "buyer"
    ? createDeterministicBuyerStreamFn(profile)
    : createDeterministicMerchantStreamFn(profile);
}
