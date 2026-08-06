/**
 * A2A Task 轮询器（基线 §18.3 / §23 恢复第 4 步 "re-fetch remote task state"）。
 *
 * 风格对齐仓库 Task Scheduler（src/agent/buyer/scheduler.ts）：确定性核心 +
 * 预算/截止约束 + 错误分类收敛，不崩整个 tick。本模块把「预算」具体化为：
 *
 *   - maxAttempts     轮询预算（attempt 上限，含首轮）；
 *   - deadlineMs      从 start 起的绝对截止（墙钟），截止前不再发起新一轮；
 *   - baseBackoffMs / maxBackoffMs / backoffMultiplier
 *                     指数退避（delay = min(base * mult^(attempt-1), max)）。
 *
 * 行为：
 *   - 每个 attempt 调 client.getTask(taskId)；解析出的状态经
 *     TaskLifecycleTracker 校验转换合法性（completed → working 这类非法回退
 *     fail-closed，协议违规不猜测）。
 *   - 终态（completed/canceled/failed）与 input-required 都是稳定观察点：
 *     input-required 表示远端在等输入，轮询不会推进它，返回后由调用方决定。
 *   - 瞬态错误（timeout / network / http_status / jsonrpc_error）退避重试；
 *     schema_invalid / invalid_response / unsafe_target 或未知状态是
 *     fail-closed 的「不可重试」错误 —— 拒绝，不猜测。
 *   - 每次任务状态变化经 onStateChanged（含 Ledger 落账）记录证据。
 */

import { A2AClientError } from "../client/index.js";
import type { A2ATask, A2ATaskState } from "../client/index.js";
import type {
  LedgerCapabilitySnapshot,
  LedgerIdentitySnapshot,
  LedgerStore,
} from "../../negotiation/ledger/index.js";
import {
  isTerminalTaskState,
  isWaitingTaskState,
  TaskLifecycleTracker,
  TaskStateError,
} from "./state.js";
import { recordTaskObservation } from "./ledger.js";

/** 轮询客户端最小面：tasks/get 足够。 */
export interface TaskPollerClient {
  getTask(taskId: string): Promise<A2ATask>;
}

export type PollStatus =
  | "completed"
  | "canceled"
  | "failed"
  | "input-required"
  | "timeout"
  | "budget_exhausted"
  | "rejected";

export interface PollResult {
  status: PollStatus;
  /** 到达终态 / input-required / 最近一次成功取回的任务。 */
  task?: A2ATask;
  /** 最后一次观察到的真实状态（若有）。 */
  state?: A2ATaskState;
  /** 已消耗的 attempt 数（含失败与成功的轮询）。 */
  attempts: number;
  /** rejected / budget_exhausted 时的根因。 */
  lastError?: unknown;
  /** rejected 时的人读原因（未知状态 / 非法转换 / schema 失败等）。 */
  reason?: string;
}

export interface TaskPollerLedgerOptions {
  ledger: LedgerStore;
  negotiation_id: string;
  identity?: LedgerIdentitySnapshot;
  capability?: LedgerCapabilitySnapshot;
}

export interface TaskPollerOptions {
  client: TaskPollerClient;
  taskId: string;
  /** 轮询带上 contextId（opaque，落账引用用）。 */
  contextId?: string;
  /** 轮询预算（attempt 数，默认 10）。 */
  maxAttempts?: number;
  /** 相对截止 ms；缺省不设墙钟截止（仅受 maxAttempts 约束）。 */
  deadlineMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  backoffMultiplier?: number;
  /** 可注入时钟（ms epoch）；缺省 Date.now()。 */
  now?: () => number;
  /** 可注入 sleep；缺省 setTimeout。测试传瞬时 sleep。 */
  sleep?: (ms: number) => Promise<void>;
  /** 任务状态变化时调用（Ledger 落账 + 观察者钩子）。 */
  onStateChanged?: (info: {
    task: A2ATask;
    from: A2ATaskState | null;
    to: A2ATaskState;
  }) => void | Promise<void>;
  /** 提供 ledger + negotiation_id 时，状态变化自动落账。 */
  ledger?: TaskPollerLedgerOptions;
}

const DEFAULTS = {
  maxAttempts: 10,
  baseBackoffMs: 250,
  maxBackoffMs: 5000,
  backoffMultiplier: 2,
} as const;

