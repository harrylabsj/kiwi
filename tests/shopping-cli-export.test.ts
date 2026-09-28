/**
 * WP12：shopping-cli 导出脚本测试。
 *
 * 证明整链：shopping-cli products 表行 → 模板 CSV（scripts/export-shopping-cli-products.mjs）
 * → convertTabularImport 校验通过（表头与 TABULAR_TEMPLATE_HEADER 同步断言）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { convertTabularImport, TABULAR_TEMPLATE_HEADER } from "../src/cloud/product-import-tabular.js";
import { buildShoppingCliExportCsv, TEMPLATE_HEADER } from "../scripts/export-shopping-cli-products.mjs";

const FIXED_NOW = new Date("2026-09-28T12:00:00Z");

function shoppingCliRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sku: "SC-001",
    title: "蓝牙耳机",
    price: 199,
    currency: "CNY",
    stock: 500,
    active: 1,
    updated_at: "2026-09-20T10:00:00Z",
    description: "含充电盒",
    ...overrides,
  };
}

describe("export-shopping-cli-products", () => {
  it("表头与共享模块的模板表头逐字一致（脚本与工作台共用同一权威定义）", () => {
    expect(TEMPLATE_HEADER).toEqual([...TABULAR_TEMPLATE_HEADER]);
  });

  it("默认只导在售商品；--include-paused 时停用商品状态=暂停", () => {
    const rows = [
      shoppingCliRow({ sku: "SC-001" }),
      shoppingCliRow({ sku: "SC-002", active: 0, title: "已停用款" }),
    ];
    const onlyActive = buildShoppingCliExportCsv(rows, { now: () => FIXED_NOW });
    expect(onlyActive.exportedCount).toBe(1);
    expect(onlyActive.skippedPaused).toEqual(["SC-002"]);

    const withPaused = buildShoppingCliExportCsv(rows, { now: () => FIXED_NOW, includePaused: true });
    expect(withPaused.exportedCount).toBe(2);
    expect(withPaused.csv).toContain("暂停");
  });

  it("导出的 CSV 可直接通过 Kiwi 导入校验（含 BOM/表头/字段映射/默认有效期）", () => {
    const rows = [
      shoppingCliRow({ description: '含充电盒, 质保一年' }),
      shoppingCliRow({ sku: "SC-002", title: "有线耳机", price: 49.5, stock: 0, updated_at: "2026-08-01T08:00:00Z", description: "" }),
    ];
    const { csv } = buildShoppingCliExportCsv(rows, { now: () => FIXED_NOW, validDays: 365 });
    const result = convertTabularImport({ kind: "csv", text: csv }, { merchantId: "merchant-001" });
    expect(result.ok).toBe(true);
    expect(result.table?.products).toHaveLength(2);
    expect(result.table?.products[0]).toMatchObject({
      sku: "SC-001",
      title: "蓝牙耳机",
      currency: "CNY",
      unit: "piece",
      price: 199,
      stock: 500,
      supply_note: "含充电盒, 质保一年",
      updated_at: "2026-09-20T10:00:00.000Z",
      valid_until: "2027-09-28T23:59:59.000Z",
      status: "active",
    });
    expect(result.table?.products[1]).toMatchObject({ stock: 0 });
  });

  it("真实 sqlite：只读打开 shopping-cli 形态的库并导出", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-sc-export-"));
    const dbPath = path.join(dir, "shopping-cli.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`create table merchants (id text primary key)`);
    db.exec(
      `create table products (
        sku text primary key, merchant_id text not null, title text not null,
        description text not null default '', category text not null default '',
        tags_json text not null default '[]', price real not null,
        currency text not null default 'CNY', stock integer not null,
        delivery_attributes_json text not null default '[]', active integer not null default 1,
        created_at text not null, updated_at text not null,
        foreign key (merchant_id) references merchants(id)
      )`,
    );
    db.prepare("insert into merchants (id) values (?)").run("m1");
    db.prepare("insert into merchants (id) values (?)").run("m2");
    db.prepare(
      "insert into products (sku, merchant_id, title, price, currency, stock, active, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("SC-100", "m1", "保温杯", 29.9, "CNY", 100, 1, "2026-01-01T00:00:00Z", "2026-09-01T00:00:00Z");
    db.prepare(
      "insert into products (sku, merchant_id, title, price, currency, stock, active, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("SC-200", "m2", "纸箱", 3.5, "CNY", 50, 1, "2026-01-01T00:00:00Z", "2026-09-02T00:00:00Z");
    db.close();

    const read = new DatabaseSync(dbPath, { readOnly: true });
    const rows = read.prepare("select sku, title, price, currency, stock, active, updated_at, description from products order by sku").all();
    read.close();
    const { csv, exportedCount } = buildShoppingCliExportCsv(rows, { now: () => FIXED_NOW });
    expect(exportedCount).toBe(2);
    const result = convertTabularImport({ kind: "csv", text: csv }, { merchantId: "merchant-001" });
    expect(result.ok).toBe(true);
    expect(result.table?.products.map((p) => p.sku)).toEqual(["SC-100", "SC-200"]);
  });
});
