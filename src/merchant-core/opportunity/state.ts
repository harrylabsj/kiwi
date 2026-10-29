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
 * 销售机会状态机（v0.2 §6.3）。
 *
 * 纯函数：只计算目标状态与副作用；不写库、不推进 RFQ/KNP/订单状态。
 * 非法迁移直接拒绝，不猜测“最接近”的状态。已结束保持终态：迟到回复、
 * 订单、退款只追加证据，不复活销售任务。
 */

import {
  OpportunityError,
  type OpportunityEvent,
  type OpportunityStatus,
} from "./types.js";

export interface TransitionResult {
  to: OpportunityStatus;
  side_effects: string[];
}

const TERMINAL: ReadonlySet<OpportunityStatus> = new Set(["CLOSED"]);

export function isTerminalStatus(status: OpportunityStatus): boolean {
  return TERMINAL.has(status);
}

function invalid(from: OpportunityStatus, event: OpportunityEvent["type"]): never {
  throw new OpportunityError(
    "invalid_transition",
    `机会状态 ${from} 不接受事件 ${event}`,
  );
}

/**
 * 计算一次合法迁移。`CLOSED` 的迟到事件返回同一状态并标记 evidence-only，
 * 由调用方只写证据、不重建任务。
 */
export function transitionOpportunity(
  from: OpportunityStatus,
  event: OpportunityEvent,
): TransitionResult {
  if (isTerminalStatus(from)) {
    if (event.type === "CLOSE") return { to: "CLOSED", side_effects: [] };
    return {
      to: "CLOSED",
      side_effects: ["append_evidence_only", "do_not_reopen_sales_tasks"],
    };
  }

  switch (event.type) {
    case "INGEST":
    case "REQUIREMENT_UPDATED": {
      if (from === "NEW" || from === "NEEDS_INFO") {
        return {
          to: event.complete ? "READY_FOR_PROPOSAL" : "NEEDS_INFO",
          side_effects: ["save_requirement_revision", "cancel_stale_clarifications"],
        };
      }
      if (from === "READY_FOR_PROPOSAL" || from === "PENDING_APPROVAL" || from === "WAITING_CUSTOMER") {
        return {
          to: event.complete ? "READY_FOR_PROPOSAL" : "NEEDS_INFO",
          side_effects: [
            "save_requirement_revision",
            "invalidate_approval",
            "cancel_followups",
          ],
        };
      }
      return invalid(from, event.type);
    }
    case "SUBMIT_FOR_APPROVAL": {
      if (from === "READY_FOR_PROPOSAL") {
        return {
          to: "PENDING_APPROVAL",
          side_effects: ["bind_selection_quote_policy", "create_approval_request"],
        };
      }
      return invalid(from, event.type);
    }
    case "APPROVAL_REJECTED": {
      if (from === "PENDING_APPROVAL") {
        return {
          to: event.needs_info ? "NEEDS_INFO" : "READY_FOR_PROPOSAL",
          side_effects: ["invalidate_approval", "record_rejection_reason", "cancel_followups"],
        };
      }
      return invalid(from, event.type);
    }
    case "APPROVAL_GRANTED_AND_SENT": {
      if (from === "PENDING_APPROVAL") {
        return {
          to: "WAITING_CUSTOMER",
          side_effects: ["record_delivery_evidence", "schedule_reply_followup"],
        };
      }
      return invalid(from, event.type);
    }
    case "WAIT_CUSTOMER": {
      if (from === "NEEDS_INFO" || from === "READY_FOR_PROPOSAL" || from === "PENDING_APPROVAL" || from === "WAITING_CUSTOMER") {
        return {
          to: "WAITING_CUSTOMER",
          side_effects: [
            ...(from === "NEEDS_INFO" ? ["keep_missing_fields_block_quote"] : []),
            "schedule_wait_deadline",
          ],
        };
      }
      return invalid(from, event.type);
    }
    case "CUSTOMER_REPLIED": {
      if (from === "WAITING_CUSTOMER") {
        if (event.needs_info) {
          return { to: "NEEDS_INFO", side_effects: ["save_requirement_revision", "cancel_followups"] };
        }
        if (event.needs_new_proposal) {
          return { to: "READY_FOR_PROPOSAL", side_effects: ["mark_proposal_stale", "cancel_followups"] };
        }
        return { to: "WAITING_CUSTOMER", side_effects: ["record_reply_acknowledged"] };
      }
      if (from === "RESULT_UNVERIFIED") {
        // 申报已下单后的迟到回复不改变核实状态，只补证据。
        return { to: "RESULT_UNVERIFIED", side_effects: ["append_evidence_only"] };
      }
      return invalid(from, event.type);
    }
    case "ORDER_CLAIMED": {
      if (from === "NEEDS_INFO" || from === "READY_FOR_PROPOSAL" || from === "PENDING_APPROVAL" || from === "WAITING_CUSTOMER") {
        return {
          to: "RESULT_UNVERIFIED",
          side_effects: ["create_order_verification_task", "preserve_previous_status"],
        };
      }
      if (from === "RESULT_UNVERIFIED") return { to: "RESULT_UNVERIFIED", side_effects: [] };
      return invalid(from, event.type);
    }
    case "ORDER_VERIFIED": {
      if (from === "RESULT_UNVERIFIED") {
        return {
          to: event.has_open_sales_todo ? "WAITING_CUSTOMER" : "CLOSED",
          side_effects: ["record_external_verification", "close_if_no_open_sales_todo"],
        };
      }
      return invalid(from, event.type);
    }
    case "ORDER_NOT_CONFIRMED": {
      if (from === "RESULT_UNVERIFIED") {
        return {
          to: event.resume_status,
          side_effects: ["record_verification_failed", "restore_previous_working_status"],
        };
      }
      return invalid(from, event.type);
    }
    case "FACTS_CHANGED": {
      if (from === "NEEDS_INFO" || from === "READY_FOR_PROPOSAL" || from === "PENDING_APPROVAL" || from === "WAITING_CUSTOMER") {
        if (event.needs_info) {
          return { to: "NEEDS_INFO", side_effects: ["save_requirement_revision", "invalidate_approval"] };
        }
        if (event.proposal_stale) {
          return { to: "READY_FOR_PROPOSAL", side_effects: ["mark_proposal_stale", "invalidate_approval"] };
        }
        return { to: from, side_effects: ["record_fact_refresh"] };
      }
      return invalid(from, event.type);
    }
    case "CLOSE": {
      return { to: "CLOSED", side_effects: ["stop_sales_followup", "record_close_reason"] };
    }
  }
}
