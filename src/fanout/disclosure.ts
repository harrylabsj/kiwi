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
 * fanout — 渐进披露构造器（基线 §30 / §29 / §4.4）。
 *
 * 同一 RFQ 意图（RfqIntent）按披露档位生成不同 payload：
 *   - anonymous（round 1 匿名首轮）：SKU + 数量区间，不含精确数量 / 交期 /
 *     任何身份线索；
 *   - detailed（round 2 Top N 后）：精确数量 + 交期要求 +（策略允许的 §29 可选项）。
 *
 * 私有字段结构性不可能出现：构造器按档位白名单投影 intent —— 预算 / 急迫度 /
 * 身份 / 联系方式在 AnonymousRfqPayload / DetailedRfqPayload 类型里没有承载字段，
 * 构造路径也从不读取这些 intent 字段。是构造时排除，而非事后过滤（§30）。
 *
 * 每档生成后必须过 NetworkDisclosurePolicy 校验（validateNetworkDisclosure），
 * 违反即抛 FanoutDisclosureError（fail-closed，§4.6）。校验器本身是纯函数，
 * 供负向断言直接使用。
 */

import type { LineItem } from "../negotiation/domain/common.js";
import { validateRfq } from "../negotiation/domain/objects.js";
import type { Rfq } from "../negotiation/domain/objects.js";
import type { DisclosureAttribute, DisclosureTier } from "./policy.js";

/** 单行 intent：精确数量（私有）+ 粗粒度数量区间（匿名档只投影区间）。 */
export interface RfqIntentItem {
  sku: string;
  /** 精确数量（私有，只投影到 detailed，且要求 purchase_quantity 被允许）。 */
  quantity: number;
  /** 匿名档披露的粗粒度区间。 */
  quantity_range: { min: number; max: number };
  unit: string;
}

/** 内部 RFQ 意图：含私有字段（§4.4 默认 private）。 */
export interface RfqIntent {
  items: RfqIntentItem[];
  /** 精确交期要求（RFC 3339；只进 detailed）。 */
  delivery_before?: string;
  /** 预算提示（私有，结构性排除，永不披露）。 */
  budget?: { currency: string; amount_minor: number };
  /** 急迫度（私有，结构性排除）。 */
  urgency?: string;
  /** 身份 / 联系方式（私有，结构性排除）。 */
  contact?: { organization?: string; email?: string; phone?: string };
  /** 位置精度（可选披露项，需 disclosure_profile 允许）。 */
  location_precision?: "city" | "district";
  /** 客户段（可选披露项，需允许）。 */
  customer_segment?: string;
  /** 历史偏好（可选披露项，需允许）。 */
  preferences?: string[];
  /** 品类（供 category_sensitivity 判定；构造器不投影）。 */
  category?: string;
}

/** 单 SKU 的数量区间（anonymous 档）。 */
export interface QuantityRange {
  sku: string;
  min: number;
  max: number;
}

export interface AnonymousRfqPayload {
  tier: "anonymous";
  rfq: {
    type: "rfq";
    /** 区间中点数量（LineItem 要求有效数量；真实信号在 quantity_range）。 */
    items: LineItem[];
    requested_terms: { quantity_range: QuantityRange[] };
  };
}

export interface DetailedRfqPayload {
  tier: "detailed";
  rfq: Rfq;
}

export type DisclosedRfqPayload = AnonymousRfqPayload | DetailedRfqPayload;

/** 构造/校验失败。携带 NetworkDisclosurePolicy 拒绝原因列表。 */
export class FanoutDisclosureError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(
      `fan-out disclosure payload failed NetworkDisclosurePolicy validation: ${errors.join("; ")}`,
    );
    this.name = "FanoutDisclosureError";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// 披露档位与 §29 属性映射
// ---------------------------------------------------------------------------

/**
 * 永远私有、结构性排除的 §29 属性：即使 disclosure_profile 显式允许也绝不投影
 * （§4.4 默认 Private：预算 / 急迫度 / 身份 / 联系方式）。校验器同样按此名单拒绝
 * —— 不在 allowlist 语义里，没有豁免路径。
 */
export const ALWAYS_PRIVATE_ATTRIBUTES: readonly DisclosureAttribute[] = [
  "budget_hints",
  "buyer_urgency",
  "contact_information",
  "organization_identity",
];

/** 子串级兜底（双保险）：这些私钥名一旦出现在序列化 payload 里即拒绝。 */
const ALWAYS_PRIVATE_KEYS = ["budget", "urgency", "contact", "email", "phone", "organization"];

/**
 * detailed 档可选披露项（受 disclosure_profile.allowed_attributes 门控）。
 * 映射：§29 属性 → intent 读取器。预算/急迫度/身份/联系方式不在其中 ——
 * 它们结构性排除，构造路径根本不读取。
 */
const OPTIONAL_EXTRACTORS: Readonly<Record<DisclosureAttribute, (intent: RfqIntent) => unknown>> = {
  location_precision: (intent) => intent.location_precision,
  customer_segment: (intent) => intent.customer_segment,
  historical_preferences: (intent) => intent.preferences,
  // 核心字段单独处理；永远私有字段的读取器不存在。
  purchase_quantity: () => undefined,
  organization_identity: () => undefined,
  buyer_urgency: () => undefined,
  contact_information: () => undefined,
  budget_hints: () => undefined,
};

const OPTIONAL_DETAILED_ATTRIBUTES: readonly DisclosureAttribute[] = [
  "location_precision",
  "customer_segment",
  "historical_preferences",
];

function includes<T extends string>(list: readonly T[], value: T): boolean {
  return (list as readonly string[]).includes(value);
}

/** 区间中点（匿名档的 LineItem quantity；真实信号是区间本身）。 */
export function rangeMidpoint(range: { min: number; max: number }): number {
  return Math.round((range.min + range.max) / 2);
}

