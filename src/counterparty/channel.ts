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
 * CounterpartyChannel 唯一接口（基线 §5 / §33 / §38 推荐结构）。
 *
 * 职责边界（§33）：
 *   - AgentDiscovery 负责：domain → Agent Card → capability intersection →
 *     identity bootstrap → channel candidates；
 *   - CounterpartyChannel 负责：open / send / getState / subscribe / close。
 *
 * 本模块是三条通道（a2a-direct / shopping-cli-hosted / platform-api）与上层
 * （recovery、未来 Negotiation Engine）之间的**唯一**接缝。WP3 recovery 的
 * `CounterpartyChannel`（identity+url 二元组）在本 WP 收敛为此处定义的单接口，
 * 不再有第二套契约。
 *
 * 不变量（基线 §4.6 Fail Closed / §36-21）：
 *   - open 失败 / send 失败绝不由通道内部降级到权限更宽的通道；候选选择是
 *     确定性的一次性决策（selectChannelCandidate），没有自动重试队列；
 *   - 未知状态 / 校验失败一律抛 ChannelError（fail-closed），不静默容错。
 */

import type { A2ATask, A2ATaskState } from "../a2a/client/index.js";
import type { NegotiationEnvelope } from "../negotiation/domain/envelope.js";
import type { PolicyResult } from "../negotiation/types.js";
import type { AgentCard } from "../discovery/agent-card/index.js";
import type { CapabilityIntersection } from "../discovery/capability/index.js";
import type { UcpIntersectionView } from "../discovery/ucp/intersect.js";
import type { UcpProfile } from "../discovery/ucp/types.js";

/** 通道种类（基线 §5 三个实现）。 */
export type ChannelKind = "a2a-direct" | "shopping-cli-hosted" | "platform-api";

/** 通道候选的确定性优先序（§33：A2A 可用 → direct；否则 hosted；都没有 fail-closed）。 */
const CHANNEL_PREFERENCE: readonly ChannelKind[] = ["a2a-direct", "shopping-cli-hosted", "platform-api"];

/**
 * 远端通道引用：negotiation + 该通道家族自己的锚点。
 *
 * direct 用 context_id/task_id；hosted 用 conversation_id/message_id。两组字段
 * 分属两个通道家族，互不冲突。taskId 只是 transport/session 状态，不得替代
 * negotiation_id（基线 §9.5）。
 */
export interface RemoteRef {
  negotiation_id: string;
  /** A2A contextId（direct，opaque，§9.2）。 */
  context_id?: string;
  /** A2A taskId（direct，§9.5）。 */
  task_id?: string;
  /** shopping-cli conversation_id（hosted）。 */
  conversation_id?: string;
  /** shopping-cli message_id（hosted）。 */
  message_id?: number;
}

/** 打开通道的输入。open 把通道绑定到一个 negotiation 实例。 */
export interface ChannelOpenInput {
  negotiation_id: string;
  /** 本方（Kiwi）身份 —— Ledger identity 的 sender 侧。 */
  sender_identity: string;
  /** 对端身份 —— 协议幂等键的 counterparty 侧。 */
  identity: string;
  /** 初始远端锚点（可选；direct 首次 send 后获得 taskId；hosted 打开即绑定会话）。 */
  remote?: {
    context_id?: string;
    task_id?: string;
    conversation_id?: string;
    message_id?: number;
  };
  /** 打开/请求超时 ms。 */
  timeoutMs?: number;
}

/** send 的输入：KNP envelope + 目标引用。 */
export interface ChannelSendInput {
  envelope: NegotiationEnvelope;
  ref?: RemoteRef;
}

/**
 * send 结果。成功返回结构化结果；硬失败（网络 / 校验 / 权限）一律抛 ChannelError。
 * direct 通道带 `task`；hosted 通道带 `policy`。
 */
export interface ChannelSendResult {
  channel: ChannelKind;
  /** 发送后应更新的远端锚点。 */
  ref: RemoteRef;
  /** direct：message/send 的远端任务。 */
  task?: A2ATask;
  /** hosted：策略结果（accepted / rejected_retryable / human_required）。 */
  policy?: PolicyResult;
  /** 幂等重放：true 表示未重复发送，返回先前结果（§17 / §20）。 */
  replayed?: boolean;
}

/**
 * 远端稳定观察点（getState）。`state` 是权威状态值：
 *   - direct：A2A task state（§18.3）；
 *   - hosted：shopping-cli conversation status（§21 Authority Model：
 *     authoritative snapshot > local cache > reasoning state）。
 */
export interface RemoteState {
  channel: ChannelKind;
  /** 权威状态值。 */
  state: string;
  /** 是否为稳定观察点（终态或等待输入）。 */
  stable: boolean;
  /** direct：A2A Task 视图。 */
  task?: A2ATask;
  /** hosted：shopping-cli 权威快照（§21）。 */
  snapshot?: import("../negotiation/types.js").NegotiationSnapshot;
  /** 远端可见 messageId 集合（recovery 比对 acknowledged messages）。 */
  message_ids: string[];
  observed_at: string;
}

export type RemoteEventKind = "state_changed" | "message_received" | "error";

