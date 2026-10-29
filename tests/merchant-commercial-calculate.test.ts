/**
 * 统一商业计算（v0.2 §9.2 / FR14）。
 *
 * 目标：同一商品事实、数量、促销、税/运费输入必须得到同一结果；RFQ 与
 * KNP 适配层后续都从这里取单价与总额，不各自实现一套。
 */
import { describe, expect, it } from "vitest";

import { calculateCommercialQuote } from "../src/merchant-core/commercial/calculate.js";
import { RfqError } from "../src/merchant-core/rfq/types.js";

const NOW = "2026-10-29T10:00:00.000Z";

function input(overrides: Record<string, unknown> = {}) {
  return {
    currency: "CNY" as const,
    quantity: 2,
    base_unit_price_minor: 18_900,
    line_tax: { basis: "EXCLUSIVE" as const, rate_bps: 0 },
    shipping_tax: { basis: "EXCLUSIVE" as const, rate_bps: 0 },
    now: NOW,
    ...overrides,
  };
}

describe("calculateCommercialQuote", () => {
  it("无促销、无税：使用 list 价并给出完整计价结果", () => {
    const result = calculateCommercialQuote(input());
    expect(result.status).toBe("quoted");
    if (result.status !== "quoted") return;
    expect(result.unit_price_minor).toBe(18_900);
    expect(result.source).toEqual({ kind: "base" });
    expect(result.pricing.lines[0]).toMatchObject({
      line_id: "line-1",
      net_minor: 37_800,
      tax_minor: 0,
      gross_minor: 37_800,
    });
    expect(result.pricing.totals).toEqual({
      net_minor: 37_800,
      tax_minor: 0,
      gross_minor: 37_800,
    });
    expect(result.valid_until).toBeNull();
  });

  it("促销选择：priority 降序 → 价格低→高 → promotion_id 字典序", () => {
    const result = calculateCommercialQuote(
      input({
        promotions: [
          { promotion_id: "promo-a", revision: 1, unit_price_minor: 17_000, ends_at: "2026-11-01T00:00:00Z", priority: 1 },
          { promotion_id: "promo-c", revision: 1, unit_price_minor: 18_000, ends_at: "2026-11-02T00:00:00Z", priority: 2 },
          { promotion_id: "promo-b", revision: 1, unit_price_minor: 18_500, ends_at: "2026-11-03T00:00:00Z", priority: 2 },
        ],
      }),
    );
    expect(result.status).toBe("quoted");
    if (result.status !== "quoted") return;
    expect(result.unit_price_minor).toBe(18_000);
    expect(result.source).toEqual({ kind: "promotion", promotion_id: "promo-c", revision: 1 });
    expect(result.valid_until).toBe("2026-11-02T00:00:00Z");
  });

  it("任一促销候选非法 → approval_required，不静默跳过", () => {
    const aboveBase = calculateCommercialQuote(
      input({
        promotions: [
          { promotion_id: "bad", revision: 1, unit_price_minor: 19_000, ends_at: "2026-11-01T00:00:00Z", priority: 1 },
        ],
      }),
    );
    expect(aboveBase).toMatchObject({ status: "approval_required", reason: "invalid_promotion" });

    const duplicate = calculateCommercialQuote(
      input({
        promotions: [
          { promotion_id: "same", revision: 1, unit_price_minor: 18_000, ends_at: "2026-11-01T00:00:00Z", priority: 1 },
          { promotion_id: "same", revision: 2, unit_price_minor: 17_500, ends_at: "2026-11-01T00:00:00Z", priority: 2 },
        ],
      }),
    );
    expect(duplicate).toMatchObject({ status: "approval_required", reason: "invalid_promotion" });
  });

  it("低于私有 floor → approval_required，且不返回价格", () => {
    const result = calculateCommercialQuote(input({ private_floor_minor: 19_000 }));
    expect(result).toMatchObject({ status: "approval_required", reason: "below_private_floor" });
    expect("pricing" in result).toBe(false);
    expect("unit_price_minor" in result).toBe(false);
  });

  it("行优惠、未税运费与税额逐项拆分", () => {
    const result = calculateCommercialQuote(
      input({
        quantity: 2,
        base_unit_price_minor: 10_000,
        line_discount_minor: 1_000,
        shipping_amount_minor: 500,
        line_tax: { basis: "EXCLUSIVE", rate_bps: 1_300 },
        shipping_tax: { basis: "EXCLUSIVE", rate_bps: 1_300 },
      }),
    );
    expect(result.status).toBe("quoted");
    if (result.status !== "quoted") return;
    expect(result.pricing.lines[0]).toEqual({
      line_id: "line-1",
      net_minor: 19_000,
      tax_minor: 2_470,
      gross_minor: 21_470,
    });
    expect(result.pricing.shipping).toEqual({
      net_minor: 500,
      tax_minor: 65,
      gross_minor: 565,
    });
    expect(result.pricing.totals).toEqual({
      net_minor: 19_500,
      tax_minor: 2_535,
      gross_minor: 22_035,
    });
  });

  it("含税价按 INCLUSIVE 反拆，净额与税额可加回总额", () => {
    const result = calculateCommercialQuote(
      input({
        quantity: 1,
        base_unit_price_minor: 11_300,
        line_tax: { basis: "INCLUSIVE", rate_bps: 1_300 },
      }),
    );
    expect(result.status).toBe("quoted");
    if (result.status !== "quoted") return;
    expect(result.pricing.lines[0]).toMatchObject({
      net_minor: 10_000,
      tax_minor: 1_300,
      gross_minor: 11_300,
    });
  });

  it("有效期取 TTL、事实上限、促销结束时间三者最早", () => {
    const withTtl = calculateCommercialQuote(input({ quote_ttl_seconds: 3_600 }));
    expect(withTtl.status).toBe("quoted");
    if (withTtl.status !== "quoted") return;
    expect(withTtl.valid_until).toBe("2026-10-29T11:00:00.000Z");

    const capped = calculateCommercialQuote(
      input({
        quote_ttl_seconds: 3_600,
        valid_until_cap: "2026-10-29T10:30:00.000Z",
        promotions: [
          { promotion_id: "promo", revision: 1, unit_price_minor: 18_000, ends_at: "2026-10-29T10:10:00.000Z", priority: 1 },
        ],
      }),
    );
    expect(capped.status).toBe("quoted");
    if (capped.status !== "quoted") return;
    expect(capped.valid_until).toBe("2026-10-29T10:10:00.000Z");
  });

  it("输入非法时整单拒绝（不截断、不回退浮点）", () => {
    expect(() => calculateCommercialQuote(input({ currency: "USD" }))).toThrow(RfqError);
    expect(() => calculateCommercialQuote(input({ quantity: 0 }))).toThrow(RfqError);
    expect(() => calculateCommercialQuote(input({ base_unit_price_minor: 1.5 }))).toThrow(RfqError);
    expect(() =>
      calculateCommercialQuote(input({ line_tax: { basis: "UNKNOWN", rate_bps: 0 } })),
    ).toThrow(RfqError);
    expect(() =>
      calculateCommercialQuote(
        input({ quantity: 100_000, base_unit_price_minor: 1_000_000_000_000 }),
      ),
    ).toThrow(RfqError);
    expect(() => calculateCommercialQuote(input({ line_discount_minor: 37_801 }))).toThrow(RfqError);
  });

  it("同输入重复计算完全一致（确定性）", () => {
    const once = calculateCommercialQuote(
      input({
        promotions: [
          { promotion_id: "p2", revision: 2, unit_price_minor: 18_000, ends_at: "2026-11-01T00:00:00Z", priority: 5 },
          { promotion_id: "p1", revision: 1, unit_price_minor: 18_000, ends_at: "2026-11-01T00:00:00Z", priority: 5 },
        ],
        quote_ttl_seconds: 600,
      }),
    );
    const twice = calculateCommercialQuote(
      input({
        promotions: [
          { promotion_id: "p1", revision: 1, unit_price_minor: 18_000, ends_at: "2026-11-01T00:00:00Z", priority: 5 },
          { promotion_id: "p2", revision: 2, unit_price_minor: 18_000, ends_at: "2026-11-01T00:00:00Z", priority: 5 },
        ],
        quote_ttl_seconds: 600,
      }),
    );
    expect(twice).toEqual(once);
    if (once.status === "quoted") {
      expect(once.source).toEqual({ kind: "promotion", promotion_id: "p1", revision: 1 });
    }
  });
});
