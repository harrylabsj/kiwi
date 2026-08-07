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
 * KNP/1.0 公共数据类型与校验原语（子规范 §7 Common Data Types）。
 *
 * Money、Quantity、TermSet 是所有 negotiation object 共享的基础类型。
 * 校验采用 fail-closed（基线 §4.6 / §33）：无法证明合法即为非法。
 * 所有校验错误统一抛出 NegotiationValidationError，`code` 对齐子规范 §18
 * 的 protocol error 词表（默认 schema_invalid；具体语义错误如
 * protocol_version_unsupported / field_unsupported / state_conflict 单独标注）。
 */

export const KNP_PROTOCOL_VERSION = "1.0" as const;

/** KNP/1.0 协议错误词表（子规范 §18）。 */
export const PROTOCOL_ERROR_CODES = [
  "protocol_version_unsupported",
  "capability_incompatible",
  "schema_invalid",
  "field_unsupported",
  "structured_text_conflict",
  "identity_rejected",
  "authentication_required",
  "authorization_failed",
  "offer_unknown",
  "offer_expired",
  "offer_withdrawn",
  "terms_digest_mismatch",
  "condition_conflict",
  "state_conflict",
  "approval_required",
  "idempotency_conflict",
  "replay_detected",
  "rate_limited",
  "temporarily_unavailable",
  "reconciliation_required",
] as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

/** 结构/语义校验失败。`path` 为 JSON Pointer 风格的字段路径。 */
export class NegotiationValidationError extends Error {
  readonly code: ProtocolErrorCode;
  readonly path: string;
  constructor(code: ProtocolErrorCode, message: string, path: string) {
    super(message);
    this.name = "NegotiationValidationError";
    this.code = code;
    this.path = path;
  }
}

/** 默认 schema 校验错误。 */
export function schemaError(path: string, message: string): NegotiationValidationError {
  return new NegotiationValidationError("schema_invalid", message, path);
}

// ---------------------------------------------------------------------------
// 校验原语
// ---------------------------------------------------------------------------

