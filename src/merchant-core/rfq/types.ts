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
 * RFQ 工作台领域类型与序列化权威（询报价工作台设计 v0.1.1 §6/§8/§10.3）。
 *
 * 类型与 contracts/merchant-rfq/0.1.0/ 的八份 JSON Schema 对齐；schema 是
 * 序列化权威，本文件类型经 tests/merchant-rfq 契约一致性测试维护。
 *
 * 内容摘要（rfq-canonical-json-v1）：对象键限定 ASCII、按字典序排序、
 * UTF-8、无多余空白、禁止浮点与非有限数值；字符串内容原样保存（不做
 * 隐式 Unicode 归一）。它不是 KNP 的 JCS——禁止把此摘要替换现有 wire
 * digest。对合法值与既有 contentHash 行为一致（契约测试覆盖）。
 */

import { createHash } from "node:crypto";

/** RFQ 业务错误（设计 v0.1.1 §11.3 错误码；MCP 层映射为带内错误）。 */
export type RfqErrorCode =
  | "auth"
  | "forbidden"
  | "not_found"
  | "validation"
  | "unavailable"
  | "tenant_mismatch"
  | "needs_clarification"
  | "sku_ambiguous"
  | "source_unavailable"
  | "source_conflict"
  | "source_invalid"
  | "fact_stale"
  | "pricing_invalid"
  | "unsupported_term"
  | "policy_requires_review"
  | "version_conflict"
  | "approval_stale"
  | "idempotency_conflict"
  | "operation_unknown"
  | "case_closed";

