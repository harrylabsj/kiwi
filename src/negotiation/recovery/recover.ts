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
 * 跨进程 context 恢复（基线 §23 Recovery and Reconciliation / 子规范 §27）。
 *
 * 八步流程的实现（WP4 后统一走 CounterpartyChannel 唯一接口）：
 *
 * ```text
 * 1. Load local negotiation           ← 从 Ledger 重建本地 phase + 出站消息
 * 2. Load Ledger high-water mark      ← highWaterMark() + verifyChain()（fail-closed）
 * 3. Resolve counterparty/profile     ← CounterpartyResolver → CounterpartyProfile
 * 4. Re-fetch remote task state       ← ChannelHandle.getState()（direct 通道）
 * 5. Compare acknowledged messages    ← 远端可见 messageId vs 本地 message_sent
 * 6. Reconcile remote state × Ledger  ← remote ahead: fetch→validate→append；
 *                                         local pending: 同 id+同 digest 安全重放
 *                                         （ChannelHandle.send）；不可调和 → 转人工
 * 7. Expire stale candidates/approvals ← 远端 revision 变化 → 本地出站消息置 stale
 * 8. Resume scheduler/subscription    ← 返回 resume_task_ids，由调用方恢复轮询
 * ```
 *
 * fail-closed 不变量：恢复过程任何不确定性（链损坏、无法解析 profile、远端不可达、
 * 未知状态、内容校验失败、pending 无法安全重放、本地终态 vs 远端活跃）一律
 * reconciliation_required，绝不自动生成新的商业承诺（§23 / §27）。
 * 恢复只对 a2a-direct 通道生效：hosted 通道有独立的 claim/stale 恢复机制，不走
 * 本流程（§24）。非 direct 通道 → reconciliation_required（不猜测，§4.6）。
 */

import { computeEnvelopeDigest, validateEnvelope, verifyEnvelopeDigest } from "../domain/envelope.js";
import type { NegotiationEnvelope } from "../domain/envelope.js";
import { NegotiationValidationError } from "../domain/common.js";
import { isTerminalPhase, type NegotiationPhase } from "../state/phase.js";
import type {
  LedgerEvent,
  LedgerEventContent,
  LedgerHighWaterMark,
} from "../ledger/index.js";
import type { A2APart, A2ATask, A2ATaskState } from "../../a2a/client/index.js";
import { isTaskState } from "../../a2a/task/index.js";
import { KNP_ENVELOPE_DATA_KEY } from "../../a2a/server/inbound-message.js";
import type { ContextMapping } from "../context-map/index.js";
import {
  openChannel,
  selectChannelCandidate,
  type ChannelHandle,
  type ChannelOpenInput,
  type CounterpartyProfile,
  type RemoteState,
} from "../../counterparty/index.js";
import type { RecoveryDeps, RecoveryResult } from "./types.js";

/** 一条本地出站消息的证据（从 Ledger message_sent 事件重建）。 */
interface OutboundLedgerEntry {
  message_id: string;
  wire_digest?: string;
  wire_payload?: Record<string, unknown>;
  remote_task_id?: string;
}

const RECOVERY_CAPABILITY = { capability: "knp.a2a.recovery", protocol_version: "1.0" } as const;
/** 恢复子系统的审计身份（reconciliation 事件的 sender 侧）。 */
export const RECOVERY_SENDER_IDENTITY = "kiwi.recovery";

/**
 * 从 Ledger 事件推断本地会话的 sender_identity（基线 §23 / §25.2）。
 *
 * 恢复重放必须以原会话身份打开通道：幂等主键是 (sender_identity, message_id)，
 * 若硬编码成 "kiwi.recovery"，pending 消息的键与原发送不匹配 → idempotency
 * check() 返回 new → A2ADirectChannel 真实重发并在 Ledger 产生第二条
 * message_sent（审计重复，§23）。此处优先取 message_sent 事件的 identity
 * snapshot（出站身份）；无出站消息时取任一非 reconciliation 事件的
 * sender_identity（reconciliation 是恢复子系统自身审计，不算会话身份）；全部
 * 缺失回退 RECOVERY_SENDER_IDENTITY（保持既有兜底）。
 */
