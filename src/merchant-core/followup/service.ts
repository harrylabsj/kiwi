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
 * 跟进任务服务：状态机 + 持久化 + 租约（v0.2 §8）。
 *
 * P0 默认只产出商家待办/草稿；没有可靠客户发送通道。执行外部动作前必须
 * `markExternalStarted`，崩溃/租约过期后只有该标记为 0 才可回到 READY。
 */

import { FollowUpRepository, type FollowUpTask } from "./repository.js";
import { transitionFollowUp } from "./state.js";
import {
  FollowUpError,
  type FollowUpEvent,
  type FollowUpStatus,
  type FollowUpTransition,
} from "./types.js";

export interface FollowUpServiceOptions {
  repository: FollowUpRepository;
  now: () => string;
}

export interface ScheduleFollowUpInput {
  merchant_id: string;
  opportunity_id?: string;
  trigger_event: string;
  action_type: string;
  target_version?: string;
  due_at?: string;
  max_attempts: number;
  idempotency_key?: string;
  payload?: Record<string, unknown>;
}

export class FollowUpService {
  private readonly repository: FollowUpRepository;
  private readonly now: () => string;

  constructor(options: FollowUpServiceOptions) {
    this.repository = options.repository;
    this.now = options.now;
  }

  schedule(input: ScheduleFollowUpInput): { task: FollowUpTask; transition: FollowUpTransition } {
    const task = this.repository.transaction(() => {
      const created = this.repository.createTask({
        merchantId: input.merchant_id,
        ...(input.opportunity_id !== undefined ? { opportunityId: input.opportunity_id } : {}),
        triggerEvent: input.trigger_event,
        actionType: input.action_type,
        ...(input.target_version !== undefined ? { targetVersion: input.target_version } : {}),
        ...(input.due_at !== undefined ? { dueAt: input.due_at } : {}),
        maxAttempts: input.max_attempts,
        ...(input.idempotency_key !== undefined ? { idempotencyKey: input.idempotency_key } : {}),
        payload: input.payload ?? {},
      });
      return created.task;
    });
    // 新建任务以 PENDING 落库；状态机的 NEW→PENDING 在这里等价记录。
    return {
      task,
      transition: {
        from: "NEW",
        event: "SCHEDULE",
        to: "PENDING",
        side_effects: ["validate_target_permission_and_unique_key"],
      },
    };
  }

  get(merchantId: string, taskId: string): FollowUpTask | undefined {
    return this.repository.getTask(merchantId, taskId);
  }

  list(merchantId: string, filter: { status?: FollowUpStatus; opportunityId?: string } = {}): FollowUpTask[] {
    return this.repository.listTasks(merchantId, filter);
  }

  listDue(merchantId: string, limit?: number): FollowUpTask[] {
    return this.repository.listDue(merchantId, this.now(), limit);
  }

  markDue(input: { merchant_id: string; task_id: string; requires_approval?: boolean }): FollowUpTask {
    const task = this.requireTask(input.merchant_id, input.task_id);
    return this.apply(input.merchant_id, task, {
      type: "DUE",
      due: true,
      ...(input.requires_approval === true ? { requires_approval: true } : {}),
    }).task;
  }

  claim(input: {
    merchant_id: string;
    task_id: string;
    worker_id: string;
    lease_ms: number;
  }): { task: FollowUpTask; transition: FollowUpTransition } {
    return this.repository.transaction(() => {
      const task = this.requireTask(input.merchant_id, input.task_id);
      if (task.status !== "READY") {
        throw new FollowUpError("invalid_transition", `任务状态 ${task.status} 不能领取`);
      }
      if (task.attempts >= task.max_attempts) {
        throw new FollowUpError("invalid_transition", "重试预算已用尽");
      }
      const transition = transitionFollowUp(task.status, { type: "CLAIM" });
      const claimed = this.repository.claim({
        merchantId: input.merchant_id,
        taskId: input.task_id,
        workerId: input.worker_id,
        leaseMs: input.lease_ms,
        now: this.now(),
      });
      if (claimed === undefined) {
        throw new FollowUpError("invalid_transition", "任务已被其他执行者领取");
      }
      this.repository.recordAttempt({
        merchantId: input.merchant_id,
        taskId: input.task_id,
        attemptNo: claimed.attempts,
        status: "RUNNING",
        startedAt: this.now(),
      });
      return { task: claimed, transition };
    });
  }

