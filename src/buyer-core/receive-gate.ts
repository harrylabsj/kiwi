/** Buyer commercial admission, bound to the actual persisted outbound wire. */
import type { NegotiationEnvelope } from "../negotiation/domain/envelope.js";
import type { LineItem, TermSet } from "../negotiation/domain/common.js";
import { contentDigest } from "../negotiation/jcs.js";
import { McpError } from "./errors.js";

export type BuyerReplyFailureCode =
  | "wire_invalid"
  | "clock_invalid"
  | "unsupported_reply"
  | "unsupported_offer_shape"
  | "sku_mismatch"
  | "quantity_mismatch"
  | "unit_unmapped"
  | "price_invalid"
  | "offer_expired"
  | "proposal_ref_mismatch"
  | "accept_binding_mismatch";

/** A receipt/reply is confirmed; rejection does not claim the remote write failed. */
export class BuyerReplyRejected extends McpError {
  constructor(readonly reason: BuyerReplyFailureCode) {
    super("contract_violation", `merchant reply was not adopted: ${reason}`, {
      reply_rejected: reason,
      reconciliation_required: true,
      remote_execution_status: "not_inferred",
    });
  }
}

function reject(reason: BuyerReplyFailureCode): never {
  throw new BuyerReplyRejected(reason);
}

function supportedItem(terms: TermSet): LineItem {
  // The current adapters send/project one requested line. Do not silently
  // consume another line or a conditional branch as that single quote.
  if (terms.items?.length !== 1) reject("unsupported_offer_shape");
  return terms.items[0]!;
}

function checkTerms(terms: TermSet, requested: LineItem, nowMs: number): void {
  const item = supportedItem(terms);
  if (item.sku !== requested.sku) reject("sku_mismatch");
  if (item.quantity.value !== requested.quantity.value) reject("quantity_mismatch");
  // No authoritative conversion/synonym mapping exists for these units.
  if (item.quantity.unit !== requested.quantity.unit) reject("unit_unmapped");
  const price = item.unit_price;
  if (!price || !Number.isSafeInteger(price.amount_minor) || price.amount_minor < 0)
    reject("price_invalid");
  const declaredCurrency = (terms as TermSet & { currency?: unknown }).currency;
  if (declaredCurrency !== undefined && declaredCurrency !== price.currency) reject("price_invalid");
  const total = (terms as TermSet & { total_price?: { currency?: unknown; amount_minor?: unknown } }).total_price;
  if (total !== undefined && (!total || total.currency !== price.currency ||
      typeof total.amount_minor !== "number" || !Number.isSafeInteger(total.amount_minor) || total.amount_minor < 0))
    reject("price_invalid");
  if (total === undefined && !Number.isSafeInteger(price.amount_minor * item.quantity.value))
    reject("unsupported_offer_shape");
  // KNP permits an absent valid_until and a zero price. An actual deadline,
  // however, must be parseable and is expired at equality, also after restart.
  if (terms.valid_until !== undefined && (!Number.isFinite(Date.parse(terms.valid_until)) ||
      Date.parse(terms.valid_until) <= nowMs)) reject("offer_expired");
}

/** Raw schema/digest/actor/capability/reply binding must already have passed. */
export function assertBuyerReplySemantics(
  reply: NegotiationEnvelope,
  wire: NegotiationEnvelope,
  now: () => string,
): void {
  const nowMs = Date.parse(now());
  if (!Number.isFinite(nowMs)) reject("clock_invalid");
  const outbound = wire.payload;
  const requested = outbound.type === "rfq"
    ? (outbound.items.length === 1 ? outbound.items[0] : undefined)
    : outbound.type === "counter_offer" ? supportedItem(outbound.proposed_terms) : undefined;
  if (!requested) reject("unsupported_offer_shape");
  const payload = reply.payload;
  if (payload.type === "conditional_offer") {
    // A659 经理裁定：兼容既有 KNP 合法形状——`conditions` 恰为**空数组**
    // （§13：空 conditions 等价 base_terms；真实 merchant 对还价的固定应答
    // 形状，probe-3 merchant-ledger 实证）。绑定完整性：必须响应 buyer 已
    // 外发 counter 的 offer_id（RFQ 不是活跃 offer，conditional 不得引用）；
    // base_terms 走与 offer/counter 完全相同的 SKU/数量/单位/金额/expiry/
    // 形状门。非空或缺失 conditions = 未知条件形状，本发行版不扩
    // （unsupported_reply）；不放松 raw 签名/关联/单位/金额/expiry。
    const conditions = (payload as { conditions?: unknown }).conditions;
    if (!Array.isArray(conditions) || conditions.length !== 0) reject("unsupported_reply");
    const baseTerms = (payload as { base_terms?: unknown }).base_terms;
    if (typeof baseTerms !== "object" || baseTerms === null) reject("unsupported_offer_shape");
    if (outbound.type !== "counter_offer") reject("proposal_ref_mismatch");
    if ((payload as { responding_to_offer_id?: unknown }).responding_to_offer_id !== outbound.offer_id)
      reject("proposal_ref_mismatch");
    checkTerms(baseTerms as TermSet, requested, nowMs);
    return;
  }
  if (payload.type === "accept_nonbinding") {
    if (outbound.type !== "counter_offer" || payload.offer_id !== outbound.offer_id ||
        payload.terms_digest !== contentDigest(outbound.proposed_terms)) reject("accept_binding_mismatch");
    checkTerms(outbound.proposed_terms, requested, nowMs);
    return;
  }
  if (payload.type === "offer" || payload.type === "counter_offer") {
    if (outbound.type === "counter_offer") {
      if ((payload as unknown as { responding_to_offer_id?: unknown }).responding_to_offer_id !== outbound.offer_id)
        reject("proposal_ref_mismatch");
    } else if (payload.type === "counter_offer") {
      // An RFQ is not an active offer that a counterproposal can reference.
      reject("proposal_ref_mismatch");
    }
    checkTerms(payload.type === "offer" ? payload.terms : payload.proposed_terms, requested, nowMs);
    return;
  }
  if (!["clarification", "clarification_response", "decline", "withdraw", "cancel"].includes(reply.action))
    reject("unsupported_reply");
}
