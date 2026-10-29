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
 * 方案发布适配（v0.2 §9.3 / §10.3 / FR15、FR18）。
 *
 * 只做形状转换：KNP 生成合法 offer/counter_offer 的 terms，RFQ 生成计价行。
 * 不伪造 RfqCase、不伪造协议对象；正式发布仍走各自既有的批准/状态机。
 */

import type { TermSet } from "../../negotiation/domain/common.js";
import { ProposalError, type ProposalOption, type ProposalSet } from "./types.js";

export function assertPublishable(set: ProposalSet, optionId: string): ProposalOption {
  if (set.status !== "READY") {
    throw new ProposalError("not_selectable", `方案集合状态 ${set.status} 不能发布`);
  }
  const option = set.options.find((candidate) => candidate.option_id === optionId);
  if (option === undefined) throw new ProposalError("not_found", `option ${optionId} not found`);
  if (option.eligibility !== "SELECTABLE") {
    throw new ProposalError(
      "not_selectable",
      `选项不可发布：${option.blocking_reasons.join(",") || option.eligibility}`,
    );
  }
  if (option.unit_price_minor === undefined) {
    throw new ProposalError("not_selectable", "选项缺少可发布单价");
  }
  return option;
}

/** 生成 KNP offer/counter_offer 的 terms（非绑定；不代表订单或支付）。 */
export function toKnpTerms(
  option: ProposalOption,
  input: { delivery_before?: string; payment_terms?: string } = {},
): TermSet {
  if (option.unit_price_minor === undefined) {
    throw new ProposalError("not_selectable", "选项缺少可发布单价");
  }
  const terms: TermSet = {
    items: [
      {
        sku: option.sku,
        quantity: { value: option.quantity, unit: option.unit },
        unit_price: { currency: option.currency, amount_minor: option.unit_price_minor },
      },
    ],
  };
  if (option.valid_until !== undefined && option.valid_until !== null) {
    terms.valid_until = option.valid_until;
  }
  if (input.delivery_before !== undefined) {
    terms.fulfillment_terms = { delivery_before: input.delivery_before };
  }
  if (input.payment_terms !== undefined) {
    terms.payment_terms = { terms: input.payment_terms };
  }
  return terms;
}

/** 生成 RFQ 计价行；税额/税基来自 RFQ terms，不在方案里重复发明。 */
export function toRfqPricingLine(
  option: ProposalOption,
  input: {
    line_id: string;
    tax_basis: "EXCLUSIVE" | "INCLUSIVE";
    tax_rate_bps: number;
    evidence_source_ids: string[];
  },
): {
  line_id: string;
  sku: string;
  unit: string;
  quantity: number;
  unit_price_minor: number;
  discount_minor: number;
  tax_basis: "EXCLUSIVE" | "INCLUSIVE";
  tax_rate_bps: number;
  evidence_source_ids: string[];
} {
  if (option.unit_price_minor === undefined) {
    throw new ProposalError("not_selectable", "选项缺少可发布单价");
  }
  if (input.line_id.trim() === "") throw new ProposalError("validation", "line_id 不能为空");
  if (!Number.isSafeInteger(input.tax_rate_bps) || input.tax_rate_bps < 0 || input.tax_rate_bps > 10_000) {
    throw new ProposalError("validation", "tax_rate_bps 必须在 [0,10000]");
  }
  return {
    line_id: input.line_id,
    sku: option.sku,
    unit: option.unit,
    quantity: option.quantity,
    unit_price_minor: option.unit_price_minor,
    discount_minor: 0,
    tax_basis: input.tax_basis,
    tax_rate_bps: input.tax_rate_bps,
    evidence_source_ids: [...input.evidence_source_ids],
  };
}
