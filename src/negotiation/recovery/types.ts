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
 * Recovery 契约（基线 §23 / 子规范 §27）。
 *
 * 恢复流程八步的接缝定义。WP4 之后，对端访问面收敛为唯一
 * `CounterpartyChannel` 接口（src/counterparty/channel.ts）：
 *
 *   - `resolveCounterparty` 返回 `CounterpartyProfile`（§33 AgentDiscovery 产出，
 *     含 channel candidates）；
 *   - `openChannel` 打开一条绑定到 negotiation 的 ChannelHandle
 *     （send/getState/subscribe/close）；
 *   - 恢复第 4/6 步经 ChannelHandle.getState/send 访问远端，不再有第二套
 *     RemoteTaskGateway 契约。
 *
 * 「远端不可信」仍落地为：getState 返回的 A2A task / envelope 必须通过
 * 校验才能进入 Ledger；任何不确定性 fail-closed → reconciliation_required。
 */

import type { A2ATaskState } from "../../a2a/client/index.js";
import type {
  ChannelHandle,
  ChannelOpenInput,
  CounterpartyProfile,
  RemoteState,
} from "../../counterparty/index.js";
import type { IdempotencyStore } from "../idempotency/index.js";
import type { LedgerHighWaterMark } from "../ledger/index.js";
import type { NegotiationPhase } from "../state/phase.js";

/** negotiation_id → 对端通道档案；未知返回 null。 */
export type CounterpartyResolver = (negotiationId: string) => Promise<CounterpartyProfile | null>;

/** 由档案打开通道；缺省用 profile 首选候选（openChannel，绝不降级）。 */
export type ChannelOpener = (profile: CounterpartyProfile, input: ChannelOpenInput) => Promise<ChannelHandle>;

/** 从 RemoteState 提取远端可见 messageId；缺省取 task.status.message.messageId。 */
export type RemoteViewMessageIds = (state: RemoteState) => string[];

export type RecoveryStatus = "resumed" | "reconciliation_required";

export interface RecoveryResult {
  status: RecoveryStatus;
  negotiation_id: string;
  /** reconciliation_required 时的原因（转人工）。 */
  reason?: string;
  /** 安全重放成功的本地 pending messageId 列表（同 message_id + 同 digest）。 */
  replayed_message_ids: string[];
  /** remote-ahead 分支落账的 reconciliation 事件数。 */
  remote_ahead_appended: number;
  /** 标记为 stale（需失效）的本地 messageId。 */
  stale_message_ids: string[];
  /** 恢复后应继续轮询的 taskId 列表。 */
  resume_task_ids: string[];
  /** 恢复时重建的本地 phase。 */
  phase?: NegotiationPhase;
  /** 远端任务状态（如有）。 */
  remote_state?: A2ATaskState;
  high_water_mark: LedgerHighWaterMark;
}

export interface RecoveryDeps {
  /** 本地权威审计链（§22 / §23 第 2、5 步）。 */
  ledger: import("../ledger/index.js").LedgerStore;
  /** negotiation_id ↔ 远端 contextId/taskId（§9.2）。 */
  contextMap: import("../context-map/index.js").ContextMapStore;
  /**
   * 协议幂等（§20 / §23）。缺省装配通道时注入：恢复重放沿用原
   * (sender_identity, message_id) 幂等键 → check() 返回 replayed → 通道不重复
   * 落 message_sent（§25.2）。注入 openChannel 时由注入方负责。
   */
  idempotency?: IdempotencyStore;
  /** 对端通道档案解析（第 3 步）。 */
  resolveCounterparty: CounterpartyResolver;
  /** 打开通道（第 3 步后）；缺省用 profile 首选候选。 */
  openChannel?: ChannelOpener;
  /** 从 RemoteState 提取远端已确认 messageId；缺省取 task.status.message.messageId。 */
  viewMessageIds?: RemoteViewMessageIds;
  /** 第 7 步失效接缝：把 stale 的候选/批准标记为过期（WP 接线方实现）。 */
  expireStale?: (negotiationId: string, staleMessageIds: string[]) => void | Promise<void>;
  /** 可注入时钟（RFC 3339）。 */
  now?: () => string;
  log?: (message: string, err?: unknown) => void;
}
