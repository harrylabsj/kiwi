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
 * Merchant capability-pack types (design §14–§15).
 *
 * The merchant agent manages catalog, inventory, incoming consultations and
 * the human-review queue through these DTOs. Connector payloads are untrusted
 * external data: every response is strictly parsed, unknown fields isolated.
 * Private merchant values (floor prices, costs) never appear here — they live
 * in the Vault and are only ever served to the model as metadata_only.
 */

/** A merchant's own catalog product (shopping-cli catalog shape). */
export interface MerchantCatalogProduct {
  sku: string;
  merchant_id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  price: number;
  currency: string;
  /** 精确库存仅在持有商户凭据时返回（design v0.3 §7 private inventory，
   *  审查 P2-1）；匿名读降级为 availability_hint，此处为 undefined。 */
  stock?: number;
  delivery_attributes: string[];
  /** Listing active flag. When true the product is paused/hidden from search. */
  paused: boolean;
  /** 商家声明的每商品成交入口（shopping-cli products.handoff_destination；KTH
   *  handoff 用，商家协商 agreement 直传 buyer）。 */
  handoff_destination?: string;
}

export interface MerchantProductInput {
  sku: string;
  merchant_id: string;
  title: string;
  price: number;
  stock: number;
  currency?: string;
  category?: string;
  tags?: string[];
  description?: string;
  delivery_attributes?: string[];
}

export interface MerchantProductPatch {
  title?: string;
  price?: number;
  stock?: number;
  currency?: string;
  category?: string;
  tags?: string[];
  description?: string;
  delivery_attributes?: string[];
}

export interface ExactMerchantProduct {
  sku: string;
  merchant_id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  stock: number;
  currency: string;
  price_minor: string;
  currency_table_version: string;
  authority_version: number;
  delivery_attributes: string[];
  handoff_destination: string;
}

export interface ExactMerchantProductInput {
  operation_id: string;
  merchant_id: string;
  sku: string;
  title: string;
  price_minor: string;
  stock: number;
  expected_authority_version: number;
  currency: string;
  currency_table_version: string;
  description?: string;
  category?: string;
  tags?: string[];
  delivery_attributes?: string[];
  handoff_destination?: string;
}

/**
 * 下游 operation 的 kind 词表——**与 shopping-cli 的 CHECK 约束同源**。
 *
 * 收敛到一处是刻意的：上游 migration_029/030 把词表写进了 CHECK，于是每加一个 kind
 * 都要重建表；这里若再枚举一遍（类型 + 解析器两处），就会变成"改一处忘一处"。
 * 加 kind 时：本数组 + 上游 CHECK（需迁移重建）同步改。
 */
export const MERCHANT_PRODUCT_OPERATION_KINDS = [
  "exact_product_create",
  "exact_product_money_update",
  "product_inventory_update",
] as const;
export type MerchantProductOperationKind = (typeof MERCHANT_PRODUCT_OPERATION_KINDS)[number];

export interface MerchantProductOperation {
  operation_id: string;
  merchant_id: string;
  operation_kind: MerchantProductOperationKind;
  sku: string;
  status: "succeeded";
  created_at: string;
}

export interface IncomingConsultation {
  conversation_id: string;
  /** e.g. waiting_merchant / waiting_buyer / human_required / closed. */
  status: string;
  buyer_id?: string;
  sku?: string;
  last_message: string;
  last_message_at: string;
}

export interface HumanReviewItem {
  review_id: string | number;
  conversation_id: string;
  buyer_id: string;
  sku: string;
  reason: string;
  severity: string;
  created_at: string;
  resolved_at?: string;
  resolution?: string;
}

export interface InventorySnapshot {
  sku: string;
  /** 无商户凭据时（匿名读）为空——精确库存是私密 inventory（审查 P2-1）。 */
  stock?: number;
  /** Observed at — never present current state as timeless fact (§18.2). */
  observed_at: string;
}

