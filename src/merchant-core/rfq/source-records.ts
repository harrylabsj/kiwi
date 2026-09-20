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
 * 询盘来源与字段证据（设计 v0.1.1 §5.1 步骤一/二、§6.2）。
 *
 * 边界：
 *   - 原始材料由操作者显式提供（粘贴文本 / UTF-8 CSV）；Core 不自动拉取
 *     任何私人会话。
 *   - 文本 locator 使用 Unicode code point 的 [start, end) 半开区间，不是
 *     UTF-8 字节偏移，也不是 UTF-16 下标。
 *   - CSV 遵循 RFC 4180：逗号分隔、双引号转义、CRLF/LF 均可；首行必须
 *     为 UTF-8 表头（允许带 BOM，服务端剥离）；未识别列拒绝而非忽略；
 *     解析失败整文件拒绝（SOURCE_INVALID），不截断续跑。
 *   - 模型提取 proposal 只产生「未确认工作成果」：每个关键字段必须带原文
 *     定位；确认状态只能由具名人工确认（confirmItems / 管理页表单）推进，
 *     模型置信度仅用于提醒。
 */

import { createHash } from "node:crypto";
import { RfqError, type RfqCaseFields, type RfqLine, type SourceLocator, type TextSpanLocator } from "./types.js";

export const SOURCE_RECORD_KINDS = ["manual_text", "csv", "customer_feedback", "manual_fact"] as const;
export type SourceRecordKind = (typeof SOURCE_RECORD_KINDS)[number];

/** 原始材料摘要记录（入库前构造；content_ref 由 repository 指派）。 */
export interface SourceRecordDraft {
  kind: SourceRecordKind;
  content_sha256: string;
  /** 原文内容（私有目录落盘；不入 telemetry/日志）。 */
  content: string;
  received_at: string;
  submitted_by: string;
  synthetic: boolean;
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * code point 定位：返回 quote 在 content 中的 [start, end) 半开区间
 * （Unicode code point 计数）。quote 必须真实出现于 content——否则提取
 * 证据是伪造的，整条 proposal 拒绝。
 */
export function textSpanLocator(content: string, quote: string): TextSpanLocator {
  if (quote === "") {
    throw new RfqError("validation", "locator quote 不能为空");
  }
  const idx = content.indexOf(quote);
  if (idx === -1) {
    throw new RfqError("source_invalid", "提取引用不在原文中（locator 必须来自原文）");
  }
  // UTF-16 下标 → code point 下标：只统计非低代理项的码元。
  const toCodePoint = (utf16: number): number =>
    Array.from(content.slice(0, utf16)).length;
  return {
    kind: "text_span",
    character_start: toCodePoint(idx),
    character_end: toCodePoint(idx + quote.length),
    quote,
  };
}

/** 按定位从原文提取引用（校验区间合法 + 内容一致）。 */
export function extractSpan(content: string, locator: SourceLocator): string {
  if (locator.kind !== "text_span") {
    throw new RfqError("validation", "text 来源只支持 text_span locator");
  }
  const points = Array.from(content);
  if (
    !Number.isInteger(locator.character_start) ||
    !Number.isInteger(locator.character_end) ||
    locator.character_start < 0 ||
    locator.character_end <= locator.character_start ||
    locator.character_end > points.length
  ) {
    throw new RfqError("source_invalid", "text_span locator 越界或区间非法");
  }
  const quote = points.slice(locator.character_start, locator.character_end).join("");
  if (quote !== locator.quote) {
    throw new RfqError("source_invalid", "locator 区间内容与 quote 不一致");
  }
  return quote;
}

// ---------------------------------------------------------------------------
// CSV（RFC 4180）
// ---------------------------------------------------------------------------

const CSV_COLUMNS = ["line_id", "query", "sku", "quantity", "unit"] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** RFC 4180 解析：返回行（首行为表头）；引号转义/列数不一致整文件拒绝。 */
export function parseCsv(raw: string): { header: string[]; rows: string[][] } {
  let text = raw;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM 剥离
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field !== "") {
        throw new RfqError("source_invalid", `CSV 第 ${rows.length + 1} 行：引号前出现裸字符`);
      }
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new RfqError("source_invalid", "CSV 引号未闭合");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) throw new RfqError("source_invalid", "CSV 缺少表头行");
  const header = rows.shift() as string[];
  if (header.some((h) => h.trim() === "")) {
    throw new RfqError("source_invalid", "CSV 表头存在空列名");
  }
  const width = header.length;
  if (rows.some((r) => r.length !== width)) {
    throw new RfqError("source_invalid", "CSV 数据行列数与表头不一致");
  }
  return { header, rows };
}

