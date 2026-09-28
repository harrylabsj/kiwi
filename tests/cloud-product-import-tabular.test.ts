/**
 * WP12：表格商品导入模块（CSV/xlsx → 云端商品表）单测。
 *
 * 覆盖任务书要求的场景：中英文表头、别名、缺价格、币种不明、重复 SKU、
 * 非法数字/日期、成本列拒绝、空表、超大表上限；另覆盖 CSV 引号/BOM/CRLF、
 * 模板 roundtrip（CSV 与 xlsx）、默认列、未识别列、xlsx 日期序列号。
 */
import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";

import {
  convertTabularImport,
  parseCsv,
  parseXlsx,
  renderImportTemplateCsv,
  renderImportTemplateXlsx,
  TABULAR_IMPORT_MAX_COLUMNS,
  TABULAR_IMPORT_MAX_ROWS,
  XLSX_MAX_ENTRY_BYTES,
  XLSX_MAX_TOTAL_BYTES,
  XLSX_MAX_ZIP_ENTRIES,
  type TabularImportResult,
} from "../src/cloud/product-import-tabular.js";

const FIXED_NOW = new Date("2026-09-28T12:00:00Z");
const OPTIONS = { merchantId: "merchant-001", now: () => FIXED_NOW };

function convertCsv(text: string): TabularImportResult {
  return convertTabularImport({ kind: "csv", text }, OPTIONS);
}

const MINIMAL_EN = [
  "sku,title,currency,unit,price,valid_until",
  "A-1,Steel Mug,CNY,piece,29.9,2027-12-31",
].join("\n");

const MINIMAL_ZH_ALIASES = [
  "货号,品名,币种,单位,价格,有效期至",
  "A-1,不锈钢保温杯,人民币,个,29.90,2027年12月31日",
].join("\n");

describe("convertTabularImport — 表头识别", () => {
  it("英文表头（shopping-cli 独立形态同名列）可导入", () => {
    const result = convertCsv(MINIMAL_EN);
    expect(result.ok).toBe(true);
    expect(result.table?.products).toHaveLength(1);
    expect(result.table?.products[0]).toMatchObject({
      sku: "A-1",
      title: "Steel Mug",
      currency: "CNY",
      unit: "piece",
      price: 29.9,
      status: "active",
    });
    expect(result.table?.merchant_id).toBe("merchant-001");
    expect(result.table?.source).toBe("merchant_upload");
  });

  it("中文别名表头可导入，且人民币/美元映射为币种代码", () => {
    const result = convertCsv(MINIMAL_ZH_ALIASES);
    expect(result.ok).toBe(true);
    expect(result.table?.products[0]).toMatchObject({
      sku: "A-1",
      currency: "CNY",
      unit: "个",
      valid_until: "2027-12-31T23:59:59.000Z",
    });
  });

  it("模板「中文/字段」双写表头可导入（模板即合法导入文件）", () => {
    const result = convertCsv(renderImportTemplateCsv());
    expect(result.ok).toBe(true);
    expect(result.table?.products.map((p) => p.sku)).toEqual(["DEMO-001", "DEMO-002"]);
    expect(result.report.unrecognized_columns).toEqual([]);
  });

  it("表头归一化容忍大小写/空格/全半角标点（如「单价(元)」「Unit Price」）", () => {
    const csv = [
      "SKU,名称,币种,Unit Price,单位,有效期(至)",
      "A-1,杯子,CNY,9.9,个,2027-12-31",
    ].join("\n");
    const result = convertCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.table?.products[0]?.price).toBe(9.9);
  });

  it("未识别列不阻断导入，逐列列入报告", () => {
    const csv = [
      "sku,title,currency,unit,price,valid_until,category,随意列",
      "A-1,杯子,CNY,个,9.9,2027-12-31,日用品,whatever",
    ].join("\n");
    const result = convertCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.report.unrecognized_columns).toEqual(["category", "随意列"]);
  });

  it("缺价格列 → 整表拒绝并点名单价", () => {
    const csv = ["sku,title,currency,unit,valid_until", "A-1,杯子,CNY,个,2027-12-31"].join("\n");
    const result = convertCsv(csv);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "MISSING_COLUMN" && /单价|价格/.test(e.message))).toBe(true);
  });

  it("缺其他必需列（sku/币种/单位/有效期）同样拒绝", () => {
    const csv = ["title,unit,price", "杯子,个,9.9"].join("\n");
    const result = convertCsv(csv);
    expect(result.ok).toBe(false);
    const missing = result.errors.filter((e) => e.code === "MISSING_COLUMN").map((e) => e.field);
    expect(missing).toEqual(expect.arrayContaining(["sku", "currency", "valid_until"]));
  });
});

