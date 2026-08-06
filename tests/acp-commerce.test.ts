/**
 * Kiwi v1.1 Transaction Handoff（WP3）— AcpCommerceAdapter seam tests。
 *
 * 覆盖（对齐工作包验收清单）：
 *  - 未配置时所有操作 fail-closed（不静默降级到 UCP 或其他通道）；
 *  - reason 明确标注 acp_commerce_not_configured；
 *  - configured=false / status=unconfigured，调用方可显式分支；
 *  - 接口形状与 HandoffChannel 对齐（一个接收 HandoffChannel 的函数可接受本适配）。
 */
import { describe, expect, it } from "vitest";
import { contentDigest } from "../src/negotiation/jcs.js";
import type { TermSet } from "../src/negotiation/domain/common.js";
import type { AcceptedNonbindingAgreement } from "../src/negotiation/domain/objects.js";
import { createHandoffPackage } from "../src/handoff/package.js";
import { createPaymentAuthorization, createUserConfirmationEvidence } from "../src/handoff/authorization.js";
import { AcpCommerceAdapter } from "../src/handoff/acp-commerce.js";
import type { HandoffChannel, HandoffResult } from "../src/handoff/channel.js";
import { AGREEMENT_ID, NEGOTIATION_ID, OFFER_ID_3, SKU } from "./negotiation-helpers.js";

const NOW = "2026-08-06T12:00:00Z";
const CLOCK = () => NOW;

const TERMS: TermSet = {
  items: [
    { sku: SKU, quantity: { value: 200, unit: "piece" }, unit_price: { currency: "CNY", amount_minor: 85000 } },
  ],
};

function makePackage(): ReturnType<typeof createHandoffPackage> {
  const agreement: AcceptedNonbindingAgreement = {
    type: "accepted_nonbinding_agreement",
    agreement_id: AGREEMENT_ID,
    negotiation_id: NEGOTIATION_ID,
    accepted_offer_id: OFFER_ID_3,
    agreed_terms: structuredClone(TERMS),
    terms_digest: contentDigest(TERMS),
    accepted_by: ["buyer", "merchant"],
    created_at: "2026-08-05T12:30:00Z",
    binding_effect: "nonbinding",
    creates_order: false,
    reserves_inventory: false,
    authorizes_payment: false,
  };
  return createHandoffPackage({
    agreement,
    identity: { buyer_identity: "buyer-001", merchant_identity: "merchant-001" },
    capability_version: "acp-commerce.checkout/1",
    created_at: NOW,
  });
}

function makeAuthorization(sessionRef: string): ReturnType<typeof createPaymentAuthorization> {
  return createPaymentAuthorization(
    {
      authorization_id: "authz_acp_test",
      session_ref: sessionRef,
      terms_digest: contentDigest(TERMS),
      intent_mandate: "mandate:acp-test",
      evidence: createUserConfirmationEvidence({ kind: "manual", reference: "approval-1" }, CLOCK),
      approved_at: NOW,
      expires_at: "2026-08-06T13:00:00Z",
    },
    CLOCK,
  );
}

describe("AcpCommerceAdapter (unconfigured placeholder)", () => {
  it("fails closed on every HandoffChannel operation with a clear reason", () => {
    const adapter = new AcpCommerceAdapter();
    const pkg = makePackage();
    const authz = makeAuthorization("acp_session_1");

    const results: HandoffResult[] = [
      adapter.createSession(pkg),
      adapter.getSession("acp_session_1"),
      adapter.updateSession("acp_session_1", TERMS),
      adapter.requestCompletion("acp_session_1", authz),
      adapter.cancelSession("acp_session_1"),
    ];
    for (const result of results) {
      expect(result.status).toBe("fail_closed");
      if (result.status === "fail_closed") {
        expect(result.reason).toMatch(/acp_commerce_not_configured/);
      }
    }
  });

  it("never silently downgrades to UCP or any other channel", () => {
    const adapter = new AcpCommerceAdapter();
    const result = adapter.createSession(makePackage());
    expect(result.status).toBe("fail_closed");
    if (result.status === "fail_closed") {
      // It does not reference the UCP checkout channel as a fallback transport…
      expect(result.reason).not.toMatch(/ucp_checkout|ucp\.checkout/);
      // …and it states the refusal explicitly (no implicit downgrade).
      expect(result.reason).toMatch(/refusing to route to UCP or any other channel/);
    }
  });

  it("exposes configured=false / status=unconfigured so callers can branch explicitly", () => {
    const adapter = new AcpCommerceAdapter();
    expect(adapter.configured).toBe(false);
    expect(adapter.status).toBe("unconfigured");
  });

  it("is shape-compatible with HandoffChannel (callers are not broken)", () => {
    const adapter = new AcpCommerceAdapter();
    function consume(channel: HandoffChannel): HandoffResult {
      return channel.getSession("acp_session_1");
    }
    const result = consume(adapter);
    expect(result.status).toBe("fail_closed");
  });

  it("rejects a structurally invalid package even before the not-configured refusal", () => {
    const adapter = new AcpCommerceAdapter();
    const pkg = makePackage();
    pkg.agreed_terms = { items: [] };
    const result = adapter.createSession(pkg);
    expect(result.status).toBe("fail_closed");
    if (result.status === "fail_closed") {
      expect(result.reason).toMatch(/invalid handoff package/);
    }
  });
});
