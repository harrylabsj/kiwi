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
 * CSV 商品导入闭环（V2 阶段四 F04：src/merchant-core/product-import.ts）。
 *
 * CSV 解析预览（新增/更新/错误逐行回执）→ 确认（命令记录）→ 执行（逐行
 * 回执，部分成功 partially_failed；相同幂等键返回同一 operation，不重复
 * 导入/发布）。撤回走同一闭环（listing 销售状态语义，F08）。
 *
 * CSV 列：sku,title,price,stock[,currency][,category][,description]
 * （首行表头；分隔符逗号；空行跳过）。解析失败行进入错误回执，不阻塞其他行。
 */

import type { MerchantClient, MerchantProductInput } from "../agent/merchant/types.js";
import type { MerchantOperation, MerchantOperationStore } from "./operations.js";

export interface CsvImportRowPlan {
  line: number;
  sku: string;
  action: "create" | "update";
  ok: boolean;
  error?: string;
}

export interface CsvImportPreview {
  total_lines: number;
  valid: number;
  creates: number;
  updates: number;
  row_errors: Array<{ line: number; error: string }>;
  /** 审批预览必须能看到将被写入的每行动作与价格（review P1-6）。 */
  rows: Array<{ line: number; sku: string; action: "create" | "update"; price: number }>;
}

const REQUIRED_COLUMNS = ["sku", "title", "price", "stock"] as const;

/** 解析 CSV → 行计划（逐行错误回执，不阻塞其他行）。 */
export function parseProductCsv(
  csv: string,
  existingSkus: ReadonlySet<string>,
): { inputs: Array<{ line: number; input: MerchantProductInput }>; preview: CsvImportPreview } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  const rowErrors: Array<{ line: number; error: string }> = [];
  const inputs: Array<{ line: number; input: MerchantProductInput }> = [];
  const rows: Array<{ line: number; sku: string; action: "create" | "update"; price: number }> = [];
  if (lines.length === 0) {
    return {
      inputs,
      preview: { total_lines: 0, valid: 0, creates: 0, updates: 0, row_errors: [], rows: [] },
    };
  }
  const header = lines[0]?.split(",").map((c) => c.trim()) ?? [];
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) {
      rowErrors.push({ line: 1, error: `表头缺列 ${col}` });
      return {
        inputs,
        preview: {
          total_lines: lines.length,
          valid: 0,
          creates: 0,
          updates: 0,
          row_errors: rowErrors,
          rows: [],
        },
      };
    }
  }
  const idx = Object.fromEntries(header.map((c, i) => [c, i]));
  for (let i = 1; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const cells = (lines[i] ?? "").split(",").map((c) => c.trim());
    const sku = cells[idx.sku ?? -1] ?? "";
    const title = cells[idx.title ?? -1] ?? "";
    const priceText = cells[idx.price ?? -1] ?? "";
    // 裸 Number() 会接受 0x10 / 1e3；导入价格只接受十进制数字。
    const price = /^\d+(?:\.\d{1,4})?$/.test(priceText) ? Number(priceText) : Number.NaN;
    // 与 price 同口径：stock 只接受十进制非负整数（Number() 会接受 0x10/1e3）。
    const stockText = cells[idx.stock ?? -1] ?? "";
    const stock = /^\d+$/.test(stockText) ? Number(stockText) : Number.NaN;
    if (sku === "" || title === "") {
      rowErrors.push({ line: lineNo, error: "sku/title 为空" });
      continue;
    }
    if (!Number.isFinite(price) || price < 0) {
      rowErrors.push({ line: lineNo, error: `price 非法（${cells[idx.price ?? -1] ?? ""}）` });
      continue;
    }
    if (!Number.isInteger(stock) || stock < 0) {
      rowErrors.push({
        line: lineNo,
        error: `stock 必须是非负整数（${cells[idx.stock ?? -1] ?? ""}）`,
      });
      continue;
    }
    rows.push({
      line: lineNo,
      sku,
      action: existingSkus.has(sku) ? "update" : "create",
      price,
    });
    inputs.push({
      line: lineNo,
      input: {
        sku,
        merchant_id: "", // 由执行器补 owner
        title,
        price,
        stock,
        ...(typeof idx.currency === "number" &&
        cells[idx.currency] !== undefined &&
        cells[idx.currency] !== ""
          ? { currency: cells[idx.currency] }
          : {}),
        ...(typeof idx.category === "number" &&
        cells[idx.category] !== undefined &&
        cells[idx.category] !== ""
          ? { category: cells[idx.category] }
          : {}),
        ...(typeof idx.description === "number" && cells[idx.description] !== undefined
          ? { description: cells[idx.description] }
          : {}),
      },
    });
  }
  const creates = inputs.filter((r) => !existingSkus.has(r.input.sku)).length;
  return {
    inputs,
    preview: {
      total_lines: lines.length - 1,
      valid: inputs.length,
      creates,
      updates: inputs.length - creates,
      row_errors: rowErrors,
      rows,
    },
  };
}

export const PRODUCTS_IMPORT_OPERATION_KIND = "products_import";

/**
 * 执行 CSV 导入（命令执行器调用）：逐行 create/update + 逐项回执；
 * 幂等键命中已完成 operation → 直接返回（不重复导入）。
 */
export async function executeProductsImport(input: {
  csv: string;
  idempotencyKey: string;
  merchantId: string;
  merchantClient: MerchantClient;
  operations: MerchantOperationStore;
  /** 与单商品 create/update 同一底价硬策略（review P1-6）。 */
  enforceFloor?: (price: unknown) => void;
}): Promise<MerchantOperation | { ok: false; operation: MerchantOperation }> {
  const existing = input.operations.createOrGet({
    kind: PRODUCTS_IMPORT_OPERATION_KIND,
    idempotencyKey: input.idempotencyKey,
  });
  if (!existing.created) {
    // 幂等：相同幂等键返回同一 operation（已终态的不重复执行；queued/running
    // 的先对账——本轮返回现状不盲目重发）。
    return (existing.operation.status === "succeeded" || existing.operation.status === "partially_failed") ? existing.operation : { ok: false, operation: existing.operation };
  }
  const operation = input.operations.markRunning(existing.operation.operation_id);
  try {
    const current = await input.merchantClient.listProducts(input.merchantId);
    const existingSkus = new Set(current.map((p) => p.sku));
    const { inputs, preview } = parseProductCsv(input.csv, existingSkus);
    const receipts: MerchantOperation["receipts"] = preview.row_errors.map((e) => ({
      item: `line ${e.line}`,
      ok: false,
      detail: e.error,
    }));
    for (const { line, input: product } of inputs) {
      try {
        input.enforceFloor?.(product.price);
        if (existingSkus.has(product.sku)) {
          await input.merchantClient.updateProduct(product.sku, {
            title: product.title,
            price: product.price,
            stock: product.stock,
          });
          receipts.push({ item: `line ${line}`, ok: true, detail: `update ${product.sku}` });
        } else {
          await input.merchantClient.createProduct({ ...product, merchant_id: input.merchantId });
          receipts.push({ item: `line ${line}`, ok: true, detail: `create ${product.sku}` });
        }
      } catch (err) {
        receipts.push({
          item: `line ${line}`,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const finished = input.operations.finish(operation.operation_id, receipts);
    // 全部行失败 → ok:false（审查 P1：否则候选仍被标 executed，审计谎报成功）
    return finished.status === "failed" ? { ok: false, operation: finished } : finished;
  } catch (err) {
    const failed = input.operations.finish(
      operation.operation_id,
      [],
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, operation: failed };
  }
}