/** 异步推送/轮询事件（§33 subscribe）。 */
export interface RemoteEvent {
  channel: ChannelKind;
  kind: RemoteEventKind;
  ref: RemoteRef;
  state?: RemoteState;
  message_id?: string;
  error?: ChannelError;
}

export type ChannelEventHandler = (event: RemoteEvent) => void | Promise<void>;
export type Unsubscribe = () => void | Promise<void>;

/** 通道打开后的操作面。open 后持有该 handle 执行 send/getState/subscribe/close。 */
export interface ChannelHandle {
  readonly kind: ChannelKind;
  /** 对端身份（open 时绑定）。 */
  readonly identity: string;
  send(input: ChannelSendInput): Promise<ChannelSendResult>;
  getState(ref: RemoteRef): Promise<RemoteState>;
  /** 无 subscribe 的通道通过 getState 轮询（§33）。 */
  subscribe?(ref: RemoteRef, handler: ChannelEventHandler): Promise<Unsubscribe>;
  close(): Promise<void>;
}

/** CounterpartyChannel 工厂接口：open 打开一条绑定到 negotiation 的通道。 */
export interface CounterpartyChannel {
  readonly kind: ChannelKind;
  open(input: ChannelOpenInput): Promise<ChannelHandle>;
}

// ---------------------------------------------------------------------------
// ChannelError
// ---------------------------------------------------------------------------

export const CHANNEL_ERROR_CODES = [
  "no_channel_candidate",
  "channel_closed",
  "invalid_envelope",
  "idempotency_conflict",
  "send_failed",
  "get_state_failed",
  "unsupported_action",
  "commerce_client_not_configured",
  "platform_not_configured",
  "not_implemented",
] as const;
export type ChannelErrorCode = (typeof CHANNEL_ERROR_CODES)[number];

/** 通道层失败。带通道 kind 与协议错误码；fail-closed，绝不静默降级。 */
export class ChannelError extends Error {
  readonly channel: ChannelKind;
  readonly code: ChannelErrorCode;
  constructor(channel: ChannelKind, code: ChannelErrorCode, message: string) {
    super(message);
    this.name = "ChannelError";
    this.channel = channel;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Discovery 产出：CounterpartyProfile + ChannelCandidate
// ---------------------------------------------------------------------------

/**
 * 通道候选（§33 AgentDiscovery 产出）。数组顺序即优先序：
 * a2a-direct → shopping-cli-hosted → platform-api。每个候选携带构造所需的最小配置。
 */
export interface ChannelCandidate {
  kind: ChannelKind;
  /** a2a-direct：capability intersection 选中的远端 endpoint URL。 */
  url?: string;
  /** shopping-cli-hosted：本地配置的 commerce 服务标识（供 deps.commerce 解析）。 */
  config_id?: string;
  /** platform-api：平台凭证引用（fail-closed，必须显式配置）。 */
  credential_ref?: string;
}

/**
 * 解析出的对端通道档案（§33 AgentDiscovery 第 1–5 步的产物）。
 * resolveCounterparty（recovery）/ 未来 Negotiation Engine 只依赖此档案 + open。
 */
export interface CounterpartyProfile {
  /** 对端身份（协议幂等键 counterparty 侧；来自 Agent Card provider/name）。 */
  identity: string;
  /** 解析来源：`domain:<host>` 或 `card:<url>`。 */
  source: string;
  /** 拉取并校验后的 Agent Card（结构校验 + secret 扫描，不变量 24）。 */
  agent_card: AgentCard;
  /** 双方 capability intersection（§33）。 */
  intersection: CapabilityIntersection;
  /** 按优先序排列的通道候选。 */
  channel_candidates: ChannelCandidate[];
  /**
   * WP3：双方 UCP capability intersection（§3.2 / §25），与 A2A binding
   * `intersection` 两个维度并存。UCP 优先路径成功且配置了 platform 侧
   * localProfile 时存在。
   */
  ucp_intersection?: UcpIntersectionView;
  /** WP3：解析出的对端 UCP profile（UCP 优先路径成功时存在）。 */
  ucp_profile?: UcpProfile;
  /** WP3：UCP 优先路径失败时的回退原因（已回退到 well-known Agent Card）。 */
  ucp_fallback_reason?: string;
}

/**
 * 确定性选择首选候选（§33 / 不变量 21）：按 direct → hosted → platform 的固定
 * 顺序取第一个可用候选。这是**一次性**决策——调用方不得在后续失败时自动退到
 * 更宽的候选（不变量 21）。
 */
export function selectChannelCandidate(profile: CounterpartyProfile): ChannelCandidate | null {
  const rank = new Map<ChannelKind, number>(CHANNEL_PREFERENCE.map((k, i) => [k, i]));
  const ordered = [...profile.channel_candidates].sort(
    (a, b) => (rank.get(a.kind) ?? Number.POSITIVE_INFINITY) - (rank.get(b.kind) ?? Number.POSITIVE_INFINITY),
  );
  return ordered[0] ?? null;
}

/** 便捷断言：把 A2A task 状态归一化为 RemoteState（direct 通道内部用）。 */
export function isStableTaskState(state: A2ATaskState): boolean {
  return (
    state === "completed" ||
    state === "canceled" ||
    state === "failed" ||
    state === "input-required"
  );
}
