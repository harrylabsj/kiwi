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
 * HandoffCandidate 生命周期 —— event-sourced 投影（KTH rev0.3 §5.1）。
 *
 * 候选内容不可变；lifecycle 状态**不是**候选 JSON 内的字段，而是
 * Ledger 事件的投影（foldCandidateLifecycle 纯函数）。迁移表：
 *
 *   (none)     --created-->  PROPOSED
 *   PROPOSED   --ready-->    READY      （策略/批准通过）
 *   PROPOSED/READY --rejected--> REJECTED （终态）
 *   PROPOSED/READY --stale-->   STALE     （绑定输入变化；不可 revive，
 *                                        需新候选带 supersedes_candidate_id）
 *   PROPOSED/READY --expired--> EXPIRED   （终态）
 *   READY      --consumed--> CONSUMED    （执行完成，终态）
 *
 * 终态：REJECTED / STALE / EXPIRED / CONSUMED。
 */

import { schemaError } from "../negotiation/domain/common.js";
import type { LedgerEvent, LedgerEventKind } from "../negotiation/ledger/event.js";

export const HANDOFF_CANDIDATE_LIFECYCLE_STATES = [
  "PROPOSED",
  "READY",
  "REJECTED",
  "STALE",
  "EXPIRED",
  "CONSUMED",
] as const;

export type HandoffCandidateLifecycleState = (typeof HANDOFF_CANDIDATE_LIFECYCLE_STATES)[number];

/** candidate 生命周期事件 kind（与 LEDGER_EVENT_KINDS 的 handoff_candidate_* 对齐）。 */
export const HANDOFF_CANDIDATE_EVENT_KINDS = [
  "handoff_candidate_created",
  "handoff_candidate_ready",
  "handoff_candidate_rejected",
  "handoff_candidate_stale",
  "handoff_candidate_expired",
  "handoff_candidate_consumed",
] as const;

export type HandoffCandidateEventKind = (typeof HANDOFF_CANDIDATE_EVENT_KINDS)[number];

const TERMINAL_STATES: ReadonlySet<HandoffCandidateLifecycleState> = new Set([
  "REJECTED",
  "STALE",
  "EXPIRED",
  "CONSUMED",
]);

/** kind → 投影状态。 */
const EVENT_KIND_TO_STATE: Readonly<Record<HandoffCandidateEventKind, HandoffCandidateLifecycleState>> = {
  handoff_candidate_created: "PROPOSED",
  handoff_candidate_ready: "READY",
  handoff_candidate_rejected: "REJECTED",
  handoff_candidate_stale: "STALE",
  handoff_candidate_expired: "EXPIRED",
  handoff_candidate_consumed: "CONSUMED",
};

/** 显式迁移表：current → allowed next states。 */
const TRANSITIONS: Readonly<Record<string, ReadonlySet<HandoffCandidateLifecycleState>>> = {
  "": new Set(["PROPOSED"]),
  PROPOSED: new Set(["READY", "REJECTED", "STALE", "EXPIRED"]),
  READY: new Set(["REJECTED", "STALE", "EXPIRED", "CONSUMED"]),
  REJECTED: new Set(),
  STALE: new Set(),
  EXPIRED: new Set(),
  CONSUMED: new Set(),
};

/** 事件 kind 是否 candidate 生命周期事件。 */
export function isHandoffCandidateEventKind(kind: LedgerEventKind): kind is HandoffCandidateEventKind {
  return (HANDOFF_CANDIDATE_EVENT_KINDS as readonly string[]).includes(kind);
}

/** 从 Ledger 事件序列投影 candidate 生命周期状态（纯函数，最后事件胜出）。 */
export function foldCandidateLifecycle(
  events: readonly Pick<LedgerEvent, "event_kind" | "event_id" | "recorded_at">[],
): HandoffCandidateLifecycleState | undefined {
  let state: HandoffCandidateLifecycleState | undefined;
  for (const event of events) {
    if (!isHandoffCandidateEventKind(event.event_kind)) continue;
    state = EVENT_KIND_TO_STATE[event.event_kind];
  }
  return state;
}

/** 迁移校验：返回 target 或抛 schemaError（fail-closed）。 */
export function transitionCandidateLifecycle(
  current: HandoffCandidateLifecycleState | undefined,
  eventKind: HandoffCandidateEventKind,
): HandoffCandidateLifecycleState {
  const target = EVENT_KIND_TO_STATE[eventKind];
  const allowed = TRANSITIONS[current ?? ""] ?? new Set<HandoffCandidateLifecycleState>();
  if (!allowed.has(target)) {
    throw schemaError(
      "handoff_candidate_lifecycle",
      `illegal handoff candidate lifecycle transition ${current ?? "(none)"} --${eventKind}--> ${target}`,
    );
  }
  return target;
}

/** 终态判定：终态候选不可 revive，必须新建候选（带 supersedes_candidate_id）。 */
export function isTerminalLifecycleState(state: HandoffCandidateLifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}
