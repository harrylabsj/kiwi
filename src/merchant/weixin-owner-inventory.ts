/**
 * Copyright 2026 harrylabsj
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

import { MerchantClientError, type ExactMerchantProduct } from "../agent/merchant/types.js";

const SKU = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

export type OwnerInventoryObservation = Readonly<{
  sku: string;
  stock: number;
  listingPaused: boolean | null;
  observedAt: number;
}>;

export class OwnerInventoryError extends Error {
  constructor(readonly code: "not_found" | "invalid_sku" | "authority_unavailable" | "scope_mismatch" | "stock_unknown") {
    super(code);
  }
}

export function ownerInventorySku(text: string): string | undefined {
  const sku = /^(?:查询|查)库存[：:\s]+([^\s]+?)\s*[？?。]?$/.exec(text.trim())?.[1];
  return sku !== undefined && SKU.test(sku) ? sku : undefined;
}

/** 复用工作台现有鉴权精确读，不把公开商品视图/可用性提示当成精确库存。 */
export function createOwnerInventoryReader(
  merchantId: string,
  readExact: (sku: string) => Promise<ExactMerchantProduct>,
  now: () => number = Date.now,
) {
  return async (sku: string): Promise<OwnerInventoryObservation> => {
    if (!SKU.test(sku)) throw new OwnerInventoryError("invalid_sku");
    let product: ExactMerchantProduct;
    try {
      product = await readExact(sku);
    } catch (error) {
      throw new OwnerInventoryError(error instanceof MerchantClientError && error.kind === "not_found"
        ? "not_found" : "authority_unavailable");
    }
    if (product.merchant_id !== merchantId || product.sku !== sku) throw new OwnerInventoryError("scope_mismatch");
    if (!Number.isSafeInteger(product.stock) || product.stock < 0) throw new OwnerInventoryError("stock_unknown");
    return { sku, stock: product.stock, listingPaused: product.listing_paused ?? null, observedAt: now() };
  };
}