describe("convertTabularImport — 值校验", () => {
  const HEADER = "sku,title,currency,unit,price,valid_until";

  it("缺价格值 → 该行报错，整表拒绝", () => {
    const result = convertCsv([HEADER, "A-1,杯子,CNY,个,,2027-12-31"].join("\n"));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "EMPTY_REQUIRED" && e.field === "price")).toBe(true);
  });

  it("币种不明 → 报错；常见中文名与三字母代码可识别", () => {
    const bad = convertCsv([HEADER, "A-1,杯子,火星币,个,9.9,2027-12-31"].join("\n"));
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.code === "BAD_CURRENCY" && e.row === 2)).toBe(true);

    for (const [raw, code] of [
      ["美元", "USD"],
      ["USD", "USD"],
      ["eur", "EUR"],
      ["港币", "HKD"],
    ] as const) {
      const good = convertCsv([HEADER, `A-1,杯子,${raw},个,9.9,2027-12-31`].join("\n"));
      expect(good.ok, raw).toBe(true);
      expect(good.table?.products[0]?.currency).toBe(code);
    }
  });

  it("重复 SKU → 指出两处行号", () => {
    const result = convertCsv(
      [HEADER, "A-1,杯子,CNY,个,9.9,2027-12-31", "A-1,杯子二号,CNY,个,19.9,2027-12-31"].join("\n"),
    );
    expect(result.ok).toBe(false);
    const dup = result.errors.find((e) => e.code === "DUPLICATE_SKU");
    expect(dup?.message).toContain("第 2 行");
    expect(dup?.message).toContain("第 3 行");
  });

  it("非法数字：单价非数字/非正数、起订量非整数、库存负数", () => {
    const cases: Array<[string, string]> = [
      ["A-1,杯子,CNY,个,abc,2027-12-31", "price"],
      ["A-1,杯子,CNY,个,-5,2027-12-31", "price"],
      ["A-1,杯子,CNY,个,9.9,2027-12-31,1.5", "moq"],
      ["A-1,杯子,CNY,个,9.9,2027-12-31,3,-2", "stock"],
    ];
    for (const [row, field] of cases) {
      const csv = ["sku,title,currency,unit,price,valid_until,moq,stock", row].join("\n");
      const result = convertCsv(csv);
      expect(result.ok, row).toBe(false);
      expect(result.errors.some((e) => e.code === "BAD_NUMBER" && e.field === field), row).toBe(true);
    }
  });

  it("单价容忍千分位与货币符号前缀", () => {
    const csv = [HEADER.replace("price", "单价"), "A-1,杯子,CNY,个,\"1,299.00\",2027-12-31"].join("\n");
    const result = convertCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.table?.products[0]?.price).toBe(1299);
  });

  it("非法日期：不存在的日期、乱文本、非法更新时间", () => {
    const cases = ["2027-02-30", "2027/13/01", "明年春天", "2027-12-31T99:00:00Z"];
    for (const bad of cases) {
      const result = convertCsv([HEADER, `A-1,杯子,CNY,个,9.9,${bad}`].join("\n"));
      expect(result.ok, bad).toBe(false);
      expect(result.errors.some((e) => e.code === "BAD_DATE" && e.field === "valid_until"), bad).toBe(true);
    }
    const updated = convertCsv(
      ["sku,title,currency,unit,price,valid_until,updated_at", "A-1,杯子,CNY,个,9.9,2027-12-31,上周"].join("\n"),
    );
    expect(updated.ok).toBe(false);
    expect(updated.errors.some((e) => e.code === "BAD_DATE" && e.field === "updated_at")).toBe(true);
  });

  it("有效期纯日期取当日 23:59:59 UTC，更新时间纯日期取当日 00:00:00 UTC", () => {
    const result = convertCsv(
      [
        "sku,title,currency,unit,price,valid_until,updated_at",
        "A-1,杯子,CNY,个,9.9,2027/12/31,2026-09-01",
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    expect(result.table?.products[0]?.valid_until).toBe("2027-12-31T23:59:59.000Z");
    expect(result.table?.products[0]?.updated_at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("状态列：在售/暂停映射；未识别值报错；缺省列默认在售并记录默认", () => {
    const ok = convertCsv([`${HEADER},status`, "A-1,杯子,CNY,个,9.9,2027-12-31,暂停"].join("\n"));
    expect(ok.ok).toBe(true);
    expect(ok.table?.products[0]?.status).toBe("paused");

    const defaulted = convertCsv(MINIMAL_EN);
    expect(defaulted.ok).toBe(true);
    expect(defaulted.report.defaulted_fields).toEqual(
      expect.arrayContaining(["status", "updated_at"]),
    );
    expect(defaulted.table?.products[0]?.status).toBe("active");
    expect(defaulted.table?.products[0]?.updated_at).toBe(FIXED_NOW.toISOString());

    const bad = convertCsv([`${HEADER},status`, "A-1,杯子,CNY,个,9.9,2027-12-31,火爆"].join("\n"));
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => e.code === "BAD_STATUS")).toBe(true);
  });
});

describe("convertTabularImport — 成本列拒绝与空表/上限", () => {
  it("疑似底价/成本/进价列 → 整表拒绝并提示移除", () => {
    for (const header of ["底价", "底价(元)", "成本价", "采购价", "cost price", "floor_price"]) {
      const csv = [
        `sku,title,currency,unit,price,valid_until,${header}`,
        "A-1,杯子,CNY,个,9.9,2027-12-31,5.5",
      ].join("\n");
      const result = convertCsv(csv);
      expect(result.ok, header).toBe(false);
      const issue = result.errors.find((e) => e.code === "COST_COLUMN");
      expect(issue, header).toBeDefined();
      expect(issue?.message, header).toContain("删除");
    }
  });

  it("空表（无行/仅表头/仅空行）→ 拒绝", () => {
    expect(convertCsv("").ok).toBe(false);
    expect(convertCsv("\n\n").ok).toBe(false);
    const headerOnly = convertCsv("sku,title,currency,unit,price,valid_until");
    expect(headerOnly.ok).toBe(false);
    expect(headerOnly.errors[0]?.code).toBe("EMPTY_TABLE");
  });

  it("数据行超过上限 → 拒绝并给出上限", () => {
    const lines = ["sku,title,currency,unit,price,valid_until"];
    for (let i = 0; i < TABULAR_IMPORT_MAX_ROWS + 1; i += 1) {
      lines.push(`SKU-${i},商品,CNY,个,9.9,2027-12-31`);
    }
    const result = convertCsv(lines.join("\n"));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === "LIMIT_ROWS" && e.message.includes(String(TABULAR_IMPORT_MAX_ROWS)))).toBe(true);
  });

  it("列数超过上限 → 拒绝", () => {
    const wide = Array.from({ length: TABULAR_IMPORT_MAX_COLUMNS + 1 }, (_, i) => `列${i}`).join(",");
    const result = convertCsv(`${wide}\nA-1,x,CNY,个,9.9,2027-12-31`);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("LIMIT_COLUMNS");
  });
});

