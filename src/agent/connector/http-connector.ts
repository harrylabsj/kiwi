/**
 * shopping-cli HTTP Commerce Connector (design §15): read-side search
 * endpoints only (GET /search/products, /search/merchants, /products/{sku}
 * are public on the gateway — no token is sent for reads).
 */

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

export class ShoppingCliConnector implements CommerceConnector {
  readonly connector_id = "shopping-cli";
  readonly platform = "shopping-cli";
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
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
}
