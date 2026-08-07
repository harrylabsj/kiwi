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
 * CommerceDataSource —— Merchant 经营事实的**数据侧**统一读取边界
 * （shopping-cli data hub v0.2.1 §4；架构 rev1.4.1 §33）。
 *
 * 边界（§33 明示）：
 *   - 数据侧（读经营事实）≠ `CommerceClient`（磋商轮询通信侧）
 *     ≠ `CounterpartyChannel`（A2A 消息通道）；
 *   - CommerceDataSource 不负责发现远端 Agent；AgentDiscovery 不读
 *     Merchant 私有经营库；
 *   - 写操作（draftProductChange / updateProduct / updateInventory）保持
 *     scope 控制与 approval-aware —— v1.1 只实现读侧 + 权威冲突模型。
 *
 * 权威模型（data hub v0.2.1 §5）：每个字段的 source authority MUST 显式；
 * 同字段多权威冲突 → fail-closed（CommerceError("authority_conflict")），
 * 绝不静默合并冲突权威源。
 */

import type { CommerceHealth } from "./types.js";

/** 字段权威类型（data hub v0.2.1 §5）。 */
export type SourceAuthority = "LOCAL_AUTHORITATIVE" | "UPSTREAM_PROXY" | "READ_ONLY";

/** 带权威标注的字段值。 */
export interface CommerceField<T> {
  readonly value: T;
  readonly authority: SourceAuthority;
  /** 权威来源标识（如 "local-db" / "erp:acme" / "shopping-cli"）。 */
  readonly source: string;
  /** 字段最后验证/更新时间（RFC 3339，可选）。 */
  readonly verified_at?: string;
}

/** 商品事实（public-only；成本/底价等私有数据绝不进入本边界）。 */
export interface ProductFact {
  readonly sku: string;
  readonly title?: string;
  /** 公开价（minor units；与 KNP Money 一致，禁 float）。 */
  readonly price_minor?: number;
  readonly currency?: string;
  /** 当前可售库存（可选）。 */
  readonly stock?: number;
  /** 配送承诺（工作日，可选）。 */
  readonly delivery_lead_days?: number;
}

export interface ProductSearchQuery {
  q?: string;
  limit?: number;
}

export type CommerceErrorCode =
  | "invalid_input"
  | "request_failed"
  | "not_found"
  | "authority_conflict";

/** CommerceDataSource 错误（fail-closed，调用方不得吞掉）。 */
export class CommerceError extends Error {
  readonly code: CommerceErrorCode;
  constructor(code: CommerceErrorCode, message: string) {
    super(message);
    this.name = "CommerceError";
    this.code = code;
  }
}

/**
 * Merchant 经营事实统一读取边界。实现：
 * - `LocalDatabaseCommerceDataSource`（本地商品库，LOCAL_AUTHORITATIVE）；
 * - `ErpCommerceDataSource`（HTTP ERP adapter，UPSTREAM_PROXY）；
 * - `compositeCommerceDataSource`（多源合并，冲突 fail-closed）。
 */
export interface CommerceDataSource {
  /** 按 SKU 取商品事实；未知 SKU 返回 undefined。 */
  getProduct(sku: string): Promise<ProductFact | undefined>;
  /** 搜索商品（q 匹配标题/SKU；limit 夹在 1..100）。 */
  getProducts(query?: ProductSearchQuery): Promise<ProductFact[]>;
  /** 库存字段（带权威标注）。 */
  getInventory(sku: string): Promise<CommerceField<number> | undefined>;
  /** 公开价字段（带权威标注）。 */
  getPrice(
    sku: string,
  ): Promise<CommerceField<{ currency: string; amount_minor: number }> | undefined>;
  /** 公开 listing 元数据（public-only 序列化）。 */
  getPublicListing(): Promise<Record<string, unknown>>;
  /** 健康检查（对齐 CommerceClient.health）。 */
  health(): Promise<CommerceHealth>;
}

/** 冲突检测的字段集合（data hub v0.2.1 §5：同字段多权威冲突 fail-closed）。 */
const CONFLICT_FIELDS = ["price_minor", "currency", "stock", "delivery_lead_days"] as const;

