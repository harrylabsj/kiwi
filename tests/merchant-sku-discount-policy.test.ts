/**
 * Option C：SKU 级折扣 + 95 折常态 + 私有底价/审批拆分。
 *
 * - `sku_max_discount_percent[sku]` 优先于全局 `max_auto_discount_percent`；
 * - 常态自动价 = 标价 × (1 - SKU 折扣)；
 * - 买家还价低于公开边界但 ≥ 私有底价时，转店主审批；批准后同一协商重试命中；
 * - 非目标 SKU 仍走全局折扣。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NegotiationHandler, NegotiationHandlerResult } from "../src/a2a/server/types.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";

const NOW = "2026-10-29T10:00:00Z";
const NEGOTIATION_ID = "neg_option_c_001";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const SKU = "SKU-001";
const OTHER_SKU = "SKU-002";

describe("merchant SKU discount policy (Option C)", () => {
  let dir: string;
  let ledger: LedgerStore;
  let approvals: NegotiationApprovalStore;
  let handler: NegotiationHandler;
  let seq = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-option-c-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
    approvals = new NegotiationApprovalStore(dir, () => NOW);
    handler = createMerchantHandler({
      productSource: {
        async getProduct(sku: string) {
          const price = sku === OTHER_SKU ? 100 : 70;
          return {
            price,
            currency: "CNY",
            unit: "piece",
            stock: 1_000,
            source_evidence: { system: "owned-test-fixture" },
          };
        },
      },
      ledger,
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
      merchantPolicy: {
        // 目标 SKU：95 折常态（70 → 66.50），底价 65。
        sku_max_discount_percent: { [SKU]: 5 },
        price_floors: { [SKU]: 65 },
        // 非目标 SKU 仍走全局 10%。
        max_auto_discount_percent: 10,
        delivery_lead_days: 7,
      },
      negotiationApprovals: approvals,
    });
    seq = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const envelopeFor = (
    action: string,
    payload: Record<string, unknown>,
    inReplyTo?: string,
  ): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: CAP,
      protocol_version: "1.0",
      negotiation_id: NEGOTIATION_ID,
      exchange_id: `ex_${seq}`,
      message_id: `msg_${seq}`,
      in_reply_to: inReplyTo ?? `msg_${seq - 1}`,
      actor: "buyer",
      action: action as NegotiationEnvelope["action"],
      created_at: NOW,
      payload: payload as never,
    });
  };

  const run = async (envelope: NegotiationEnvelope): Promise<NegotiationHandlerResult> =>
    handler.handle({
      envelope: envelope as never,
      message: { role: "user", parts: [], messageId: envelope.message_id },
      taskId: `task_${seq}`,
      senderIdentity: "buyer:buyer-001",
    });

  const rfq = (sku: string) =>
    envelopeFor("rfq", { type: "rfq", items: [{ sku, quantity: { value: 10, unit: "piece" } }] });

  const counter = (unitPriceMinor: number, sku = SKU) =>
    envelopeFor("counter_offer", {
      type: "counter_offer",
      offer_id: `off_${seq}`,
      proposed_terms: {
        currency: "CNY",
        items: [
          {
            sku,
            quantity: { value: 10, unit: "piece" },
            unit_price: { currency: "CNY", amount_minor: unitPriceMinor },
          },
        ],
      },
    });

  const payloadOf = (result: NegotiationHandlerResult): Record<string, unknown> | undefined =>
    result.kind === "accepted" && result.message
      ? (result.message.parts[0] as unknown as { data?: { knp_envelope?: { payload?: Record<string, unknown> } } })
          ?.data?.knp_envelope?.payload
      : undefined;

  const priceOf = (result: NegotiationHandlerResult): number | undefined => {
    const payload = payloadOf(result);
    const terms = (payload?.terms ?? payload?.base_terms) as
      | { items?: Array<{ unit_price?: { amount_minor?: number } }> }
      | undefined;
    return terms?.items?.[0]?.unit_price?.amount_minor;
  };

  it("SKU 级 5% 优先于全局 10%：还价 66.50 自动成交", async () => {
    await run(rfq(SKU));
    const result = await run(counter(6_650));
    expect(result.kind).toBe("accepted");
    expect(priceOf(result)).toBe(6_650);
    expect(approvals.list("pending")).toHaveLength(0);
  });

  it("低于公开边界但 ≥ 底价：转审批，批准后同一协商重试命中 65", async () => {
    await run(rfq(SKU));
    const declined = await run(counter(6_300));
    expect(declined.kind).toBe("declined");
    if (declined.kind === "declined") expect(declined.reasonCode).toBe("approval_required");

    const pending = approvals.list("pending");
    expect(pending).toHaveLength(1);
    // public_bound 6650 证明用的是 SKU 级 5%，不是全局 10%（6300）。
    expect(pending[0]).toMatchObject({
      negotiation_id: NEGOTIATION_ID,
      sku: SKU,
      buyer_offer_minor: 6_300,
      public_bound_minor: 6_650,
      floor_minor: 6_500,
    });

    approvals.approve({
      approval_id: pending[0]!.approval_id,
      approved_minor: 6_500,
      ttl_seconds: 600,
      approved_by: "merchant:operator",
    });
    const retried = await run(counter(6_300));
    expect(retried.kind).toBe("accepted");
    expect(priceOf(retried)).toBe(6_500);
    expect(approvals.list("consumed")).toHaveLength(1);
  });

  it("非目标 SKU 仍走全局 10%：还价 90 自动成交", async () => {
    await run(rfq(OTHER_SKU));
    const result = await run(counter(9_000, OTHER_SKU));
    expect(result.kind).toBe("accepted");
    expect(priceOf(result)).toBe(9_000);
    expect(approvals.list("pending")).toHaveLength(0);
  });

  it("报价带 delivery_lead_days=7 的 fulfillment_terms", async () => {
    const result = await run(rfq(SKU));
    const payload = payloadOf(result);
    const terms = (payload?.terms ?? payload?.base_terms) as
      | { fulfillment_terms?: { delivery_before?: string } }
      | undefined;
    expect(terms?.fulfillment_terms?.delivery_before).toBe("2026-11-05T10:00:00.000Z");
  });
});
