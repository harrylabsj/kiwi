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
 * 方案集合、选项与选择记录（v0.2 §9 / FR12–FR15、FR17）。
 *
 * P0 支持 1–3 个内部选项，但每次只发布一个选定方案；选项之间不互相
 * SUPERSEDE。公开投影只含可说明的适配理由、报价与条件，绝不包含私有
 * 成本、底价或贡献阈值。
 */

import type { PricingResult } from "../rfq/types.js";
import type {
  CommercialPromotion,
  CommercialTax,
} from "../commercial/types.js";

export const PROPOSAL_SET_STATUSES = ["DRAFT", "EVALUATED", "READY", "STALE", "WITHDRAWN"] as const;
export type ProposalSetStatus = (typeof PROPOSAL_SET_STATUSES)[number];

export type AdaptationResult = "MET" | "NOT_MET" | "UNKNOWN";

export interface AdaptationEntry {
  /** 硬性需求名（尺寸、承重、地区、交付期限等）。 */
  constraint: string;
  result: AdaptationResult;
  evidence_ref?: string;
}

export type OptionEligibility =
  | "SELECTABLE"
  | "CHANGE_REQUIRES_CUSTOMER_CONFIRMATION"
  | "BLOCKED";

export interface ProposalOptionInput {
  option_id?: string;
  sku: string;
  unit: string;
  quantity: number;
  /** 公开 list 单价（minor）。 */
  base_unit_price_minor: number;
  promotions?: readonly CommercialPromotion[];
  /** 私有 floor：只用于发布判断，不进入选项公开字段。 */
  private_floor_minor?: number;
  line_discount_minor?: number;
  shipping_amount_minor?: number;
  line_tax: CommercialTax;
  shipping_tax: CommercialTax;
  valid_until_cap?: string;
  quote_ttl_seconds?: number;
  adaptation: AdaptationEntry[];
  /** 超出客户已确认范围的替代品/数量变化，先取得客户确认。 */
  is_alternative?: boolean;
  note?: string;
}

export interface ProposalOption {
  option_id: string;
  sku: string;
  unit: string;
  quantity: number;
  unit_price_minor?: number;
  currency: "CNY";
  pricing?: PricingResult;
  valid_until?: string | null;
  price_source?: { kind: "base" } | { kind: "promotion"; promotion_id: string; revision: number };
  adaptation: AdaptationEntry[];
  eligibility: OptionEligibility;
  blocking_reasons: string[];
  is_alternative: boolean;
  note?: string;
}

export interface PrepareProposalSetInput {
  merchant_id: string;
  opportunity_id: string;
  requirement_revision: number;
  /** 影响报价的事实摘要（来源/版本/价格/库存/交期）。 */
  facts_digest: string;
  policy_version: string;
  options: ProposalOptionInput[];
  now: string;
}

export interface ProposalSet {
  set_id: string;
  merchant_id: string;
  opportunity_id: string;
  requirement_revision: number;
  facts_digest: string;
  policy_version: string;
  status: ProposalSetStatus;
  options: ProposalOption[];
  created_at: string;
  updated_at: string;
  revision: number;
  stale_reason?: string;
}

export type PublishReference =
  | { kind: "rfq_quote"; quote_id: string; revision: number }
  | {
      kind: "knp_offer";
      negotiation_id: string;
      action: "offer" | "counter_offer";
      terms_digest: string;
    };

export interface SelectionRecordInput {
  merchant_id: string;
  set: ProposalSet;
  option_id: string;
  selected_by: string;
  requirement_revision: number;
  publish_reference: PublishReference;
  now: string;
}

export interface SelectionRecord {
  selection_id: string;
  merchant_id: string;
  set_id: string;
  option_id: string;
  selected_by: string;
  selected_at: string;
  requirement_revision: number;
  publish_reference: PublishReference;
}

export interface ApprovalBindingInput {
  merchant_id: string;
  set: ProposalSet;
  option_id: string;
  policy_version: string;
  expires_at: string;
  now: string;
}

export interface ApprovalBinding {
  approval_id: string;
  merchant_id: string;
  set_id: string;
  option_id: string;
  opportunity_id: string;
  requirement_revision: number;
  policy_version: string;
  content_digest: string;
  scope: "publish_quote";
  expires_at: string;
  created_at: string;
}

export interface ApprovalVerificationInput {
  binding: ApprovalBinding;
  set: ProposalSet;
  option_id: string;
  policy_version: string;
  now: string;
}

export type ProposalErrorCode =
  | "validation"
  | "not_found"
  | "not_selectable"
  | "requirement_out_of_scope"
  | "approval_mismatch"
  | "approval_expired";

export class ProposalError extends Error {
  readonly code: ProposalErrorCode;
  constructor(code: ProposalErrorCode, message: string) {
    super(message);
    this.name = "ProposalError";
    this.code = code;
  }
}
