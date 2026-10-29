/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 贡献核算（v0.2 §13.1–§13.4 / FR26–FR28）。
 *
 * 纯整数运算；未知成本不填 0；贡献率用万分比交叉相乘判断阈值，展示舍入
 * 不改变发布结论。现金退款与成本恢复分开：退款只减收入，只有显式成本
 * 恢复才减成本。
 */

import {
  ContributionError,
  type ContributionAssessment,
  type ContributionGate,
  type ContributionInput,
  type GateDecision,
} from "./types.js";

const MAX_MINOR = BigInt(1_000_000_000_000);

function requireMinor(value: unknown, name: string, allowNegative = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value > Number(MAX_MINOR) ||
    (!allowNegative && value < 0)
  ) {
    throw new ContributionError(
      `${name} 必须是 [${allowNegative ? -Number(MAX_MINOR) : 0}, ${Number(MAX_MINOR)}] 内的安全整数`,
    );
  }
  return value;
}

function optionalMinor(value: unknown, name: string): number {
  if (value === undefined) return 0;
  return requireMinor(value, name);
}

/** 非负净收入的四舍五入整数除法；负分子按远离 0 取整，仅用于展示。 */
function roundDiv(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new ContributionError("rate denominator must be positive");
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const rounded = (2n * abs + denominator) / (2n * denominator);
  const value = negative ? -rounded : rounded;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new ContributionError("贡献率超出安全整数范围");
  }
  return Number(value);
}

function evaluateGate(
  input: ContributionInput,
  contributionMinor: number | null,
  netRevenueMinor: number,
): GateDecision {
  const gate: ContributionGate | undefined = input.gate;
  if (gate === undefined || !gate.enabled) {
    return { status: "NOT_EVALUATED", reasons: ["gate_disabled"] };
  }
  const reasons: string[] = [];
  if (input.completeness === "INCOMPLETE") {
    // 缺项没有可证明上限：独立例外也不能当成硬门满足。
    return { status: "BLOCKED", reasons: ["missing_cost"] };
  }
  if (input.completeness === "ESTIMATED") {
    if (gate.exception_authorized !== true) {
      return { status: "BLOCKED", reasons: ["estimated_requires_exception"] };
    }
    reasons.push("estimated_exception");
  }
  if (contributionMinor === null) {
    return { status: "BLOCKED", reasons: [...reasons, "contribution_unknown"] };
  }
  if (gate.min_contribution_minor !== undefined) {
    const minimum = requireMinor(gate.min_contribution_minor, "gate.min_contribution_minor");
    if (contributionMinor < minimum) reasons.push("below_min_contribution");
  }
  if (gate.min_rate_bps !== undefined) {
    const minRate = requireMinor(gate.min_rate_bps, "gate.min_rate_bps");
    if (minRate > 10_000) throw new ContributionError("gate.min_rate_bps 不得超过 10000");
    if (netRevenueMinor <= 0) {
      reasons.push("rate_not_applicable");
    } else if (
      BigInt(contributionMinor) * 10_000n <
      BigInt(minRate) * BigInt(netRevenueMinor)
    ) {
      reasons.push("below_min_rate");
    }
  }
  const blocked = reasons.some((reason) =>
    ["below_min_contribution", "below_min_rate", "rate_not_applicable"].includes(reason),
  );
  if (blocked) return { status: "BLOCKED", reasons };
  if (reasons.includes("estimated_exception")) {
    return { status: "EXCEPTION_ALLOWED", reasons };
  }
  return { status: "PASSED", reasons };
}

export function calculateContribution(input: ContributionInput): ContributionAssessment {
  if (input.kind !== "ESTIMATED" && input.kind !== "ACTUAL") {
    throw new ContributionError("kind 必须是 ESTIMATED 或 ACTUAL");
  }
  if (
    input.completeness !== "COMPLETE" &&
    input.completeness !== "ESTIMATED" &&
    input.completeness !== "INCOMPLETE"
  ) {
    throw new ContributionError("completeness 非法");
  }

  const hasNet = input.net_revenue_minor !== undefined;
  const hasGross = input.gross_revenue_minor !== undefined || input.refund_minor !== undefined;
  if (hasNet && hasGross) {
    throw new ContributionError("net_revenue_minor 与 gross_revenue_minor/refund_minor 只能二选一");
  }
  let netRevenue: number;
  if (hasNet) {
    netRevenue = requireMinor(input.net_revenue_minor, "net_revenue_minor", true);
  } else if (input.gross_revenue_minor !== undefined) {
    const gross = requireMinor(input.gross_revenue_minor, "gross_revenue_minor");
    const refund = optionalMinor(input.refund_minor, "refund_minor");
    netRevenue = requireMinor(gross - refund, "net_revenue_minor", true);
    if (refund > gross) throw new ContributionError("refund_minor 不得超过 gross_revenue_minor");
  } else {
    throw new ContributionError("必须提供 net_revenue_minor 或 gross_revenue_minor");
  }

  const goods = optionalMinor(input.costs.goods_cost_minor, "costs.goods_cost_minor");
  const recovery = optionalMinor(input.cost_recovery_minor, "cost_recovery_minor");
  if (recovery > goods) throw new ContributionError("cost_recovery_minor 不得超过商品成本");
  const shipping = optionalMinor(input.costs.shipping_cost_minor, "costs.shipping_cost_minor");
  const platform = optionalMinor(input.costs.platform_fee_minor, "costs.platform_fee_minor");
  const other = optionalMinor(input.costs.other_variable_minor, "costs.other_variable_minor");

  const missing = [...(input.missing_cost_items ?? [])].map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new ContributionError("missing_cost_items 必须是非空字符串");
    }
    return item;
  });
  if (input.completeness === "INCOMPLETE" && missing.length === 0) {
    throw new ContributionError("未算全时必须列出 missing_cost_items");
  }
  if (input.completeness !== "INCOMPLETE" && missing.length > 0) {
    throw new ContributionError("完整/暂估口径不应带有缺失成本项");
  }

  const goodsNet = goods - recovery;
  const totalCost = requireMinor(goodsNet + shipping + platform + other, "total_cost");
  const knownContribution = requireMinor(netRevenue - totalCost, "known_contribution", true);
  const contribution = input.completeness === "INCOMPLETE" ? null : knownContribution;

  let rateBps: number | null = null;
  if (contribution !== null && netRevenue > 0) {
    rateBps = roundDiv(BigInt(contribution) * 10_000n, BigInt(netRevenue));
  }
  const ratePercent = rateBps === null ? null : Math.round(rateBps) / 100;

  return {
    method_version: "kiwi-contribution/1",
    kind: input.kind,
    completeness: input.completeness,
    net_revenue_minor: netRevenue,
    costs: {
      goods_net_minor: goodsNet,
      shipping_minor: shipping,
      platform_fee_minor: platform,
      other_variable_minor: other,
      total_minor: totalCost,
    },
    contribution_minor: contribution,
    known_contribution_minor: knownContribution,
    missing_cost_items: missing,
    rate_bps: rateBps,
    rate_percent: ratePercent,
    gate: evaluateGate(input, contribution, netRevenue),
  };
}