export interface CsvInquiry {
  lines: Array<Pick<RfqLine, "line_id" | "query" | "sku" | "quantity" | "unit">>;
}

/**
 * 询盘 CSV → 规范行。列名必须匹配既定映射（line_id/query/sku/quantity/unit），
 * 未识别列拒绝；quantity 非正整数整文件拒绝；至少 1 行数据。
 */
export function parseCsvInquiry(raw: string): CsvInquiry {
  const { header, rows } = parseCsv(raw);
  const unknown = header.filter((h) => !CSV_COLUMNS.includes(h.trim() as CsvColumn));
  if (unknown.length > 0) {
    throw new RfqError(
      "source_invalid",
      `CSV 存在未识别列（${unknown.join(",")}）；支持列：${CSV_COLUMNS.join(",")}`,
    );
  }
  if (rows.length === 0) throw new RfqError("source_invalid", "CSV 缺少数据行");
  // 输入上限（§17.3）：单 CSV 最多 1,000 行数据（单份报价 100 行上限由计价
  // 引擎另行把关——超限明确拒绝，不截断后继续正式报价）。
  if (rows.length > 1000) throw new RfqError("source_invalid", "CSV 最多 1000 行数据（超出请分批导入）");
  const col = (name: string): number => header.findIndex((h) => h.trim() === name);
  const out = rows.map((r, idx) => {
    const lineId = (r[col("line_id")] ?? "").trim() || `L${idx + 1}`;
    const query = (r[col("query")] ?? "").trim();
    const sku = (r[col("sku")] ?? "").trim();
    const quantityRaw = (r[col("quantity")] ?? "").trim();
    const unit = (r[col("unit")] ?? "").trim();
    if (query === "") {
      throw new RfqError("source_invalid", `CSV 第 ${idx + 2} 行：query 必填`);
    }
    let quantity: number | null = null;
    if (quantityRaw !== "") {
      const n = Number(quantityRaw);
      if (!Number.isSafeInteger(n) || n < 1 || n > 100_000) {
        throw new RfqError(
          "source_invalid",
          `CSV 第 ${idx + 2} 行：quantity 必须是 1..100000 的正整数`,
        );
      }
      quantity = n;
    }
    return {
      line_id: lineId,
      query,
      sku: sku === "" ? null : sku,
      quantity,
      unit: unit === "" ? null : unit,
    };
  });
  const ids = new Set(out.map((l) => l.line_id));
  if (ids.size !== out.length) {
    throw new RfqError("source_invalid", "CSV line_id 重复");
  }
  return { lines: out };
}

// ---------------------------------------------------------------------------
// 提取 proposal（模型建议；一律保持未确认）
// ---------------------------------------------------------------------------

/** 允许模型提议的字段路径（§13.2 提取与输出分离；数量/单位/条款，不含 SKU）。 */
export const PROPOSABLE_PATHS = [
  "client_ref",
  "recipient_ref",
  "lines.quantity",
  "lines.unit",
  "terms.tax_basis",
  "terms.tax_rate_bps",
  "terms.shipping_known",
  "terms.shipping_minor",
  "terms.delivery_date",
  "terms.payment_terms",
] as const;
export type ProposablePath = (typeof PROPOSABLE_PATHS)[number];

