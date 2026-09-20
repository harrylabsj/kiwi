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
 * 报价投影与差异（设计 v0.1.1 §11.1 compare、§13.2、§14.2）。
 *
 * PublicQuoteView 是客户可见字段的唯一来源（正式文件与客户投影都以它
 * 渲染）：绝不包含成本、底价、内部利润、策略阈值、未授权精确库存、客户
 * 原始聊天、系统 token 或审批 nonce。QuoteDiff 做字段级差异并标注旧版
 * 失效原因——「旧版为什么不能再用」必须显式，不静默。
 */

import { rfqContentDigest, type PricingInput, type PricingResult, type PublicQuoteView, type QuoteDiff, type QuoteStatus, type TaxBasis } from "./types.js";

/** 客户投影摘要（不含生命周期状态；与 artifact_sha256 / content_digest 三者不可混用，§10.3）。 */
export function publicProjectionDigest(projection: Omit<PublicQuoteView, "status">): string {
  return rfqContentDigest(projection);
}

export interface QuoteProjectionInput {
  quoteId: string;
  revision: number;
  caseId: string;
  caseRevision: number;
  clientRef: string;
  recipientRef: string;
  pricingInput: PricingInput;
  pricingOutput: PricingResult;
  deliveryTerms: string;
  paymentTerms: string;
  validUntil: string;
  dataAsOf: string;
}

const NON_BINDING_BOUNDARY =
  "本报价为商业报价，不构成订单确认、付款请求或库存预留；价格与条款以双方书面确认为准。";

/** 客户投影（公开字段白名单；不含生命周期状态——状态由读取层附加）。 */
export function buildPublicProjection(input: QuoteProjectionInput): Omit<PublicQuoteView, "status"> {
  const lines = input.pricingInput.lines.map((line) => {
    const split = input.pricingOutput.lines.find((l) => l.line_id === line.line_id);
    if (split === undefined) {
      throw new Error(`计价输出缺少行 ${line.line_id}`);
    }
    return {
      line_id: line.line_id,
      sku: line.sku ?? line.line_id,
      quantity: line.quantity,
      unit: line.unit ?? "",
      unit_price_minor: line.unit_price_minor,
      discount_minor: line.discount_minor,
      tax_basis: line.tax_basis as TaxBasis,
      tax_rate_bps: line.tax_rate_bps,
    };
  });
  return {
    quote_id: input.quoteId,
    revision: input.revision,
    case_id: input.caseId,
    case_revision: input.caseRevision,
    recipient_ref: input.recipientRef,
    client_ref: input.clientRef,
    currency: "CNY",
    totals: input.pricingOutput.totals,
    lines,
    shipping: {
      amount_minor: input.pricingInput.shipping.amount_minor,
      tax_basis: input.pricingInput.shipping.tax_basis as TaxBasis,
      tax_rate_bps: input.pricingInput.shipping.tax_rate_bps,
    },
    delivery_terms: input.deliveryTerms,
    payment_terms: input.paymentTerms,
    valid_until: input.validUntil,
    data_as_of: input.dataAsOf,
    nonbinding_execution_boundary: NON_BINDING_BOUNDARY,
  };
}

// sku / unit 由 pricing_input 行内透传字段提供（与 pricing-input.schema.json 一致）。

/** 字段级差异（逐项保真；「未报价」与「0」区分表达）。 */
export function diffQuotes(
  from: { view: PublicQuoteView; invalidReason?: string },
  to: { view: PublicQuoteView; invalidReason?: string },
): QuoteDiff {
  const changed: QuoteDiff["changed"] = [];
  const flat = (view: PublicQuoteView): Array<[string, unknown]> => {
    const rows: Array<[string, unknown]> = [
      ["recipient_ref", view.recipient_ref],
      ["currency", view.currency],
      ["totals.net_minor", view.totals.net_minor],
      ["totals.tax_minor", view.totals.tax_minor],
      ["totals.gross_minor", view.totals.gross_minor],
      ["shipping.amount_minor", view.shipping.amount_minor],
      ["shipping.tax_basis", view.shipping.tax_basis],
      ["shipping.tax_rate_bps", view.shipping.tax_rate_bps],
      ["delivery_terms", view.delivery_terms],
      ["payment_terms", view.payment_terms],
      ["valid_until", view.valid_until],
    ];
    for (const line of view.lines) {
      for (const [k, v] of Object.entries(line)) {
        rows.push([`lines.${line.line_id}.${k}`, v]);
      }
    }
    return rows;
  };
  const left = new Map(flat(from.view));
  const right = new Map(flat(to.view));
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const key of keys) {
    const a = left.get(key);
    const b = right.get(key);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed.push({ field: key, from: a ?? "(未报价)", to: b ?? "(未报价)" });
    }
  }
  return {
    from: { quote_id: from.view.quote_id, revision: from.view.revision, status: from.view.status },
    to: { quote_id: to.view.quote_id, revision: to.view.revision, status: to.view.status },
    changed,
    ...(from.invalidReason !== undefined ? { from_invalid_reason: from.invalidReason } : {}),
    ...(to.invalidReason !== undefined ? { to_invalid_reason: to.invalidReason } : {}),
  };
}

/** 旧版失效原因（compare/导出提示用；§5.2 不能声称已撤回客户手中的文件）。 */
export function invalidReasonOf(status: QuoteStatus, validUntil: string, nowIso: string): string | undefined {
  if (status === "EXPIRED" || (Date.parse(validUntil) <= Date.parse(nowIso) && status !== "EXPORTED")) {
    return "已超过报价有效期";
  }
  if (status === "SUPERSEDED") return "已被新版本替代（旧文件可能已在客户手中，需人工说明替代关系）";
  if (status === "REJECTED") return "已被操作者拒绝";
  if (status === "DRAFT" || status === "VALIDATED") return "尚未通过正式发布，不是对外版本";
  return undefined;
}
