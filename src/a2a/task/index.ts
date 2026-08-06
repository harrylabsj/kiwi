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
