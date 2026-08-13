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
 *     scope 控制与 approval-aware —— v0.7.0 只实现读侧 + 权威冲突模型。
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
  /** 当前可售库存（可选；公开/匿名投影剥除 → availability_hint 替代）。 */
  readonly stock?: number;
  /**
   * 私有成交入口（KTH handoff 目的地；仅 owner 鉴权读回，匿名/公开投影一律
   * 剥除）。审查 X-M1：此前数据源路径从未解析该字段，带 token 也静默丢失。
   */
  readonly handoff_destination?: string;
  /**
   * 库存可用性提示（in_stock / out_of_stock；公开投影把精确 stock 降级为它，
   * 审查 X-M1）。消费方应据此识别「库存不可得」而非把缺字段当 0。
   */
  readonly availability_hint?: string;
  /** 配送承诺（工作日，可选）。 */
  readonly delivery_lead_days?: number;
  /** 配送方式/承诺标签（如 ["same-city","courier"]；审查 P3：此前 wire
   *  声明该字段但 parse 静默丢弃，配送承诺数据从未到达消费方）。 */
  readonly delivery_attributes?: readonly string[];
}

export interface ProductSearchQuery {
  /** 关键词（匹配标题/SKU 等；wire 参数名与 shopping-cli 一致为 query）。 */
  query?: string;
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
 *   `shopping_cli/data_sources/erp_source.py` + migration v17（product provenance））。
 */
export interface CommerceDataSource {
  /** 按 SKU 取商品事实；未知 SKU 返回 undefined。 */
  getProduct(sku: string): Promise<ProductFact | undefined>;
  /** 搜索商品（query 匹配标题/SKU；limit 夹在 1..100）。 */
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
