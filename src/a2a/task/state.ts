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
 * A2A Task 生命周期状态机（基线 §18.3 / 子规范 §23）。
 *
 * 完全使用 A2A 原生 Task lifecycle，Kiwi 不发明另一套任务状态（§18.3）。
 * 六态 + `unknown` 作为 fail-closed 桶：
 *
 *   submitted → working → input-required → working → completed | canceled | failed
 *
 * 规则：
 * - 终态（completed / canceled / failed）不可再转换（§18.3 语义）；
 * - `unknown` 永远不是合法源/目标状态 —— 远端回 unknown 一律 fail-closed 拒绝，
 *   绝不猜测（基线 §4.6）；
 * - 同状态重复观察（如轮询时再次看到 working）是合法 no-op；
 * - 状态机不自行产生商业承诺，只对观察到的远端状态做合法性判定。
 */

import { A2A_TASK_STATES, type A2ATaskState } from "../client/index.js";

export const A2A_TASK_STATES_REAL = A2A_TASK_STATES.filter((s) => s !== "unknown") as readonly Exclude<
  A2ATaskState,
  "unknown"
>[];

/** 终态：任务生命周期结束，不可再转换。 */
export const A2A_TASK_TERMINAL_STATES = ["completed", "canceled", "failed"] as const;
export type A2ATaskTerminalState = (typeof A2A_TASK_TERMINAL_STATES)[number];

/** A2A Task 转换表：源状态 → 允许的下一状态（不含同状态 no-op，见 transitionTaskState）。 */
export const A2A_TASK_TRANSITIONS: Record<Exclude<A2ATaskState, "unknown">, readonly A2ATaskState[]> = {
  submitted: ["working", "input-required", "completed", "canceled", "failed"],
  working: ["input-required", "completed", "canceled", "failed"],
  "input-required": ["working", "completed", "canceled", "failed"],
  completed: [],
  canceled: [],
  failed: [],
};

export type TaskStateErrorCode = "unknown_state" | "illegal_transition";

export class TaskStateError extends Error {
  readonly code: TaskStateErrorCode;
  constructor(code: TaskStateErrorCode, message: string) {
    super(message);
    this.name = "TaskStateError";
    this.code = code;
  }
}

/** 是否为 A2A_TASK_STATES 枚举内的字符串（含 unknown 桶）。 */
export function isTaskState(value: unknown): value is A2ATaskState {
  return typeof value === "string" && (A2A_TASK_STATES as readonly string[]).includes(value);
}

/** 是否为真实可转换的任务状态（排除 unknown 桶）。 */
export function isRealTaskState(value: unknown): value is Exclude<A2ATaskState, "unknown"> {
  return isTaskState(value) && value !== "unknown";
}

export function isTerminalTaskState(value: A2ATaskState | undefined): value is A2ATaskTerminalState {
  return (
    value !== undefined && (A2A_TASK_TERMINAL_STATES as readonly string[]).includes(value)
  );
}

export function isWaitingTaskState(value: A2ATaskState | undefined): value is "input-required" {
  return value === "input-required";
}

/**
 * 校验一次任务状态转换。fail-closed：
 * - 源/目标任一为 `unknown` → unknown_state（不猜测）；
 * - 转换不在转换表 → illegal_transition；
 * - 源 === 目标 → 同状态 no-op，返回该状态（轮询重观察合法）。
 */
export function transitionTaskState(
  from: A2ATaskState,
  to: A2ATaskState,
): A2ATaskState {
  if (!isRealTaskState(from)) {
    throw new TaskStateError("unknown_state", `source task state ${String(from)} is unknown`);
  }
  if (!isRealTaskState(to)) {
    throw new TaskStateError("unknown_state", `target task state ${String(to)} is unknown`);
  }
  if (from === to) return to;
  const allowed = A2A_TASK_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new TaskStateError(
      "illegal_transition",
      `illegal A2A task transition: ${from} -> ${to}`,
    );
  }
  return to;
}

/**
 * 任务状态追踪器：记录当前已知状态，并对每次新观察做转换校验。
 * 轮询器用它判定远端状态变化是否合法；非法变化（如 completed → working）
 * 是协议违规，fail-closed 拒绝。
 */
export class TaskLifecycleTracker {
  private currentState: A2ATaskState | null = null;

  /** 当前已知状态；尚无任何观察时为 null。 */
  current(): A2ATaskState | null {
    return this.currentState;
  }

  isTerminal(): boolean {
    return isTerminalTaskState(this.currentState ?? undefined);
  }

  /**
   * 观察一个新状态。返回观察后的当前状态（同状态 no-op 返回原值）。
   * 首次观察接受任何真实状态；后续观察必须落在转换表内。
   * `unknown` 或非法转换抛 TaskStateError。
   */
  observe(observed: A2ATaskState): A2ATaskState {
    if (this.currentState === null) {
      if (!isRealTaskState(observed)) {
        throw new TaskStateError("unknown_state", `observed task state ${String(observed)} is unknown`);
      }
      this.currentState = observed;
      return observed;
    }
    const next = transitionTaskState(this.currentState, observed);
    this.currentState = next;
    return next;
  }
}
