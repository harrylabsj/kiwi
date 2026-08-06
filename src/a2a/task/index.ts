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
 * a2a/task — A2A Task 生命周期模型 + 轮询器（WP3，基线 §18.3 / §23）。
 */

export {
  A2A_TASK_STATES_REAL,
  A2A_TASK_TERMINAL_STATES,
  A2A_TASK_TRANSITIONS,
  isRealTaskState,
  isTaskState,
  isTerminalTaskState,
  isWaitingTaskState,
  TaskLifecycleTracker,
  transitionTaskState,
  TaskStateError,
} from "./state.js";
export type { A2ATaskTerminalState, TaskStateErrorCode } from "./state.js";
export { recordTaskObservation } from "./ledger.js";
export type { TaskObservationInput } from "./ledger.js";
export { A2ATaskPoller } from "./poller.js";
export type {
  PollResult,
  PollStatus,
  TaskPollerClient,
  TaskPollerLedgerOptions,
  TaskPollerOptions,
} from "./poller.js";
