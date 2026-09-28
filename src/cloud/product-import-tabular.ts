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
 * 表格商品导入（WP12）：CSV / .xlsx → 云端商品表（`product-source.ts`）的
 * 唯一转换与校验实现。工作台「商品与导入」、shopping-cli 导出脚本与技能
 * `kiwi-product-import` 的列说明都以本模块为准。
 *
 * 设计要点：
 *   - 解析在**服务端**：一份实现同时服务工作台与脚本（浏览器端会在无构建步
 *     的内联页面脚本里复制逻辑，必然漂移）；xlsx 用 node:zlib 解 DEFLATE，
 *     **零新增依赖**（供应链锁定不变）；
 *   - 表头映射容错：中文/英文/常见别名（大小写、空格、全半角标点归一化后
 *     匹配）；模板表头为「中文名/字段名」双写；
 *   - **疑似底价/成本/进价列 → 整表拒绝**：私密策略值不属于商品表（设计
 *     §10.1 硬规则），宁可拒收也不让底价混进公开表；
 *   - 无法识别的列不阻断导入，逐列列出交商家确认；
 *   - 转换出的表**再过一次** `parseProductTable`（纵深防御），最终落盘仍走
 *     既有 import-drafts 严格校验与整表替换预览；
 *   - 上限：数据行 5000、列 64、单文件 4 MiB、单元格 2000 字符。
 */

import { inflateRawSync } from "node:zlib";

import {
  parseProductTable,
  PRODUCT_TABLE_SCHEMA_VERSION,
  ProductTableError,
  type CloudProductRecord,
  type CloudProductTable,
} from "./product-source.js";

// ── 上限与常量 ─────────────────────────────────────────────────────────

export const TABULAR_IMPORT_MAX_ROWS = 5000;
export const TABULAR_IMPORT_MAX_COLUMNS = 64;
export const TABULAR_IMPORT_MAX_BYTES = 4 * 1024 * 1024;
export const TABULAR_IMPORT_MAX_CELL_CHARS = 2000;

/** 结构性失败（CSV/xlsx 解不开、超上限）抛出；逐行/逐格问题进 errors 数组。 */
export class TabularImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TabularImportError";
    this.code = code;
  }
}

// ── 列定义：字段、中文表头、别名 ───────────────────────────────────────

export type TabularField =
  | "sku"
  | "title"
  | "currency"
  | "unit"
  | "price"
  | "moq"
  | "stock"
  | "supply_note"
  | "updated_at"
  | "valid_until"
  | "status";

export interface TabularFieldSpec {
  field: TabularField;
  /** 模板中文表头（模板表头为「中文/字段」双写）。 */
  zh: string;
  required: boolean;
  /** 归一化后匹配的别名（英文/常见变体）。 */
  aliases: readonly string[];
}

export const TABULAR_FIELDS: readonly TabularFieldSpec[] = [
  {
    field: "sku",
    zh: "商品编号",
    required: true,
    aliases: ["sku", "skucode", "skuno", "商品编号", "商品编码", "货号", "商品sku", "itemcode"],
  },
  {
    field: "title",
    zh: "名称",
    required: true,
    aliases: ["title", "name", "productname", "producttitle", "商品名称", "产品名称", "品名", "名称", "商品标题"],
  },
  {
    field: "currency",
    zh: "币种",
    required: true,
    aliases: ["currency", "currencycode", "币种", "币别", "货币", "计价币种"],
  },
  {
    field: "unit",
    zh: "计价单位",
    required: true,
    aliases: ["unit", "units", "pricingunit", "unitofmeasure", "uom", "计价单位", "单位", "计量单位", "价格单位"],
  },
  {
    field: "price",
    zh: "单价",
    required: true,
    aliases: [
      "price",
      "unitprice",
      "listprice",
      "sellingprice",
      "单价",
      "价格",
      "销售价",
      "销售单价",
      "售价",
      "公开价",
      "报价",
    ],
  },
  {
    field: "moq",
    zh: "起订量",
    required: false,
    aliases: ["moq", "minorderqty", "minimumorderquantity", "起订量", "最小起订量", "起订数量"],
  },
  {
    field: "stock",
    zh: "库存",
    required: false,
    aliases: ["stock", "stockqty", "inventory", "qty", "quantity", "库存", "库存数量", "可用库存", "剩余库存"],
  },
  {
    field: "supply_note",
    zh: "供货说明",
    required: false,
    aliases: ["supplynote", "note", "notes", "remark", "remarks", "供货说明", "供货备注", "备注", "说明", "商品说明", "描述", "description"],
  },
  {
    field: "updated_at",
    zh: "更新时间",
    required: false,
    aliases: ["updatedat", "updatetime", "lastupdated", "更新时间", "数据时间", "修改时间", "最近更新"],
  },
  {
    field: "valid_until",
    zh: "有效期至",
    required: true,
    aliases: [
      "validuntil",
      "validtill",
      "validity",
      "expiry",
      "expireat",
      "有效期",
      "有效期至",
      "有效期限",
      "有效期到",
      "截止日期",
      "截止时间",
      "到期日",
      "失效日期",
    ],
  },
  {
    field: "status",
    zh: "状态",
    required: false,
    aliases: ["status", "listingstatus", "active", "状态", "商品状态", "销售状态", "上架状态"],
  },
];

