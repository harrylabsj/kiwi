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
 * shopping-cli HTTP Merchant client (design §15.3/§15.4).
 *
 * Catalog/inventory/conversation reads and writes against the real gateway.
 * Tokens come from the CredentialBroker per scope: catalog writes and
 * merchant-scoped reads use the catalog credential, inventory writes use the
 * inventory credential. Tokens are attached per-request and never stored.
 *
 * Trade-off (fail-closed): shopping-cli 2.x has no listing pause/resume
 * endpoint (`active` is internal to the catalog), so pauseListing refuses
 * here with a clear message — the approval machinery still runs, only the
 * final write is refused.
 */

import type { CredentialBroker } from "./credential-broker.js";
import type {
  HumanReviewItem,
  IncomingConsultation,
  InventorySnapshot,
  MerchantCatalogProduct,
  MerchantClient,
  MerchantProductInput,
  MerchantProductPatch,
} from "./types.js";
import {
  MerchantClientError,
  parseHumanReviewItem,
  parseIncomingConsultation,
  parseMerchantCatalogProduct,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;

export class HttpMerchantClient implements MerchantClient {
  private readonly baseUrl: string;
  private readonly broker: CredentialBroker;

  constructor(baseUrl: string, broker: CredentialBroker) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.broker = broker;
  }

  // ---- HTTP plumbing -------------------------------------------------------

  private async request(
    method: "GET" | "POST" | "PATCH",
    pathname: string,
    options: { query?: Record<string, string>; body?: unknown; token?: string } = {},
  ): Promise<unknown> {
    const url = `${this.baseUrl}${pathname}${
      options.query ? `?${new URLSearchParams(options.query).toString()}` : ""
    }`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        // 审查 P2-H：携带 Bearer token 的请求绝不跟随 3xx——重定向会把凭据
        // 转发到第三方域（同仓 http-connector.ts 同款纪律注释）。3xx 在
        // manual 模式下不进 response.ok，下方按非 2xx 处理（fail-closed）。
        redirect: "manual",
        headers: {
          accept: "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new MerchantClientError(
        "transient",
        `merchant request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    // 响应体大小上限（审查 P2-H 配套项：此前无上限，恶意网关可回传巨量 body）。
    const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    let payload: unknown;
    try {
      const raw = await response.arrayBuffer();
      if (raw.byteLength > MAX_RESPONSE_BYTES) {
        throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      const text = new TextDecoder("utf-8").decode(raw);
      payload = text === "" ? null : JSON.parse(text);
    } catch (err) {
      throw new MerchantClientError(
        "transient",
        `merchant returned non-JSON or oversized body (HTTP ${response.status}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!response.ok) {
      const kind =
        response.status === 404
          ? "not_found"
          : response.status === 401 || response.status === 403
            ? "auth"
            : response.status >= 400 && response.status < 500
              ? "validation"
              : "transient";
      throw new MerchantClientError(kind, `merchant HTTP ${response.status} for ${pathname}`);
    }
    return payload;
  }

  /** Catalog credential token; missing scope -> fail closed. */
  private catalogToken(): string {
    const token = this.broker.resolve("catalog");
    if (token === undefined) {
      throw new MerchantClientError(
        "auth",
        "没有 catalog 作用域凭据（commerce.credentials.catalog.token_env 未配置）",
      );
    }
    return token;
  }

  // ---- catalog ---------------------------------------------------------------

  async listProducts(merchantId: string): Promise<MerchantCatalogProduct[]> {
    // Public search endpoint returns merchant_id per product; filter locally.
    // Real gateway has no merchant-owned product listing route.
    // include_out_of_stock=1：商家自查目录要看到全部在架商品（含缺货/暂停），
    // 买家搜索默认排除缺货的行为不适用于商家自己的商品清单。
    // 审查 P2-1：精确库存是私密 inventory——带 catalog 凭据（可解析时）读，
    // 网关按 owner 校验后返回本商家精确 stock；未配置凭据则匿名读（无 stock）。
    const token = this.broker.resolve("catalog");
    const payload = (await this.request("GET", "/search/products", {
      query: { limit: "100", offset: "0", include_out_of_stock: "1" },
      ...(token !== undefined ? { token } : {}),
    })) as { results?: unknown };
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.results)) {
      throw new MerchantClientError("validation", "search/products response lacks a results array");
    }
    return payload.results
      .map((p) => parseMerchantCatalogProduct(p))
      .filter((p) => p.merchant_id === merchantId);
  }

  async getProduct(sku: string): Promise<MerchantCatalogProduct> {
    // 审查 P2-1：精确库存仅向商品所属商户本人开放——带 catalog 凭据
    // （可解析时）读，网关按 owner 校验；未配置凭据则匿名读（availability）。
    const token = this.broker.resolve("catalog");
    const payload = (await this.request(
      "GET",
      `/products/${encodeURIComponent(sku)}`,
      ...(token !== undefined ? [{ token }] : []),
    )) as { product?: unknown };
    if (payload === null || typeof payload !== "object" || payload.product === undefined) {
      throw new MerchantClientError("validation", "get product response lacks a product object");
    }
    return parseMerchantCatalogProduct(payload.product);
  }

  async createProduct(input: MerchantProductInput): Promise<MerchantCatalogProduct> {
    const payload = (await this.request("POST", "/products", {
      body: {
        merchant_id: input.merchant_id,
        sku: input.sku,
        title: input.title,
        price: input.price,
        stock: input.stock,
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.delivery_attributes !== undefined
          ? { delivery_attributes: input.delivery_attributes }
          : {}),
      },
      token: this.catalogToken(),
    })) as { product?: unknown };
    if (payload === null || typeof payload !== "object" || payload.product === undefined) {
      throw new MerchantClientError("validation", "create product response lacks a product object");
    }
    return parseMerchantCatalogProduct(payload.product);
  }

  async updateProduct(sku: string, patch: MerchantProductPatch): Promise<MerchantCatalogProduct> {
    const payload = (await this.request("PATCH", `/products/${encodeURIComponent(sku)}`, {
      body: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.price !== undefined ? { price: patch.price } : {}),
        ...(patch.stock !== undefined ? { stock: patch.stock } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.delivery_attributes !== undefined
          ? { delivery_attributes: patch.delivery_attributes }
          : {}),
      },
      token: this.catalogToken(),
    })) as { product?: unknown };
    if (payload === null || typeof payload !== "object" || payload.product === undefined) {
      throw new MerchantClientError("validation", "update product response lacks a product object");
    }
    return parseMerchantCatalogProduct(payload.product);
  }

  // ---- inventory --------------------------------------------------------------

  async getInventorySnapshot(sku: string): Promise<InventorySnapshot> {
    const product = await this.getProduct(sku);
    return { sku: product.sku, stock: product.stock, observed_at: new Date().toISOString() };
  }

  /** Inventory-scope write: PATCH only the stock field with the inventory token. */
  async updateInventory(sku: string, stock: number): Promise<MerchantCatalogProduct> {
    const token = this.broker.resolve("inventory");
    if (token === undefined) {
      throw new MerchantClientError(
        "auth",
        "没有 inventory 作用域凭据（commerce.credentials.inventory.token_env 未配置）",
      );
    }
    const payload = (await this.request("PATCH", `/products/${encodeURIComponent(sku)}`, {
      body: { stock },
      token,
    })) as { product?: unknown };
    if (payload === null || typeof payload !== "object" || payload.product === undefined) {
      throw new MerchantClientError("validation", "update inventory response lacks a product object");
    }
    return parseMerchantCatalogProduct(payload.product);
  }

  // ---- consultations & human review -------------------------------------------

  async listIncomingConsultations(merchantId: string): Promise<IncomingConsultation[]> {
    const payload = (await this.request(
      "GET",
      `/merchants/${encodeURIComponent(merchantId)}/conversations`,
      { token: this.catalogToken() },
    )) as { conversations?: unknown };
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.conversations)) {
      throw new MerchantClientError("validation", "conversations response lacks a conversations array");
    }
    return payload.conversations.map((c) => parseIncomingConsultation(c));
  }

  async getHumanReviewQueue(merchantId: string): Promise<HumanReviewItem[]> {
    const payload = (await this.request(
      "GET",
      `/merchants/${encodeURIComponent(merchantId)}/human-review`,
      { token: this.catalogToken() },
    )) as { reviews?: unknown; conversations?: unknown };
    // shopping-cli 2.x returns {conversations:[...]}; accept both shapes.
    const reviews = payload.reviews ?? payload.conversations;
    if (payload === null || typeof payload !== "object" || !Array.isArray(reviews)) {
      throw new MerchantClientError(
        "validation",
        "human-review response lacks a reviews/conversations array",
      );
    }
    return reviews.map((r) => parseHumanReviewItem(r));
  }

  /** shopping-cli 2.x has no listing pause endpoint — fail closed. */
  async pauseListing(_sku: string, _paused: boolean): Promise<MerchantCatalogProduct> {
    throw new MerchantClientError(
      "validation",
      "shopping-cli 2.x 不提供 listing pause/resume 端点（active 为目录内部字段）；" +
        "该能力在真实 Connector 上 fail closed，只保留审批候选记录。",
    );
  }
}
