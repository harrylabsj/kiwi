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
 * 文件式商品源（设计 v0.1.2 §10.1「商家上传商品表并在页面确认」路径）。
 *
 * 云端首版允许两种商品来源：可从云端安全访问的 shopping-cli 服务，或商家
 * 上传的商品表。本模块实现后者：读一份受校验的 JSON 商品表。
 *
 * 硬规则（与设计 §10.1 一致）：
 *   - 只读公开字段（SKU/名称/币种/计价单位/单价/起订量/供货说明/时间戳/有效期/状态）；
 *     **底价、成本、自动折扣边界不在商品表里**——它们属于商家私密策略（profile）；
 *   - 商品表按 mtime 热加载：商家更新即生效，无需重启；
 *   - 过期（valid_until 已过）、暂停（paused）、查无此 SKU、表不可读 → 一律抛错，
 *     由 merchant handler 走 fail-closed decline；**绝不回退演示价**；
 *   - merchant_id 是租户边界：表内商家与运行实例不一致即拒绝加载。
 */

import { readFileSync, statSync } from "node:fs";
import type { MerchantProductSource } from "../a2a/server/merchant-handler.js";

/** 商品表 schema 版本（与交接包控制面同版）。 */
export const PRODUCT_TABLE_SCHEMA_VERSION = "0.1.2";

export interface CloudProductRecord {
  sku: string;
  /** 公开名称。 */
  title: string;
  currency: string;
  /** 计价单位（piece/box/kg…）。 */
  unit: string;
  /** 单价（major units，元），两位小数精度。 */
  price: number;
  /** 起订量。 */
  moq?: number;
  /** 公开供货说明。 */
  supply_note?: string;
  /** 数据时间戳（ISO）。 */
  updated_at: string;
  /** 有效期（ISO）：过期后停止自动报价。 */
  valid_until: string;
  status: "active" | "paused";
  /** 库存（可选；未知即不写，不猜）。 */
  stock?: number;
  /** 测试商品显式标记（设计 §5.1：测试商品必须明确标记）。 */
  test?: boolean;
}

export interface CloudProductTable {
  schema_version: string;
  merchant_id: string;
  /** 来源标记：商家上传 / 测试夹具。 */
  source: "merchant_upload" | "test_fixture";
  generated_at: string;
  products: CloudProductRecord[];
}

export class ProductTableError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProductTableError";
    this.code = code;
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProductTableError("PRODUCT_TABLE_INVALID", `商品表字段 ${field} 必须是非空字符串`);
  }
  return value;
}

function requireIso(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (Number.isNaN(Date.parse(text))) {
    throw new ProductTableError("PRODUCT_TABLE_INVALID", `商品表字段 ${field} 不是合法时间：${text}`);
  }
  return text;
}

/** 严格解析商品表：任何结构问题都抛错（不"尽力解析"半个表）。 */
export function parseProductTable(value: unknown, source: string): CloudProductTable {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductTableError("PRODUCT_TABLE_INVALID", `商品表必须是 JSON 对象：${source}`);
  }
  const table = value as Record<string, unknown>;
  const productsRaw = table["products"];
  if (!Array.isArray(productsRaw) || productsRaw.length === 0) {
    throw new ProductTableError("PRODUCT_TABLE_EMPTY", `商品表没有商品条目：${source}`);
  }
  const products: CloudProductRecord[] = productsRaw.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new ProductTableError("PRODUCT_TABLE_INVALID", `products[${index}] 必须是对象`);
    }
    const record = item as Record<string, unknown>;
    const status = record["status"];
    if (status !== "active" && status !== "paused") {
      throw new ProductTableError(
        "PRODUCT_TABLE_INVALID",
        `products[${index}].status 必须是 active|paused（收到 ${String(status)}）`,
      );
    }
    const price = record["price"];
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new ProductTableError(
        "PRODUCT_TABLE_INVALID",
        `products[${index}].price 必须是正数（收到 ${String(price)}）`,
      );
    }
    const moq = record["moq"];
    if (moq !== undefined && (typeof moq !== "number" || !Number.isInteger(moq) || moq <= 0)) {
      throw new ProductTableError("PRODUCT_TABLE_INVALID", `products[${index}].moq 必须是正整数`);
    }
    const stock = record["stock"];
    if (stock !== undefined && (typeof stock !== "number" || !Number.isInteger(stock) || stock < 0)) {
      throw new ProductTableError(
        "PRODUCT_TABLE_INVALID",
        `products[${index}].stock 必须是非负整数`,
      );
    }
    return {
      sku: requireString(record["sku"], `products[${index}].sku`),
      title: requireString(record["title"], `products[${index}].title`),
      currency: requireString(record["currency"], `products[${index}].currency`),
      unit: requireString(record["unit"], `products[${index}].unit`),
      price,
      ...(moq !== undefined ? { moq } : {}),
      ...(typeof record["supply_note"] === "string" ? { supply_note: record["supply_note"] } : {}),
      updated_at: requireIso(record["updated_at"], `products[${index}].updated_at`),
      valid_until: requireIso(record["valid_until"], `products[${index}].valid_until`),
      status,
      ...(stock !== undefined ? { stock } : {}),
      ...(record["test"] === true ? { test: true } : {}),
    };
  });
  return {
    schema_version: requireString(table["schema_version"], "schema_version"),
    merchant_id: requireString(table["merchant_id"], "merchant_id"),
    source: table["source"] === "test_fixture" ? "test_fixture" : "merchant_upload",
    generated_at: requireIso(table["generated_at"], "generated_at"),
    products,
  };
}

