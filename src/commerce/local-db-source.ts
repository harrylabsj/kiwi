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
 * LocalDatabaseCommerceDataSource —— 本地商品库（node:sqlite，
 * shopping-cli data hub v0.2.1 §4/#6「至少一种本地数据库源」）。
 *
 * 全部字段 LOCAL_AUTHORITATIVE（本地规则/录入即权威）；存储惯例对齐
 * src/handoff/order-record.ts（目录 0700 / 文件 0600 / DatabaseSync）。
 * public-only：成本/底价等私有字段不在本表。
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CommerceHealth } from "./types.js";
import {
  CommerceError,
  type CommerceDataSource,
  type CommerceField,
  type ProductFact,
  type ProductSearchQuery,
} from "./data-source.js";

const PRODUCT_SCHEMA = `
CREATE TABLE IF NOT EXISTS product_facts (
  sku               TEXT PRIMARY KEY,
  title             TEXT NOT NULL DEFAULT '',
  price_minor       INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'CNY',
  stock             INTEGER,
  delivery_lead_days INTEGER,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_title ON product_facts(title);
`;

interface ProductRow {
  sku: string;
  title: string;
  price_minor: number;
  currency: string;
  stock: number | null;
  delivery_lead_days: number | null;
  updated_at: string;
}

const CTOR = Symbol("local-db-source.ctor");

/** LIKE 通配符转义（`%`/`_` 在用户输入里是字面量，不是通配符）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 本地商品库 CommerceDataSource（LOCAL_AUTHORITATIVE）。 */
export class LocalDatabaseCommerceDataSource implements CommerceDataSource {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, _token: typeof CTOR) {
    this.db = db;
  }

  async getProduct(sku: string): Promise<ProductFact | undefined> {
    if (typeof sku !== "string" || sku.length === 0) {
      throw new CommerceError("invalid_input", "sku must be a non-empty string");
    }
    const row = this.db
      .prepare("SELECT * FROM product_facts WHERE sku = ?")
      .get(sku) as unknown as ProductRow | undefined;
    return row === undefined ? undefined : this.rowToFact(row);
  }

  async getProducts(query: ProductSearchQuery = {}): Promise<ProductFact[]> {
    const limit = Math.max(1, Math.min(Number(query.limit ?? 20) || 20, 100));
    const q = (query.q ?? "").trim();
    const rows = q
      ? (this.db
          .prepare(
            "SELECT * FROM product_facts WHERE sku LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' ORDER BY sku LIMIT ?",
          )
          .all(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`, limit) as unknown as ProductRow[])
      : (this.db
          .prepare("SELECT * FROM product_facts ORDER BY sku LIMIT ?")
          .all(limit) as unknown as ProductRow[]);
    return rows.map((r) => this.rowToFact(r));
  }

  async getInventory(sku: string): Promise<CommerceField<number> | undefined> {
    const product = await this.getProduct(sku);
    if (product?.stock === undefined) return undefined;
    return {
      value: product.stock,
      authority: "LOCAL_AUTHORITATIVE",
      source: "local-db",
    };
  }

  async getPrice(
    sku: string,
  ): Promise<CommerceField<{ currency: string; amount_minor: number }> | undefined> {
    const product = await this.getProduct(sku);
    if (product?.price_minor === undefined || product.currency === undefined) return undefined;
    return {
      value: { currency: product.currency, amount_minor: product.price_minor },
      authority: "LOCAL_AUTHORITATIVE",
      source: "local-db",
    };
  }

  async getPublicListing(): Promise<Record<string, unknown>> {
    const rows = this.db
      .prepare("SELECT sku, title, price_minor, currency FROM product_facts ORDER BY sku LIMIT 500")
      .all() as unknown as ProductRow[];
    return { source: "local-db", count: rows.length, products: rows.map((r) => this.rowToFact(r)) };
  }

  async health(): Promise<CommerceHealth> {
    try {
      this.db.prepare("SELECT COUNT(*) AS n FROM product_facts").get();
      return { ok: true, service: "local-db-commerce-data-source", version: "1" };
    } catch (err) {
      return {
        ok: false,
        service: "local-db-commerce-data-source",
        details: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /** 写入商品事实（本地权威：录入即事实）。 */
  upsertProduct(input: {
    sku: string;
    title?: string;
    price_minor: number;
    currency?: string;
    stock?: number;
    delivery_lead_days?: number;
    updated_at?: string;
  }): ProductFact {
    if (typeof input.sku !== "string" || input.sku.length === 0) {
      throw new CommerceError("invalid_input", "sku must be a non-empty string");
    }
    if (!Number.isInteger(input.price_minor) || input.price_minor < 0) {
      throw new CommerceError("invalid_input", "price_minor must be a non-negative integer");
    }
    const updatedAt = input.updated_at ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO product_facts (sku, title, price_minor, currency, stock, delivery_lead_days, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sku) DO UPDATE SET
           title=excluded.title, price_minor=excluded.price_minor, currency=excluded.currency,
           stock=excluded.stock, delivery_lead_days=excluded.delivery_lead_days, updated_at=excluded.updated_at`,
      )
      .run(
        input.sku,
        input.title ?? "",
        input.price_minor,
        input.currency ?? "CNY",
        input.stock ?? null,
        input.delivery_lead_days ?? null,
        updatedAt,
      );
    const row = this.db.prepare("SELECT * FROM product_facts WHERE sku = ?").get(input.sku) as unknown as
      | ProductRow
      | undefined;
    if (row === undefined) throw new CommerceError("request_failed", "upsert did not persist");
    return this.rowToFact(row);
  }

  close(): void {
    this.db.close();
  }

  private rowToFact(row: ProductRow): ProductFact {
    return {
      sku: row.sku,
      ...(row.title !== "" ? { title: row.title } : {}),
      price_minor: row.price_minor,
      currency: row.currency,
      ...(row.stock !== null ? { stock: row.stock } : {}),
      ...(row.delivery_lead_days !== null ? { delivery_lead_days: row.delivery_lead_days } : {}),
    };
  }
}

/** 打开（必要时创建）本地商品库；目录 0700 / 文件 0600。 */
export function openLocalDatabaseCommerceDataSource(options: {
  dbPath: string;
}): LocalDatabaseCommerceDataSource {
  if (options.dbPath === ":memory:") {
    const db = new DatabaseSync(":memory:");
    db.exec(PRODUCT_SCHEMA);
    return new LocalDatabaseCommerceDataSource(db, CTOR);
  }
  const dir = path.dirname(options.dbPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const db = new DatabaseSync(options.dbPath);
  if (existsSync(options.dbPath)) chmodSync(options.dbPath, 0o600);
  db.exec(PRODUCT_SCHEMA);
  return new LocalDatabaseCommerceDataSource(db, CTOR);
}
