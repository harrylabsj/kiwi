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
 * 持久跟进任务状态（v0.2 §8 / FR08–FR11、FR31–FR35）。
 *
 * 任务状态只由服务端迁移；模型不能批准状态，外部动作结果不明时必须
 * 进入 UNKNOWN，不能靠等待超时假定失败。
 */

export const FOLLOWUP_STATUSES = [
  "NEW",
  "PENDING",
  "READY",
  "RUNNING",
  "WAITING_APPROVAL",
  "SUCCEEDED",
  "CANCELLED",
  "FAILED",
  "UNKNOWN",
] as const;
export type FollowUpStatus = (typeof FOLLOWUP_STATUSES)[number];

export type FollowUpEvent =
  | { type: "SCHEDULE" }
  | { type: "DUE"; due: boolean; requires_approval?: boolean }
  | { type: "CLAIM"; requires_approval?: boolean }
  | { type: "NEED_APPROVAL" }
  | { type: "APPROVE"; still_due: boolean }
  | { type: "REJECT" }
  | { type: "SUCCEED" }
  | { type: "FAIL"; reason_code: string }
  | { type: "UNKNOWN" }
  | { type: "LEASE_EXPIRED"; proven_not_sent: boolean }
  | {
      type: "RETRY";
      retryable: boolean;
      attempts_so_far: number;
      max_attempts: number;
      still_authorized: boolean;
    }
  | {
      type: "RESOLVE";
      outcome: "completed" | "not_executed" | "failed";
      still_authorized: boolean;
    }
  | { type: "STOP"; in_flight: boolean };

export interface FollowUpTransition {
  from: FollowUpStatus;
  event: FollowUpEvent["type"];
  to: FollowUpStatus;
  /** 执行器/服务需要执行的副作用。 */
  side_effects: string[];
}

export type FollowUpErrorCode =
  | "invalid_transition"
  | "terminal_state"
  | "validation";

export class FollowUpError extends Error {
  readonly code: FollowUpErrorCode;
  constructor(code: FollowUpErrorCode, message: string) {
    super(message);
    this.name = "FollowUpError";
    this.code = code;
  }
}