export interface FileProductSourceOptions {
  file: string;
  /** 运行实例的商家 id（租户边界；不一致即拒绝）。 */
  merchantId: string;
  now?: () => number;
}

export interface CloudProductSourceHandle {
  source: MerchantProductSource;
  /** 当前表里该 SKU 是否可自动报价（就绪/诊断用，不泄露价格）。 */
  describeSku: (sku: string) => { available: boolean; code?: string };
}

/**
 * 构造文件式商品源。实现要点：
 *   - 按 mtime 热加载（表更新即生效）；
 *   - 查询路径上的所有失败都抛错（handler 据此 decline），不返回"看起来正常"的价；
 *   - 只在内存保留解析结果，不写任何状态。
 */
export function createFileProductSource(options: FileProductSourceOptions): CloudProductSourceHandle {
  const now = options.now ?? (() => Date.now());
  let cached: { mtimeMs: number; table: CloudProductTable } | undefined;

  const load = (): CloudProductTable => {
    let mtimeMs: number;
    let raw: string;
    try {
      const stat = statSync(options.file);
      mtimeMs = stat.mtimeMs;
      raw = readFileSync(options.file, "utf8");
    } catch (err) {
      throw new ProductTableError(
        "PRODUCT_TABLE_UNREADABLE",
        `商品表不可读：${options.file}（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.table;
    let table: CloudProductTable;
    try {
      table = parseProductTable(JSON.parse(raw) as unknown, options.file);
    } catch (err) {
      if (err instanceof ProductTableError) throw err;
      throw new ProductTableError(
        "PRODUCT_TABLE_INVALID",
        `商品表不是合法 JSON：${options.file}（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
    if (table.merchant_id !== options.merchantId) {
      throw new ProductTableError(
        "PRODUCT_TABLE_TENANT_MISMATCH",
        `商品表 merchant_id=${table.merchant_id} 与运行实例 ${options.merchantId} 不一致：拒绝加载`,
      );
    }
    cached = { mtimeMs, table };
    return table;
  };

  const findSku = (sku: string): CloudProductRecord | undefined =>
    load().products.find((product) => product.sku === sku);

  const availability = (sku: string): { available: boolean; code?: string } => {
    let record: CloudProductRecord | undefined;
    try {
      record = findSku(sku);
    } catch (err) {
      return { available: false, code: err instanceof ProductTableError ? err.code : "PRODUCT_TABLE_ERROR" };
    }
    if (record === undefined) return { available: false, code: "PRODUCT_NOT_IN_TABLE" };
    if (record.status !== "active") return { available: false, code: "PRODUCT_PAUSED" };
    if (Date.parse(record.valid_until) < now()) return { available: false, code: "PRODUCT_EXPIRED" };
    return { available: true };
  };

  return {
    describeSku: availability,
    source: {
      async getProduct(sku: string) {
        const check = availability(sku);
        if (!check.available) {
          // 抛错即 fail-closed：merchant handler 走 decline，不产生任何价格。
          throw new ProductTableError(check.code ?? "PRODUCT_UNAVAILABLE", `SKU ${sku} 不可报价（${check.code}）`);
        }
        const record = findSku(sku);
        if (record === undefined) {
          throw new ProductTableError("PRODUCT_NOT_IN_TABLE", `SKU ${sku} 不在商品表中`);
        }
        return {
          price: record.price,
          currency: record.currency,
          title: record.title,
          ...(record.stock !== undefined ? { stock: record.stock } : {}),
          // 把有效期一并交给 handler（纵深防御：source 已按有效期拒绝，handler
          // 再按同一条款判定，避免"另一个商品源忘了判"的缺口）。
          valid_until: record.valid_until,
        };
      },
    },
  };
}