/**
 * The merchant write surface. Read calls that are merchant-scoped (listing
 * one's own catalog, inventory, consultations, human-review queue) require the
 * catalog credential; negotiation reads/writes require the negotiation
 * credential. `create/update/pause` require catalog; `updateInventory` is the
 * inventory scope. All tokens are supplied by the CredentialBroker — this
 * client never sees or stores a token beyond the per-call header.
 */
export interface MerchantClient {
  listProducts(merchantId: string): Promise<MerchantCatalogProduct[]>;
  getProduct(sku: string): Promise<MerchantCatalogProduct>;
  createProduct(input: MerchantProductInput): Promise<MerchantCatalogProduct>;
  updateProduct(sku: string, patch: MerchantProductPatch): Promise<MerchantCatalogProduct>;
  getInventorySnapshot(sku: string): Promise<InventorySnapshot>;
  /** Inventory-scope write: set the stock of a product. */
  updateInventory(sku: string, stock: number): Promise<MerchantCatalogProduct>;
  listIncomingConsultations(merchantId: string): Promise<IncomingConsultation[]>;
  getHumanReviewQueue(merchantId: string): Promise<HumanReviewItem[]>;
  /** Pause/resume a listing (fail closed on gateways without this endpoint). */
  pauseListing(sku: string, paused: boolean): Promise<MerchantCatalogProduct>;
  listExactProducts(merchantId: string): Promise<ExactMerchantProduct[]>;
  getExactProduct(merchantId: string, sku: string): Promise<ExactMerchantProduct>;
  createExactProduct(input: ExactMerchantProductInput): Promise<ExactMerchantProduct>;
  updateExactProductMoney(input: {
    operation_id: string;
    merchant_id: string;
    sku: string;
    price_minor: string;
    currency_table_version: string;
    expected_authority_version: number;
  }): Promise<ExactMerchantProduct>;
  /**
   * v1 库存写入 + **同事务 operation receipt**（B 线）。
   *
   * 与 `updateInventory`（legacy 路径）的区别是**可对账**：本方法落回执，于是外部写
   * 落进 UNKNOWN 时可以按 `operation_id` **查明副作用是否真的发生过**，而不是拿
   * **当前**库存值去猜**历史**操作的结果。回执经 `getProductOperation` 查询。
   *
   * 前置：商家须在 exact 线上（v1 面口径，回执投影读金额权威）。
   */
  updateInventoryExact(input: {
    operation_id: string;
    merchant_id: string;
    sku: string;
    stock: number;
    currency_table_version: string;
  }): Promise<ExactMerchantProduct>;

  getProductOperation(
    merchantId: string,
    operationId: string,
  ): Promise<MerchantProductOperation>;
}

export class MerchantClientError extends Error {
  readonly kind: "transient" | "validation" | "not_found" | "auth";
  constructor(kind: MerchantClientError["kind"], message: string) {
    super(message);
    this.name = "MerchantClientError";
    this.kind = kind;
  }
}

// ---- strict parsing (isolate unknown fields) -------------------------------

function fail(message: string): never {
  throw new MerchantClientError("validation", `merchant client payload rejected: ${message}`);
}

function reqString(value: unknown, at: string): string {
  if (typeof value !== "string") fail(`${at} must be a string`);
  return value;
}

