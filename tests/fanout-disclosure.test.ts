/**
 * fanout/disclosure — WP2 渐进披露构造器（基线 §30 / §29 / §4.4）。
 *
 * 覆盖：
 *   - anonymous 档：SKU + 数量区间，不含精确数量 / 交期 / 身份线索；
 *   - detailed 档：精确数量 + 交期要求 +（策略允许的 §29 可选项）；
 *   - 私有字段（预算 / 急迫度 / 身份 / 联系方式）结构性缺席的负向断言；
 *   - NetworkDisclosurePolicy 校验（purchase_quantity 门控、可选披露项 allowlist、
 *     always-private 属性无豁免路径）；
 *   - 每档 payload 都过 KNP RFQ wire 校验（validateRfq）。
 */

import { describe, expect, it } from "vitest";
import { validateRfq } from "../src/negotiation/domain/objects.js";
import {
  ALWAYS_PRIVATE_ATTRIBUTES,
  buildDisclosedRfq,
  rangeMidpoint,
  validateNetworkDisclosure,
} from "../src/fanout/disclosure.js";
import type { DisclosedRfqPayload, RfqIntent } from "../src/fanout/disclosure.js";
import { intent } from "./fanout-helpers.js";

const PRIVATE_NEEDLES = [
  "budget",
  "urgency",
  "contact",
  "email",
  "phone",
  "organization",
  "Acme Buying",
  "buyer@acme.example",
];

/** 序列化负向断言：任何私有字段名/值都不应出现在 payload 里。 */
function expectNoPrivateLeak(payload: DisclosedRfqPayload): void {
  const serialized = JSON.stringify(payload);
  for (const needle of PRIVATE_NEEDLES) {
    expect(serialized).not.toContain(needle);
  }
}

/** 精确数量缺席断言：意图的精确值（42）不该出现在序列化输出里。 */
function expectExactQuantityAbsent(payload: DisclosedRfqPayload): void {
  expect(JSON.stringify(payload)).not.toContain('"value":42');
}

describe("anonymous 档（round 1 匿名首轮）", () => {
  it("只含 SKU + 数量区间；精确数量 / 交期 / 身份线索全部缺席", () => {
    const payload = buildDisclosedRfq({
      intent: intent(),
      tier: "anonymous",
      allowed_attributes: ["purchase_quantity"],
    });
    expect(payload.tier).toBe("anonymous");
    if (payload.tier !== "anonymous") throw new Error("expected anonymous tier");

    const rfq = payload.rfq;
    expect(rfq.items[0]?.sku).toBe("SKU-001");
    // 匿名档只投影区间中点作为 LineItem 数量（真实信号是区间本身）。
    expect(rfq.items[0]?.quantity.value).toBe(rangeMidpoint({ min: 10, max: 50 }));
    expect(rfq.requested_terms.quantity_range).toEqual([{ sku: "SKU-001", min: 10, max: 50 }]);
    // 无交期、无精确数量、无任何私有字段。
    expect(JSON.stringify(rfq)).not.toContain("delivery_before");
    expectExactQuantityAbsent(payload);
    expectNoPrivateLeak(payload);
    // wire 校验：匿名档仍是合法 KNP RFQ。
    expect(() => validateRfq(rfq)).not.toThrow();
  });

  it("多 SKU 意图：每行都投影区间中点与 quantity_range", () => {
    const multi: RfqIntent = {
      items: [
        { sku: "SKU-001", quantity: 42, quantity_range: { min: 10, max: 50 }, unit: "piece" },
        { sku: "SKU-002", quantity: 7, quantity_range: { min: 2, max: 10 }, unit: "box" },
      ],
    };
    const payload = buildDisclosedRfq({ intent: multi, tier: "anonymous", allowed_attributes: [] });
    expect(payload.tier).toBe("anonymous");
    if (payload.tier !== "anonymous") throw new Error("expected anonymous tier");
    expect(payload.rfq.items.map((i) => i.sku)).toEqual(["SKU-001", "SKU-002"]);
    expect(payload.rfq.requested_terms.quantity_range).toEqual([
      { sku: "SKU-001", min: 10, max: 50 },
      { sku: "SKU-002", min: 2, max: 10 },
    ]);
  });
});

describe("detailed 档（round 2 Top N 精化）", () => {
  it("含精确数量 + 交期要求；私有字段仍结构性缺席", () => {
    const payload = buildDisclosedRfq({
      intent: intent(),
      tier: "detailed",
      allowed_attributes: ["purchase_quantity"],
    });
    expect(payload.tier).toBe("detailed");
    if (payload.tier !== "detailed") throw new Error("expected detailed tier");
    expect(payload.rfq.items[0]?.quantity.value).toBe(42);
    expect(payload.rfq.requested_terms?.delivery_before).toBe("2026-08-20T18:00:00Z");
    // 预算 / 急迫度 / 身份即使 intent 里填了也不会进 detailed 档。
    expectNoPrivateLeak(payload);
    expect(() => validateRfq(payload.rfq)).not.toThrow();
  });

  it("可选披露项只在 disclosure_profile 允许时投影", () => {
    const allowed = ["purchase_quantity", "location_precision", "customer_segment"] as const;
    const payload = buildDisclosedRfq({
      intent: intent(),
      tier: "detailed",
      allowed_attributes: allowed,
    });
    expect(payload.tier).toBe("detailed");
    if (payload.tier !== "detailed") throw new Error("expected detailed tier");
    const requested = payload.rfq.requested_terms ?? {};
    expect(requested["location_precision"]).toBe("district");
    expect(requested["customer_segment"]).toBe("enterprise");
    // historical_preferences 未允许 → 缺席。
    expect(requested["historical_preferences"]).toBeUndefined();
  });
});

