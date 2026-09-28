#!/usr/bin/env node
/**
 * shopping-cli → Kiwi 云端商品表模板 CSV 导出（WP12）。
 *
 * 只读调研结论：shopping-cli（v3.2.5）只有导入方向（`import-csv-excel`），
 * 没有任何 CSV/Excel 导出命令（listing projections 是只读预览，输出
 * text/json）。因此导出在 kiwi 仓实现：本脚本**只读**打开 shopping-cli 的
 * sqlite（node:sqlite DatabaseSync readOnly，零依赖、不改 shopping-cli 仓），
 * 把 products 表转成与工作台「商品与导入」模板一致的 CSV（表头与
 * src/cloud/product-import-tabular.ts 的 TABULAR_TEMPLATE_HEADER 保持一致，
 * 由 tests/shopping-cli-export.test.ts 断言同步）。
 *
 * 字段映射：sku/title/currency/stock/updated_at 直取；supply_note←description；
 * status←active（1→在售，0→暂停，默认不导出，--include-paused 开启）；
 * unit 与 valid_until 在 shopping-cli 中不存在——unit 用 --unit（默认 piece），
 * valid_until 用导出时刻 + --valid-days（默认 365 天）生成的日期；两个默认值
 * 都会在 stderr 说明，商家导入前可在表格里改。
 *
 * 用法：
 *   node scripts/export-shopping-cli-products.mjs \
 *     --db /path/to/shopping-cli.sqlite [--merchant m1] [--out products.csv] \
 *     [--unit piece] [--valid-days 365] [--include-paused]
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import process from "node:process";

/** 与 src/cloud/product-import-tabular.ts 的 TABULAR_TEMPLATE_HEADER 一致（测试断言同步）。 */
export const TEMPLATE_HEADER = [
  "商品编号/sku",
  "名称/title",
  "币种/currency",
  "计价单位/unit",
  "单价/price",
  "起订量/moq",
  "库存/stock",
  "供货说明/supply_note",
  "更新时间/updated_at",
  "有效期至/valid_until",
  "状态/status",
];

export const MAX_EXPORT_ROWS = 5000;

function csvEscape(cell) {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

function isoDatePlusDays(from, days) {
  const date = new Date(from.getTime() + days * 86400000);
  return date.toISOString().slice(0, 10);
}

/** shopping-cli products 行 → 模板 CSV 行（字段映射见文件头注释）。 */
export function buildShoppingCliExportCsv(
  rows,
  options = {},
) {
  const {
    unit = "piece",
    validDays = 365,
    includePaused = false,
    now = () => new Date(),
  } = options;
  const exported = [];
  const skippedPaused = [];
  for (const row of rows) {
    if (!includePaused && row.active !== 1) {
      skippedPaused.push(row.sku);
      continue;
    }
    exported.push([
      String(row.sku ?? ""),
      String(row.title ?? ""),
      String(row.currency || "CNY"),
      unit,
      String(row.price ?? ""),
      "",
      row.stock === null || row.stock === undefined ? "" : String(row.stock),
      String(row.description ?? ""),
      String(row.updated_at ?? ""),
      isoDatePlusDays(now(), validDays),
      row.active === 1 ? "在售" : "暂停",
    ]);
  }
  const lines = [TEMPLATE_HEADER, ...exported].map((cells) => cells.map(csvEscape).join(","));
  return {
    csv: `\ufeff${lines.join("\r\n")}\r\n`,
    exportedCount: exported.length,
    skippedPaused,
  };
}

function parseArgs(argv) {
  const options = {
    db: process.env.SHOPPING_DB ?? "shopping-cli.sqlite",
    merchant: "",
    out: "",
    unit: "piece",
    validDays: 365,
    includePaused: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--include-paused") {
      options.includePaused = true;
      continue;
    }
    const next = argv[i + 1];
    const map = {
      "--db": "db",
      "--merchant": "merchant",
      "--out": "out",
      "--unit": "unit",
      "--valid-days": "validDays",
    };
    if (map[arg] === undefined || next === undefined) {
      throw new Error(`未知或缺参的参数：${arg}（用法见文件头注释）`);
    }
    options[map[arg]] = next;
    i += 1;
  }
  const days = Number(options.validDays);
  if (!Number.isInteger(days) || days <= 0) throw new Error("--valid-days 须为正整数");
  if (options.unit.trim() === "") throw new Error("--unit 不能为空");
  return { ...options, validDays: days };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let db;
  try {
    db = new DatabaseSync(options.db, { readOnly: true });
  } catch (err) {
    process.stderr.write(
      `打不开 shopping-cli 数据库（只读）：${options.db}\n${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
  let rows;
  try {
    const sql = options.merchant
      ? "select sku, title, price, currency, stock, active, updated_at, description from products where merchant_id = ? order by sku limit ?"
      : "select sku, title, price, currency, stock, active, updated_at, description from products order by sku limit ?";
    rows = db.prepare(sql).all(...(options.merchant ? [options.merchant] : []), MAX_EXPORT_ROWS + 1);
  } catch (err) {
    process.stderr.write(
      `查询 products 表失败（确认这是 shopping-cli 的 sqlite 库）：${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  } finally {
    db.close();
  }
  if (rows.length > MAX_EXPORT_ROWS) {
    process.stderr.write(
      `商品超过 ${MAX_EXPORT_ROWS} 行（工作台导入上限），请用 --merchant 分商家导出或先精简。\n`,
    );
    process.exit(1);
  }
  const result = buildShoppingCliExportCsv(rows, {
    unit: options.unit,
    validDays: options.validDays,
    includePaused: options.includePaused,
  });
  const notes = [
    `导出 ${result.exportedCount} 行商品`,
    result.skippedPaused.length > 0 ? `跳过 ${result.skippedPaused.length} 个已停用商品（--include-paused 可包含，状态=暂停）` : "",
    `计价单位统一填「${options.unit}」（shopping-cli 无此字段）、有效期统一填 ${options.validDays} 天后（shopping-cli 无此字段）——导入前可在表格里按商品改`,
    "提示：Kiwi 导入是整表替换，表里没有的 SKU 提交后会被下架。",
  ].filter(Boolean);
  process.stderr.write(notes.join("；") + "\n");
  if (options.out !== "") {
    writeFileSync(options.out, result.csv, "utf8");
    process.stderr.write(`已写入 ${options.out}\n`);
  } else {
    process.stdout.write(result.csv);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