/**
 * 疑似底价/成本/进价列（归一化后**包含**即命中）：整表拒绝。底价、成本
 * 属于商家私密策略，绝不能进公开商品表（设计 §10.1 硬规则）。
 */
const COST_COLUMN_TOKENS: readonly string[] = [
  "底价",
  "成本",
  "进价",
  "进货价",
  "采购价",
  "购入价",
  "内部价",
  "cost",
  "costprice",
  "floorprice",
  "floor",
  "baseprice",
  "purchaseprice",
  "buyprice",
  "buyingprice",
];

/** 表头归一化：小写、去空白与中英文标点（模板「中文/字段」双写靠这个收敛）。 */
function normalizeHeader(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_·•、，,。.：:；;（）()\[\]【】{}*#"'’“”]/g, "");
}

function buildAliasIndex(): Map<string, TabularField> {
  const index = new Map<string, TabularField>();
  for (const spec of TABULAR_FIELDS) {
    index.set(normalizeHeader(spec.field), spec.field);
    index.set(normalizeHeader(spec.zh), spec.field);
    index.set(normalizeHeader(`${spec.zh}/${spec.field}`), spec.field);
    for (const alias of spec.aliases) {
      const key = normalizeHeader(alias);
      if (!index.has(key)) index.set(key, spec.field);
    }
  }
  return index;
}

const ALIAS_INDEX: ReadonlyMap<string, TabularField> = buildAliasIndex();

function isCostColumn(normalized: string): boolean {
  return COST_COLUMN_TOKENS.some((token) => normalized.includes(token));
}

// ── 值解析：数字 / 日期 / 币种 / 状态 ─────────────────────────────────

const NUMBER_STRIP_RE = /[￥¥$€\s,，]/g;

/** 解析数字：允许货币符号前缀与千分位分隔；必须是非空有限数。 */
function parseCellNumber(raw: string): number {
  const cleaned = raw.replace(NUMBER_STRIP_RE, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return Number.NaN;
  return Number(cleaned);
}

const CURRENCY_MAP: Readonly<Record<string, string>> = {
  人民币: "CNY",
  人民币元: "CNY",
  元: "CNY",
  cny: "CNY",
  rmb: "CNY",
  美元: "USD",
  美金: "USD",
  usd: "USD",
  欧元: "EUR",
  eur: "EUR",
  港币: "HKD",
  港元: "HKD",
  hkd: "HKD",
  日元: "JPY",
  jpy: "JPY",
  英镑: "GBP",
  gbp: "GBP",
};

function parseCellCurrency(raw: string): string {
  const key = raw.trim().normalize("NFKC").toLowerCase();
  const mapped = CURRENCY_MAP[key];
  if (mapped !== undefined) return mapped;
  if (/^[a-z]{3}$/.test(key)) return key.toUpperCase();
  return "";
}

const STATUS_ACTIVE = new Set([
  "active",
  "在售",
  "正常",
  "销售",
  "销售中",
  "售卖",
  "售卖中",
  "上架",
  "已上架",
  "启用",
  "1",
  "yes",
  "true",
]);
const STATUS_PAUSED = new Set([
  "paused",
  "暂停",
  "已暂停",
  "暂停销售",
  "停售",
  "下架",
  "已下架",
  "停用",
  "0",
  "no",
  "false",
]);

function parseCellStatus(raw: string): "active" | "paused" | "" {
  const key = raw.trim().normalize("NFKC").toLowerCase();
  if (STATUS_ACTIVE.has(key)) return "active";
  if (STATUS_PAUSED.has(key)) return "paused";
  return "";
}

const DATE_RE =
  /^(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * 解析日期单元格：YYYY-MM-DD / YYYY/M/D / YYYY年M月D日（可带时间）或 ISO
 * 时间戳。纯日期按 UTC 解释；`endOfDay=true`（有效期）取当日 23:59:59，
 * 避免商家填「2027-12-31」当天上午就过期。其余返回空串（由调用方报错）。
 */
function parseCellDate(raw: string, options: { endOfDay: boolean }): string {
  const text = raw.trim();
  const match = DATE_RE.exec(text);
  if (match !== null) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = match[4] !== undefined ? Number(match[4]) : 0;
    const minute = match[5] !== undefined ? Number(match[5]) : 0;
    const second = match[6] !== undefined ? Number(match[6]) : 0;
    const hasTime = match[4] !== undefined;
    if (month < 1 || month > 12 || day < 1 || day > 31) return "";
    const date = new Date(
      Date.UTC(
        year,
        month - 1,
        day,
        hasTime ? hour : options.endOfDay ? 23 : 0,
        hasTime ? minute : options.endOfDay ? 59 : 0,
        hasTime ? second : options.endOfDay ? 59 : 0,
      ),
    );
    // 回读校验：Date.UTC 会静默滚动非法日期（如 2 月 30 日），必须拒绝。
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return "";
    }
    return date.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const parsed = Date.parse(text);
    if (Number.isNaN(parsed)) return "";
    return new Date(parsed).toISOString();
  }
  return "";
}

