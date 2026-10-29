/**
 * 方案发布适配（v0.2 §9.3/§10.3）：KNP terms 与 RFQ 计价行。
 */
import { describe, expect, it } from "vitest";

import { prepareProposalSet } from "../src/merchant-core/proposal/engine.js";
import {
  assertPublishable,
  toKnpTerms,
  toRfqPricingLine,
} from "../src/merchant-core/proposal/publish.js";

const NOW = "2026-10-29T10:00:00.000Z";

function set(overrides: { alternative?: boolean; blocked?: boolean } = {}) {
  return prepareProposalSet({
    merchant_id: "merchant-1",
    opportunity_id: "opp-1",
    requirement_revision: 1,
    facts_digest: "facts:v1",
    policy_version: "policy:v1",
    now: NOW,
    options: [
      {
        option_id: "opt-1",
        sku: "SKU-1",
        unit: "piece",
        quantity: 2,
        base_unit_price_minor: 10_000,
        line_tax: { basis: "EXCLUSIVE", rate_bps: 0 },
        shipping_tax: { basis: "EXCLUSIVE", rate_bps: 0 },
        adaptation: [{ constraint: "size", result: overrides.blocked ? "NOT_MET" : "MET" }],
        ...(overrides.alternative === true ? { is_alternative: true } : {}),
        valid_until_cap: "2026-10-30T10:00:00.000Z",
      },
    ],
  });
}

describe("publish adapters", () => {
  it("KNP terms 使用方案单价、数量、有效期与可选条件", () => {
    const terms = toKnpTerms(assertPublishable(set(), "opt-1"), {
      delivery_before: "2026-11-03",
      payment_terms: "net 30 (nonbinding)",
    });
    expect(terms).toEqual({
      items: [
        {
          sku: "SKU-1",
          quantity: { value: 2, unit: "piece" },
          unit_price: { currency: "CNY", amount_minor: 10_000 },
        },
      ],
      valid_until: "2026-10-30T10:00:00.000Z",
      fulfillment_terms: { delivery_before: "2026-11-03" },
      payment_terms: { terms: "net 30 (nonbinding)" },
    });
  });

  it("RFQ 计价行不重复决定税，只透传 terms", () => {
    const line = toRfqPricingLine(assertPublishable(set(), "opt-1"), {
      line_id: "line-1",
      tax_basis: "INCLUSIVE",
      tax_rate_bps: 1_300,
      evidence_source_ids: ["snap-1"],
    });
    expect(line).toMatchObject({
      line_id: "line-1",
      sku: "SKU-1",
      quantity: 2,
      unit_price_minor: 10_000,
      discount_minor: 0,
      tax_basis: "INCLUSIVE",
      tax_rate_bps: 1_300,
      evidence_source_ids: ["snap-1"],
    });
  });

  it("替代品/被硬约束阻断/非 READY 集合不能发布", () => {
    expect(() => assertPublishable(set({ alternative: true }), "opt-1")).toThrowError(
      expect.objectContaining({ code: "not_selectable" }),
    );
    expect(() => assertPublishable(set({ blocked: true }), "opt-1")).toThrowError(
      expect.objectContaining({ code: "not_selectable" }),
    );
    const stale = { ...set(), status: "STALE" as const };
    expect(() => assertPublishable(stale, "opt-1")).toThrowError(
      expect.objectContaining({ code: "not_selectable" }),
    );
  });

  it("非法税基/税率与空 line_id 被拒绝", () => {
    const option = assertPublishable(set(), "opt-1");
    expect(() =>
      toRfqPricingLine(option, {
        line_id: "line-1",
        tax_basis: "EXCLUSIVE",
        tax_rate_bps: 20_000,
        evidence_source_ids: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "validation" }));
    expect(() =>
      toRfqPricingLine(option, {
        line_id: " ",
        tax_basis: "EXCLUSIVE",
        tax_rate_bps: 0,
        evidence_source_ids: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "validation" }));
  });
});