export function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw schemaError(path, `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw schemaError(path, `${path} must be an array`);
  }
  return value;
}

export function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw schemaError(path, `${path} must be a string`);
  }
  return value;
}

export function requireNonEmptyString(value: unknown, path: string): string {
  const s = requireString(value, path);
  if (s.length === 0) {
    throw schemaError(path, `${path} must be a non-empty string`);
  }
  return s;
}

/** 整数（含 0 与负数）；Number.isInteger 同时排除 NaN/Infinity/float。 */
export function requireInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw schemaError(path, `${path} must be an integer`);
  }
  return value;
}

/** 布尔（v1.1 KTH 三副作用不变量等）。 */
export function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw schemaError(path, `${path} must be a boolean`);
  }
  return value;
}

export function requirePositiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw schemaError(path, `${path} must be a positive number`);
  }
  return value;
}

export function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  const s = requireNonEmptyString(value, path);
  if (!(allowed as readonly string[]).includes(s)) {
    throw schemaError(path, `${path} must be one of ${allowed.join("|")}`);
  }
  return s as T;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * RFC 3339 时间戳（子规范 §7.3）。
 * 格式正则之外还要 Date.parse 真实可解析：`2026-13-01T00:00:00Z` 等越界
 * 时间/日期能过正则但 Date.parse 返回 NaN（fail-open 缺口，见
 * transaction.ts 过期门）。不可解析 → schemaError（fail-closed）。
 */
export function requireIsoTimestamp(value: unknown, path: string): string {
  const s = requireNonEmptyString(value, path);
  if (!RFC3339.test(s)) {
    throw schemaError(path, `${path} must be an RFC 3339 timestamp`);
  }
  if (!Number.isFinite(Date.parse(s))) {
    throw schemaError(path, `${path} must be a parseable RFC 3339 timestamp`);
  }
  return s;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** `sha256:` 前缀的小写 hex 摘要（子规范 §19.2/§19.3）。 */
export function requireDigest(value: unknown, path: string): string {
  const s = requireNonEmptyString(value, path);
  if (!DIGEST.test(s)) {
    throw schemaError(path, `${path} must be sha256:<64 lowercase hex>`);
  }
  return s;
}

/** 判别字段检查：`obj.type` 必须等于期望值。 */
export function requireType(obj: Record<string, unknown>, expected: string, path: string): void {
  if (obj.type !== expected) {
    throw schemaError(`${path}/type`, `type must be ${expected}`);
  }
}

// ---------------------------------------------------------------------------
// Money / Quantity / LineItem / TermSet（子规范 §7.1 / §7.2 / §7.4）
// ---------------------------------------------------------------------------

export interface Money {
  /** 三位大写货币代码。 */
  currency: string;
  /** 最小货币单位；协议禁止 float 金额（§7.1）。 */
  amount_minor: number;
}

export function validateMoney(value: unknown, path: string): Money {
  const obj = requireObject(value, path);
  const currency = requireNonEmptyString(obj.currency, `${path}/currency`);
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw schemaError(`${path}/currency`, "currency must be a three-letter uppercase code");
  }
  const amountMinor = requireInteger(obj.amount_minor, `${path}/amount_minor`);
  if (amountMinor < 0) {
    throw schemaError(`${path}/amount_minor`, "amount_minor must be a non-negative integer");
  }
  return { currency, amount_minor: amountMinor };
}

export interface Quantity {
  /** 正数（§7.2）。 */
  value: number;
  unit: string;
}

export function validateQuantity(value: unknown, path: string): Quantity {
  const obj = requireObject(value, path);
  return {
    value: requirePositiveNumber(obj.value, `${path}/value`),
    unit: requireNonEmptyString(obj.unit, `${path}/unit`),
  };
}

export interface LineItem {
  sku: string;
  quantity: Quantity;
  /** Offer 等 offer-like 项的 unit_price 由调用方通过 opts 强制。 */
  unit_price?: Money;
}

export function validateLineItem(
  value: unknown,
  path: string,
  opts: { requireUnitPrice?: boolean } = {},
): LineItem {
  const obj = requireObject(value, path);
  const item: LineItem = {
    sku: requireNonEmptyString(obj.sku, `${path}/sku`),
    quantity: validateQuantity(obj.quantity, `${path}/quantity`),
  };
  if (obj.unit_price !== undefined) {
    item.unit_price = validateMoney(obj.unit_price, `${path}/unit_price`);
  } else if (opts.requireUnitPrice === true) {
    throw schemaError(`${path}/unit_price`, "unit_price is required on offer-like items");
  }
  return item;
}

export interface TermSet {
  items?: LineItem[];
  price_terms?: Record<string, unknown>;
  fulfillment_terms?: Record<string, unknown>;
  service_terms?: Record<string, unknown>;
  payment_terms?: Record<string, unknown>;
  valid_until?: string;
}

/**
 * TermSet 校验（§7.4）。稳定顶层域：items / price_terms / fulfillment_terms /
 * service_terms / payment_terms / valid_until。payment_terms 只表达商业条件，
 * 不代表支付授权。
 */
export function validateTermSet(
  value: unknown,
  path: string,
  opts: { requireUnitPrice?: boolean } = {},
): TermSet {
  const obj = requireObject(value, path);
  const terms: TermSet = {};
  if (obj.items !== undefined) {
    terms.items = requireArray(obj.items, `${path}/items`).map((item, i) =>
      validateLineItem(item, `${path}/items/${i}`, opts),
    );
  }
  if (obj.price_terms !== undefined) {
    terms.price_terms = requireObject(obj.price_terms, `${path}/price_terms`);
  }
  if (obj.fulfillment_terms !== undefined) {
    const fulfillment = requireObject(obj.fulfillment_terms, `${path}/fulfillment_terms`);
    if (fulfillment.delivery_before !== undefined) {
      requireIsoTimestamp(fulfillment.delivery_before, `${path}/fulfillment_terms/delivery_before`);
    }
    terms.fulfillment_terms = fulfillment;
  }
  if (obj.service_terms !== undefined) {
    terms.service_terms = requireObject(obj.service_terms, `${path}/service_terms`);
  }
  if (obj.payment_terms !== undefined) {
    terms.payment_terms = requireObject(obj.payment_terms, `${path}/payment_terms`);
  }
  if (obj.valid_until !== undefined) {
    terms.valid_until = requireIsoTimestamp(obj.valid_until, `${path}/valid_until`);
  }
  return terms;
}