// ── CSV 解析（RFC 4180 风格：引号、双引号转义、CRLF、BOM）────────────

export function parseCsv(text: string): string[][] {
  if (text.length > TABULAR_IMPORT_MAX_BYTES) {
    throw new TabularImportError("LIMIT_BYTES", `文件超过上限 ${TABULAR_IMPORT_MAX_BYTES} 字节`);
  }
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (inQuotes) {
      if (ch === '"') {
        if (stripped[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\r") {
      if (stripped[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((line) => !(line.length === 1 && line[0] === ""));
}

// ── xlsx 读取（ZIP + sheet XML；零依赖）───────────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** 最小 ZIP 读取器：EOCD → 中央目录 → 本地头定位数据；支持 stored/deflate。 */
function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new TabularImportError("PARSE_ERROR", "不是合法的 xlsx 文件（找不到 ZIP 目录）");
  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  let cursor = cdOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new TabularImportError("PARSE_ERROR", "xlsx 的 ZIP 中央目录损坏");
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const local = entry.localOffset;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) {
      throw new TabularImportError("PARSE_ERROR", `xlsx 的本地文件头损坏：${entry.name}`);
    }
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);
    let content: Uint8Array;
    if (entry.method === 0) {
      content = data;
    } else if (entry.method === 8) {
      try {
        content = new Uint8Array(inflateRawSync(Buffer.from(data)));
      } catch {
        throw new TabularImportError("PARSE_ERROR", `xlsx 内部文件解压失败：${entry.name}`);
      }
    } else {
      throw new TabularImportError("PARSE_ERROR", `xlsx 使用了不支持的压缩方式：${entry.name}`);
    }
    files.set(entry.name, content);
  }
  return files;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Excel 序列日（1900 系，历元 1899-12-30）→ ISO 字符串；整数为纯日期。 */
function excelSerialToIso(serial: number): string {
  const rounded = Math.round(serial * 86400) / 86400;
  const ms = Math.round((rounded - 25569) * 86400000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const hasTime = Math.abs(serial - Math.round(serial)) > 1e-9;
  if (!hasTime) return date.toISOString().slice(0, 10);
  return date.toISOString();
}

function columnToIndex(ref: string): number {
  const match = /^([A-Z]+)/.exec(ref);
  if (match === null) return -1;
  let index = 0;
  for (const ch of match[1] ?? "") index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** 解析第一张工作表为字符串矩阵；数值保持原文，日期样式数值转 ISO。 */
export function parseXlsx(bytes: Uint8Array): string[][] {
  if (bytes.length > TABULAR_IMPORT_MAX_BYTES) {
    throw new TabularImportError("LIMIT_BYTES", `文件超过上限 ${TABULAR_IMPORT_MAX_BYTES} 字节`);
  }
  const files = readZipEntries(bytes);
  const sheetPath = resolveFirstSheetPath(files);
  const sheetXml = files.get(sheetPath);
  if (sheetXml === undefined) {
    throw new TabularImportError("PARSE_ERROR", `xlsx 里找不到工作表：${sheetPath}`);
  }
  const shared = readSharedStrings(files.get("xl/sharedStrings.xml"));
  const dateStyles = readDateStyles(files.get("xl/styles.xml"));
  const xml = new TextDecoder().decode(sheetXml);

  const rows: string[][] = [];
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>|<row[^>]*\/>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    if (rows.length >= TABULAR_IMPORT_MAX_ROWS + 1) {
      throw new TabularImportError("LIMIT_ROWS", `数据行超过上限 ${TABULAR_IMPORT_MAX_ROWS} 行`);
    }
    const cells: string[] = [];
    const body = rowMatch[2] ?? "";
    const cellRe = /<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    let fallbackColumn = 0;
    while ((cellMatch = cellRe.exec(body)) !== null) {
      const attrs = cellMatch[1] ?? "";
      const inner = cellMatch[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "";
      const style = /\bs="(\d+)"/.exec(attrs)?.[1];
      const column = ref !== "" ? columnToIndex(ref) : fallbackColumn;
      fallbackColumn = column + 1;
      if (column < 0 || column >= TABULAR_IMPORT_MAX_COLUMNS) {
        if (column >= TABULAR_IMPORT_MAX_COLUMNS) {
          throw new TabularImportError("LIMIT_COLUMNS", `列数超过上限 ${TABULAR_IMPORT_MAX_COLUMNS}`);
        }
        continue;
      }
      const value = readCellValue(inner, type, style, shared, dateStyles);
      cells[column] = value;
    }
    // cells 是稀疏数组（按列号落位）；map/forEach 会跳过空洞导致错位，
    // 必须先稠密化。
    const normalized = Array.from({ length: cells.length }, (_, index) => cells[index] ?? "");
    rows.push(normalized.slice(0, TABULAR_IMPORT_MAX_COLUMNS));
  }
  return rows.filter((line) => !line.every((cell) => cell === ""));
}

function resolveFirstSheetPath(files: ReadonlyMap<string, Uint8Array>): string {
  const workbook = files.get("xl/workbook.xml");
  const rels = files.get("xl/_rels/workbook.xml.rels");
  if (workbook !== undefined && rels !== undefined) {
    const rid = /<sheet[^>]*\br:id="(rId\d+)"/.exec(new TextDecoder().decode(workbook))?.[1];
    if (rid !== undefined) {
      const relXml = new TextDecoder().decode(rels);
      const relRe = new RegExp(`<Relationship[^>]*\\bId="${rid}"[^>]*\\bTarget="([^"]+)"`);
      const target = relRe.exec(relXml)?.[1];
      if (target !== undefined) {
        return target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      }
    }
  }
  return "xl/worksheets/sheet1.xml";
}

function readCellValue(
  inner: string,
  type: string,
  style: string | undefined,
  shared: readonly string[],
  dateStyles: ReadonlySet<number>,
): string {
  if (type === "inlineStr") {
    const parts: string[] = [];
    const textRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = textRe.exec(inner)) !== null) parts.push(decodeXmlEntities(textMatch[1] ?? ""));
    return parts.join("");
  }
  const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
  if (value === "") return "";
  if (type === "s") {
    const index = Number.parseInt(value, 10);
    return shared[index] ?? "";
  }
  if (type === "str" || type === "b") {
    if (type === "b") return value === "1" ? "true" : "false";
    return decodeXmlEntities(value);
  }
  // 数值单元格：日期样式 → ISO；否则保留原文（由列转换按数字解析）。
  if (style !== undefined && dateStyles.has(Number(style))) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return excelSerialToIso(numeric);
  }
  return decodeXmlEntities(value);
}

function readSharedStrings(xml: Uint8Array | undefined): string[] {
  if (xml === undefined) return [];
  const text = new TextDecoder().decode(xml);
  const strings: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRe.exec(text)) !== null) {
    const parts: string[] = [];
    const textRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let textMatch: RegExpExecArray | null;
    while ((textMatch = textRe.exec(siMatch[1] ?? "")) !== null) {
      parts.push(decodeXmlEntities(textMatch[1] ?? ""));
    }
    strings.push(parts.join(""));
  }
  return strings;
}

