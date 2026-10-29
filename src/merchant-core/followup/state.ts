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
 * 跟进任务状态机（v0.2 §8.1 / §8.5 迁移表）。
 *
 * 纯函数：返回目标状态与副作用；不读写数据库、不调用外部通道。终态
 * SUCCEEDED/CANCELLED 拒绝任何恢复请求；外部结果不明只能进入 UNKNOWN，
 * 由回执/权威查询/有证据的人工核对解决。
 */

import {
  FollowUpError,
  type FollowUpEvent,
  type FollowUpStatus,
  type FollowUpTransition,
} from "./types.js";

const TERMINAL: ReadonlySet<FollowUpStatus> = new Set(["SUCCEEDED", "CANCELLED"]);

function invalid(from: FollowUpStatus, event: FollowUpEvent["type"]): never {
  throw new FollowUpError(
    "invalid_transition",
    `跟进任务状态 ${from} 不接受事件 ${event}`,
  );
}

export function isTerminalFollowUp(status: FollowUpStatus): boolean {
  return TERMINAL.has(status);
}

export function transitionFollowUp(
  from: FollowUpStatus,
  event: FollowUpEvent,
): FollowUpTransition {
  if (isTerminalFollowUp(from)) {
    throw new FollowUpError("terminal_state", `终态 ${from} 不可恢复或重试`);
  }

  const result = (to: FollowUpStatus, side_effects: string[]): FollowUpTransition => ({
    from,
    event: event.type,
    to,
    side_effects,
  });

  switch (event.type) {
    case "SCHEDULE":
      if (from !== "NEW") return invalid(from, event.type);
      return result("PENDING", ["validate_target_permission_and_unique_key"]);

    case "DUE":
      if (from !== "PENDING") return invalid(from, event.type);
      if (!event.due) return result("PENDING", []);
      return result(event.requires_approval === true ? "WAITING_APPROVAL" : "READY", [
        ...(event.requires_approval === true ? ["bind_approval_summary"] : []),
      ]);

    case "CLAIM":
      if (from !== "READY") return invalid(from, event.type);
      return result(event.requires_approval === true ? "WAITING_APPROVAL" : "RUNNING", [
        ...(event.requires_approval === true ? ["release_lease", "bind_approval_summary"] : ["acquire_lease_and_fencing_token"]),
      ]);

    case "NEED_APPROVAL":
      if (from !== "RUNNING") return invalid(from, event.type);
      return result("WAITING_APPROVAL", ["release_lease", "bind_approval_summary"]);

    case "APPROVE":
      if (from !== "WAITING_APPROVAL") return invalid(from, event.type);
      return result(event.still_due ? "READY" : "PENDING", ["record_approval"]);

    case "REJECT":
      if (from !== "WAITING_APPROVAL") return invalid(from, event.type);
      return result("CANCELLED", ["record_rejection", "release_lease"]);

    case "SUCCEED":
      if (from !== "RUNNING") return invalid(from, event.type);
      return result("SUCCEEDED", ["record_external_receipt", "release_lease"]);

    case "FAIL":
      if (from !== "RUNNING") return invalid(from, event.type);
      return result("FAILED", ["record_failure_reason", "release_lease"]);

    case "UNKNOWN":
      if (from !== "RUNNING") return invalid(from, event.type);
      return result("UNKNOWN", ["suspend_retries", "require_receipt_or_manual_check"]);

    case "LEASE_EXPIRED":
      if (from !== "RUNNING") return invalid(from, event.type);
      return event.proven_not_sent
        ? result("READY", ["release_lease", "allow_new_lease"])
        : result("UNKNOWN", ["release_lease", "suspend_retries", "require_receipt_or_manual_check"]);

    case "RETRY":
      if (from !== "FAILED") return invalid(from, event.type);
      if (
        !event.retryable ||
        !event.still_authorized ||
        !Number.isSafeInteger(event.attempts_so_far) ||
        !Number.isSafeInteger(event.max_attempts) ||
        event.attempts_so_far < 0 ||
        event.max_attempts < 1 ||
        event.attempts_so_far >= event.max_attempts
      ) {
        return result("FAILED", ["keep_failed_for_manual_handling"]);
      }
      return result("PENDING", ["enqueue_retry_with_backoff"]);

    case "RESOLVE":
      if (from !== "UNKNOWN") return invalid(from, event.type);
      if (event.outcome === "completed") {
        return result("SUCCEEDED", ["record_resolution_evidence"]);
      }
      if (event.outcome === "failed") {
        return result("FAILED", ["record_resolution_evidence"]);
      }
      return event.still_authorized
        ? result("READY", ["record_resolution_evidence", "allow_new_lease"])
        : result("CANCELLED", ["record_resolution_evidence", "authorization_revoked"]);

    case "STOP":
      // 结果不明时不能取消：停止只记 stop_requested，仍要继续只读核实到
      // 真实结果，避免把“可能已发生”伪装成“已撤回”。
      if (from === "UNKNOWN" || (from === "RUNNING" && event.in_flight)) {
        return result("UNKNOWN", ["record_stop_requested", "continue_readonly_verification"]);
      }
      return result("CANCELLED", ["invalidate_unexecuted_tasks", "stop_followups"]);

    default:
      return invalid(from, (event as FollowUpEvent).type);
  }
}
