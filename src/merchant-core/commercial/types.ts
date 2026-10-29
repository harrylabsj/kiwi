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
 * 统一商业计算输入/输出（商家持续经营设计 v0.2 §9.2、FR14）。
 *
 * 这一层只做确定性算术：选择公开促销价、应用行优惠、按税基拆分、汇总
 * 总额并给出有效期。它不读取私有底价以外的商家策略，也不接受模型提交
 * 的最终金额。RFQ 与 KNP 适配层共享同一输入，保证同事实/同规则得到
 * 同结果；wire 形状与发布对象由各自适配层负责。
 */

import type { PricingResult, TaxBasis } from "../rfq/types.js";

export const COMMERCIAL_CALCULATION_VERSION = "kiwi-commercial/1" as const;
export type CommercialCalculationVersion = typeof COMMERCIAL_CALCULATION_VERSION;

/** 公开促销候选（金额为最小货币单位整数，币种固定 CNY）。 */
export interface CommercialPromotion {
  promotion_id: string;
  revision: number;
  unit_price_minor: number;
  /** 促销结束时间（RFC 3339）；到期后不得再被选中。 */
  ends_at: string;
  /** 数值越大优先级越高；同优先级按价格低→高、promotion_id 字典序。 */
  priority: number;
}

/** 税口径：basis 与 bps 必须显式给出，未知不得进入计价。 */
export interface CommercialTax {
  basis: TaxBasis;
  rate_bps: number;
}

export interface CommercialQuoteInput {
  /** P0 仅 CNY（与 PricingEngine / KNP Money 一致）。 */
  currency: "CNY";
  quantity: number;
  /** 公开 list 单价（minor）。 */
  base_unit_price_minor: number;
  /** 公开促销候选；空数组等价没有促销。 */
  promotions?: readonly CommercialPromotion[];
  /**
   * 私有 floor（minor）。只用于判断“能否自动报价”，绝不进入返回的
   * 价格、投影或日志。低于 floor 时返回 approval_required。
   */
  private_floor_minor?: number;
  /** 行级优惠（minor）；不得大于行基数。 */
  line_discount_minor?: number;
  /** 商家承担的配送金额（minor）；0/缺省表示包邮。 */
  shipping_amount_minor?: number;
  line_tax: CommercialTax;
  shipping_tax: CommercialTax;
  /** 报价有效期上限（秒）；从 now 起算。 */
  quote_ttl_seconds?: number;
  /** 商品事实或商家策略给出的额外有效期上限（RFC 3339）。 */
  valid_until_cap?: string;
  /** 计算基准时间（RFC 3339）。 */
  now: string;
}

export interface CommercialPriceSourceBase {
  kind: "base";
}

export interface CommercialPriceSourcePromotion {
  kind: "promotion";
  promotion_id: string;
  revision: number;
}

export type CommercialPriceSource = CommercialPriceSourceBase | CommercialPriceSourcePromotion;

export type CommercialQuoteResult =
  | {
      status: "quoted";
      calculation_version: CommercialCalculationVersion;
      currency: "CNY";
      quantity: number;
      unit_price_minor: number;
      source: CommercialPriceSource;
      pricing: PricingResult;
      /** 实际生效的最早截止时间；没有约束时为 null。 */
      valid_until: string | null;
    }
  | {
      status: "approval_required";
      calculation_version: CommercialCalculationVersion;
      reason: "below_private_floor" | "invalid_promotion";
    };
