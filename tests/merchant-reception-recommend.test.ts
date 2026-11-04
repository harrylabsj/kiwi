/**
 * M3：recommend_option 推荐块只允许可验证的理由。
 *  - lowest_public_price：被推荐价必须不高于所有比较项；
 *  - in_stock：被推荐项的事实必须表明库存可覆盖；
 *  - 引用非法/理由不可验证时整块拒绝。
 */
import { describe, expect, it } from "vitest";

import {
  factRevision,
  InMemoryFactRegistry,
  publishResponsePlan,
} from "../src/a2a/reception/publish.js";
import type { FactRef } from "../src/a2a/reception/types.js";

const NOW = "2026-11-03T04:00:00.000Z";
const MERCHANT = "merchant-1";

function register(
  registry: InMemoryFactRegistry,
  sku: string,
  price: number | undefined,
  stockAvailable: boolean | undefined,
  unit: string | null = "piece",
  currency = "CNY",
): FactRef {
  const base = {
    merchantId: MERCHANT,
    sku,
    visibility: "public" as const,
    issuedAt: NOW,
    facts: {
      ...(price !== undefined ? { listPrice: price, currency } : {}),
      ...(unit !== null ? { unit } : {}),
      ...(stockAvailable !== undefined ? { stockAvailable } : {}),
    },
  };
  return registry.register({ ...base, revision: factRevision(base) });
}

describe("recommend_option validation", () => {
  it("最便宜且在库存内：允许推荐并渲染理由", () => {
    const registry = new InMemoryFactRegistry();
    const cheap = register(registry, "VQ-CHEAP", 90, true);
    const expensive = register(registry, "VQ-EXP", 110, true);
    const result = publishResponsePlan({
      plan: {
        locale: "zh-CN",
        blocks: [
          {
            kind: "recommend_option",
            ref: cheap,
            comparedRefs: [expensive],
            reasonCode: "lowest_public_price",
          },
        ],
      },
      registry,
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(result.rejected).toHaveLength(0);
    expect(result.text).toContain("建议先看 SKU VQ-CHEAP");
    expect(result.text).toContain("公开标价更低");
  });

  it("被推荐价不是最低：整块拒绝", () => {
    const registry = new InMemoryFactRegistry();
    const expensive = register(registry, "VQ-EXP", 110, true);
    const cheap = register(registry, "VQ-CHEAP", 90, true);
    const result = publishResponsePlan({
      plan: {
        locale: "zh-CN",
        blocks: [
          {
            kind: "recommend_option",
            ref: expensive,
            comparedRefs: [cheap],
            reasonCode: "lowest_public_price",
          },
        ],
      },
      registry,
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(result.rejected[0]?.reason).toBe("unverified_claim");
    expect(result.text).toBe("");
  });

  it("库存不足时 in_stock 理由被拒绝", () => {
    const registry = new InMemoryFactRegistry();
    const out = register(registry, "VQ-OUT", 90, false);
    const result = publishResponsePlan({
      plan: {
        locale: "zh-CN",
        blocks: [{ kind: "recommend_option", ref: out, reasonCode: "in_stock" }],
      },
      registry,
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(result.rejected[0]?.reason).toBe("unverified_claim");
  });

  it("比较项缺少公开价时不能证明最低：拒绝", () => {
    const registry = new InMemoryFactRegistry();
    const cheap = register(registry, "VQ-CHEAP", 90, true);
    const unknown = register(registry, "VQ-UNKNOWN", undefined, true);
    const result = publishResponsePlan({
      plan: {
        locale: "zh-CN",
        blocks: [
          {
            kind: "recommend_option",
            ref: cheap,
            comparedRefs: [unknown],
            reasonCode: "lowest_public_price",
          },
        ],
      },
      registry,
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(result.rejected[0]?.reason).toBe("unverified_claim");
  });
  it("价格相等不构成更低：拒绝", () => {
    const registry = new InMemoryFactRegistry();
    const main = register(registry, "VQ-A", 90, true);
    const equal = register(registry, "VQ-B", 90, true);
    const result = publishResponsePlan({
      plan: {
        locale: "zh-CN",
        blocks: [{ kind: "recommend_option", ref: main, comparedRefs: [equal], reasonCode: "lowest_public_price" }],
      },
      registry,
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(result.rejected[0]?.reason).toBe("unverified_claim");
  });

  it("不同币种不可比较：拒绝", () => {
    const registry = new InMemoryFactRegistry();
    const main = register(registry, "VQ-A", 90, true, "piece", "CNY");
    const usd = register(registry, "VQ-B", 100, true, "piece", "USD");
    const result = publishResponsePlan({
      plan: {
        locale: "zh-CN",
        blocks: [{ kind: "recommend_option", ref: main, comparedRefs: [usd], reasonCode: "lowest_public_price" }],
      },
      registry,
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(result.rejected[0]?.reason).toBe("unverified_claim");
  });

  it("不同单位不可比较：拒绝；box/盒同义可比较", () => {
    const registry = new InMemoryFactRegistry();
    const main = register(registry, "VQ-A", 90, true, "box");
    const different = register(registry, "VQ-B", 100, true, "piece");
    const rejected = publishResponsePlan({
      plan: {
        locale: "zh-CN",
        blocks: [{ kind: "recommend_option", ref: main, comparedRefs: [different], reasonCode: "lowest_public_price" }],
      },
      registry,
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(rejected.rejected[0]?.reason).toBe("unverified_claim");

    const aliasRegistry = new InMemoryFactRegistry();
    const aliasMain = register(aliasRegistry, "VQ-A", 90, true, "box");
    const aliasCompared = register(aliasRegistry, "VQ-B", 100, true, "盒");
    const accepted = publishResponsePlan({
      plan: {
        locale: "zh-CN",
        blocks: [{ kind: "recommend_option", ref: aliasMain, comparedRefs: [aliasCompared], reasonCode: "lowest_public_price" }],
      },
      registry: aliasRegistry,
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(accepted.rejected).toHaveLength(0);
  });

  it("库存覆盖但缺少单位/数量证据时不声称可覆盖", () => {
    const registry = new InMemoryFactRegistry();
    const unknownUnit = register(registry, "VQ-A", 90, true, null);
    const noUnit = publishResponsePlan({
      plan: {
        locale: "zh-CN",
        blocks: [{ kind: "recommend_option", ref: unknownUnit, reasonCode: "in_stock" }],
      },
      registry,
      merchantId: MERCHANT,
      now: NOW,
    });
    expect(noUnit.rejected[0]?.reason).toBe("unverified_claim");
  });

});