function reqNumber(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${at} must be a finite number`);
  return value;
}

function reqInteger(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`${at} must be an integer`);
  return value;
}

function reqMinorText(value: unknown, at: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail(`${at} must be an exact non-negative minor-unit string`);
  }
  return value;
}

export function parseExactMerchantProduct(value: unknown): ExactMerchantProduct {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("exact product must be an object");
  }
  const v = value as Record<string, unknown>;
  return {
    sku: reqString(v.sku, "product.sku"),
    merchant_id: reqString(v.merchant_id, "product.merchant_id"),
    title: reqString(v.title, "product.title"),
    description: typeof v.description === "string" ? v.description : "",
    category: typeof v.category === "string" ? v.category : "",
    tags: Array.isArray(v.tags) ? stringArray(v.tags, "product.tags") : [],
    stock: reqInteger(v.stock, "product.stock"),
    currency: reqString(v.currency, "product.currency"),
    price_minor: reqMinorText(v.price_minor, "product.price_minor"),
    currency_table_version: reqString(v.currency_table_version, "product.currency_table_version"),
    authority_version: reqInteger(v.authority_version, "product.authority_version"),
    delivery_attributes: Array.isArray(v.delivery_attributes)
      ? stringArray(v.delivery_attributes, "product.delivery_attributes")
      : [],
    handoff_destination: typeof v.handoff_destination === "string" ? v.handoff_destination : "",
  };
}

export function parseMerchantProductOperation(value: unknown): MerchantProductOperation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("merchant product operation must be an object");
  }
  const v = value as Record<string, unknown>;
  const operationKind = reqString(v.operation_kind, "operation.operation_kind");
  if (!(MERCHANT_PRODUCT_OPERATION_KINDS as readonly string[]).includes(operationKind)) {
    fail("operation.operation_kind is invalid");
  }
  if (v.status !== "succeeded") fail("operation.status is invalid");
  return {
    operation_id: reqString(v.operation_id, "operation.operation_id"),
    merchant_id: reqString(v.merchant_id, "operation.merchant_id"),
    operation_kind: operationKind as MerchantProductOperationKind,
    sku: reqString(v.sku, "operation.sku"),
    status: "succeeded",
    created_at: reqString(v.created_at, "operation.created_at"),
  };
}

function stringArray(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(`${at} must be a string array`);
  }
  return value as string[];
}

/** Parse a catalog product, tolerating both the public and merchant shapes. */
export function parseMerchantCatalogProduct(value: unknown): MerchantCatalogProduct {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("product must be an object");
  }
  const v = value as Record<string, unknown>;
  return {
    sku: reqString(v.sku, "product.sku"),
    merchant_id: reqString(v.merchant_id, "product.merchant_id"),
    title: reqString(v.title, "product.title"),
    description: typeof v.description === "string" ? v.description : "",
    category: typeof v.category === "string" ? v.category : "",
    tags: Array.isArray(v.tags) ? stringArray(v.tags, "product.tags") : [],
    price: reqNumber(v.price, "product.price"),
    currency: typeof v.currency === "string" ? v.currency : "CNY",
    stock: typeof v.stock === "number" ? v.stock : undefined,
    delivery_attributes: Array.isArray(v.delivery_attributes)
      ? stringArray(v.delivery_attributes, "product.delivery_attributes")
      : [],
    paused: typeof v.paused === "boolean" ? v.paused : v.active === false,
    handoff_destination:
      typeof v.handoff_destination === "string" ? v.handoff_destination : undefined,
  };
}

/**
 * 解析商品创建入参（白名单 + 类型校验；MCP/命令面共用）。merchant_id 强制
 * 归属商家：缺省补 ownerId，传入不一致直接拒绝（防跨租户写）。非数值/负数
 * price、负数或非整数 stock 一律拒绝——审批前的 prepare 即失败，不烧人工确认。
 */
export function parseProductCreateInput(value: unknown, ownerId: string): MerchantProductInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("product 必须是对象");
  }
  const v = value as Record<string, unknown>;
  const merchantId =
    typeof v.merchant_id === "string" && v.merchant_id !== "" ? v.merchant_id : ownerId;
  if (merchantId !== ownerId) {
    throw new TypeError(`product.merchant_id 与本实例商家不一致（不允许跨商家创建）`);
  }
  const sku = typeof v.sku === "string" ? v.sku.trim() : "";
  if (sku === "") throw new TypeError("product.sku 必须是非空字符串");
  const title = typeof v.title === "string" ? v.title.trim() : "";
  if (title === "") throw new TypeError("product.title 必须是非空字符串");
  if (typeof v.price !== "number" || !Number.isFinite(v.price) || v.price < 0) {
    throw new TypeError("product.price 必须是非负有限数值");
  }
  if (typeof v.stock !== "number" || !Number.isInteger(v.stock) || v.stock < 0) {
    throw new TypeError("product.stock 必须是非负整数");
  }
  const input: MerchantProductInput = {
    merchant_id: merchantId,
    sku,
    title,
    price: v.price,
    stock: v.stock,
  };
  if (typeof v.currency === "string" && v.currency !== "") input.currency = v.currency;
  if (typeof v.category === "string" && v.category !== "") input.category = v.category;
  if (typeof v.description === "string") input.description = v.description;
  if (Array.isArray(v.tags)) input.tags = stringArray(v.tags, "product.tags");
  if (Array.isArray(v.delivery_attributes))
    input.delivery_attributes = stringArray(v.delivery_attributes, "product.delivery_attributes");
  return input;
}

export function parseInventorySnapshot(value: unknown, sku: string): InventorySnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("inventory snapshot must be an object");
  }
  const v = value as Record<string, unknown>;
  return {
    sku: typeof v.sku === "string" ? v.sku : sku,
    stock:
      typeof v.stock === "number"
        ? v.stock
        : typeof v.quantity === "number"
          ? v.quantity
          : undefined,
    observed_at: typeof v.observed_at === "string" ? v.observed_at : new Date().toISOString(),
  };
}

export function parseIncomingConsultation(value: unknown): IncomingConsultation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("consultation must be an object");
  }
  const v = value as Record<string, unknown>;
  // shopping-cli conversation summaries use `id`; the agent DTO uses
  // `conversation_id` — accept both (fail closed only when both are absent).
  const conversationId =
    typeof v.conversation_id === "string"
      ? v.conversation_id
      : typeof v.id === "string" || typeof v.id === "number"
        ? String(v.id)
        : undefined;
  if (conversationId === undefined) fail("consultation.conversation_id/id is required");
  // Last message may be nested in `messages` (real gateway) or flat.
  const messages = Array.isArray(v.messages) ? (v.messages as Record<string, unknown>[]) : [];
  const lastMsg = messages.length > 0 ? (messages[messages.length - 1] ?? {}) : {};
  const nestedText = typeof lastMsg.public_message === "string" ? lastMsg.public_message : "";
  return {
    conversation_id: conversationId,
    status: typeof v.status === "string" ? v.status : "",
    ...(typeof v.buyer_id === "string" ? { buyer_id: v.buyer_id } : {}),
    ...(typeof v.sku === "string" ? { sku: v.sku } : {}),
    last_message: typeof v.last_message === "string" ? v.last_message : nestedText,
    last_message_at:
      typeof v.last_message_at === "string"
        ? v.last_message_at
        : typeof v.updated_at === "string"
          ? v.updated_at
          : new Date().toISOString(),
  };
}

function reqId(value: unknown, at: string): string | number {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  fail(`${at} must be a positive integer or non-empty string`);
}

export function parseHumanReviewItem(value: unknown): HumanReviewItem {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("review must be an object");
  }
  const v = value as Record<string, unknown>;
  return {
    // shopping-cli summaries use `id`; the DTO uses `review_id` — accept both.
    review_id: reqId(v.review_id ?? v.id, "review.review_id/id"),
    conversation_id: reqString(v.conversation_id ?? v.id, "review.conversation_id/id"),
    buyer_id: reqString(v.buyer_id, "review.buyer_id"),
    sku: reqString(v.sku, "review.sku"),
    reason: typeof v.reason === "string" ? v.reason : "",
    severity: typeof v.severity === "string" ? v.severity : "info",
    created_at: reqString(v.created_at, "review.created_at"),
    ...(typeof v.resolved_at === "string" ? { resolved_at: v.resolved_at } : {}),
    ...(typeof v.resolution === "string" ? { resolution: v.resolution } : {}),
  };
}