  markExternalStarted(input: { merchant_id: string; task_id: string; fencing_token: number }): void {
    this.repository.markExternalStarted(input.merchant_id, input.task_id, input.fencing_token);
  }

  needApproval(input: { merchant_id: string; task_id: string; fencing_token: number }): FollowUpTask {
    const task = this.requireTask(input.merchant_id, input.task_id);
    return this.apply(
      input.merchant_id,
      task,
      { type: "NEED_APPROVAL" },
      input.fencing_token,
    ).task;
  }

  approve(input: { merchant_id: string; task_id: string; still_due: boolean }): FollowUpTask {
    const task = this.requireTask(input.merchant_id, input.task_id);
    return this.apply(input.merchant_id, task, { type: "APPROVE", still_due: input.still_due }).task;
  }

  reject(input: { merchant_id: string; task_id: string }): FollowUpTask {
    const task = this.requireTask(input.merchant_id, input.task_id);
    return this.apply(input.merchant_id, task, { type: "REJECT" }).task;
  }

  finish(input: {
    merchant_id: string;
    task_id: string;
    fencing_token: number;
    outcome: "succeeded" | "failed" | "unknown";
    receipt?: Record<string, unknown>;
    error_code?: string;
  }): FollowUpTask {
    const task = this.requireTask(input.merchant_id, input.task_id);
    const event: FollowUpEvent =
      input.outcome === "succeeded"
        ? { type: "SUCCEED" }
        : input.outcome === "failed"
          ? { type: "FAIL", reason_code: input.error_code ?? "unknown" }
          : { type: "UNKNOWN" };
    const result = this.apply(input.merchant_id, task, event, input.fencing_token);
    this.repository.finishAttempt({
      merchantId: input.merchant_id,
      taskId: input.task_id,
      attemptNo: task.attempts,
      status: input.outcome,
      endedAt: this.now(),
      ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
      ...(input.error_code !== undefined ? { errorCode: input.error_code } : {}),
    });
    return result.task;
  }

  retry(input: {
    merchant_id: string;
    task_id: string;
    retryable: boolean;
    still_authorized: boolean;
  }): FollowUpTask {
    const task = this.requireTask(input.merchant_id, input.task_id);
    return this.apply(input.merchant_id, task, {
      type: "RETRY",
      retryable: input.retryable,
      attempts_so_far: task.attempts,
      max_attempts: task.max_attempts,
      still_authorized: input.still_authorized,
    }).task;
  }

  resolve(input: {
    merchant_id: string;
    task_id: string;
    outcome: "completed" | "not_executed" | "failed";
    still_authorized: boolean;
  }): FollowUpTask {
    const task = this.requireTask(input.merchant_id, input.task_id);
    return this.apply(input.merchant_id, task, {
      type: "RESOLVE",
      outcome: input.outcome,
      still_authorized: input.still_authorized,
    }).task;
  }

  stop(input: { merchant_id: string; task_id: string; in_flight: boolean }): FollowUpTask {
    const task = this.requireTask(input.merchant_id, input.task_id);
    const result = this.apply(input.merchant_id, task, {
      type: "STOP",
      in_flight: input.in_flight,
    });
    return result.task;
  }

  recoverExpiredLeases(merchantId: string): FollowUpTask[] {
    return this.repository.transaction(() =>
      this.repository.recoverExpiredLeases(merchantId, this.now()),
    );
  }

  private requireTask(merchantId: string, taskId: string): FollowUpTask {
    const task = this.repository.getTask(merchantId, taskId);
    if (task === undefined) throw new FollowUpError("validation", `task ${taskId} not found`);
    return task;
  }

  private apply(
    merchantId: string,
    task: FollowUpTask,
    event: FollowUpEvent,
    fencingToken?: number,
  ): { task: FollowUpTask; transition: FollowUpTransition } {
    const transition = transitionFollowUp(task.status, event);
    const token =
      task.status === "RUNNING"
        ? fencingToken ?? task.fencing_token
        : undefined;
    const updated = this.repository.applyTransition({
      merchantId,
      taskId: task.task_id,
      from: task.status,
      to: transition.to,
      ...(token !== undefined ? { fencingToken: token } : {}),
      ...(transition.to === "UNKNOWN" ? { stopRequested: true } : {}),
      ...(event.type === "FAIL" ? { lastError: event.reason_code } : {}),
    });
    return { task: updated, transition };
  }
}