export interface ExtractionProposalEntry {
  /** 行定位：多行询盘按 line_id 定位行级字段。 */
  line_id?: string;
  field_path: ProposablePath;
  value: string | number | boolean;
  /** 原文引用（text 来源必须带；必须真实出现于来源原文）。 */
  quote: string;
  /** 模型置信度（仅提醒用，绝不作为授权或正确性证明）。 */
  confidence?: number;
}

export interface ProposalOutcome {
  fields: RfqCaseFields;
  /** 记录的证据（source_id + locator + 字段路径）。 */
  evidence: Array<{ line_id?: string; field_path: string; locator: SourceLocator; source_id: string }>;
  /** 低置信提醒（warning，不阻断）。 */
  warnings: string[];
}

function proposedValue(field: string, value: unknown): string | number | boolean {
  if (field === "terms.tax_rate_bps") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
      throw new RfqError("validation", "terms.tax_rate_bps 必须是 0..10000 整数（basis points）");
    }
    return value;
  }
  if (field === "terms.shipping_minor") {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 1_000_000_000_000
    ) {
      throw new RfqError("validation", "terms.shipping_minor 必须是 0..1e12 安全整数");
    }
    return value;
  }
  if (field === "terms.tax_basis") {
    if (value !== "EXCLUSIVE" && value !== "INCLUSIVE" && value !== "UNKNOWN") {
      throw new RfqError("validation", "terms.tax_basis 必须是 EXCLUSIVE/INCLUSIVE/UNKNOWN");
    }
    return value;
  }
  if (field === "terms.shipping_known") {
    if (typeof value !== "boolean") throw new RfqError("validation", "terms.shipping_known 必须是布尔值");
    return value;
  }
  if (field === "lines.quantity") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100_000) {
      throw new RfqError("validation", "lines.quantity 必须是 1..100000 整数");
    }
    return value;
  }
  if (typeof value !== "string" || value.trim() === "" || value.length > 1024) {
    throw new RfqError("validation", `${field} 必须是 1..1024 字符的字符串`);
  }
  return value;
}

/**
 * 应用提取 proposal：类型/范围校验 + 原文定位核验。所有被提议字段保持
 * confirmation=unconfirmed（确认走具名人工确认通道）；相同文件重传去重
 * 由 repository 完成（不同客户/不同 RFQ 的相同文本不自动合并）。
 */
export function applyExtractionProposal(input: {
  fields: RfqCaseFields;
  entries: ExtractionProposalEntry[];
  sourceContent: string;
  sourceId: string;
  /** proposal 引用必须落在该区间的原文内（分材料引用核验）。 */
  span: string;
}): ProposalOutcome {
  const evidence: ProposalOutcome["evidence"] = [];
  const warnings: string[] = [];
  const fields: RfqCaseFields = structuredClone(input.fields);
  for (const entry of input.entries) {
    if (!PROPOSABLE_PATHS.includes(entry.field_path)) {
      throw new RfqError("validation", `不允许提议的字段路径：${String(entry.field_path)}`);
    }
    const value = proposedValue(entry.field_path, entry.value);
    if (typeof entry.confidence === "number" && entry.confidence < 0.5) {
      warnings.push(`${entry.field_path} 置信度较低（${entry.confidence}），需要人工确认`);
    }
    // 引用核验：先对整篇原文定位，再要求引用确实落在本次来源的原文里。
    const outer = textSpanLocator(input.sourceContent, entry.quote);
    const spanStart = input.span === "" ? 0 : input.sourceContent.indexOf(input.span);
    if (spanStart === -1 || input.sourceContent.indexOf(entry.quote, spanStart) === -1) {
      throw new RfqError("source_invalid", `提取引用不在来源 ${input.sourceId} 的原文内`);
    }
    void outer;
    const locator = textSpanLocator(input.span === input.sourceContent ? input.sourceContent : input.span, entry.quote);
    const path = entry.field_path;
    if (path === "client_ref") fields.client_ref = String(value);
    else if (path === "recipient_ref") fields.recipient_ref = String(value);
    else if (path === "lines.quantity" || path === "lines.unit") {
      const line = requireLine(fields, entry.line_id);
      if (path === "lines.quantity") line.quantity = Number(value);
      else line.unit = String(value);
      line.evidence_source_ids = unionEvidence(line.evidence_source_ids, input.sourceId);
    } else if (path === "terms.tax_basis") fields.terms.tax_basis = value as RfqCaseFields["terms"]["tax_basis"];
    else if (path === "terms.tax_rate_bps") fields.terms.tax_rate_bps = Number(value);
    else if (path === "terms.shipping_known") fields.terms.shipping_known = Boolean(value);
    else if (path === "terms.shipping_minor") fields.terms.shipping_minor = Number(value);
    else if (path === "terms.delivery_date") fields.terms.delivery_date = String(value);
    else if (path === "terms.payment_terms") fields.terms.payment_terms = String(value);
    evidence.push({ ...(entry.line_id !== undefined ? { line_id: entry.line_id } : {}), field_path: path, locator, source_id: input.sourceId });
  }
  return { fields, evidence, warnings };
}

