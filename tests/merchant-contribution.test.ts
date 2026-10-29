/**
 * 贡献核算金样本（v0.2 §13.1–§13.4 / FR26–FR28、AC07/AC12/AC13）。
 */
import { describe, expect, it } from "vitest";

import { calculateContribution } from "../src/merchant-core/contribution/calculate.js";
import {
  ContributionError,
  type ContributionInput,
} from "../src/merchant-core/contribution/types.js";

const completeCosts = {
  goods_cost_minor: 600,
  shipping_cost_minor: 60,
  platform_fee_minor: 0,
  other_variable_minor: 20,
};

function input(overrides: Partial<ContributionInput> = {}): ContributionInput {
  return {
    net_revenue_minor: 1_000,
    costs: completeCosts,
    completeness: "COMPLETE",
    kind: "ACTUAL",
    ...overrides,
  };
}

describe("贡献核算（§13.4 固定样例）", () => {
  it("完整口径：1000/680 → 320，32%", () => {
    const result = calculateContribution(
      input({ gate: { enabled: true, min_contribution_minor: 100, min_rate_bps: 1_000 } }),
    );
    expect(result.contribution_minor).toBe(320);
    expect(result.rate_bps).toBe(3_200);
    expect(result.rate_percent).toBe(32);
    expect(result.gate).toEqual({ status: "PASSED", reasons: [] });
  });

  it("部分退款 200 且无成本恢复：800/680 → 120，15%；重放不重复扣减", () => {
    const refunded = input({
      net_revenue_minor: undefined,
      gross_revenue_minor: 1_000,
      refund_minor: 200,
      gate: { enabled: true, min_contribution_minor: 100, min_rate_bps: 1_000 },
    });
    const once = calculateContribution(refunded);
    const twice = calculateContribution(refunded);
    expect(once.net_revenue_minor).toBe(800);
    expect(once.contribution_minor).toBe(120);
    expect(once.rate_bps).toBe(1_500);
    expect(once.gate.status).toBe("PASSED");
    expect(twice).toEqual(once);
  });

  it("成本恢复只减商品成本；退款本身不冲回成本", () => {
    const withRecovery = calculateContribution(
      input({
        net_revenue_minor: undefined,
        gross_revenue_minor: 1_000,
        refund_minor: 200,
        cost_recovery_minor: 50,
      }),
    );
    expect(withRecovery.costs.goods_net_minor).toBe(550);
    expect(withRecovery.contribution_minor).toBe(170);

    const withoutRecovery = calculateContribution(
      input({ net_revenue_minor: undefined, gross_revenue_minor: 1_000, refund_minor: 200 }),
    );
    expect(withoutRecovery.costs.goods_net_minor).toBe(600);
    expect(withoutRecovery.contribution_minor).toBe(120);
  });

  it("配送暂估：金额可展示，但默认阻断硬门；独立例外只记例外放行", () => {
    const estimated = calculateContribution(
      input({
        completeness: "ESTIMATED",
        gate: { enabled: true, min_contribution_minor: 100, min_rate_bps: 1_000 },
      }),
    );
    expect(estimated.contribution_minor).toBe(320);
    expect(estimated.gate).toEqual({
      status: "BLOCKED",
      reasons: ["estimated_requires_exception"],
    });

    const exception = calculateContribution(
      input({
        completeness: "ESTIMATED",
        gate: {
          enabled: true,
          min_contribution_minor: 100,
          min_rate_bps: 1_000,
          exception_authorized: true,
        },
      }),
    );
    expect(exception.gate.status).toBe("EXCEPTION_ALLOWED");
  });

  it("配送成本缺项：不填 0，只展示已知金额，硬门阻断", () => {
    const incomplete = calculateContribution(
      input({
        costs: { goods_cost_minor: 620 },
        completeness: "INCOMPLETE",
        missing_cost_items: ["shipping"],
        gate: {
          enabled: true,
          min_contribution_minor: 100,
          min_rate_bps: 1_000,
          exception_authorized: true,
        },
      }),
    );
    expect(incomplete.contribution_minor).toBeNull();
    expect(incomplete.known_contribution_minor).toBe(380);
    expect(incomplete.rate_bps).toBeNull();
    expect(incomplete.gate).toEqual({ status: "BLOCKED", reasons: ["missing_cost"] });
  });

  it("零净收入：贡献 -680，比率不适用", () => {
    const result = calculateContribution(
      input({
        net_revenue_minor: 0,
        gate: { enabled: true, min_rate_bps: 1_000 },
      }),
    );
    expect(result.contribution_minor).toBe(-680);
    expect(result.rate_bps).toBeNull();
    expect(result.rate_percent).toBeNull();
    expect(result.gate).toEqual({ status: "BLOCKED", reasons: ["rate_not_applicable"] });
  });

  it("负净收入：贡献 -780，比率不适用", () => {
    const result = calculateContribution(input({ net_revenue_minor: -100 }));
    expect(result.contribution_minor).toBe(-780);
    expect(result.rate_bps).toBeNull();
  });

  it("负贡献：-100，-10%，不通过硬门", () => {
    const result = calculateContribution(
      input({
        costs: { ...completeCosts, goods_cost_minor: 1_020 },
        gate: { enabled: true, min_contribution_minor: 100, min_rate_bps: 1_000 },
      }),
    );
    expect(result.contribution_minor).toBe(-100);
    expect(result.rate_percent).toBe(-10);
    expect(result.gate.status).toBe("BLOCKED");
    expect(result.gate.reasons).toEqual(
      expect.arrayContaining(["below_min_contribution", "below_min_rate"]),
    );
  });

  it("未启用硬门 → NOT_EVALUATED；恰好达标 → PASSED（交叉相乘，不经浮点）", () => {
    expect(calculateContribution(input()).gate).toEqual({
      status: "NOT_EVALUATED",
      reasons: ["gate_disabled"],
    });

    const exactly = calculateContribution(
      input({
        net_revenue_minor: 1_000,
        costs: {
          goods_cost_minor: 700,
          shipping_cost_minor: 160,
          platform_fee_minor: 20,
          other_variable_minor: 20,
        },
        gate: { enabled: true, min_rate_bps: 1_000 },
      }),
    );
    expect(exactly.contribution_minor).toBe(100);
    expect(exactly.rate_bps).toBe(1_000);
    expect(exactly.gate.status).toBe("PASSED");

    const justBelow = calculateContribution(
      input({
        net_revenue_minor: 1_000,
        costs: {
          goods_cost_minor: 700,
          shipping_cost_minor: 161,
          platform_fee_minor: 20,
          other_variable_minor: 20,
        },
        gate: { enabled: true, min_rate_bps: 1_000 },
      }),
    );
    expect(justBelow.contribution_minor).toBe(99);
    expect(justBelow.gate.status).toBe("BLOCKED");
  });

  it("输入校验：退款超过收入、缺项未列明、同时给净收入与总额、负成本", () => {
    expect(() =>
      calculateContribution(
        input({ net_revenue_minor: undefined, gross_revenue_minor: 100, refund_minor: 101 }),
      ),
    ).toThrowError(ContributionError);
    expect(() =>
      calculateContribution(input({ completeness: "INCOMPLETE" })),
    ).toThrowError(ContributionError);
    expect(() =>
      calculateContribution(
        input({ completeness: "COMPLETE", costs: { goods_cost_minor: 1 }, missing_cost_items: ["x"] }),
      ),
    ).toThrowError(ContributionError);
    expect(() =>
      calculateContribution(
        input({ net_revenue_minor: undefined, gross_revenue_minor: 100, refund_minor: 0 }),
      ),
    ).not.toThrow();
    expect(() =>
      calculateContribution(input({ costs: { goods_cost_minor: -1 } })),
    ).toThrowError(ContributionError);
  });
});
