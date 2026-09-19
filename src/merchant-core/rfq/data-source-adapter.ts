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
 * MerchantClient → CommerceDataSource 适配器（RFQ 事实读取用；设计
 * v0.1.1 §2.3、§6.3）。
 *
 * 金额存在两种读取类型（facade 公开视图 `price: number` vs 数据侧
 * `price_minor`）——本适配器**不猜测单位**：必须在部署配置显式声明
 * priceUnit（"minor"|"yuan"）；未声明时 getPrice 不可得（报价会以
 * SOURCE_UNAVAILABLE 阻断），其余读取不受影响。价格单位口径是 §21.2
 * 待确认项，由商家在部署配置中明确授权。
 */

import type { MerchantClient } from "../../agent/merchant/types.js";
import {
  CommerceError,
  type CommerceDataSource,
  type CommerceField,
  type ProductFact,
  type ProductSearchQuery,
} from "../../commerce/data-source.js";
import type { CommerceHealth } from "../../commerce/types.js";

export interface MerchantClientCommerceDataSourceDeps {
  client: MerchantClient;
  merchantId: string;
  /** 价格单位口径（部署显式声明；不猜测）。 */
  priceUnit?: "minor" | "yuan";
  now?: () => string;
}

export class MerchantClientCommerceDataSource implements CommerceDataSource {
  private readonly deps: MerchantClientCommerceDataSourceDeps;

  constructor(deps: MerchantClientCommerceDataSourceDeps) {
    this.deps = deps;
  }

  private nowIso(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  async getProduct(sku: string): Promise<ProductFact | undefined> {
    try {
      const product = await this.deps.client.getProduct(sku);
      return {
        sku: product.sku,
        title: product.title,
        currency: product.currency,
        ...(product.stock !== undefined ? { stock: product.stock } : {}),
        availability_hint:
          product.paused === true
            ? "out_of_stock"
            : product.stock !== undefined
              ? product.stock > 0
                ? "in_stock"
                : "out_of_stock"
              : undefined,
        ...(product.delivery_attributes !== undefined
          ? { delivery_attributes: product.delivery_attributes }
          : {}),
      };
    } catch (err) {
      if (err instanceof CommerceError && err.code === "not_found") return undefined;
      throw err;
    }
  }

  async getProducts(query?: ProductSearchQuery): Promise<ProductFact[]> {
    const products = await this.deps.client.listProducts(this.deps.merchantId);
    const q = (query?.query ?? "").trim().toLowerCase();
    const limit = Math.min(Math.max(query?.limit ?? 20, 1), 100);
    const filtered = products
      .filter((p) => !p.paused)
      .filter(
        (p) =>
          q === "" ||
          p.sku.toLowerCase().includes(q) ||
          p.title.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)),
      )
      .slice(0, limit);
    return filtered.map((p) => ({
      sku: p.sku,
      title: p.title,
      currency: p.currency,
      ...(p.stock !== undefined ? { stock: p.stock } : {}),
      availability_hint: p.paused === true ? "out_of_stock" : p.stock !== undefined ? (p.stock > 0 ? "in_stock" : "out_of_stock") : undefined,
      ...(p.delivery_attributes !== undefined ? { delivery_attributes: p.delivery_attributes } : {}),
    }));
  }

  async getInventory(sku: string): Promise<CommerceField<number> | undefined> {
    try {
      const snapshot = await this.deps.client.getInventorySnapshot(sku);
      if (snapshot.stock === undefined) return undefined;
      return {
        value: snapshot.stock,
        authority: "LOCAL_AUTHORITATIVE",
        source: "merchant-client",
        verified_at: snapshot.observed_at,
      };
    } catch (err) {
      if (err instanceof CommerceError && err.code === "not_found") return undefined;
      throw err;
    }
  }

  async getPrice(sku: string): Promise<CommerceField<{ currency: string; amount_minor: number }> | undefined> {
    // 单位口径未声明 = 价格事实不可得（fail-closed；绝不猜测元/分）。
    if (this.deps.priceUnit === undefined) return undefined;
    const product = await this.deps.client.getProduct(sku);
    if (product.currency !== "CNY") {
      throw new CommerceError("invalid_input", `SKU ${sku} 币种为 ${product.currency}（首版仅 CNY）`);
    }
    const amount =
      this.deps.priceUnit === "minor" ? product.price : Math.round(product.price * 100);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new CommerceError("invalid_input", `SKU ${sku} 价格非法（按 ${this.deps.priceUnit} 口径）`);
    }
    return {
      value: { currency: product.currency, amount_minor: amount },
      authority: "LOCAL_AUTHORITATIVE",
      source: "merchant-client",
      verified_at: this.nowIso(),
    };
  }

  async getPublicListing(): Promise<Record<string, unknown>> {
    return { merchant_id: this.deps.merchantId, products: await this.getProducts({ limit: 100 }) };
  }

  async health(): Promise<CommerceHealth> {
    return {
      ok: true,
      service: "merchant-client-adapter",
      details: { price_unit: this.deps.priceUnit ?? "unconfigured（价格事实不可得）" },
    };
  }
}
