import { isAlipayCollectionAgreement } from "../handoff/alipay-collection.js";
import { contentDigest } from "../negotiation/jcs.js";
import { McpError } from "./errors.js";

/** Generic hosts cannot accept terms they cannot inspect or display privately. */
export function assertGenericA2AAcceptTerms(provenance: {
  latest_agreed_terms?: unknown;
  latest_terms_digest?: unknown;
}): void {
  const terms = provenance.latest_agreed_terms;
  if (terms === null || typeof terms !== "object" || Array.isArray(terms) ||
      provenance.latest_terms_digest !== contentDigest(terms)) {
    throw new McpError("invalid_params", "A2A 候选缺少可核对的最新商家条款，请重新获取报价");
  }
  assertNoAlipayAccept(terms);
}

export function assertNoAlipayAccept(terms: unknown): void {
  if (isAlipayCollectionAgreement(terms)) {
    throw new McpError("invalid_params", "请使用支持支付宝私有展示和含费总额校验的原生买家终端接受该报价", {
      reason_code: "ALIPAY_PRIVATE_DISPLAY_REQUIRED",
    });
  }
}

/** A destination added outside the accepted term set must not become a local agreement. */
export function assertGenericA2AAgreement(agreement: { agreed_terms: unknown; handoff_destination?: unknown }): void {
  if (isAlipayCollectionAgreement(agreement.agreed_terms, agreement.handoff_destination)) {
    throw new McpError("internal_error", "商家返回了不受当前宿主支持的支付宝协议，需人工对账", {
      reconciliation_required: true, reason_code: "ALIPAY_PRIVATE_DISPLAY_REQUIRED",
    });
  }
}
