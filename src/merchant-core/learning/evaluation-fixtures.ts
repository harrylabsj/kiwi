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
 * M5 真实评测的冻结事实夹具。
 *
 * 评测必须可复现：商品、价格、单位、库存和搜索行为都固定在仓库内，不能依赖
 * 某次部署的临时脚本或生产商品表。夹具只用于评测回放，不进入生产商品源。
 */

import type { ReceptionProductSource } from "../../a2a/reception/engine.js";

export interface M5FixtureProduct {
  readonly sku: string;
  readonly title: string;
  readonly price: number;
  readonly currency: string;
  readonly stock: number;
  readonly unit: string;
  /** 买家常用称呼；搜索按这些词命中，避免依赖标题全文匹配。 */
  readonly keywords: readonly string[];
}

/** pilot 冻结商品：覆盖单位歧义、价格异议与同店比较三类目标场景。 */
export const M5_FIXTURE_PRODUCTS: Readonly<Record<string, M5FixtureProduct>> = Object.freeze({
  "VQ-001": Object.freeze({
    sku: "VQ-001",
    title: "保温杯 500ml",
    price: 149.07,
    currency: "CNY",
    stock: 100,
    unit: "件",
    keywords: ["保温杯", "500ml", "试用装"],
  }),
  "VQ-101": Object.freeze({
    sku: "VQ-101",
    title: "办公款保温杯",
    price: 99,
    currency: "CNY",
    stock: 100,
    unit: "件",
    keywords: ["办公款", "办公"],
  }),
  "VQ-002": Object.freeze({
    sku: "VQ-002",
    title: "基础款保温杯",
    price: 90,
    currency: "CNY",
    stock: 100,
    unit: "件",
    keywords: ["基础款", "基础"],
  }),
});

/** 关键词命中标题或 SKU；无命中时返回空数组（与生产搜索的零命中语义一致）。 */
function matchesQuery(product: M5FixtureProduct, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return true;
  if (product.sku.toLowerCase().includes(normalized)) return true;
  return product.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

/** 冻结夹具的只读商品源；搜索与取商品都必须实现。 */
export type M5FixtureProductSource = Required<
  Pick<ReceptionProductSource, "searchProducts" | "getProduct">
>;

/** 冻结夹具的只读商品源，可直接注入真实评测 runner。 */
export function createM5FixtureProductSource(): M5FixtureProductSource {
  const products = Object.values(M5_FIXTURE_PRODUCTS);
  return {
    async searchProducts(query) {
      return products
        .filter((product) => matchesQuery(product, query))
        .map((product) => ({
          sku: product.sku,
          title: product.title,
          price: product.price,
          currency: product.currency,
          stock: product.stock,
        }));
    },
    async getProduct(sku) {
      const product = M5_FIXTURE_PRODUCTS[sku];
      if (product === undefined) throw new Error(`unknown fixture sku: ${sku}`);
      return {
        price: product.price,
        currency: product.currency,
        stock: product.stock,
        unit: product.unit,
      };
    },
  };
}