export class RfqError extends Error {
  readonly code: RfqErrorCode;
  constructor(code: RfqErrorCode, message: string) {
    super(message);
    this.name = "RfqError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// rfq-canonical-json-v1
// ---------------------------------------------------------------------------

const ASCII_KEY = /^[\x20-\x7E]+$/;

/**
 * 规范化序列化（v0.1.1 §10.3）。数组保序；对象键 ASCII 且字典序排序；
 * number 仅接受安全整数（浮点/非有限值拒绝——金额与数量绝不以浮点进入
 * 摘要）；undefined 键剔除（与既有 stableStringify 一致，重试幂等依赖它）。
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        if (!ASCII_KEY.test(k)) {
          throw new RfqError("validation", `rfq-canonical-json-v1：对象键必须为 ASCII（${k.slice(0, 8)}…）`);
        }
        return [k, v] as const;
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RfqError("validation", "rfq-canonical-json-v1：禁止浮点与非有限数值");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new RfqError("validation", "rfq-canonical-json-v1：禁止 bigint（先转安全整数）");
  }
  return JSON.stringify(value) ?? "null";
}

/** 规范化 JSON 的 sha256 内容摘要（sha256: 前缀，与既有 contentHash 同风格）。 */
export function rfqContentDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// 状态域（v0.1.1 §8.1；四个状态域独立维护，绝不相互推导）
// ---------------------------------------------------------------------------

export const RFQ_STAGES = [
  "NEW",
  "NEEDS_CLARIFICATION",
  "READY",
  "PRICED",
  "CLOSED",
  "CANCELLED",
] as const;
export type RfqStage = (typeof RFQ_STAGES)[number];

export const QUOTE_STATUSES = [
  "DRAFT",
  "VALIDATED",
  "PENDING_APPROVAL",
  "APPROVED",
  "EXPORTED",
  "REJECTED",
  "SUPERSEDED",
  "EXPIRED",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** 报价生命周期事件（rfq_quote_events 投影；当前状态 = 最新事件）。 */
export type QuoteEventKind = Exclude<QuoteStatus, "DRAFT">;

export const DELIVERY_STATUSES = [
  "NOT_SENT",
  "REPORTED_SENT",
  "RECEIPT_VERIFIED",
  "DELIVERY_UNKNOWN",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const HANDOFF_STATUSES = [
  "PACKET_READY",
  "OWNER_RECORDED",
  "TARGET_VERIFIED",
  "REJECTED",
  "UNKNOWN",
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

// ---------------------------------------------------------------------------
// 询盘与规范字段（对齐 rfq-case.schema.json）
// ---------------------------------------------------------------------------

export interface RfqLine {
  line_id: string;
  /** 客户原始需求描述（未经模型改写）。 */
  query: string;
  sku: string | null;
  quantity: number | null;
  unit: string | null;
  confirmation: "unconfirmed" | "confirmed";
  /** 服务端验证过的具名确认引用（模型自报 human_confirmed 不作数）。 */
  confirmation_ref: string | null;
  evidence_source_ids: string[];
}

export interface RfqTerms {
  currency: "CNY";
  tax_basis: "UNKNOWN" | "INCLUSIVE" | "EXCLUSIVE";
  tax_rate_bps: number | null;
  shipping_known: boolean;
  shipping_minor: number | null;
  /** 已确认交期表达（原文口径；不做自然语言承诺扩展）。 */
  delivery_date: string | null;
  payment_terms: string | null;
}

/** 一版需求 revision 的规范字段（rfq_case_revisions.fields_json）。 */
export interface RfqCaseFields {
  client_ref: string;
  recipient_ref: string | null;
  lines: RfqLine[];
  terms: RfqTerms;
}

/** 规范字段缺口（view 级投影；NEEDS_CLARIFICATION 的依据）。 */
export interface RfqBlocker {
  field: string;
  reason: string;
}

/** 文本来源定位：Unicode code point 半开区间（不是 UTF-8 字节偏移）。 */
export interface TextSpanLocator {
  kind: "text_span";
  character_start: number;
  character_end: number;
  quote: string;
}

/** CSV 来源定位：1 起算数据行号 + 列名。 */
export interface CsvCellLocator {
  kind: "csv_cell";
  row_start: number;
  row_end: number;
  column: string;
}

export type SourceLocator = TextSpanLocator | CsvCellLocator;

// ---------------------------------------------------------------------------
// 事实快照（对齐 fact-snapshot.schema.json；§6.3 权威/新鲜度）
// ---------------------------------------------------------------------------

export type FactAuthority = "LOCAL_AUTHORITATIVE" | "UPSTREAM_PROXY" | "READ_ONLY";

/** 单字段事实（对齐 fact-snapshot.schema.json：八字段全必填）。 */
export interface FactField {
  field_path: string;
  value: string | number | boolean | null;
  authority: FactAuthority;
  source: string;
  /** 源版本；上游未提供时记 "unknown"（发布时按缺验证阻断，§6.3）。 */
  source_version: string;
  verified_at: string;
  /** 快照内过期时点（verified_at + fresh_for_seconds；无阈值时 = fetched_at + rules 阈值）。 */
  expires_at: string;
  /** 可见性：进入模型工具结果的字段必须 model_public（§15.2）。 */
  visibility: "model_public" | "operator_only";
}

// ---------------------------------------------------------------------------
// 计价与报价（对齐 pricing-input / quote-revision.schema.json）
// ---------------------------------------------------------------------------

export type TaxBasis = "EXCLUSIVE" | "INCLUSIVE";

export interface PricingLineInput {
  line_id: string;
  /** SKU / 单位为透传字段（供投影与策略使用，不参与算术）。 */
  sku?: string;
  unit?: string;
  quantity: number;
  unit_price_minor: number;
  discount_minor: number;
  tax_basis: TaxBasis;
  tax_rate_bps: number;
}

export interface PricingShippingInput {
  amount_minor: number;
  tax_basis: TaxBasis;
  tax_rate_bps: number;
}

/** PricingEngine 的纯函数输入（§7.4：不接受模型提交的最终金额）。 */
export interface PricingInput {
  schema_version: "0.1.0";
  currency: "CNY";
  rounding: "HALF_UP_LINE";
  lines: PricingLineInput[];
  shipping: PricingShippingInput;
}

export interface PricingSplit {
  net_minor: number;
  tax_minor: number;
  gross_minor: number;
}

export interface PricingResult {
  lines: Array<PricingSplit & { line_id: string }>;
  shipping: PricingSplit;
  totals: PricingSplit;
}

/** 客户投影（公开字段白名单；绝不包含成本/底价/内部备注）。 */
export interface PublicQuoteView {
  quote_id: string;
  revision: number;
  case_id: string;
  case_revision: number;
  status: QuoteStatus;
  recipient_ref: string;
  client_ref: string;
  currency: "CNY";
  totals: PricingSplit;
  lines: Array<{
    line_id: string;
    sku: string;
    quantity: number;
    unit: string;
    unit_price_minor: number;
    discount_minor: number;
    tax_basis: TaxBasis;
    tax_rate_bps: number;
  }>;
  shipping: { amount_minor: number; tax_basis: TaxBasis; tax_rate_bps: number };
  delivery_terms: string;
  payment_terms: string;
  valid_until: string;
  /** 数据截至时间 + 产品边界（§14.2 客户文件必含）。 */
  data_as_of: string;
  nonbinding_execution_boundary: string;
}

/** 两版报价的字段级差异（§11.1 compare；只读）。 */
export interface QuoteDiff {
  from: { quote_id: string; revision: number; status: QuoteStatus };
  to: { quote_id: string; revision: number; status: QuoteStatus };
  changed: Array<{ field: string; from: unknown; to: unknown }>;
  from_invalid_reason?: string;
  to_invalid_reason?: string;
}
