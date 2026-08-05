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

/**
 * Structured influence of applied operator strategy directives on candidate
 * generation (docs/operator-tui-v0.2.md §7). Compiled by the operator runner
 * from the session's directive list; never widens HardPolicy by itself — the
 * authoritative policy gates still run on the profile at submit time.
 */
export interface DecisionHints {
  /** Effective buyer budget ceiling (last budget directive, else profile). */
  buyer_max_total_price?: number;
  /** Effective merchant floor (last floor directive, else profile). */
  merchant_min_unit_price?: number;
  /** Quantity cap ("最多买 N 件"). */
  quantity_cap?: number;
  /** Buyer target unit price: counter toward this before accepting ("砍到 100"). */
  buyer_target_unit_price?: number;
  /** Prefer free shipping: counter with fee 0 before accepting. */
  prefer_free_shipping?: boolean;
  /** This turn only asks; never accept or counter with a price. */
  ask_only?: boolean;
}

/** Build the deterministic decision from a snapshot. Pure function. */
export function deterministicMerchantDecision(
  snapshot: NegotiationSnapshot,
  quoteTtlSeconds: number,
  hints: DecisionHints = {},
): NegotiationDecision {
  const p = snapshot.product;
  const buyerText = snapshot.messages
    .filter((m) => m.sender_role === "buyer")
    .map((m) => m.public_message)
    .join("\n");
  const qtyMatch = /(\d+)\s*(?:件|个|只|x\b)/i.exec(buyerText);
  const quantity = Math.min(
    Math.max(Number(qtyMatch?.[1] ?? 1), 1),
    snapshot.stock.quantity || 1,
    hints.quantity_cap ?? Number.POSITIVE_INFINITY,
  );
  const validUntil = new Date(
    Date.parse(snapshot.stock.observed_at) + quoteTtlSeconds * 1000,
  ).toISOString();
  // A floor directive above the list price raises the quote; at or below it
  // the list price already satisfies the floor, so the quote is unchanged.
  const unitPrice =
    hints.merchant_min_unit_price !== undefined && hints.merchant_min_unit_price > p.list_price
      ? hints.merchant_min_unit_price
      : p.list_price;

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

  // Convergence: accept the buyer's latest counter when it meets the merchant
  // floor — otherwise the merchant would re-quote the list price forever and
  // the autonomous negotiation never closes.
  const floor = hints.merchant_min_unit_price;
  const buyerProposal = snapshot.current_proposal;
  if (floor !== undefined && buyerProposal !== null && buyerProposal !== undefined && buyerProposal.unit_price >= floor) {
    return {
      protocol_version: PROTOCOL_VERSION,
      conversation_id: snapshot.conversation.id,
      in_reply_to_message_id: snapshot.in_reply_to_message_id,
      action: "accept_nonbinding",
      proposal: buyerProposal,
      open_issues: [...snapshot.open_issues],
      public_message: "接受该报价，双方达成非约束性共识。",
      confidence: 0.9,
      reason_codes: ["within_policy", "consensus"],
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
      unit_price: unitPrice,
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
    public_message: `可以按单价 ${unitPrice} ${p.currency} 提供 ${quantity} 件，报价 ${quoteTtlSeconds} 秒内有效。`,
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
  hints: DecisionHints = {},
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

  // Turn-scoped ask-only directive: this turn asks, never accepts or counters
  // with a price (design §7.3 example: "这一轮只问交期，不接受报价").
  if (hints.ask_only) {
    return {
      ...base,
      action: "ask",
      open_issues: ["turn_ask_only"],
      public_message: "请先确认交付时间与售后条款。",
      confidence: 0.8,
      reason_codes: ["turn_ask_only"],
      request_human_review: false,
    };
  }

  // A quantity cap ("最多买 N 件") re-scopes the check to the capped size.
  const capped =
    hints.quantity_cap !== undefined && proposal.quantity > hints.quantity_cap
      ? { ...proposal, quantity: hints.quantity_cap }
      : proposal;
  const total = capped.unit_price * capped.quantity + capped.delivery.fee;
  const maxTotal = hints.buyer_max_total_price ?? policy.max_total_price_private;
  const etaOk = Date.parse(proposal.delivery.eta_end) <= Date.parse(policy.acceptable_eta_latest);
  const refs = new Set(proposal.after_sales_policy_refs);
  const termsOk = policy.required_after_sales_terms.every((t) => refs.has(t));
  if (total > maxTotal || !etaOk || !termsOk) {
    // The offer does not fit the constraints. Never reveal why in numeric
    // terms — escalate to a human instead of leaking the budget.
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

  // Counter toward the buyer's target unit price ("砍到 100"): if the offer
  // is above the target, push back at the target, bounded by what the budget
  // allows per unit. Never reveal the private budget in numeric terms.
  const targetPrice = hints.buyer_target_unit_price;
  if (targetPrice !== undefined && proposal.unit_price > targetPrice) {
    const affordable = maxTotal / capped.quantity;
    const counterPrice = Math.min(targetPrice, affordable);
    if (counterPrice < proposal.unit_price) {
      return {
        ...base,
        action: "counter",
        proposal: { ...capped, unit_price: counterPrice },
        open_issues: [...snapshot.open_issues],
        public_message: `单价 ${counterPrice} ${proposal.currency}（${capped.quantity} 件）我可以接受，请确认。`,
        confidence: 0.9,
        reason_codes: ["within_policy", "target_price"],
        request_human_review: false,
      };
    }
  }

  // Soft preference: fight for free shipping before accepting a fee-bearing
  // offer ("先争取包邮").
  if (hints.prefer_free_shipping && proposal.delivery.fee > 0) {
    return {
      ...base,
      action: "counter",
      proposal: { ...proposal, delivery: { ...proposal.delivery, fee: 0 } },
      open_issues: [...snapshot.open_issues],
      public_message: "如果免运费（包邮），我可以接受当前报价。",
      confidence: 0.8,
      reason_codes: ["within_policy", "shipping_discussed"],
      request_human_review: false,
    };
  }

  // Quantity cap: accept at most the capped quantity.
  if (capped !== proposal) {
    return {
      ...base,
      action: "counter",
      proposal: capped,
      open_issues: [...snapshot.open_issues],
      public_message: `按 ${hints.quantity_cap} 件以内我可以接受，请确认。`,
      confidence: 0.8,
      reason_codes: ["within_policy", "quantity_capped"],
      request_human_review: false,
    };
  }

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
