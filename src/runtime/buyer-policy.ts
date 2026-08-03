/**
 * Buyer-side LOCAL private policy gate (design §7.2, §16.3).
 *
 * The buyer's private budget lives only in the Kiwi profile; the marketplace
 * never sees it and never checks it (shopping-cli's buyer gate is structural
 * only). This module enforces the private policy inside the submit tool,
 * BEFORE anything reaches the gateway:
 *
 * - proposal total (unit_price * quantity + delivery fee) must not exceed
 *   max_total_price_private;
 * - proposal delivery eta_end must not be later than acceptable_eta_latest;
 * - every required_after_sales_terms entry must be referenced by the
 *   accepted/issued proposal;
 * - public_message must not leak the private budget: explicit budget talk
 *   ("我的预算" / "最高预算" / "内部预算" / "budget" …) is rejected locally.
 *   A plain quote that happens to equal the budget is fine — the number
 *   alone is not a leak; calling it a budget is.
 *
 * Privacy invariant: rejection reasons NEVER contain the private threshold
 * value. The value is not logged, not sent to the gateway, and not echoed
 * back to the model.
 */

import type { BuyerPolicy } from "../config/profile.js";
import type { NegotiationDecision, PolicyResult } from "../negotiation/types.js";
import { PROTOCOL_VERSION } from "../negotiation/types.js";

export interface BuyerPolicyViolation {
  reason_codes: string[];
  /** Safe to show the model and to log: never contains private numbers. */
  public_reason: string;
}

/**
 * Budget-threshold wording. A public message using these phrases is treated
 * as leaking the private budget regardless of whether a number appears.
 */
const BUDGET_LEAK_PATTERN =
  /(我的|最高|最大|内部|私有|心里)?预算|预算上限|budget|price\s*ceiling|max(imum)?\s*budget/i;

/** Total price of a proposal: goods plus delivery fee. */
export function proposalTotal(decision: NegotiationDecision): number | undefined {
  const p = decision.proposal;
  if (!p) return undefined;
  return p.unit_price * p.quantity + p.delivery.fee;
}

/**
 * Check a decision against the local buyer policy. Returns undefined when
 * the decision may go to the gateway, or a violation describing the first
 * problem found (without any private values).
 */
export function checkBuyerLocalPolicy(
  decision: NegotiationDecision,
  policy: BuyerPolicy,
): BuyerPolicyViolation | undefined {
  // 1. Private-budget leak scan applies to every action with public text.
  if (BUDGET_LEAK_PATTERN.test(decision.public_message)) {
    return {
      reason_codes: ["local_budget_leak"],
      public_reason:
        "公开文本出现预算类措辞，可能泄露私有预算约束。请删除任何关于预算/上限的表述后重试。",
    };
  }

  const proposal = decision.proposal;
  if (!proposal) return undefined;

  // 2. Private budget: total price must fit the private maximum.
  const total = proposalTotal(decision);
  if (total !== undefined && total > policy.max_total_price_private) {
    return {
      reason_codes: ["local_budget_exceeded"],
      public_reason:
        "该报价总价超出你的私有预算约束。请还价、放弃（decline）或转人工（escalate），不要透露预算数值。",
    };
  }

  // 3. Delivery ETA must be acceptable.
  const etaEnd = Date.parse(proposal.delivery.eta_end);
  const latest = Date.parse(policy.acceptable_eta_latest);
  if (!Number.isNaN(etaEnd) && !Number.isNaN(latest) && etaEnd > latest) {
    return {
      reason_codes: ["local_eta_violation"],
      public_reason:
        "该报价的配送预计送达时间晚于你可接受的最晚时间。请要求更快的配送、放弃或转人工。",
    };
  }

  // 4. Required after-sales terms must all be referenced.
  const refs = new Set(proposal.after_sales_policy_refs);
  const missing = policy.required_after_sales_terms.filter((term) => !refs.has(term));
  if (missing.length > 0) {
    return {
      reason_codes: ["local_missing_after_sales_terms"],
      public_reason: `该报价缺少必需的售后条款: ${missing.join(", ")}。请要求对方加入这些条款、放弃或转人工。`,
    };
  }

  return undefined;
}

/**
 * Build the local policy_result for a violated decision. Shaped like the
 * frozen PolicyResult so the agent loop can handle it uniformly; it is
 * produced locally and never touches the gateway.
 */
export function localBuyerPolicyResult(
  conversationId: string,
  violation: BuyerPolicyViolation,
  retriesRemaining: number,
): PolicyResult {
  return {
    protocol_version: PROTOCOL_VERSION,
    result: "rejected_retryable",
    conversation_id: conversationId,
    next_actor: "buyer",
    reason_codes: violation.reason_codes,
    public_reason: violation.public_reason,
    retries_remaining: Math.max(0, retriesRemaining),
  };
}
