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
 * - `ShoppingCliCommerceDataSource`（唯一数据入口；kiwi merchant 不直连
 *   ERP 或其他数据库——外部数据接入在 shopping-cli 仓实现，
 *   `shopping_cli/data_sources/erp_source.py` + migration v16）。
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