export class A2ATaskPoller {
  private readonly client: TaskPollerClient;
  private readonly taskId: string;
  private readonly contextId?: string;
  private readonly maxAttempts: number;
  private readonly deadlineMs?: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly backoffMultiplier: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onStateChanged?: TaskPollerOptions["onStateChanged"];
  private readonly ledger?: TaskPollerLedgerOptions;

  constructor(options: TaskPollerOptions) {
    this.client = options.client;
    this.taskId = options.taskId;
    this.contextId = options.contextId;
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.deadlineMs = options.deadlineMs;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.backoffMultiplier = options.backoffMultiplier ?? DEFAULTS.backoffMultiplier;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onStateChanged = options.onStateChanged;
    this.ledger = options.ledger;
  }

  /** 第 attempt 次（1-based）尝试后的退避延迟。 */
  private backoffFor(attempt: number): number {
    const raw = this.baseBackoffMs * Math.pow(this.backoffMultiplier, Math.max(0, attempt - 1));
    return Math.min(raw, this.maxBackoffMs);
  }

  private async recordObservation(
    task: A2ATask,
    from: A2ATaskState | null,
    to: A2ATaskState,
  ): Promise<void> {
    if (this.ledger !== undefined) {
      recordTaskObservation({
        ledger: this.ledger.ledger,
        negotiation_id: this.ledger.negotiation_id,
        task_id: this.taskId,
        task_state: to,
        context_id: this.contextId ?? task.contextId,
        message_id: task.status.message?.messageId,
        identity: this.ledger.identity,
        capability: this.ledger.capability,
        occurred_at: new Date(this.now()).toISOString(),
      });
    }
    if (this.onStateChanged !== undefined) {
      await this.onStateChanged({ task, from, to });
    }
  }

  /**
   * 轮询到稳定观察点。返回：
   *   completed/canceled/failed    远端终态；
   *   input-required               远端等待输入（稳定点，轮询不再推进）；
   *   timeout                      墙钟截止先于终态；
   *   budget_exhausted             瞬态错误耗尽 attempt 预算；
   *   rejected                     fail-closed（未知状态 / 非法转换 / 不可重试错误）。
   */
  async poll(): Promise<PollResult> {
    const start = this.now();
    const deadline = this.deadlineMs === undefined ? Number.POSITIVE_INFINITY : start + this.deadlineMs;
    const tracker = new TaskLifecycleTracker();
    let lastError: unknown;
    let lastTask: A2ATask | undefined;
    let attempts = 0;

    for (;;) {
      // 截止与预算在每次尝试前检查：attempts 语义 = 已执行的轮询次数。
      if (this.now() >= deadline) {
        return { status: "timeout", attempts, lastError, state: tracker.current() ?? undefined, task: lastTask };
      }
      if (attempts >= this.maxAttempts) {
        return {
          status: "budget_exhausted",
          attempts,
          lastError,
          state: tracker.current() ?? undefined,
          task: lastTask,
        };
      }
      attempts += 1;

      let task: A2ATask;
      try {
        task = await this.client.getTask(this.taskId);
      } catch (err) {
        lastError = err;
        lastTask = undefined;
        if (err instanceof A2AClientError) {
          const kind = (err as A2AClientError).kind;
          if (
            kind === "schema_invalid" ||
            kind === "invalid_response" ||
            kind === "unsafe_target"
          ) {
            // 响应不可信：不重试，fail-closed。
            return { status: "rejected", attempts, lastError: err, reason: kind };
          }
          // timeout / network / http_status / jsonrpc_error → 瞬态，退避重试。
        } else {
          return { status: "rejected", attempts, lastError: err, reason: "unknown_error" };
        }
        if (attempts >= this.maxAttempts) {
          return { status: "budget_exhausted", attempts, lastError: err };
        }
        await this.sleep(this.backoffFor(attempts));
        continue;
      }

      lastTask = task;
      const observed = task.status.state;
      const before = tracker.current();
      let after: A2ATaskState;
      try {
        after = tracker.observe(observed);
      } catch (err) {
        lastError = err;
        return {
          status: "rejected",
          attempts,
          lastError: err,
          reason: err instanceof TaskStateError ? err.code : "invalid_state",
          task,
        };
      }

      if (after !== before) {
        await this.recordObservation(task, before, after);
      }

      if (isTerminalTaskState(after) || isWaitingTaskState(after)) {
        return { status: after, attempts, task, state: after };
      }

      // submitted / working：继续轮询。先检查截止，再退避。
      if (this.now() >= deadline) {
        return { status: "timeout", attempts, lastError, state: after, task };
      }
      await this.sleep(this.backoffFor(attempts));
    }
  }
}
