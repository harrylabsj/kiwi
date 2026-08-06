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
 * Deterministic in-memory MerchantClient for tests and offline smoke runs.
 * Mirrors the shopping-cli catalog/consultation semantics closely enough that
 * merchant capability tools can be exercised end-to-end without a gateway:
 * catalog CRUD, inventory snapshot, incoming consultations, human-review queue
 * and the paused listing flag. Private merchant values (floor/cost) are NOT
 * here — they live in the Vault / profile and never enter this client.
 */

import { MerchantClientError } from "./types.js";
import type {
  HumanReviewItem,
  IncomingConsultation,
  InventorySnapshot,
  MerchantCatalogProduct,
  MerchantClient,
  MerchantProductInput,
  MerchantProductPatch,
} from "./types.js";

export class FakeMerchantClient implements MerchantClient {
  private readonly products = new Map<string, MerchantCatalogProduct>();
  private readonly consultations: IncomingConsultation[] = [];
  private readonly reviews: HumanReviewItem[] = [];
  private now: string;

  constructor(options: {
    products?: MerchantCatalogProduct[];
    consultations?: IncomingConsultation[];
    reviews?: HumanReviewItem[];
    now?: string;
  } = {}) {
    for (const p of options.products ?? []) this.products.set(p.sku, p);
    this.consultations.push(...(options.consultations ?? []));
    this.reviews.push(...(options.reviews ?? []));
    this.now = options.now ?? "2026-08-03T15:00:00+08:00";
  }

  /** Test helper: advance the fake clock. */
  advanceTime(ms: number): void {
    this.now = new Date(Date.parse(this.now) + ms).toISOString();
  }

  /** Test helper: add or replace a catalog product. */
  put(product: MerchantCatalogProduct): void {
    this.products.set(product.sku, product);
  }

  /** Test helper: push an incoming consultation. */
  addConsultation(c: IncomingConsultation): void {
    this.consultations.push(c);
  }

  async listProducts(merchantId: string): Promise<MerchantCatalogProduct[]> {
    return [...this.products.values()].filter((p) => p.merchant_id === merchantId);
  }

  async getProduct(sku: string): Promise<MerchantCatalogProduct> {
    const product = this.products.get(sku);
    if (product === undefined) {
      throw new MerchantClientError("not_found", `no product ${sku}`);
    }
    return product;
  }

  async createProduct(input: MerchantProductInput): Promise<MerchantCatalogProduct> {
    if (this.products.has(input.sku)) {
      throw new MerchantClientError("validation", `product ${input.sku} already exists`);
    }
    const product: MerchantCatalogProduct = {
      sku: input.sku,
      merchant_id: input.merchant_id,
      title: input.title,
      description: input.description ?? "",
      category: input.category ?? "",
      tags: input.tags ?? [],
      price: input.price,
      currency: input.currency ?? "CNY",
      stock: input.stock,
      delivery_attributes: input.delivery_attributes ?? [],
      paused: false,
    };
    this.products.set(product.sku, product);
    return product;
  }

  async updateProduct(sku: string, patch: MerchantProductPatch): Promise<MerchantCatalogProduct> {
    const product = this.requireProduct(sku);
    const updated: MerchantCatalogProduct = {
      ...product,
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
    };
    this.products.set(sku, updated);
    return updated;
  }

  async getInventorySnapshot(sku: string): Promise<InventorySnapshot> {
    const product = await this.getProduct(sku);
    return { sku: product.sku, stock: product.stock, observed_at: this.now };
  }

  /** Inventory-scope write, always against a fresh read of the product. */
  async updateInventory(sku: string, stock: number): Promise<MerchantCatalogProduct> {
    return this.updateProduct(sku, { stock });
  }

  async listIncomingConsultations(merchantId: string): Promise<IncomingConsultation[]> {
    return this.consultations.filter((c) => {
      const product = this.products.get(c.sku ?? "");
      return product === undefined || product.merchant_id === merchantId;
    });
  }

  async getHumanReviewQueue(merchantId: string): Promise<HumanReviewItem[]> {
    const owned = new Set(
      [...this.products.values()].filter((p) => p.merchant_id === merchantId).map((p) => p.sku),
    );
    return this.reviews.filter((r) => owned.has(r.sku));
  }

  async pauseListing(sku: string, paused: boolean): Promise<MerchantCatalogProduct> {
    return this.updateProduct(sku, { paused });
  }

  private requireProduct(sku: string): MerchantCatalogProduct {
    const product = this.products.get(sku);
    if (product === undefined) {
      throw new MerchantClientError("not_found", `no product ${sku}`);
    }
    return product;
  }
}

/** A merchant catalog fixture with shopping-cli field shapes. */
export function fakeMerchantProduct(overrides: Partial<MerchantCatalogProduct> = {}): MerchantCatalogProduct {
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
    paused: false,
    ...overrides,
  };
}