// ---------------------------------------------------------------------------
// NetworkDisclosurePolicy 校验
// ---------------------------------------------------------------------------

export interface DisclosureValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * NetworkDisclosurePolicy 校验（§29 / §30）。纯函数，供每档生成后 fail-closed
 * 与测试负向断言共用。
 *
 * 检查：
 *   - 永远私有属性结构性缺席（budget/urgency/contact/organization，含子串兜底）；
 *   - anonymous 档必须带 quantity_range，且不得带 delivery_before；
 *   - detailed 档可选披露项必须在 allowed_attributes 里；
 *   - detailed 档精确数量必须在 purchase_quantity 允许时出现，否则必须退回
 *     quantity_range（policy 门控，§29 purchase quantity）。
 */
export function validateNetworkDisclosure(
  payload: DisclosedRfqPayload,
  allowed: readonly DisclosureAttribute[],
): DisclosureValidationResult {
  const errors: string[] = [];
  const serialized = JSON.stringify(payload);

  for (const attr of ALWAYS_PRIVATE_ATTRIBUTES) {
    if (serialized.includes(`"${attr}"`)) {
      errors.push(`payload MUST NOT contain always-private attribute "${attr}"`);
    }
  }
  for (const needle of ALWAYS_PRIVATE_KEYS) {
    if (serialized.includes(`"${needle}`)) {
      errors.push(`payload MUST NOT contain private field "${needle}"`);
    }
  }

  if (payload.tier === "anonymous") {
    const terms = payload.rfq.requested_terms;
    if (terms.quantity_range === undefined || terms.quantity_range.length === 0) {
      errors.push("anonymous tier MUST carry a non-empty quantity_range");
    }
    const asRecord = terms as Record<string, unknown>;
    if (asRecord["delivery_before"] !== undefined) {
      errors.push("anonymous tier MUST NOT carry delivery_before (exact delivery is private)");
    }
  } else {
    const requested = payload.rfq.requested_terms ?? {};
    for (const attr of OPTIONAL_DETAILED_ATTRIBUTES) {
      if (requested[attr] !== undefined && !includes(allowed, attr)) {
        errors.push(`detailed tier carries "${attr}" but disclosure_profile does not allow it`);
      }
    }
    // 精确数量门控：purchase_quantity 未允许时，detailed 必须退回 quantity_range。
    const carriesRange = requested["quantity_range"] !== undefined;
    if (!includes(allowed, "purchase_quantity") && !carriesRange) {
      errors.push(
        "detailed tier MUST fall back to quantity_range when purchase_quantity is not allowed",
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 构造器
// ---------------------------------------------------------------------------

function buildAnonymous(intent: RfqIntent): AnonymousRfqPayload {
  const items: LineItem[] = intent.items.map((item) => ({
    sku: item.sku,
    quantity: { value: rangeMidpoint(item.quantity_range), unit: item.unit },
  }));
  const quantity_range: QuantityRange[] = intent.items.map((item) => ({
    sku: item.sku,
    min: item.quantity_range.min,
    max: item.quantity_range.max,
  }));
  return {
    tier: "anonymous",
    rfq: { type: "rfq", items, requested_terms: { quantity_range } },
  };
}

function buildDetailed(
  intent: RfqIntent,
  allowed: readonly DisclosureAttribute[],
): DetailedRfqPayload {
  const allowPurchaseQuantity = includes(allowed, "purchase_quantity");
  const items: LineItem[] = intent.items.map((item) => ({
    sku: item.sku,
    // 精确数量只在 purchase_quantity 允许时投影；否则退回区间中点（不泄精确量）。
    quantity: {
      value: allowPurchaseQuantity ? item.quantity : rangeMidpoint(item.quantity_range),
      unit: item.unit,
    },
  }));

  const requested: Record<string, unknown> = {};
  if (!allowPurchaseQuantity) {
    requested["quantity_range"] = intent.items.map((item) => ({
      sku: item.sku,
      min: item.quantity_range.min,
      max: item.quantity_range.max,
    }));
  }
  if (intent.delivery_before !== undefined) {
    requested["delivery_before"] = intent.delivery_before;
  }
  for (const attr of OPTIONAL_DETAILED_ATTRIBUTES) {
    if (!includes(allowed, attr)) continue;
    const value = OPTIONAL_EXTRACTORS[attr](intent);
    if (value !== undefined) {
      requested[attr] = value;
    }
  }

  const rfq: Rfq = { type: "rfq", items };
  if (Object.keys(requested).length > 0) {
    rfq.requested_terms = requested;
  }
  return { tier: "detailed", rfq };
}

export interface DisclosureBuildInput {
  intent: RfqIntent;
  tier: DisclosureTier;
  /** §29 属性 allowlist（来自 FanoutPolicy.disclosure_profile.allowed_attributes）。 */
  allowed_attributes: readonly DisclosureAttribute[];
}

/**
 * 按档位构造披露 payload。构造即排除（白名单投影，不读取私有 intent 字段）；
 * 生成后立即过 NetworkDisclosurePolicy 校验，失败即抛（fail-closed）。
 */
export function buildDisclosedRfq(input: DisclosureBuildInput): DisclosedRfqPayload {
  const payload =
    input.tier === "anonymous"
      ? buildAnonymous(input.intent)
      : buildDetailed(input.intent, input.allowed_attributes);
  const check = validateNetworkDisclosure(payload, input.allowed_attributes);
  if (!check.ok) {
    throw new FanoutDisclosureError(check.errors);
  }
  // wire 结构保证：payload.rfq 必须是合法 KNP RFQ（fail-closed，§4.6）。
  validateRfq(payload.rfq);
  return payload;
}