/** 内建日期数字格式（14–22、45–47）+ 自定义含 y/m/d/h/s 的格式。 */
function readDateStyles(xml: Uint8Array | undefined): Set<number> {
  const styles = new Set<number>();
  if (xml === undefined) return styles;
  const text = new TextDecoder().decode(xml);
  const customFormats = new Map<number, string>();
  const fmtRe = /<numFmt[^>]*\bnumFmtId="(\d+)"[^>]*\bformatCode="([^"]*)"/g;
  let fmtMatch: RegExpExecArray | null;
  while ((fmtMatch = fmtRe.exec(text)) !== null) {
    customFormats.set(Number(fmtMatch[1]), fmtMatch[2] ?? "");
  }
  const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(text)?.[1] ?? "";
  const xfRe = /<xf\b[^>]*?(?:\/>|>)/g;
  let xfMatch: RegExpExecArray | null;
  let styleIndex = 0;
  while ((xfMatch = xfRe.exec(cellXfs)) !== null) {
    // xf 可省略 numFmtId（继承样式 0）；索引按 xf 出现顺序递增，不能跳过。
    const numFmtId = Number(/\bnumFmtId="(\d+)"/.exec(xfMatch[0])?.[1] ?? 0);
    if (
      (numFmtId >= 14 && numFmtId <= 22) ||
      (numFmtId >= 45 && numFmtId <= 47) ||
      (customFormats.get(numFmtId) ?? "").replace(/\[[^\]]*\]|"[^"]*"/g, "").match(/[ymdhs]/i) !== null
    ) {
      styles.add(styleIndex);
    }
    styleIndex += 1;
  }
  return styles;
}

