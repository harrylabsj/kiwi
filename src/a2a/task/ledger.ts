/**
 * A2A Task 状态 → Ledger 落账（基线 §22 / §18.3 / 子规范 §28）。
 *
 * 轮询器每次观察到任务状态变化时调用 recordTaskObservation，把远端 taskId /
 * contextId 引用与 task_state 一起落账（§22 要求的 remote contextId/taskId 引用）。
 * event_kind 用 `system`：task 状态不是 KNP phase 转换（state_transition 是
 * NegotiationPhase 维度），也不是消息收发；作为运行时观察证据记录。
 *
 * 不保存 raw chain-of-thought / Vault plaintext（§28 禁词由 LedgerStore.append
 * 强制）。远端 contextId 只作 opaque 引用存储（基线 §9.2 / §6.6），不解析不推断。
 */

import type {
  LedgerCapabilitySnapshot,
  LedgerIdentitySnapshot,
  LedgerStore,
} from "../../negotiation/ledger/index.js";
import type { A2ATaskState } from "../client/index.js";

const DEFAULT_IDENTITY: LedgerIdentitySnapshot = {
  sender_identity: "kiwi.a2a.task",
  counterparty_identity: "remote",
};

const DEFAULT_CAPABILITY: LedgerCapabilitySnapshot = {
  capability: "a2a.task.observation",
  protocol_version: "1.0",
};

export interface TaskObservationInput {
  ledger: LedgerStore;
  negotiation_id: string;
  task_id: string;
  task_state: A2ATaskState;
  /** 远端 A2A contextId（opaque）。 */
  context_id?: string;
  /** 观察时任务携带的最近 messageId（如有）。 */
  message_id?: string;
  identity?: LedgerIdentitySnapshot;
  capability?: LedgerCapabilitySnapshot;
  /** 业务发生时间（RFC 3339）。 */
  occurred_at: string;
}

/**
 * 记录一次任务状态观察。调用方保证 task_state 已通过状态机校验
 * （recordTaskObservation 不对状态做业务判定，只落账）；task_state 为
 * `unknown` 时 fail-closed 抛错，绝不把不确定状态写进审计链。
 */
export function recordTaskObservation(input: TaskObservationInput): void {
  if (input.task_state === "unknown") {
    throw new Error("recordTaskObservation refuses to record unknown task state");
  }
  input.ledger.append({
    event_kind: "system",
    negotiation_id: input.negotiation_id,
    message_id: input.message_id,
    remote_context_id: input.context_id,
    remote_task_id: input.task_id,
    identity: input.identity ?? DEFAULT_IDENTITY,
    capability: input.capability ?? DEFAULT_CAPABILITY,
    outcome: { kind: "ok", result: { task_id: input.task_id, task_state: input.task_state } },
    occurred_at: input.occurred_at,
  });
}
