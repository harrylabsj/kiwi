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
  /** pause_or_resume_listing maps to this listing flag. */
  paused?: boolean;
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
    handoff_destination: typeof v.handoff_destination === "string" ? v.handoff_destination : undefined,
  };
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