/**
 * 多源合并：以第一个源为主（primary），其余为次要源。
 * 任一字段在次要源中出现且与 primary 不一致 → CommerceError
 * （authority_conflict，fail-closed——绝不静默合并冲突权威源）。
 */
export function compositeCommerceDataSource(
  sources: readonly CommerceDataSource[],
): CommerceDataSource {
  const first = sources[0];
  if (first === undefined) {
    throw new CommerceError("invalid_input", "compositeCommerceDataSource requires at least one source");
  }
  const primary = first;
  const others = sources.slice(1);

  async function mergedProduct(sku: string): Promise<ProductFact | undefined> {
    const base = await primary.getProduct(sku);
    if (base === undefined) return undefined;
    const merged: ProductFact = { ...base };
    for (const other of others) {
      const otherProduct = await other.getProduct(sku);
      if (otherProduct === undefined) continue;
      for (const field of CONFLICT_FIELDS) {
        const baseValue = (merged as unknown as Record<string, unknown>)[field];
        const otherValue = (otherProduct as unknown as Record<string, unknown>)[field];
        if (otherValue !== undefined && baseValue !== undefined && otherValue !== baseValue) {
          throw new CommerceError(
            "authority_conflict",
            `field "${field}" of SKU "${sku}" conflicts between sources ` +
              `(primary=${String(baseValue)}, secondary=${String(otherValue)})`,
          );
        }
      }
    }
    return merged;
  }

  return {
    async getProduct(sku: string): Promise<ProductFact | undefined> {
      return mergedProduct(sku);
    },
    async getProducts(query?: ProductSearchQuery): Promise<ProductFact[]> {
      const results = await primary.getProducts(query);
      // 次要源只补充 primary 缺失的 SKU；**重叠 SKU 不得静默跳过**——与
      // mergedProduct 同一冲突语义：次要源给出冲突字段值 → fail-closed
      //（authority_conflict，绝不静默合并冲突权威源）。此前 getProduct 抛错
      // 而 getProducts 静默取 primary，同 SKU 走两条 API 行为不一致。
      const bySku = new Map(results.map((p) => [p.sku, p]));
      for (const other of others) {
        for (const product of await other.getProducts(query)) {
          const existing = bySku.get(product.sku);
          if (existing === undefined) {
            bySku.set(product.sku, product);
            continue;
          }
          for (const field of CONFLICT_FIELDS) {
            const baseValue = (existing as unknown as Record<string, unknown>)[field];
            const otherValue = (product as unknown as Record<string, unknown>)[field];
            if (otherValue !== undefined && baseValue !== undefined && otherValue !== baseValue) {
              throw new CommerceError(
                "authority_conflict",
                `field "${field}" of SKU "${product.sku}" conflicts between sources ` +
                  `(primary=${String(baseValue)}, secondary=${String(otherValue)})`,
              );
            }
          }
        }
      }
      return [...bySku.values()];
    },
    async getInventory(sku: string): Promise<CommerceField<number> | undefined> {
      // 先走 mergedProduct 冲突检测（此前只看 primary，绕过了 fail-closed）；
      // primary 有库存时保留其权威标注，否则给 composite 标注。
      const product = await mergedProduct(sku);
      if (product?.stock === undefined) return undefined;
      const primaryInv = await primary.getInventory(sku);
      if (primaryInv !== undefined) return primaryInv;
      return { value: product.stock, authority: "UPSTREAM_PROXY", source: "composite" };
    },
    async getPrice(
      sku: string,
    ): Promise<CommerceField<{ currency: string; amount_minor: number }> | undefined> {
      const product = await mergedProduct(sku);
      if (product?.price_minor === undefined || product.currency === undefined) return undefined;
      const primaryPrice = await primary.getPrice(sku);
      if (primaryPrice !== undefined) return primaryPrice;
      return {
        value: { currency: product.currency, amount_minor: product.price_minor },
        authority: "UPSTREAM_PROXY",
        source: "composite",
      };
    },
    async getPublicListing(): Promise<Record<string, unknown>> {
      return primary.getPublicListing();
    },
    async health(): Promise<CommerceHealth> {
      return primary.health();
    },
  };
}
