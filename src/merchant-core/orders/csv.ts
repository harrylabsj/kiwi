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
 * 人工/CSV 订单申报（v0.2 §11.1 / FR19）。
 *
 * 只解析并分组，不写入；写入仍走 `MerchantOrderService.recordManualReport`
 * （evidence_source = manual_report / csv_import）。没有稳定列或数字非法时
 * 整批拒绝，不跳过坏行。
 */

import type { ExternalOrderIdentity, OrderLineFact } from "./model.js";
import { OrderFactError } from "./model.js";

export interface CsvOrderReport {
  identity: ExternalOrderIdentity;
  lines: OrderLineFact[];
  currency?: string;
  total_minor?: number;
  payment_status?: string;
  fulfillment_status?: string;
  observed_at: string;
}

/** 最小 RFC 4180 解析：逗号分隔、双引号转义、CRLF/LF。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (field !== "") throw new OrderFactError("validation", "CSV 引号只能出现在字段开头");
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char === "\r") {
      // 忽略 CR，等待 LF；单独 CR 结尾也按行结束处理。
      if (text[i + 1] !== "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
    } else {
      field += char;
    }
  }
  if (quoted) throw new OrderFactError("validation", "CSV 引号未闭合");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim() !== ""));
}

const REQUIRED = [
  "source_namespace",
  "source_account_id",
  "external_order_id",
  "line_id",
  "sku",
  "quantity",
  "amount_minor",
  "observed_at",
] as const;

function integerCell(value: string | undefined, name: string, row: number): number {
  const raw = value?.trim() ?? "";
  if (!/^[0-9]+$/.test(raw)) {
    throw new OrderFactError("validation", `第 ${row} 行 ${name} 必须是非负整数`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new OrderFactError("validation", `第 ${row} 行 ${name} 超出安全整数`);
  }
  return n;
}

function textCell(value: string | undefined, name: string, row: number): string {
  const raw = value?.trim() ?? "";
  if (raw === "") throw new OrderFactError("validation", `第 ${row} 行 ${name} 不能为空`);
  return raw;
}

/** 解析订单 CSV：同一订单的多行按复合身份分组；组内字段冲突整批拒绝。 */
export function parseOrderCsv(text: string): CsvOrderReport[] {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new OrderFactError("validation", "CSV 至少需要表头与一行数据");
  const header = rows[0]!.map((cell) => cell.trim());
  const index = new Map(header.map((name, i) => [name, i]));
  for (const name of REQUIRED) {
    if (!index.has(name)) {
      throw new OrderFactError("validation", `CSV 缺少必需列：${name}`);
    }
  }
  const get = (row: string[], name: string): string | undefined => {
    const at = index.get(name);
    return at === undefined ? undefined : row[at];
  };

  const grouped = new Map<string, CsvOrderReport>();
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]!;
    const identity: ExternalOrderIdentity = {
      merchant_id: "", // 由调用方注入；解析阶段不信任 CSV 自报商家。
      source_namespace: textCell(get(row, "source_namespace"), "source_namespace", r + 1),
      source_account_id: textCell(get(row, "source_account_id"), "source_account_id", r + 1),
      external_order_id: textCell(get(row, "external_order_id"), "external_order_id", r + 1),
    };
    const key = [
      identity.source_namespace,
      identity.source_account_id,
      identity.external_order_id,
    ].join("\u0000");
    const observedAt = textCell(get(row, "observed_at"), "observed_at", r + 1);
    if (!Number.isFinite(Date.parse(observedAt))) {
      throw new OrderFactError("validation", `第 ${r + 1} 行 observed_at 不可解析`);
    }
    const line: OrderLineFact = {
      line_id: textCell(get(row, "line_id"), "line_id", r + 1),
      sku: textCell(get(row, "sku"), "sku", r + 1),
      quantity: integerCell(get(row, "quantity"), "quantity", r + 1),
      amount_minor: integerCell(get(row, "amount_minor"), "amount_minor", r + 1),
    };
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        identity,
        lines: [line],
        observed_at: observedAt,
        ...(get(row, "currency") !== undefined ? { currency: textCell(get(row, "currency"), "currency", r + 1) } : {}),
        ...(get(row, "total_minor") !== undefined
          ? { total_minor: integerCell(get(row, "total_minor"), "total_minor", r + 1) }
          : {}),
        ...(get(row, "payment_status") !== undefined
          ? { payment_status: textCell(get(row, "payment_status"), "payment_status", r + 1) }
          : {}),
        ...(get(row, "fulfillment_status") !== undefined
          ? { fulfillment_status: textCell(get(row, "fulfillment_status"), "fulfillment_status", r + 1) }
          : {}),
      });
    } else {
      if (existing.lines.some((candidate) => candidate.line_id === line.line_id)) {
        throw new OrderFactError("validation", `第 ${r + 1} 行 line_id 在同一订单内重复`);
      }
      if (existing.observed_at !== observedAt) {
        throw new OrderFactError("validation", `第 ${r + 1} 行与同订单其他行 observed_at 不一致`);
      }
      existing.lines.push(line);
    }
  }
  return [...grouped.values()];
}
