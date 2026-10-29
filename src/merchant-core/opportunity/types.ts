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
 * 销售机会、来源记录与需求快照（v0.2 §6 / FR05–FR07、FR12）。
 *
 * 关键边界：
 *  - 来源记录（一次外部询盘）与采购机会（一次采购意图）分开计数；
 *  - 同一外部事件重复进入必须幂等；相似文本只提示重复，不自动合并；
 *  - 机会状态是业务投影，不反向修改 RFQ/KNP/订单状态；
 *  - 需求字段的“客户已确认/模型提取/未知”分别保存，不把推测当确认。
 */

export const OPPORTUNITY_STATUSES = [
  "NEW",
  "NEEDS_INFO",
  "READY_FOR_PROPOSAL",
  "PENDING_APPROVAL",
  "WAITING_CUSTOMER",
  "RESULT_UNVERIFIED",
  "CLOSED",
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export type RequirementFieldStatus = "CONFIRMED" | "UNCONFIRMED" | "UNKNOWN";

export interface RequirementField {
  field: string;
  value: string | number | boolean | null;
  status: RequirementFieldStatus;
  /** 字段来源（manual、model、channel 等）；CONFIRMED 时必须有确认者。 */
  source?: string;
  confirmed_by?: string;
  confirmed_at?: string;
}

export interface RequirementSnapshot {
  opportunity_id: string;
  revision: number;
  fields: RequirementField[];
  created_at: string;
  created_by: string;
}

export interface OpportunitySource {
  source_id: string;
  merchant_id: string;
  source_namespace: string;
  source_account_id: string;
  external_inquiry_id: string;
  raw_excerpt: string;
  received_at: string;
  operator: string;
  parse_version: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface OpportunitySourceEvent {
  event_id: string;
  source_id: string;
  external_event_id: string;
  event_kind: string;
  payload_digest: string;
  received_at: string;
  created_at: string;
}

export interface SalesOpportunity {
  opportunity_id: string;
  merchant_id: string;
  status: OpportunityStatus;
  owner: string;
  next_action: string | null;
  next_action_due_at: string | null;
  waiting_reason: string | null;
  rfq_case_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface OpportunityLink {
  link_id: string;
  merchant_id: string;
  opportunity_id: string;
  source_id: string;
  status: "LINKED" | "UNLINKED";
  basis: string;
  confirmed_by: string;
  confirmed_at: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export type OpportunityEvent =
  | { type: "INGEST"; complete: boolean }
  | { type: "REQUIREMENT_UPDATED"; complete: boolean }
  | { type: "SUBMIT_FOR_APPROVAL" }
  | { type: "APPROVAL_REJECTED"; needs_info: boolean }
  | { type: "APPROVAL_GRANTED_AND_SENT" }
  | { type: "WAIT_CUSTOMER"; reason: string }
  | { type: "CUSTOMER_REPLIED"; needs_info: boolean; needs_new_proposal: boolean }
  | { type: "ORDER_CLAIMED" }
  | { type: "ORDER_VERIFIED"; has_open_sales_todo: boolean }
  | {
      type: "ORDER_NOT_CONFIRMED";
      /** 候选不成立时回到的先前工作状态（已结束/待核实以外的非新建状态）。 */
      resume_status: Exclude<OpportunityStatus, "NEW" | "RESULT_UNVERIFIED" | "CLOSED">;
    }
  | { type: "FACTS_CHANGED"; needs_info: boolean; proposal_stale: boolean }
  | { type: "CLOSE"; reason: string };

export interface OpportunityTransition {
  from: OpportunityStatus;
  event: OpportunityEvent["type"];
  to: OpportunityStatus;
  /** 迁移的副作用（取消任务、建立核实任务等），由调用方执行。 */
  side_effects: string[];
}

export type OpportunityErrorCode =
  | "validation"
  | "not_found"
  | "version_conflict"
  | "invalid_transition"
  | "source_conflict"
  | "idempotency_conflict";

export class OpportunityError extends Error {
  readonly code: OpportunityErrorCode;
  constructor(code: OpportunityErrorCode, message: string) {
    super(message);
    this.name = "OpportunityError";
    this.code = code;
  }
}