describe("parseCsv — RFC 4180 风格", () => {
  it("引号内逗号、双引号转义、CRLF、BOM", () => {
    const text = "\ufeffa,b\r\n\"x,\"\"y\"\"\",z\r\n";
    expect(parseCsv(text)).toEqual([
      ["a", "b"],
      ['x,"y"', "z"],
    ]);
  });
});

describe("xlsx 模板 roundtrip 与日期序列", () => {
  it("生成的 xlsx 模板能被解析并成功转换", () => {
    const bytes = renderImportTemplateXlsx();
    const grid = parseXlsx(bytes);
    expect(grid[0]?.slice(0, 3)).toEqual(["商品编号/sku", "名称/title", "币种/currency"]);
    const result = convertTabularImport({ kind: "xlsx", bytes }, OPTIONS);
    expect(result.ok).toBe(true);
    expect(result.report.format).toBe("xlsx");
    expect(result.table?.products).toHaveLength(2);
    expect(result.table?.products[0]?.supply_note).toBe("现货，下单后 3 个工作日发货");
    expect(result.table?.products[1]?.updated_at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("日期样式的数值单元格按 Excel 序列日转换（含时间保留、纯日期当日生效）", () => {
    const sheet =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
      `<row r="1"><c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>title</t></is></c>` +
      `<c r="C1" t="inlineStr"><is><t>currency</t></is></c><c r="D1" t="inlineStr"><is><t>unit</t></is></c>` +
      `<c r="E1" t="inlineStr"><is><t>price</t></is></c><c r="F1" t="inlineStr"><is><t>valid_until</t></is></c></row>` +
      `<row r="2"><c r="A2" t="inlineStr"><is><t>A-1</t></is></c><c r="B2" t="inlineStr"><is><t>杯子</t></is></c>` +
      `<c r="C2" t="inlineStr"><is><t>CNY</t></is></c><c r="D2" t="inlineStr"><is><t>个</t></is></c>` +
      `<c r="E2"><v>9.9</v></c><c r="F2" s="1"><v>46416</v></c></row>` +
      `</sheetData></worksheet>`;
    const styles =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;-&quot;mm&quot;-&quot;dd&quot;"/></numFmts>` +
      `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
    const bytes = buildTestXlsx([
      { name: "[Content_Types].xml", content: contentTypes() },
      { name: "_rels/.rels", content: rels() },
      { name: "xl/workbook.xml", content: workbook() },
      { name: "xl/_rels/workbook.xml.rels", content: workbookRels() },
      { name: "xl/sharedStrings.xml", content: `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"></sst>` },
      { name: "xl/styles.xml", content: styles },
      { name: "xl/worksheets/sheet1.xml", content: sheet },
    ]);
    const result = convertTabularImport({ kind: "xlsx", bytes }, OPTIONS);
    expect(result.ok).toBe(true);
    // 46416 = 2027-01-29（纯日期 → 当日 23:59:59 生效）。
    expect(result.table?.products[0]?.valid_until).toBe("2027-01-29T23:59:59.000Z");
    expect(result.table?.products[0]?.price).toBe(9.9);
  });

  it("非日期样式的数值单元格保留原值（价格按数字解析）", () => {
    const sheet =
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
      `<row r="1"><c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>title</t></is></c>` +
      `<c r="C1" t="inlineStr"><is><t>currency</t></is></c><c r="D1" t="inlineStr"><is><t>unit</t></is></c>` +
      `<c r="E1" t="inlineStr"><is><t>price</t></is></c><c r="F1" t="inlineStr"><is><t>valid_until</t></is></c></row>` +
      `<row r="2"><c r="A2" t="inlineStr"><is><t>A-1</t></is></c><c r="B2" t="inlineStr"><is><t>杯子</t></is></c>` +
      `<c r="C2" t="inlineStr"><is><t>CNY</t></is></c><c r="D2" t="inlineStr"><is><t>个</t></is></c>` +
      `<c r="E2"><v>12.5</v></c><c r="F2" t="inlineStr"><is><t>2027-12-31</t></is></c></row>` +
      `</sheetData></worksheet>`;
    const bytes = buildTestXlsx([
      { name: "[Content_Types].xml", content: contentTypes() },
      { name: "_rels/.rels", content: rels() },
      { name: "xl/workbook.xml", content: workbook() },
      { name: "xl/_rels/workbook.xml.rels", content: workbookRels() },
      { name: "xl/worksheets/sheet1.xml", content: sheet },
    ]);
    const result = convertTabularImport({ kind: "xlsx", bytes }, OPTIONS);
    expect(result.ok).toBe(true);
    expect(result.table?.products[0]?.price).toBe(12.5);
  });

  it("不是 ZIP 的文件 → 结构性错误", () => {
    const result = convertTabularImport({ kind: "xlsx", bytes: new Uint8Array([1, 2, 3]) }, OPTIONS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("PARSE_ERROR");
  });
});


describe("xlsx zip 炸弹防护（验收修复）", () => {
  const SHEET_MINIMAL =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>title</t></is></c>` +
    `<c r="C1" t="inlineStr"><is><t>currency</t></is></c><c r="D1" t="inlineStr"><is><t>unit</t></is></c>` +
    `<c r="E1" t="inlineStr"><is><t>price</t></is></c><c r="F1" t="inlineStr"><is><t>valid_until</t></is></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>B-1</t></is></c><c r="B2" t="inlineStr"><is><t>杯子</t></is></c>` +
    `<c r="C2" t="inlineStr"><is><t>CNY</t></is></c><c r="D2" t="inlineStr"><is><t>个</t></is></c>` +
    `<c r="E2"><v>9.9</v></c><c r="F2" t="inlineStr"><is><t>2027-12-31</t></is></c></row>` +
    `</sheetData></worksheet>`;

  function baseEntries(overrides: Partial<TestZipEntry> = {}): TestZipEntry[] {
    return [
      { name: "[Content_Types].xml", content: contentTypes() },
      { name: "_rels/.rels", content: rels() },
      { name: "xl/workbook.xml", content: workbook() },
      { name: "xl/_rels/workbook.xml.rels", content: workbookRels() },
      { name: "xl/worksheets/sheet1.xml", content: SHEET_MINIMAL, ...overrides },
    ];
  }

  it("deflate 条目（真实 Excel 存法）仍可正常解析", () => {
    const bytes = buildTestXlsx(baseEntries().map((e) => ({ ...e, deflate: true })));
    const result = convertTabularImport({ kind: "xlsx", bytes }, OPTIONS);
    expect(result.ok).toBe(true);
    expect(result.table?.products[0]?.sku).toBe("B-1");
  });

  it("声明的解压大小超过单条目上限 → ZIP_BOMB 拒绝（不解压）", () => {
    const bytes = buildTestXlsx(
      baseEntries({
        deflate: true,
        content: "x".repeat(1024),
        declaredUncompressedSize: XLSX_MAX_ENTRY_BYTES + 1,
      }),
    );
    const result = convertTabularImport({ kind: "xlsx", bytes }, OPTIONS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("ZIP_BOMB");
    expect(result.errors[0]?.message).toContain(String(XLSX_MAX_ENTRY_BYTES));
  });

  it("声明大小与实际解压不符 → ZIP_BOMB 拒绝", () => {
    const bytes = buildTestXlsx(
      baseEntries({ deflate: true, content: "x".repeat(1024 * 1024), declaredUncompressedSize: 100 }),
    );
    const result = convertTabularImport({ kind: "xlsx", bytes }, OPTIONS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("ZIP_BOMB");
    expect(result.errors[0]?.message).toContain("不符");
  });

  it("真实 zip 炸弹：声明在限内但解压输出冲破单条目上限 → ZIP_BOMB", () => {
    // 40 MiB 高度可压缩数据；声明 20 MiB（≤32 MiB，骗过声明检查），
    // 解压输出触发 inflateRawSync 的 maxOutputLength。
    const bomb = Buffer.alloc(40 * 1024 * 1024, 0x41);
    const bytes = buildTestXlsx(
      baseEntries({
        deflate: true,
        content: bomb,
        declaredUncompressedSize: 20 * 1024 * 1024,
      }),
    );
    expect(bytes.length).toBeLessThan(4 * 1024 * 1024); // 压缩包本身很小——正是炸弹形态
    const result = convertTabularImport({ kind: "xlsx", bytes }, OPTIONS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("ZIP_BOMB");
    expect(result.errors[0]?.message).toContain("单条目上限");
  });

  it("多条目累计解压超过总上限 → ZIP_BOMB 拒绝（单条目均在限内）", () => {
    const half = 20 * 1024 * 1024;
    expect(XLSX_MAX_TOTAL_BYTES).toBeLessThan(2 * half);
    const bytes = buildTestXlsx([
      { name: "[Content_Types].xml", content: contentTypes() },
      { name: "_rels/.rels", content: rels() },
      { name: "xl/workbook.xml", content: workbook() },
      { name: "xl/_rels/workbook.xml.rels", content: workbookRels() },
      { name: "xl/sharedStrings.xml", content: `<sst>${"<si><t>x</t></si>".repeat(1024)}${"x".repeat(half - 20480)}</sst>`, deflate: true },
      { name: "xl/worksheets/sheet1.xml", content: SHEET_MINIMAL + `<!--${"y".repeat(half)}-->`, deflate: true },
    ]);
    const result = convertTabularImport({ kind: "xlsx", bytes }, OPTIONS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("ZIP_BOMB");
    expect(result.errors[0]?.message).toContain("总上限");
  });

  it("ZIP 条目数超过上限 → LIMIT_ZIP_ENTRIES 拒绝", () => {
    const entries = baseEntries();
    for (let i = 0; i < XLSX_MAX_ZIP_ENTRIES + 1; i += 1) {
      entries.push({ name: `xl/dummy-${i}.bin`, content: "0" });
    }
    const bytes = buildTestXlsx(entries);
    const result = convertTabularImport({ kind: "xlsx", bytes }, OPTIONS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe("LIMIT_ZIP_ENTRIES");
    expect(result.errors[0]?.message).toContain(String(XLSX_MAX_ZIP_ENTRIES));
  });

  it("未引用的条目不会被解压（惰性读取不放大炸弹）", () => {
    // 一个声明 100 MiB 的无关条目不影响读取：它从未被 read()。
    const bytes = buildTestXlsx([
      ...baseEntries(),
      { name: "xl/evil-unused.bin", content: "z", declaredUncompressedSize: 100 * 1024 * 1024 },
    ]);
    const result = convertTabularImport({ kind: "xlsx", bytes }, OPTIONS);
    expect(result.ok).toBe(true);
  });
});

// ── 测试内嵌的最小 stored-xlsx 构造器（与模块生成器同构，仅测试用）──────

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crc32Table()[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let cachedTable: number[] | undefined;
function crc32Table(): number[] {
  if (cachedTable !== undefined) return cachedTable;
  cachedTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    cachedTable[n] = c >>> 0;
  }
  return cachedTable;
}

interface TestZipEntry {
  name: string;
  content: string | Uint8Array;
  /** 以 deflate 存放（真实 Excel 的存法）；默认 stored。 */
  deflate?: boolean;
  /** 覆写 ZIP 头里声明的解压大小（构造声明不实的条目，测 zip 炸弹防护）。 */
  declaredUncompressedSize?: number;
}

function buildTestXlsx(entries: ReadonlyArray<TestZipEntry>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const rawBytes =
      typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
    const dataBytes = entry.deflate
      ? new Uint8Array(deflateRawSync(Buffer.from(rawBytes)))
      : rawBytes;
    const declared = entry.declaredUncompressedSize ?? rawBytes.length;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(rawBytes);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, declared, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, declared, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, dataBytes);
    centrals.push(central);
    offset += local.length + dataBytes.length;
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const chunk of [...locals, ...centrals, eocd]) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function contentTypes(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`
  );
}

function rels(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`
  );
}

function workbook(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`
  );
}

function workbookRels(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`
  );
}
