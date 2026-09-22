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
  ExactMerchantProduct,
  ExactMerchantProductInput,
  IncomingConsultation,
  InventorySnapshot,
  MerchantCatalogProduct,
  MerchantClient,
  MerchantProductInput,
  MerchantProductOperation,
  MerchantProductPatch,
} from "./types.js";

export class FakeMerchantClient implements MerchantClient {
  private readonly products = new Map<string, MerchantCatalogProduct>();
  private readonly exactProducts = new Map<string, ExactMerchantProduct>();
  private readonly exactOperations = new Map<string, MerchantProductOperation>();
  private readonly consultations: IncomingConsultation[] = [];
  private readonly reviews: HumanReviewItem[] = [];
  private now: string;

  constructor(
    options: {
      products?: MerchantCatalogProduct[];
      exactProducts?: ExactMerchantProduct[];
      consultations?: IncomingConsultation[];
      reviews?: HumanReviewItem[];
      now?: string;
    } = {},
  ) {
    for (const p of options.products ?? []) this.products.set(p.sku, p);
    for (const p of options.exactProducts ?? []) this.exactProducts.set(p.sku, p);
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

  async listExactProducts(merchantId: string): Promise<ExactMerchantProduct[]> {
    return [...this.exactProducts.values()].filter((product) => product.merchant_id === merchantId);
  }

  async getExactProduct(merchantId: string, sku: string): Promise<ExactMerchantProduct> {
    const product = this.exactProducts.get(sku);
    if (product === undefined || product.merchant_id !== merchantId) {
      throw new MerchantClientError("not_found", `no exact product ${sku}`);
    }
    return product;
  }

  async createExactProduct(input: ExactMerchantProductInput): Promise<ExactMerchantProduct> {
    const replay = this.exactOperations.get(input.operation_id);
    if (replay !== undefined) {
      if (replay.operation_kind !== "exact_product_create" || replay.sku !== input.sku) {
        throw new MerchantClientError("validation", "operation id was reused");
      }
      return this.getExactProduct(input.merchant_id, input.sku);
    }
    if (this.products.has(input.sku) || this.exactProducts.has(input.sku)) {
      throw new MerchantClientError("validation", `product ${input.sku} already exists`);
    }
    const product: ExactMerchantProduct = {
      sku: input.sku,
      merchant_id: input.merchant_id,
      title: input.title,
      description: input.description ?? "",
      category: input.category ?? "",
      tags: input.tags ?? [],
      stock: input.stock,
      currency: input.currency,
      price_minor: input.price_minor,
      currency_table_version: input.currency_table_version,
      authority_version: input.expected_authority_version,
      delivery_attributes: input.delivery_attributes ?? [],
      handoff_destination: input.handoff_destination ?? "",
    };
    this.exactProducts.set(product.sku, product);
    this.products.set(product.sku, {
      sku: product.sku,
      merchant_id: product.merchant_id,
      title: product.title,
      description: product.description,
      category: product.category,
      tags: product.tags,
      price: Number(product.price_minor) / 100,
      currency: product.currency,
      stock: product.stock,
      delivery_attributes: product.delivery_attributes,
      paused: false,
      handoff_destination: product.handoff_destination,
    });
    this.exactOperations.set(input.operation_id, {
      operation_id: input.operation_id,
      merchant_id: input.merchant_id,
      operation_kind: "exact_product_create",
      sku: input.sku,
      status: "succeeded",
      created_at: this.now,
    });
    return product;
  }

  async updateExactProductMoney(input: {
    operation_id: string;
    merchant_id: string;
    sku: string;
    price_minor: string;
    currency_table_version: string;
    expected_authority_version: number;
  }): Promise<ExactMerchantProduct> {
    const replay = this.exactOperations.get(input.operation_id);
    if (replay !== undefined) {
      if (replay.operation_kind !== "exact_product_money_update" || replay.sku !== input.sku) {
        throw new MerchantClientError("validation", "operation id was reused");
      }
      return this.getExactProduct(input.merchant_id, input.sku);
    }
    const current = await this.getExactProduct(input.merchant_id, input.sku);
    if (current.authority_version !== input.expected_authority_version) {
      throw new MerchantClientError("validation", "exact money authority version changed");
    }
    const updated = { ...current, price_minor: input.price_minor };
    this.exactProducts.set(input.sku, updated);
    const legacy = this.requireProduct(input.sku);
    this.products.set(input.sku, { ...legacy, price: Number(input.price_minor) / 100 });
    this.exactOperations.set(input.operation_id, {
      operation_id: input.operation_id,
      merchant_id: input.merchant_id,
      operation_kind: "exact_product_money_update",
      sku: input.sku,
      status: "succeeded",
      created_at: this.now,
    });
    return updated;
  }

  async updateInventoryExact(input: {
    operation_id: string;
    merchant_id: string;
    sku: string;
    stock: number;
    currency_table_version: string;
  }): Promise<ExactMerchantProduct> {
    const replay = this.exactOperations.get(input.operation_id);
    if (replay !== undefined) {
      if (replay.operation_kind !== "product_inventory_update" || replay.sku !== input.sku) {
        throw new MerchantClientError("validation", "operation id was reused");
      }
      return this.getExactProduct(input.merchant_id, input.sku);
    }
    const current = await this.getExactProduct(input.merchant_id, input.sku);
    const updated = { ...current, stock: input.stock };
    this.exactProducts.set(input.sku, updated);
    const legacy = this.requireProduct(input.sku);
    this.products.set(input.sku, { ...legacy, stock: input.stock });
    this.exactOperations.set(input.operation_id, {
      operation_id: input.operation_id,
      merchant_id: input.merchant_id,
      operation_kind: "product_inventory_update",
      sku: input.sku,
      status: "succeeded",
      created_at: this.now,
    });
    return updated;
  }

  async getProductOperation(
    merchantId: string,
    operationId: string,
  ): Promise<MerchantProductOperation> {
    const operation = this.exactOperations.get(operationId);
    if (operation === undefined || operation.merchant_id !== merchantId) {
      throw new MerchantClientError("not_found", `no exact product operation ${operationId}`);
    }
    return operation;
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
    // Fake 演示态支持 listing pause（真实引擎无该端点，HttpMerchantClient
    // fail-closed）；直接改 paused 字段，不经 PATCH patch（真实网关无此字段）。
    const product = this.requireProduct(sku);
    const updated = { ...product, paused };
    this.products.set(sku, updated);
    return updated;
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
export function fakeMerchantProduct(
  overrides: Partial<MerchantCatalogProduct> = {},
): MerchantCatalogProduct {
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