// ── 模板生成（CSV + xlsx；同一份表头与示例行）────────────────────────

/** 模板表头（「中文名/字段名」双写），CSV 与 xlsx 模板、别名索引共用。 */
export const TABULAR_TEMPLATE_HEADER: readonly string[] = [
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

export const TABULAR_TEMPLATE_EXAMPLE_ROWS: readonly string[][] = [
  [
    "DEMO-001",
    "不锈钢保温杯 500ml",
    "CNY",
    "piece",
    "29.90",
    "50",
    "2000",
    "现货，下单后 3 个工作日发货",
    "",
    "2027-12-31",
    "在售",
  ],
  [
    "DEMO-002",
    "瓦楞纸箱 五层加强",
    "CNY",
    "box",
    "3.50",
    "100",
    "8000",
    "按订单生产，约 7 天交期",
    "2026-09-01",
    "2028-06-30",
    "在售",
  ],
];

function csvEscape(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** CSV 模板（带 BOM，Excel 直接打开中文不乱码；本模块的解析器会剥掉 BOM）。 */
export function renderImportTemplateCsv(): string {
  const lines = [TABULAR_TEMPLATE_HEADER, ...TABULAR_TEMPLATE_EXAMPLE_ROWS].map((row) =>
    row.map(csvEscape).join(","),
  );
  return `\ufeff${lines.join("\r\n")}\r\n`;
}

// ── xlsx 模板写出（stored ZIP：无需压缩，只算 CRC32）──────────────────

const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );
}

interface StoredZipInput {
  name: string;
  content: string;
}

