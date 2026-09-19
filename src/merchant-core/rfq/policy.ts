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
 * 报价硬策略（设计 v0.1.1 §7.3）。
 *
 * QuotePolicy.validate 读取当前授权与策略，输出通过/拒绝——对外只返回
 * POLICY_REQUIRES_REVIEW 等理由码，绝不泄露底价、成本、利润或阈值数值
 * （拒绝接口不得成为底价探测器；任意价格反复试探由调用方限流与审计）。
 * 硬底线不可在「批准报价」动作中修改；策略变更走既有独立策略变更流程。
 */

import { RfqError, type FactField, type QuoteStatus } from "./types.js";
import { evaluateFreshness } from "./fact-resolver.js";

/** 报价硬策略配置（来自商家受控策略面；缺省项不启用对应检查）。 */
export interface RfqPolicyConfig {
  /** 起订量（按 SKU 覆盖，缺省全局）。 */
  min_order_quantity?: number;
  min_order_quantity_by_sku?: Record<string, number>;
  /** 允许的计量单位白名单。 */
  allowed_units?: string[];
  /** 允许的付款条件白名单（逐字匹配已确认表达）。 */
  allowed_payment_terms?: string[];
  /** 报价有效期上限（天）。 */
  max_valid_until_days?: number;
  /**
   * 私有底价（minor units；只在本配置对象内存在，绝不进投影/错误/日志）。
   */
  floor_price_minor_by_sku?: Record<string, number>;
  /** 交付区域白名单（客户地址须命中其一）。 */
  allowed_delivery_regions?: string[];
}

export interface RfqPolicyLineContext {
  sku: string;
  quantity: number;
  unit: string;
  /** 行单价（minor units）。 */
  unit_price_minor: number;
}

export interface RfqPolicyContext {
  merchantId: string;
  lines: RfqPolicyLineContext[];
  validUntil: string;
  paymentTerms: string;
  deliveryRegion?: string;
  facts: FactField[];
  nowIso: string;
  currentStatus?: QuoteStatus;
}

export type RfqPolicyVerdict =
  | { ok: true }
  | { ok: false; reason_code: "policy_requires_review"; message: string };

const GENERIC_DENY = "报价未通过硬策略校验（POLICY_REQUIRES_REVIEW）；原因不透出阈值数值";

function deny(message?: string): RfqPolicyVerdict {
  return { ok: false, reason_code: "policy_requires_review", message: message ?? GENERIC_DENY };
}

/** 硬策略校验：任一不过即整体拒绝（无部分通过）。 */
export function validateQuotePolicy(ctx: RfqPolicyContext, policy: RfqPolicyConfig | undefined): RfqPolicyVerdict {
  if (ctx.merchantId === "") return deny();
  for (const line of ctx.lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw new RfqError("validation", `行 ${line.sku} 数量非法`);
    }
    const minQty =
      policy?.min_order_quantity_by_sku?.[line.sku] ?? policy?.min_order_quantity ?? undefined;
    if (minQty !== undefined && line.quantity < minQty) return deny();
    if (policy?.allowed_units !== undefined && !policy.allowed_units.includes(line.unit)) {
      return deny();
    }
    const floor = policy?.floor_price_minor_by_sku?.[line.sku];
    if (floor !== undefined && line.unit_price_minor < floor) return deny();
  }
  if (policy?.allowed_payment_terms !== undefined && !policy.allowed_payment_terms.includes(ctx.paymentTerms)) {
    return deny();
  }
  if (policy?.allowed_delivery_regions !== undefined) {
    if (ctx.deliveryRegion === undefined || !policy.allowed_delivery_regions.includes(ctx.deliveryRegion)) {
      return deny();
    }
  }
  if (policy?.max_valid_until_days !== undefined) {
    const days = (Date.parse(ctx.validUntil) - Date.parse(ctx.nowIso)) / 86_400_000;
    if (!Number.isFinite(days) || days < 0 || days > policy.max_valid_until_days) return deny();
  }
  if (Date.parse(ctx.validUntil) <= Date.parse(ctx.nowIso)) {
    return deny("报价有效期早于当前时间");
  }
  // 关键事实新鲜度：过期或缺验证时点即阻断（v0.1.1 §6.3）。
  const freshness = evaluateFreshness(ctx.facts, ctx.nowIso);
  if (freshness.stale.length > 0) {
    throw new RfqError("fact_stale", `关键事实已过期：${freshness.stale.join(", ")}`);
  }
  if (freshness.missing_verification.length > 0) {
    throw new RfqError("fact_stale", `关键事实缺少源版本/验证信息：${freshness.missing_verification.join(", ")}`);
  }
  return { ok: true };
}
