/**
 * shopping-cli HTTP Commerce Connector (design §15): read-side search
 * endpoints only (GET /search/products, /search/merchants, /products/{sku}
 * are public on the gateway — no token is sent for reads).
 */

import { createHash } from "node:crypto";
import {
  ConnectorError,
  parseConnectorMerchant,
  parseConnectorProduct,
  type CommerceConnector,
  type ConnectorMerchant,
  type ConnectorProduct,
  type SearchMerchantsQuery,
  type SearchProductsQuery,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;

export interface ShoppingCliConnectorOptions {
  /**
   * Buyer bootstrap token (gateway env SHOPPING_BUYER_BOOTSTRAP_TOKEN), used
   * to start consultations via POST /buyer/ask. Read endpoints are public.
   */
  buyerBootstrapToken?: string;
}

export class ShoppingCliConnector implements CommerceConnector {
  readonly connector_id = "shopping-cli";
  readonly platform = "shopping-cli";
  private readonly baseUrl: string;
  private readonly buyerBootstrapToken: string | undefined;

  constructor(baseUrl: string, options: ShoppingCliConnectorOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.buyerBootstrapToken = options.buyerBootstrapToken;
  }

  private async get(pathname: string, params: Record<string, string>): Promise<unknown> {
    const url = `${this.baseUrl}${pathname}?${new URLSearchParams(params).toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      throw new ConnectorError(
        "transient",
        `connector request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ConnectorError("transient", `connector returned non-JSON (HTTP ${response.status})`);
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
      throw new ConnectorError(kind, `connector HTTP ${response.status} for ${pathname}`);
    }
    return payload;
  }

  async searchProducts(query: SearchProductsQuery): Promise<ConnectorProduct[]> {
    const payload = (await this.get("/search/products", {
      query: query.query ?? "",
      city: query.city ?? "",
      area: query.area ?? "",
      ...(query.max_price !== undefined ? { max_price: String(query.max_price) } : {}),
      include_out_of_stock: query.include_out_of_stock === true ? "true" : "",
      ...(query.limit !== undefined ? { limit: String(query.limit) } : {}),
      ...(query.offset !== undefined ? { offset: String(query.offset) } : {}),
    })) as { results?: unknown };
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.results)) {
      throw new ConnectorError("validation", "search/products response lacks a results array");
    }
    return payload.results.map((p) => parseConnectorProduct(p));
  }

  async getProduct(sku: string): Promise<ConnectorProduct> {
    const payload = (await this.get(
      `/products/${encodeURIComponent(sku)}`,
      {},
    )) as { product?: unknown };
    if (payload === null || typeof payload !== "object" || payload.product === undefined) {
      throw new ConnectorError("validation", "get product response lacks a product object");
    }
    return parseConnectorProduct(payload.product);
  }

  async searchMerchants(query: SearchMerchantsQuery): Promise<ConnectorMerchant[]> {
    const payload = (await this.get("/search/merchants", {
      query: query.query ?? "",
      city: query.city ?? "",
      ...(query.limit !== undefined ? { limit: String(query.limit) } : {}),
      ...(query.offset !== undefined ? { offset: String(query.offset) } : {}),
    })) as { results?: unknown };
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.results)) {
      throw new ConnectorError("validation", "search/merchants response lacks a results array");
    }
    return payload.results.map((m) => parseConnectorMerchant(m));
  }

  /**
   * Start a consultation via `POST /buyer/ask`. Requires the buyer bootstrap
   * token in the Authorization header. The buyer task is only linked to the
   * returned conversation — authoritative state stays in the marketplace.
   */
  async startConsultation(input: {
    buyer_id: string;
    sku: string;
    merchant_id: string;
    opening_message: string;
  }): Promise<{ conversation_id: string; status: string }> {
    void input.merchant_id;
    void input.sku;
    if (this.buyerBootstrapToken === undefined) {
      throw new ConnectorError(
        "auth",
        "未配置 buyer bootstrap token（gateway 的 SHOPPING_BUYER_BOOTSTRAP_TOKEN）；无法发起咨询",
      );
    }
    // Content-addressed idempotency key: a retried start after a lost response
    // dedups on the gateway instead of creating a second conversation.
    const idempotencyKey = createHash("sha256")
      .update(`${input.buyer_id}:${input.sku}:${input.opening_message}`)
      .digest("hex")
      .slice(0, 16);
    const payload = (await this.post("/buyer/ask", {
      buyer_id: input.buyer_id,
      text: input.opening_message,
    }, {
      authorization: `Bearer ${this.buyerBootstrapToken}`,
      "idempotency-key": idempotencyKey,
    })) as Record<string, unknown>;
    const conversationId =
      typeof payload.conversation_id === "string"
        ? payload.conversation_id
        : typeof (payload as { conversation?: { id?: unknown } }).conversation?.id === "string"
          ? ((payload as { conversation: { id: string } }).conversation.id)
          : undefined;
    if (conversationId === undefined) {
      throw new ConnectorError("validation", "buyer/ask response lacks a conversation id");
    }
    const status =
      typeof payload.status === "string"
        ? payload.status
        : typeof (payload as { conversation?: { status?: unknown } }).conversation?.status === "string"
          ? ((payload as { conversation: { status: string } }).conversation.status)
          : "waiting_merchant";
    return { conversation_id: conversationId, status };
  }

  private async post(
    pathname: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${pathname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ConnectorError(
        "transient",
        `connector request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ConnectorError("transient", `connector returned non-JSON (HTTP ${response.status})`);
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
      throw new ConnectorError(kind, `connector HTTP ${response.status} for ${pathname}`);
    }
    return payload;
  }
}