/** 打一个最小 stored ZIP（全 ASCII 文件名；UTF-8 内容）。 */
function buildStoredZip(entries: readonly StoredZipInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const dataBytes = encoder.encode(entry.content);
    const crc = crc32(dataBytes);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 文件名标志
    localView.setUint16(8, 0, true); // stored
    localView.setUint32(14, crc, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local, dataBytes);
    centrals.push(central);
    offset += local.length + dataBytes.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  const totalLength = offset + centralSize + 22;
  const out = new Uint8Array(totalLength);
  let cursor = 0;
  for (const chunk of [...locals, ...centrals, eocd]) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function sheetXmlFromGrid(rows: readonly (readonly string[])[]): string {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, columnIndex) =>
          cell === ""
            ? ""
            : `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`,
        )
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  const cols = Array.from({ length: columnCount }, (_, index) => {
    const width = index === 0 || index === 7 ? 260 : 110;
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
  }).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`
  );
}

function columnName(index: number): string {
  let name = "";
  let rest = index;
  do {
    name = String.fromCharCode(65 + (rest % 26)) + name;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return name;
}

/** xlsx 模板（单工作表「商品导入模板」；单元格为内联字符串，stored ZIP）。 */
export function renderImportTemplateXlsx(): Uint8Array {
  const grid = [TABULAR_TEMPLATE_HEADER, ...TABULAR_TEMPLATE_EXAMPLE_ROWS];
  return buildStoredZip([
    {
      name: "[Content_Types].xml",
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `</Types>`,
    },
    {
      name: "_rels/.rels",
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="商品导入模板" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `</Relationships>`,
    },
    { name: "xl/worksheets/sheet1.xml", content: sheetXmlFromGrid(grid) },
  ]);
}

// ── 转换主流程：表格矩阵 → CloudProductTable ──────────────────────────

export interface TabularImportIssue {
  row?: number;
  column?: string;
  field?: TabularField;
  code: string;
  message: string;
}

export interface TabularImportReport {
  format: "csv" | "xlsx";
  /** 数据行数（不含表头、不含空行）。 */
  rows: number;
  /** 每列的识别结果（含未识别列，按原表顺序）。 */
  header_mapping: Array<{ column: string; field?: TabularField }>;
  /** 无法识别的列名（原样），交商家确认；不阻断导入。 */
  unrecognized_columns: string[];
  /** 未提供而按默认值处理的字段。 */
  defaulted_fields: TabularField[];
  skipped_empty_rows: number;
}

export interface TabularImportResult {
  ok: boolean;
  /** ok=true 时给出可直接提交 import-drafts 的商品表。 */
  table?: CloudProductTable;
  report: TabularImportReport;
  /** ok=false 时的全部问题（整表拒绝，任一行错误都不导入）。 */
  errors: TabularImportIssue[];
}

export interface TabularImportOptions {
  merchantId: string;
  now?: () => Date;
}

export type TabularImportInput =
  | { kind: "csv"; text: string }
  | { kind: "xlsx"; bytes: Uint8Array };

/**
 * CSV/xlsx → 云端商品表。任何行级/格级问题都进 `errors`（整表拒绝、逐条列
 * 出）；成功时再过一次 `parseProductTable`（复用既有严格校验，纵深防御）。
 */
export function convertTabularImport(
  input: TabularImportInput,
  options: TabularImportOptions,
): TabularImportResult {
  const now = options.now ?? (() => new Date());
  const errors: TabularImportIssue[] = [];
  let grid: string[][];
  try {
    grid = input.kind === "csv" ? parseCsv(input.text) : parseXlsx(input.bytes);
  } catch (err) {
    if (err instanceof TabularImportError) {
      return {
        ok: false,
        report: { format: input.kind, rows: 0, header_mapping: [], unrecognized_columns: [], defaulted_fields: [], skipped_empty_rows: 0 },
        errors: [{ code: err.code, message: err.message }],
      };
    }
    throw err;
  }
  const report: TabularImportReport = {
    format: input.kind,
    rows: 0,
    header_mapping: [],
    unrecognized_columns: [],
    defaulted_fields: [],
    skipped_empty_rows: 0,
  };

  const headerRow = grid[0];
  if (headerRow === undefined || headerRow.every((cell) => cell.trim() === "")) {
    return { ok: false, report, errors: [{ code: "EMPTY_TABLE", message: "表格是空的：第一行应为表头" }] };
  }
  if (grid.length - 1 <= 0) {
    return { ok: false, report, errors: [{ code: "EMPTY_TABLE", message: "表格只有表头，没有商品行" }] };
  }
  if (headerRow.length > TABULAR_IMPORT_MAX_COLUMNS) {
    return {
      ok: false,
      report,
      errors: [
        {
          code: "LIMIT_COLUMNS",
          message: `表头有 ${headerRow.length} 列，超过上限 ${TABULAR_IMPORT_MAX_COLUMNS} 列`,
        },
      ],
    };
  }

  // 表头识别 + 成本列拒绝。
  const columnField: Array<TabularField | undefined> = [];
  headerRow.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      report.header_mapping.push({ column: trimmed });
      columnField.push(undefined);
      return;
    }
    const normalized = normalizeHeader(trimmed);
    const field = ALIAS_INDEX.get(normalized);
    if (field !== undefined) {
      report.header_mapping.push({ column: trimmed, field });
      columnField.push(field);
      return;
    }
    if (isCostColumn(normalized)) {
      errors.push({
        column: trimmed,
        code: "COST_COLUMN",
        message: `第 ${index + 1} 列「${trimmed}」疑似底价/成本/进价列：底价与成本属于私密报价策略，不能出现在公开商品表里。请删除该列（及同类列）后重新导出再导入。`,
      });
      report.header_mapping.push({ column: trimmed });
      columnField.push(undefined);
      return;
    }
    report.header_mapping.push({ column: trimmed });
    report.unrecognized_columns.push(trimmed);
    columnField.push(undefined);
  });
  const hasCostColumn = errors.some((issue) => issue.code === "COST_COLUMN");
  if (hasCostColumn) return { ok: false, report, errors };

  // 必需列检查（缺价格单独点名，其余列出一并报）。
  const present = new Set(columnField.filter((field): field is TabularField => field !== undefined));
  for (const spec of TABULAR_FIELDS) {
    if (spec.required && !present.has(spec.field)) {
      const label = spec.field === "price" ? "单价/价格" : `${spec.zh}（${spec.field}）`;
      errors.push({
        field: spec.field,
        code: "MISSING_COLUMN",
        message: `表头缺少必需列：${label}。请按导入模板补齐后再导入（模板可在工作台「商品与导入」页下载）。`,
      });
    }
    if (!spec.required && !present.has(spec.field)) {
      report.defaulted_fields.push(spec.field);
    }
  }
  if (errors.length > 0) return { ok: false, report, errors };

  // 数据行 → CloudProductRecord。
  const columnIndex = new Map<TabularField, number>();
  columnField.forEach((field, index) => {
    if (field !== undefined && !columnIndex.has(field)) columnIndex.set(field, index);
  });
  const cellOf = (row: string[], field: TabularField): string => {
    const index = columnIndex.get(field);
    return index === undefined ? "" : (row[index] ?? "").trim();
  };

  const products: CloudProductRecord[] = [];
  const skuRows = new Map<string, number>();
  for (let index = 1; index < grid.length; index += 1) {
    const row = grid[index] ?? [];
    const rowNumber = index + 1; // 表头是第 1 行，与 Excel 行号一致。
    if (row.every((cell) => cell.trim() === "")) {
      report.skipped_empty_rows += 1;
      continue;
    }
    if (products.length >= TABULAR_IMPORT_MAX_ROWS) {
      errors.push({
        code: "LIMIT_ROWS",
        message: `数据行超过上限 ${TABULAR_IMPORT_MAX_ROWS} 行（第 ${rowNumber} 行起未读取）。请分批导入或精简表格。`,
      });
      break;
    }
    report.rows += 1;

    for (const [field] of columnIndex) {
      const cell = cellOf(row, field);
      if (cell.length > TABULAR_IMPORT_MAX_CELL_CHARS) {
        errors.push({
          row: rowNumber,
          field,
          code: "CELL_TOO_LONG",
          message: `第 ${rowNumber} 行「${field}」超过 ${TABULAR_IMPORT_MAX_CELL_CHARS} 字符`,
        });
      }
    }

    const sku = cellOf(row, "sku");
    if (sku === "") {
      errors.push({ row: rowNumber, field: "sku", code: "EMPTY_REQUIRED", message: `第 ${rowNumber} 行商品编号（sku）为空` });
    }
    const title = cellOf(row, "title");
    if (title === "") {
      errors.push({ row: rowNumber, field: "title", code: "EMPTY_REQUIRED", message: `第 ${rowNumber} 行名称（title）为空` });
    }
    const unit = cellOf(row, "unit");
    if (unit === "") {
      errors.push({ row: rowNumber, field: "unit", code: "EMPTY_REQUIRED", message: `第 ${rowNumber} 行计价单位（unit）为空` });
    }

    const priceRaw = cellOf(row, "price");
    const price = parseCellNumber(priceRaw);
    if (priceRaw === "") {
      errors.push({ row: rowNumber, field: "price", code: "EMPTY_REQUIRED", message: `第 ${rowNumber} 行单价（price）为空：价格必须由商家提供，不能缺省` });
    } else if (Number.isNaN(price) || price <= 0) {
      errors.push({ row: rowNumber, field: "price", code: "BAD_NUMBER", message: `第 ${rowNumber} 行单价不是正数（收到「${priceRaw}」）` });
    }

    const currencyRaw = cellOf(row, "currency");
    const currency = parseCellCurrency(currencyRaw);
    if (currencyRaw === "") {
      errors.push({ row: rowNumber, field: "currency", code: "EMPTY_REQUIRED", message: `第 ${rowNumber} 行币种为空` });
    } else if (currency === "") {
      errors.push({ row: rowNumber, field: "currency", code: "BAD_CURRENCY", message: `第 ${rowNumber} 行币种无法识别（收到「${currencyRaw}」）：请填三字母代码（如 CNY/USD）或常见中文名（人民币/美元/欧元/港币/日元/英镑）` });
    }

    const validRaw = cellOf(row, "valid_until");
    const validUntil = parseCellDate(validRaw, { endOfDay: true });
    if (validRaw === "") {
      errors.push({ row: rowNumber, field: "valid_until", code: "EMPTY_REQUIRED", message: `第 ${rowNumber} 行有效期至为空：请填商品可报价的截止日期（如 2027-12-31）` });
    } else if (validUntil === "") {
      errors.push({ row: rowNumber, field: "valid_until", code: "BAD_DATE", message: `第 ${rowNumber} 行有效期不是合法日期（收到「${validRaw}」）：请用 2027-12-31、2027/12/31 或 2027年12月31日 格式` });
    }

    const updatedRaw = cellOf(row, "updated_at");
    const updatedAt =
      updatedRaw === "" ? now().toISOString() : parseCellDate(updatedRaw, { endOfDay: false });
    if (updatedRaw !== "" && updatedAt === "") {
      errors.push({ row: rowNumber, field: "updated_at", code: "BAD_DATE", message: `第 ${rowNumber} 行更新时间不是合法日期（收到「${updatedRaw}」）：留空将自动使用导入时间` });
    }

    const statusRaw = cellOf(row, "status");
    const status = statusRaw === "" ? "active" : parseCellStatus(statusRaw);
    if (statusRaw !== "" && status === "") {
      errors.push({ row: rowNumber, field: "status", code: "BAD_STATUS", message: `第 ${rowNumber} 行状态无法识别（收到「${statusRaw}」）：留空=在售；或填 在售/暂停` });
    }

    const moqRaw = cellOf(row, "moq");
    let moq: number | undefined;
    if (moqRaw !== "") {
      const parsed = parseCellNumber(moqRaw);
      if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
        errors.push({ row: rowNumber, field: "moq", code: "BAD_NUMBER", message: `第 ${rowNumber} 行起订量必须是正整数（收到「${moqRaw}」）` });
      } else {
        moq = parsed;
      }
    }

    const stockRaw = cellOf(row, "stock");
    let stock: number | undefined;
    if (stockRaw !== "") {
      const parsed = parseCellNumber(stockRaw);
      if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed < 0) {
        errors.push({ row: rowNumber, field: "stock", code: "BAD_NUMBER", message: `第 ${rowNumber} 行库存必须是非负整数（收到「${stockRaw}」）；不确定就留空，不要填 0 冒充` });
      } else {
        stock = parsed;
      }
    }

    if (sku !== "") {
      const firstRow = skuRows.get(sku);
      if (firstRow !== undefined) {
        errors.push({ row: rowNumber, field: "sku", code: "DUPLICATE_SKU", message: `第 ${rowNumber} 行商品编号「${sku}」与第 ${firstRow} 行重复：同一 SKU 只能出现一次` });
      } else {
        skuRows.set(sku, rowNumber);
      }
    }

    products.push({
      sku,
      title,
      currency: currency === "" ? currencyRaw : currency,
      unit,
      price: Number.isNaN(price) ? 0 : Math.round(price * 100) / 100,
      ...(moq !== undefined ? { moq } : {}),
      ...(stock !== undefined ? { stock } : {}),
      ...(cellOf(row, "supply_note") !== "" ? { supply_note: cellOf(row, "supply_note") } : {}),
      updated_at: updatedAt === "" ? now().toISOString() : updatedAt,
      valid_until: validUntil === "" ? validRaw : validUntil,
      status: status === "" ? "active" : status,
    });
  }

  if (errors.length > 0) return { ok: false, report, errors };
  if (products.length === 0) {
    return { ok: false, report, errors: [{ code: "EMPTY_TABLE", message: "表格没有有效商品行" }] };
  }

  const table: CloudProductTable = {
    schema_version: PRODUCT_TABLE_SCHEMA_VERSION,
    merchant_id: options.merchantId,
    source: "merchant_upload",
    generated_at: now().toISOString(),
    products,
  };
  try {
    // 复用 product-source 的严格校验（任何结构问题都不放行）。
    parseProductTable(table, "tabular import");
  } catch (err) {
    const message = err instanceof ProductTableError ? err.message : String(err);
    return { ok: false, report, errors: [{ code: "TABLE_INVALID", message: `转换结果未通过商品表校验：${message}` }] };
  }
  return { ok: true, table, report, errors: [] };
}