describe("私有字段结构性排除（负向断言）", () => {
  it("即使 intent 填满私有字段，两档 payload 序列化后都不含任何私有键名", () => {
    const fullIntent = intent({
      budget: { currency: "CNY", amount_minor: 50000 },
      urgency: "high",
      contact: {
        organization: "Acme Buying",
        email: "buyer@acme.example",
        phone: "+8613800000000",
      },
      customer_segment: "enterprise",
      preferences: ["priority-delivery"],
    });
    for (const tier of ["anonymous", "detailed"] as const) {
      const payload = buildDisclosedRfq({
        intent: fullIntent,
        tier,
        allowed_attributes: [
          "purchase_quantity",
          "location_precision",
          "customer_segment",
          "historical_preferences",
        ],
      });
      expectNoPrivateLeak(payload);
    }
  });

  it("ALWAYS_PRIVATE_ATTRIBUTES 包含预算 / 急迫度 / 身份 / 联系方式（§4.4）", () => {
    expect(ALWAYS_PRIVATE_ATTRIBUTES).toEqual(
      expect.arrayContaining([
        "budget_hints",
        "buyer_urgency",
        "contact_information",
        "organization_identity",
      ]),
    );
  });
});

describe("NetworkDisclosurePolicy 校验", () => {
  it("拒绝含 always-private 属性的 payload（无豁免路径）", () => {
    const tampered: DisclosedRfqPayload = {
      tier: "detailed",
      rfq: {
        type: "rfq",
        items: [
          {
            sku: "SKU-001",
            quantity: { value: 42, unit: "piece" },
            unit_price: { currency: "CNY", amount_minor: 100 },
          },
        ],
        // 显式塞入私有字段（模拟构造路径外泄）。
        requested_terms: { budget_hints: { currency: "CNY", amount_minor: 50000 } },
      },
    };
    const check = validateNetworkDisclosure(tampered, ["purchase_quantity", "budget_hints"]);
    expect(check.ok).toBe(false);
    expect(check.errors.join()).toContain("budget_hints");
    // 即使 allowlist 里显式允许 budget_hints，也拒绝（结构性排除，§4.4）。
    expect(validateNetworkDisclosure(tampered, ["purchase_quantity", "budget_hints"]).ok).toBe(
      false,
    );
  });

  it("拒绝 anonymous 档携带交期", () => {
    const tampered: DisclosedRfqPayload = {
      tier: "anonymous",
      rfq: {
        type: "rfq",
        items: [{ sku: "SKU-001", quantity: { value: 30, unit: "piece" } }],
        // 匿名档不允许 delivery_before。
        requested_terms: {
          quantity_range: [{ sku: "SKU-001", min: 10, max: 50 }],
          delivery_before: "2026-08-20T18:00:00Z",
        } as unknown as { quantity_range: { sku: string; min: number; max: number }[] },
      },
    };
    const check = validateNetworkDisclosure(tampered, []);
    expect(check.ok).toBe(false);
    expect(check.errors.join()).toContain("delivery_before");
  });

  it("detailed 档可选披露项必须在 allowlist 里", () => {
    const violating: DisclosedRfqPayload = {
      tier: "detailed",
      rfq: {
        type: "rfq",
        items: [{ sku: "SKU-001", quantity: { value: 42, unit: "piece" } }],
        requested_terms: { customer_segment: "enterprise" },
      },
    };
    const check = validateNetworkDisclosure(violating, ["purchase_quantity"]);
    expect(check.ok).toBe(false);
    expect(check.errors.join()).toContain("customer_segment");
  });

  it("purchase_quantity 未允许时 detailed 必须退回 quantity_range", () => {
    const fallback = buildDisclosedRfq({
      intent: intent(),
      tier: "detailed",
      allowed_attributes: [],
    });
    expect(fallback.tier).toBe("detailed");
    if (fallback.tier !== "detailed") throw new Error("expected detailed tier");
    const requested = fallback.rfq.requested_terms ?? {};
    // 退回区间：精确数量不投影，quantity_range 补齐。
    expect(fallback.rfq.items[0]?.quantity.value).toBe(rangeMidpoint({ min: 10, max: 50 }));
    expect(requested["quantity_range"]).toEqual([{ sku: "SKU-001", min: 10, max: 50 }]);
    expect(JSON.stringify(fallback)).not.toContain('"value":42');
    // 仍可通过校验（fallback 是合法的门控退化路径）。
    expect(validateNetworkDisclosure(fallback, []).ok).toBe(true);
    // 交期要求仍在（round 2 的 delivery requirements 不是 §29 私有属性）。
    expect(fallback.rfq.requested_terms?.delivery_before).toBe("2026-08-20T18:00:00Z");
  });
});

describe("构造即排除（非事后过滤）", () => {
  it("anonymous 档不读取 intent 的私有字段（白名单投影）", () => {
    const payload = buildDisclosedRfq({
      intent: intent(),
      tier: "anonymous",
      allowed_attributes: [],
    });
    // 匿名档的关键事实只有 sku + quantity_range；intent 里的精确数量/预算/急迫度
    // 从不被读取，因此序列化输出与这些字段完全无关。
    const keys = new Set<string>();
    for (const item of payload.rfq.items) keys.add(item.sku);
    expect([...keys]).toEqual(["SKU-001"]);
    expectNoPrivateLeak(payload);
  });
});
