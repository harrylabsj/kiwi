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
 * Commerce Connector boundary (design §2.1.7, §15): the read-side search
 * surface used by Buyer tasks. shopping-cli is the first connector; future
 * external platforms implement the same interface.
 *
 * Connector payloads are untrusted external data (§17): every response is
 * strictly parsed into these DTOs — known fields type-checked, unknown
 * fields isolated (never passed through to the model or the database).
 */

/** Public merchant delivery rule (shopping-cli shape). */
export interface ConnectorDelivery {
  service_area: string;
  /** 未知时为 undefined——**绝不**按 0（免运费）处理（§18.2）。 */
  fee?: number;
  currency: string;
  /** 未知时为 undefined——**绝不**按 0（立即送达）处理（§18.2）。 */
  eta_minutes?: number;
  radius_km: number;
  notes: string;
}

export interface ConnectorMerchant {
  id: string;
  name: string;
  city: string;
  service_area: string;
  hours: string;
  tags: string[];
  delivery: ConnectorDelivery;
  product_count: number;
}

export interface ConnectorProduct {
  sku: string;
  merchant_id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  price: number;
  currency: string;
  stock: number;
  delivery_attributes: string[];
  delivery: ConnectorDelivery;
  merchant: ConnectorMerchant;
  warnings: string[];
}

export interface SearchProductsQuery {
  query?: string;
  city?: string;
  area?: string;
  max_price?: number;
  include_out_of_stock?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchMerchantsQuery {
  query?: string;
  city?: string;
  limit?: number;
  offset?: number;
}

export type ConnectorErrorKind = "transient" | "validation" | "not_found" | "auth";

export class ConnectorError extends Error {
  readonly kind: ConnectorErrorKind;
  constructor(kind: ConnectorErrorKind, message: string) {
    super(message);
    this.name = "ConnectorError";
    this.kind = kind;
  }
}

export interface CommerceConnector {
  readonly connector_id: string;
  readonly platform: string;
  searchProducts(query: SearchProductsQuery): Promise<ConnectorProduct[]>;
  getProduct(sku: string): Promise<ConnectorProduct>;
  searchMerchants(query: SearchMerchantsQuery): Promise<ConnectorMerchant[]>;
  /**
   * Start a consultation (design §11.8/§20-C): create an authoritative
   * Marketplace Conversation about a product and return its id. The buyer task
   * is only *linked* to this conversation — the conversation itself stays
   * authoritative in the marketplace. Reuses the existing negotiation runtime;
   * this never copies or duplicates authoritative state.
   */
  startConsultation(input: {
    buyer_id: string;
    sku: string;
    merchant_id: string;
    opening_message: string;
  }): Promise<{ conversation_id: string; status: string }>;
}

// ---- strict parsing (isolate unknown fields) ------------------------------

function fail(message: string): never {
  throw new ConnectorError("validation", `connector payload rejected: ${message}`);
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

function parseDelivery(value: unknown, at: string): ConnectorDelivery {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${at} must be an object`);
  }
  const v = value as Record<string, unknown>;
  // 审查 P2：缺失的 fee/eta_minutes 是「未知」，不是 0。显式给出的非法值
  // 仍然硬拒绝；缺失则保留 undefined，由 hardFilter/ranker 按未知处理。
  const fee = v.fee === undefined || v.fee === null ? undefined : reqNumber(v.fee, `${at}.fee`);
  const eta =
    v.eta_minutes === undefined || v.eta_minutes === null
      ? undefined
      : reqNumber(v.eta_minutes, `${at}.eta_minutes`);
  return {
    service_area: typeof v.service_area === "string" ? v.service_area : "",
    ...(fee === undefined ? {} : { fee }),
    currency: typeof v.currency === "string" ? v.currency : "CNY",
    ...(eta === undefined ? {} : { eta_minutes: eta }),
    radius_km: reqNumber(v.radius_km ?? 0, `${at}.radius_km`),
    notes: typeof v.notes === "string" ? v.notes : "",
  };
}

export function parseConnectorMerchant(value: unknown): ConnectorMerchant {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("merchant must be an object");
  }
  const v = value as Record<string, unknown>;
  return {
    id: reqString(v.id, "merchant.id"),
    name: typeof v.name === "string" ? v.name : "",
    city: typeof v.city === "string" ? v.city : "",
    service_area: typeof v.service_area === "string" ? v.service_area : "",
    hours: typeof v.hours === "string" ? v.hours : "",
    tags: Array.isArray(v.tags) ? stringArray(v.tags, "merchant.tags") : [],
    delivery: parseDelivery(v.delivery ?? {}, "merchant.delivery"),
    product_count: typeof v.product_count === "number" ? v.product_count : 0,
  };
}

export function parseConnectorProduct(value: unknown): ConnectorProduct {
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
    currency: reqString(v.currency, "product.currency"),
    stock: reqNumber(v.stock, "product.stock"),
    delivery_attributes: Array.isArray(v.delivery_attributes)
      ? stringArray(v.delivery_attributes, "product.delivery_attributes")
      : [],
    delivery: parseDelivery(v.delivery ?? {}, "product.delivery"),
    merchant: parseConnectorMerchant(v.merchant ?? {}),
    warnings: Array.isArray(v.warnings) ? stringArray(v.warnings, "product.warnings") : [],
  };
}