function unionEvidence(existing: string[], sourceId: string): string[] {
  return existing.includes(sourceId) ? existing : [...existing, sourceId];
}

function requireLine(fields: RfqCaseFields, lineId: string | undefined): RfqLine {
  const line = fields.lines.find((l) => l.line_id === lineId);
  if (line === undefined) {
    throw new RfqError("validation", `未知 line_id：${String(lineId)}`);
  }
  return line;
}

/** 缺口计算（v0.1.1 §8.2 READY 前置；NEEDS_CLARIFICATION 的依据）。 */
export function computeBlockers(fields: RfqCaseFields): RfqBlockerLike[] {
  const blockers: RfqBlockerLike[] = [];
  if (fields.recipient_ref === null || fields.recipient_ref.trim() === "") {
    blockers.push({ field: "recipient_ref", reason: "收件对象未确认" });
  }
  for (const line of fields.lines) {
    if (line.confirmation !== "confirmed" || line.confirmation_ref === null) {
      blockers.push({ field: `lines.${line.line_id}`, reason: "行未具名人工确认" });
      continue;
    }
    if (line.sku === null) blockers.push({ field: `lines.${line.line_id}.sku`, reason: "SKU 未确认" });
    if (line.quantity === null) blockers.push({ field: `lines.${line.line_id}.quantity`, reason: "数量未确认" });
    if (line.unit === null) blockers.push({ field: `lines.${line.line_id}.unit`, reason: "单位未确认" });
  }
  if (fields.terms.tax_basis === "UNKNOWN") {
    blockers.push({ field: "terms.tax_basis", reason: "含税/未税口径未确认" });
  }
  if (fields.terms.tax_basis !== "UNKNOWN" && fields.terms.tax_rate_bps === null) {
    blockers.push({ field: "terms.tax_rate_bps", reason: "税率未由业务权威提供" });
  }
  if (!fields.terms.shipping_known || fields.terms.shipping_minor === null) {
    blockers.push({ field: "terms.shipping", reason: "运费未知（未知运费不是 0）" });
  }
  if (fields.terms.delivery_date === null || fields.terms.delivery_date.trim() === "") {
    blockers.push({ field: "terms.delivery_date", reason: "交期无已确认表达" });
  }
  if (fields.terms.payment_terms === null || fields.terms.payment_terms.trim() === "") {
    blockers.push({ field: "terms.payment_terms", reason: "付款条件未确认" });
  }
  return blockers;
}

export interface RfqBlockerLike {
  field: string;
  reason: string;
}
