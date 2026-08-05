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
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MerchantClientError("transient", `merchant returned non-JSON (HTTP ${response.status})`);
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
    const payload = (await this.request("GET", "/search/products", {
      query: { limit: "100", offset: "0" },
    })) as { results?: unknown };
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.results)) {
      throw new MerchantClientError("validation", "search/products response lacks a results array");
    }
    return payload.results
      .map((p) => parseMerchantCatalogProduct(p))
      .filter((p) => p.merchant_id === merchantId);
  }

  async getProduct(sku: string): Promise<MerchantCatalogProduct> {
    const payload = (await this.request(
      "GET",
      `/products/${encodeURIComponent(sku)}`,
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
    )) as { reviews?: unknown };
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.reviews)) {
      throw new MerchantClientError("validation", "human-review response lacks a reviews array");
    }
    return payload.reviews.map((r) => parseHumanReviewItem(r));
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
