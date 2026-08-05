/**
 * Deterministic in-memory Commerce Connector for tests and offline smoke
 * runs. Filter semantics mirror shopping-cli's /search/products: case-
 * insensitive substring match over title/description/category/tags, plus
 * city/area, max_price and stock filters.
 */

import {
  ConnectorError,
  type CommerceConnector,
  type ConnectorMerchant,
  type ConnectorProduct,
  type SearchMerchantsQuery,
  type SearchProductsQuery,
} from "./types.js";

export class FakeCommerceConnector implements CommerceConnector {
  readonly connector_id = "shopping-cli";
  readonly platform = "shopping-cli";
  private readonly products = new Map<string, ConnectorProduct>();

  constructor(seed: ConnectorProduct[] = []) {
    for (const p of seed) this.products.set(p.sku, p);
  }

  /** Test helper: add or replace a product. */
  put(product: ConnectorProduct): void {
    this.products.set(product.sku, product);
  }

  searchProducts(query: SearchProductsQuery): Promise<ConnectorProduct[]> {
    const needle = (query.query ?? "").toLowerCase();
    let out = [...this.products.values()];
    if (needle !== "") {
      out = out.filter((p) =>
        [p.title, p.description, p.category, ...p.tags]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      );
    }
    if (query.city !== undefined && query.city !== "") {
      out = out.filter((p) => p.merchant.city === query.city);
    }
    if (query.area !== undefined && query.area !== "") {
      out = out.filter((p) => p.delivery.service_area.includes(query.area as string));
    }
    if (query.max_price !== undefined) {
      out = out.filter((p) => p.price <= (query.max_price as number));
    }
    if (query.include_out_of_stock !== true) {
      out = out.filter((p) => p.stock > 0);
    }
    out.sort((a, b) => a.sku.localeCompare(b.sku));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 10;
    return Promise.resolve(out.slice(offset, offset + limit));
  }

  getProduct(sku: string): Promise<ConnectorProduct> {
    const product = this.products.get(sku);
    if (product === undefined) {
      return Promise.reject(new ConnectorError("not_found", `no product ${sku}`));
    }
    return Promise.resolve(product);
  }

  searchMerchants(query: SearchMerchantsQuery): Promise<ConnectorMerchant[]> {
    const byId = new Map<string, ConnectorMerchant>();
    for (const p of this.products.values()) byId.set(p.merchant.id, p.merchant);
    let out = [...byId.values()];
    const needle = (query.query ?? "").toLowerCase();
    if (needle !== "") {
      out = out.filter((m) => `${m.name} ${m.tags.join(" ")}`.toLowerCase().includes(needle));
    }
    if (query.city !== undefined && query.city !== "") {
      out = out.filter((m) => m.city === query.city);
    }
    return Promise.resolve(out.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 10)));
  }

  /**
   * Deterministic fake consultation start. The fake marketplace binds each
   * merchant to one conversation id (`conv-<merchant_id>`), so starting a
   * consultation returns exactly that id — matching the FakeCommerceClient
   * marketplace convention used by the buyer/merchant negotiation clients.
   */
  startConsultation(input: {
    buyer_id: string;
    sku: string;
    merchant_id: string;
    opening_message: string;
  }): Promise<{ conversation_id: string; status: string }> {
    void input;
    return Promise.resolve({
      conversation_id: `conv-${input.merchant_id}`,
      status: "waiting_merchant",
    });
  }
}

/** A catalog product fixture with shopping-cli field shapes. */
export function fakeConnectorProduct(overrides: Partial<ConnectorProduct> = {}): ConnectorProduct {
  return {
    sku: "sku-001",
    merchant_id: "merchant-001",
    title: "手写陶瓷杯",
    description: "手工拉坯，350ml",
    category: "kitchenware",
    tags: ["手工", "陶瓷"],
    price: 99,
    currency: "CNY",
    stock: 12,
    delivery_attributes: [],
    delivery: {
      service_area: "北京市 海淀区",
      fee: 5,
      currency: "CNY",
      eta_minutes: 1440,
      radius_km: 10,
      notes: "当日达",
    },
    merchant: {
      id: "merchant-001",
      name: "拾光手作",
      city: "北京市",
      service_area: "海淀区",
      hours: "10:00-21:00",
      tags: ["手作"],
      delivery: {
        service_area: "北京市 海淀区",
        fee: 5,
        currency: "CNY",
        eta_minutes: 1440,
        radius_km: 10,
        notes: "当日达",
      },
      product_count: 3,
    },
    warnings: [],
    ...overrides,
  };
}