export function deriveSessionIdentity(events: LedgerEvent[]): string {
  for (const event of events) {
    if (event.event_kind === "message_sent") {
      return event.identity.sender_identity;
    }
  }
  for (const event of events) {
    if (event.event_kind !== "reconciliation") {
      return event.identity.sender_identity;
    }
  }
  return RECOVERY_SENDER_IDENTITY;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultViewMessageIds(state: RemoteState): string[] {
  const id = state.task?.status.message?.messageId;
  return id === undefined ? [] : [id];
}

/** 审查 P3：远端回包用新 messageId——"远端 id 集合包含本地出站 id"永远为假，
 *  恢复第 5 步的 ack 比较形同虚设（每条出站消息每次恢复都判 pending，靠发送
 *  侧幂等短路兜住）。正确的 ack 键是远端消息的 `in_reply_to`（KNP envelope
 *  data part）：回包引用本地出站 message_id 即已确认。 */
function acknowledgedMessageIds(task: A2ATask | null): Set<string> {
  const ids = new Set<string>();
  const parts = task?.status.message?.parts;
  if (!Array.isArray(parts)) return ids;
  for (const part of parts) {
    if (part.kind !== "data" || part.data === undefined) continue;
    const envelope = part.data["knp_envelope"] as { in_reply_to?: unknown } | undefined;
    if (
      envelope !== undefined &&
      typeof envelope.in_reply_to === "string" &&
      envelope.in_reply_to !== ""
    ) {
      ids.add(envelope.in_reply_to);
    }
  }
  return ids;
}

/** 第 1 步：从 Ledger 的 state_transition 事件重建本地 phase；无记录时 OPEN。 */
export function deriveLocalPhase(events: LedgerEvent[]): NegotiationPhase {
  let phase: NegotiationPhase = "OPEN";
  for (const event of events) {
    if (event.state_transition?.to_phase !== undefined) {
      phase = event.state_transition.to_phase;
    }
  }
  return phase;
}

/** 从 Ledger 事件收集本地出站消息（message_sent 事件）。 */
export function collectOutbound(events: LedgerEvent[]): OutboundLedgerEntry[] {
  const entries: OutboundLedgerEntry[] = [];
  for (const event of events) {
    if (event.event_kind !== "message_sent" || event.message_id === undefined) continue;
    const entry: OutboundLedgerEntry = { message_id: event.message_id };
    if (event.wire_digest !== undefined) entry.wire_digest = event.wire_digest;
    if (event.wire_payload !== undefined) entry.wire_payload = event.wire_payload;
    if (event.remote_task_id !== undefined) entry.remote_task_id = event.remote_task_id;
    entries.push(entry);
  }
  return entries;
}

/** Ledger 中最后一次记录的任务状态（system 观察事件），供 revision 比对。 */
function lastRecordedTaskState(events: LedgerEvent[]): A2ATaskState | undefined {
  let state: A2ATaskState | undefined;
  for (const event of events) {
    if (event.event_kind !== "system" || event.outcome.kind !== "ok") continue;
    const result = event.outcome.result;
    if (result === undefined || typeof result !== "object") continue;
    const raw = (result as Record<string, unknown>)["task_state"];
    if (isTaskState(raw)) state = raw;
  }
  return state;
}

/** 校验远端 task 携带的 KNP envelope；返回 messageId → 已校验 envelope。 */
function extractValidatedEnvelopes(task: A2ATask): Map<string, NegotiationEnvelope> {
  const map = new Map<string, NegotiationEnvelope>();
  const validatePart = (part: A2APart): NegotiationEnvelope | null => {
    if (part.kind !== "data") return null;
    const raw = part.data[KNP_ENVELOPE_DATA_KEY];
    if (raw === undefined) return null;
    const env = validateEnvelope(raw);
    if (!verifyEnvelopeDigest(env)) {
      throw new NegotiationValidationError(
        "state_conflict",
        "remote task envelope digest mismatch (integrity failure)",
        "/digest",
      );
    }
    return env;
  };
  const message = task.status.message;
  if (message !== undefined) {
    for (const part of message.parts) {
      const env = validatePart(part);
      if (env !== null) map.set(message.messageId, env);
    }
  }
  // artifacts 无 messageId：同样校验（远端内容 untrusted，§4.5），但不键控。
  for (const artifact of task.artifacts ?? []) {
    for (const part of artifact.parts) validatePart(part);
  }
  return map;
}

export class NegotiationRecovery {
  private readonly deps: RecoveryDeps;

  constructor(deps: RecoveryDeps) {
    this.deps = deps;
  }

  private nowIso(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private toView(state: RemoteState): { task: A2ATask | null; message_ids: string[] } {
    const ids = (this.deps.viewMessageIds ?? defaultViewMessageIds)(state);
    return { task: state.task ?? null, message_ids: [...new Set(ids)] };
  }

  private reconciliationContent(
    negotiationId: string,
    profile: CounterpartyProfile | null,
    input: {
      message_id?: string;
      remote_context_id?: string;
      remote_task_id?: string;
      wire_payload?: Record<string, unknown>;
      outcome: LedgerEventContent["outcome"];
      occurred_at: string;
    },
  ): LedgerEventContent {
    return {
      event_kind: "reconciliation",
      negotiation_id: negotiationId,
      message_id: input.message_id,
      remote_context_id: input.remote_context_id,
      remote_task_id: input.remote_task_id,
      identity: {
        sender_identity: RECOVERY_SENDER_IDENTITY,
        counterparty_identity: profile?.identity ?? "unresolved",
      },
      capability: { ...RECOVERY_CAPABILITY },
      wire_payload: input.wire_payload,
      outcome: input.outcome,
      occurred_at: input.occurred_at,
    };
  }

  /** 失败审计：不可调和的原因落 reconciliation error 事件后转人工。 */
  private async required(
    negotiationId: string,
    reason: string,
    hwm: LedgerHighWaterMark,
    phase?: NegotiationPhase,
    remoteState?: A2ATaskState,
  ): Promise<RecoveryResult> {
    try {
      this.deps.ledger.append(
        this.reconciliationContent(negotiationId, null, {
          outcome: { kind: "error", code: "reconciliation_required", message: reason },
          occurred_at: this.nowIso(),
        }),
      );
    } catch (err) {
      this.deps.log?.("recovery failed to record reconciliation_required evidence", err);
    }
    return {
      status: "reconciliation_required",
      negotiation_id: negotiationId,
      reason,
      replayed_message_ids: [],
      remote_ahead_appended: 0,
      stale_message_ids: [],
      resume_task_ids: [],
      phase,
      remote_state: remoteState,
      high_water_mark: hwm,
    };
  }

  private makeChannel(profile: CounterpartyProfile, input: ChannelOpenInput): Promise<ChannelHandle> {
    if (this.deps.openChannel !== undefined) return this.deps.openChannel(profile, input);
    // 默认装配也注入 idempotency：恢复重放复用原 (sender_identity, message_id)
    // 幂等键 → check() 返回 replayed → 通道不重复落 message_sent（§23/§25.2）。
    return openChannel(
      profile,
      { ledger: this.deps.ledger, idempotency: this.deps.idempotency },
      input,
    );
  }

  /**
   * 执行八步恢复。任何不确定性 fail-closed → reconciliation_required。
   */
  async recover(negotiationId: string): Promise<RecoveryResult> {
    const { ledger, contextMap, resolveCounterparty } = this.deps;
    const now = this.nowIso();

    // 1. Load local negotiation（从 Ledger 重建）。
    let events: LedgerEvent[];
    let hwm: LedgerHighWaterMark;
    try {
      events = ledger.events(negotiationId);
      hwm = ledger.highWaterMark(negotiationId);
    } catch (err) {
      return this.required(
        negotiationId,
        `ledger unreadable: ${errMsg(err)}`,
        emptyHwm(negotiationId),
      );
    }
    const phase = deriveLocalPhase(events);
    const localSent = collectOutbound(events);
    const localTaskState = lastRecordedTaskState(events);
    // 恢复重放沿用原会话身份（§23/§25.2）：从 Ledger identity snapshot 取，
    // 不用硬编码 —— 否则幂等键 (sender_identity, message_id) 错位，通道会
    // 真实重发并在 Ledger 产生第二条 message_sent。
    const senderIdentity = deriveSessionIdentity(events);

    // 2. Ledger high-water mark + 链完整性（损坏即 fail-closed，绝不可信）。
    const chain = ledger.verifyChain(negotiationId);
    if (!chain.valid) {
      return this.required(
        negotiationId,
        `ledger chain invalid (${chain.error?.code ?? "unknown"} at index ${chain.error?.index ?? -1})`,
        hwm,
        phase,
      );
    }

    let map: ContextMapping | null = null;
    try {
      map = contextMap.get(negotiationId);
    } catch (err) {
      return this.required(negotiationId, `context map corrupt: ${errMsg(err)}`, hwm, phase);
    }

    // 3. Resolve counterparty/profile。
    let profile: CounterpartyProfile | null;
    try {
      profile = await resolveCounterparty(negotiationId);
    } catch (err) {
      return this.required(negotiationId, `counterparty resolution failed: ${errMsg(err)}`, hwm, phase);
    }
    if (profile === null) {
      if (localSent.length > 0) {
        return this.required(negotiationId, "outbound messages pending but no counterparty profile", hwm, phase);
      }
      return this.resumed(negotiationId, hwm, phase, undefined, [], 0, [], map?.task_ids ?? []);
    }

    const contextId = map?.remote_context_id;
    const taskIds = map?.task_ids ?? [];
    const activeTaskId = taskIds.at(-1);

    // 恢复只支持 direct 通道（§24：hosted 有独立的 claim/stale 恢复机制）。
    // 先按确定性选择判定，不打开非 direct 通道（避免 hosted claim 副作用）。
    const selected = selectChannelCandidate(profile);
    if (selected === null || selected.kind !== "a2a-direct") {
      return this.required(
        negotiationId,
        `recovery requires an a2a-direct channel (selected ${selected?.kind ?? "none"})`,
        hwm,
        phase,
      );
    }

    let handle: ChannelHandle;
    try {
      handle = await this.makeChannel(profile, {
        negotiation_id: negotiationId,
        sender_identity: senderIdentity,
        identity: profile.identity,
        remote: { context_id: contextId, task_id: activeTaskId },
      });
    } catch (err) {
      return this.required(negotiationId, `channel open failed: ${errMsg(err)}`, hwm, phase);
    }
    // 防御性兜底：注入的 openChannel 若返回非 direct handle 仍 fail-closed。
    if (handle.kind !== "a2a-direct") {
      return this.required(
        negotiationId,
        `recovery requires an a2a-direct channel (opened ${handle.kind})`,
        hwm,
        phase,
      );
    }

    // 4. Re-fetch remote task state。
    let view: { task: A2ATask | null; message_ids: string[] } = { task: null, message_ids: [] };
    let validatedEnvelopes = new Map<string, NegotiationEnvelope>();
    if (activeTaskId !== undefined) {
      let state: RemoteState;
      try {
        state = await handle.getState({
          negotiation_id: negotiationId,
          context_id: contextId,
          task_id: activeTaskId,
        });
      } catch (err) {
        this.deps.log?.(`recovery getState(${activeTaskId}) failed`, err);
        return this.required(negotiationId, `remote task unreachable: ${errMsg(err)}`, hwm, phase);
      }
      const task = state.task;
      if (task !== undefined && task.status.state === "unknown") {
        return this.required(negotiationId, "remote task state is unknown (fail-closed)", hwm, phase);
      }
      if (task !== undefined) {
        try {
          validatedEnvelopes = extractValidatedEnvelopes(task);
        } catch (err) {
          return this.required(
            negotiationId,
            `remote task content failed validation: ${errMsg(err)}`,
            hwm,
            phase,
          );
        }
      }
      view = this.toView(state);
    }

    // 5. Compare acknowledged messages。
    const remoteIds = new Set(view.message_ids);
    const acknowledged = acknowledgedMessageIds(view.task);
    const localIds = new Set(
      events.filter((e) => e.message_id !== undefined).map((e) => e.message_id as string),
    );
    const remoteAhead = [...remoteIds].filter((id) => !localIds.has(id));
    // 审查 P3：pending = 本地出站 id 未被远端确认——确认 = 远端消息 id 相等
    // 或远端回包 in_reply_to 指向它（此前只比 id，恒 pending，重放证据逻辑退化）。
    const pending = localSent.filter(
      (entry) => !remoteIds.has(entry.message_id) && !acknowledged.has(entry.message_id),
    );

    // 6. Reconcile。
    // 6a. remote ahead：fetch → validate（已做）→ append Ledger。
    let appended = 0;
    for (const mid of remoteAhead) {
      if (ledger.findByMessageId(mid) !== null) continue;
      const envelope = validatedEnvelopes.get(mid);
      try {
        ledger.append(
          this.reconciliationContent(negotiationId, profile, {
            message_id: mid,
            remote_context_id: contextId,
            remote_task_id: activeTaskId,
            wire_payload: envelope === undefined ? undefined : (envelope as unknown as Record<string, unknown>),
            outcome: {
              kind: "ok",
              result: {
                remote_ahead_message_id: mid,
                remote_state: view.task?.status.state,
              },
            },
            occurred_at: now,
          }),
        );
        appended += 1;
      } catch (err) {
        return this.required(
          negotiationId,
          `failed to append remote-ahead reconciliation: ${errMsg(err)}`,
          hwm,
          phase,
          view.task?.status.state,
        );
      }
    }

    // 6b. local pending：同 message_id + 同 digest → 安全幂等重放；否则转人工。
    if (pending.length > 0 && contextId === undefined && activeTaskId === undefined) {
      return this.required(
        negotiationId,
        "local pending messages but no remote context/task anchor to continue",
        hwm,
        phase,
      );
    }
    const replayed: string[] = [];
    for (const entry of pending) {
      // 幂等守卫：先前一次恢复已重放过该消息（reconciliation 事件记录了
      // replayed_message_id），不再重复发送、不再重复落账。
      if (hasReplayEvidence(events, entry.message_id)) {
        replayed.push(entry.message_id);
        continue;
      }
      const remoteState = view.task?.status.state;
      if (remoteState !== undefined && isTerminalTaskStateValue(remoteState)) {
        return this.required(
          negotiationId,
          `local message ${entry.message_id} pending but remote task is terminal (${remoteState})`,
          hwm,
          phase,
          remoteState,
        );
      }
      // 同 id + 同 digest 校验：重算 envelope digest 与存储的 wire_digest 一致。
      const digestOk =
        entry.wire_digest !== undefined &&
        entry.wire_payload !== undefined &&
        (entry.wire_payload as Record<string, unknown>)["message_id"] === entry.message_id &&
        computeEnvelopeDigest(entry.wire_payload) === entry.wire_digest;
      if (!digestOk) {
        return this.required(
          negotiationId,
          `local message ${entry.message_id} cannot be verified for safe replay (missing/conflicting digest)`,
          hwm,
          phase,
        );
      }

      const envelope = entry.wire_payload as unknown as NegotiationEnvelope;
      const ref = {
        negotiation_id: negotiationId,
        context_id: contextId,
        task_id: activeTaskId,
      };
      try {
        const result = await handle.send({ envelope, ref });
        replayed.push(entry.message_id);
        ledger.append(
          this.reconciliationContent(negotiationId, profile, {
            message_id: entry.message_id,
            remote_context_id: contextId,
            remote_task_id: activeTaskId,
            outcome: { kind: "ok", result: { replayed_message_id: entry.message_id } },
            occurred_at: now,
          }),
        );
        // 重放响应可能携带远端新信息（如 counter）：补记 remote ahead。
        if (result.task !== undefined) {
          const replyState: RemoteState = {
            channel: "a2a-direct",
            state: result.task.status.state,
            stable: true,
            task: result.task,
            message_ids:
              result.task.status.message?.messageId === undefined
                ? []
                : [result.task.status.message.messageId],
            observed_at: now,
          };
          const replyView = this.toView(replyState);
          for (const mid of replyView.message_ids) {
            if (localIds.has(mid) || ledger.findByMessageId(mid) !== null) continue;
            ledger.append(
              this.reconciliationContent(negotiationId, profile, {
                message_id: mid,
                remote_context_id: contextId,
                remote_task_id: result.task?.id,
                outcome: {
                  kind: "ok",
                  result: { remote_ahead_message_id: mid, remote_state: result.task?.status.state },
                },
                occurred_at: now,
              }),
            );
            appended += 1;
          }
        }
      } catch (err) {
        return this.required(
          negotiationId,
          `safe replay of ${entry.message_id} failed: ${errMsg(err)}`,
          hwm,
          phase,
        );
      }
    }

    // 本地终态 vs 远端活跃：矛盾，不可调和。
    const remoteState = view.task?.status.state;
    if (isTerminalPhase(phase) && remoteState !== undefined && !isTerminalTaskStateValue(remoteState)) {
      return this.required(
        negotiationId,
        `local phase ${phase} is terminal but remote task is still ${remoteState}`,
        hwm,
        phase,
        remoteState,
      );
    }

    // 7. Expire stale candidates/approvals：远端 revision 变化 → 本地出站消息置 stale。
    const stale: string[] = [];
    const revisionChanged =
      localTaskState !== undefined && remoteState !== undefined && localTaskState !== remoteState;
    if (revisionChanged) {
      for (const entry of localSent) stale.push(entry.message_id);
    }
    if (this.deps.expireStale !== undefined && stale.length > 0) {
      try {
        await this.deps.expireStale(negotiationId, stale);
      } catch (err) {
        return this.required(
          negotiationId,
          `expireStale failed: ${errMsg(err)}`,
          hwm,
          phase,
          remoteState,
        );
      }
    }

    // 8. Resume。
    return this.resumed(
      negotiationId,
      hwm,
      phase,
      remoteState,
      replayed,
      appended,
      stale,
      taskIds,
    );
  }

  private resumed(
    negotiationId: string,
    hwm: LedgerHighWaterMark,
    phase?: NegotiationPhase,
    remoteState?: A2ATaskState,
    replayed: string[] = [],
    appended = 0,
    stale: string[] = [],
    resumeTaskIds: string[] = [],
  ): RecoveryResult {
    return {
      status: "resumed",
      negotiation_id: negotiationId,
      replayed_message_ids: replayed,
      remote_ahead_appended: appended,
      stale_message_ids: stale,
      resume_task_ids: resumeTaskIds,
      phase,
      remote_state: remoteState,
      high_water_mark: hwm,
    };
  }
}

function isTerminalTaskStateValue(value: A2ATaskState): boolean {
  return value === "completed" || value === "canceled" || value === "failed";
}

/** 该消息是否已有成功重放的 reconciliation 证据（幂等守卫）。 */
function hasReplayEvidence(events: LedgerEvent[], messageId: string): boolean {
  for (const event of events) {
    if (event.event_kind !== "reconciliation" || event.outcome.kind !== "ok") continue;
    const result = event.outcome.result;
    if (result === undefined || typeof result !== "object") continue;
    if ((result as Record<string, unknown>)["replayed_message_id"] === messageId) return true;
  }
  return false;
}

/** Ledger 无法读取时的占位高水位（恢复第一步 fail-closed 用）。 */
function emptyHwm(negotiationId: string): LedgerHighWaterMark {
  return {
    negotiation_id: negotiationId,
    count: 0,
    last_event_id: null,
    last_event_digest: null,
    last_recorded_at: null,
  };
}
