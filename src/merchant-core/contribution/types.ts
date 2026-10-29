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
 * 订单贡献与私有成本快照（v0.2 §13 / FR16、FR26–FR28）。
 *
 * 贡献 = 净收入 − 净商品成本 − 商家配送总成本 − 平台及支付费用 − 其他
 * 可归属变动履约成本。未知成本不按 0 填充；暂估/未算全默认不能通过最低
 * 贡献硬门。贡献不是企业净利润，也不包含“节省人工工资”。
 */

export type CostCompleteness = "COMPLETE" | "ESTIMATED" | "INCOMPLETE";
export type ContributionKind = "ESTIMATED" | "ACTUAL";

export interface ContributionCosts {
  /** 净商品成本（已扣除有证据的成本恢复）。 */
  goods_cost_minor?: number;
  /** 商家承担的配送总成本。 */
  shipping_cost_minor?: number;
  /** 平台及支付费用。 */
  platform_fee_minor?: number;
  /** 其他可归属变动履约成本。 */
  other_variable_minor?: number;
}

export interface ContributionGate {
  enabled: boolean;
  min_contribution_minor?: number;
  /** 贡献率下限，万分比（10% = 1000 bps），用交叉相乘避免浮点。 */
  min_rate_bps?: number;
  /** 暂估/缺项的独立例外授权（不是硬门满足）。 */
  exception_authorized?: boolean;
}

export interface ContributionInput {
  /** 订单有效交易金额（商品/服务/向客户收取的运费），已按实际取消/退款调整。 */
  net_revenue_minor?: number;
  /** 可选：原始收入与退款；提供时与 net_revenue 二选一（不得同时给）。 */
  gross_revenue_minor?: number;
  refund_minor?: number;
  /** 有证据的成本恢复（退货入库/供应商退费），用于减少商品成本。 */
  cost_recovery_minor?: number;
  costs: ContributionCosts;
  completeness: CostCompleteness;
  missing_cost_items?: string[];
  kind: ContributionKind;
  gate?: ContributionGate;
}

export type GateDecision =
  | { status: "PASSED"; reasons: string[] }
  | { status: "BLOCKED"; reasons: string[] }
  | { status: "NOT_EVALUATED"; reasons: string[] }
  | { status: "EXCEPTION_ALLOWED"; reasons: string[] };

export interface ContributionAssessment {
  method_version: "kiwi-contribution/1";
  kind: ContributionKind;
  completeness: CostCompleteness;
  net_revenue_minor: number;
  costs: {
    goods_net_minor: number;
    shipping_minor: number;
    platform_fee_minor: number;
    other_variable_minor: number;
    total_minor: number;
  };
  /** 口径完整/暂估时可展示的贡献；未算全时为 null（不得填 0）。 */
  contribution_minor: number | null;
  /** 已知成本的贡献（未算全时用于展示已知部分，不作为发布依据）。 */
  known_contribution_minor: number;
  missing_cost_items: string[];
  /** 贡献率（bps，整数）；净收入 ≤ 0 时为 null。 */
  rate_bps: number | null;
  /** 贡献率百分比，展示用两位小数；净收入 ≤ 0 时为 null。 */
  rate_percent: number | null;
  gate: GateDecision;
}

export type ContributionErrorCode = "validation";

export class ContributionError extends Error {
  readonly code: ContributionErrorCode;
  constructor(message: string) {
    super(message);
    this.name = "ContributionError";
    this.code = "validation";
  }
}
