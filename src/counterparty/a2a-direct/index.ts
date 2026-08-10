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
 * A2ADirectChannel — 直接 A2A 通道（基线 §5 / §24 Direct Reliability）。
 *
 * 基于 A2AClient + A2ATaskPoller + Ledger/Idempotency：
 *
 *   - send      走 `message/send`，KNP envelope 入 Data Part 的 `knp_envelope` 键
 *               （§24.3 约定）；出站前校验 envelope 并 verify digest（fail-closed）；
 *               send 前协议幂等 check（§20），成功后 Ledger 落 message_sent 证据、
 *               幂等 commit。
 *   - getState  走 `tasks/get`；task_state 观察落 Ledger（system 事件）。
 *   - subscribe 用轮询实现（A2ATaskPoller）：状态变化发 RemoteEvent。
 *   - close     停止订阅、标记已关闭。
 *
 * Direct 可靠性模型（§24）：只使用 A2A Message / Task / Subscribe/Poll /
 * message idempotency / Ledger / reconciliation。**不伪造** claim/heartbeat
 * （那是 hosted 通道内部机制）。任何失败抛 ChannelError，绝不自动降级到
 * 权限更宽的通道（不变量 21）。
 */

import { A2AClient, A2AClientError } from "../../a2a/client/index.js";
import type { A2AMessage, A2ATask } from "../../a2a/client/index.js";
import { A2ATaskPoller, recordTaskObservation } from "../../a2a/task/index.js";
import { validateEnvelope, verifyEnvelopeDigest } from "../../negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../../negotiation/domain/envelope.js";
import type { IdempotencyStore } from "../../negotiation/idempotency/index.js";
import type { FileLeaseStore } from "../../negotiation/lease/store.js";
import { randomUUID as cryptoRandomUUID } from "node:crypto";
import type {
  LedgerCapabilitySnapshot,
  LedgerIdentitySnapshot,
  LedgerStore,
} from "../../negotiation/ledger/index.js";
import {
  ChannelError,
  type ChannelEventHandler,
  type ChannelHandle,
  type ChannelOpenInput,
  type ChannelSendInput,
  type ChannelSendResult,
  type CounterpartyChannel,
  type RemoteRef,
  type RemoteState,
  isStableTaskState,
} from "../channel.js";

/** 审查 BUG-07：出站 send 临界区租约 TTL（毫秒）——覆盖一次典型 HTTP send。 */
const OUTBOUND_LEASE_TTL_MS = 30_000;

export interface A2ADirectChannelOptions {
  /** 远端 A2A endpoint URL（capability intersection 选中）。 */
  url: string;
  ledger?: LedgerStore;
  idempotency?: IdempotencyStore;
  now?: () => string;
  /** 注入 fetch（测试用）；透传给 A2AClient。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 透传 A2AClient 的 SSRF 选项（测试/本机直连）。 */
  allowPrivateRanges?: boolean;
  /** 全临界区 ownership 租约（审查 BUG-07）：共享持久目录时提供——并发
   *  direct send 同 key 只允许一个 owner 执行（check→HTTP→ledger→commit）。 */
  lease?: FileLeaseStore;
  skipDnsCheck?: boolean;
  resolveIp?: (hostname: string) => Promise<string[]>;
}

const DIRECT_CAPABILITY: LedgerCapabilitySnapshot = {
  capability: "knp.a2a.direct",
  protocol_version: "1.0",
};

export class A2ADirectChannel implements CounterpartyChannel {
  readonly kind = "a2a-direct" as const;
  private readonly client: A2AClient;
  private readonly ledger?: LedgerStore;
  private readonly idempotency?: IdempotencyStore;
  private readonly lease?: FileLeaseStore;
  private readonly now: () => string;

  constructor(options: A2ADirectChannelOptions) {
    this.client = new A2AClient({
      url: options.url,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
      allowPrivateRanges: options.allowPrivateRanges,
      skipDnsCheck: options.skipDnsCheck,
      resolveIp: options.resolveIp,
    });
    this.ledger = options.ledger;
    this.idempotency = options.idempotency;
    this.lease = options.lease;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async open(input: ChannelOpenInput): Promise<ChannelHandle> {
    return new A2ADirectHandle({
      client: this.client,
      ledger: this.ledger,
      idempotency: this.idempotency,
      ...(this.lease !== undefined ? { lease: this.lease } : {}),
      now: this.now,
      negotiationId: input.negotiation_id,
      senderIdentity: input.sender_identity,
      identity: input.identity,
      openRemote: input.remote ?? {},
    });
  }
}

interface A2ADirectHandleDeps {
  client: A2AClient;
  ledger?: LedgerStore;
  idempotency?: IdempotencyStore;
  /** 审查 BUG-07：全临界区租约（透传自 channel options）。 */
  lease?: FileLeaseStore;
  now: () => string;
  negotiationId: string;
  senderIdentity: string;
  identity: string;
  openRemote: { context_id?: string; task_id?: string };
}

class A2ADirectHandle implements ChannelHandle {
  readonly kind = "a2a-direct" as const;
  readonly identity: string;
  private readonly deps: A2ADirectHandleDeps;
  private readonly identitySnapshot: LedgerIdentitySnapshot;
  private closed = false;
  private readonly subscriptions = new Set<() => void | Promise<void>>();

  constructor(deps: A2ADirectHandleDeps) {
    this.deps = deps;
    this.identity = deps.identity;
    this.identitySnapshot = {
      sender_identity: deps.senderIdentity,
      counterparty_identity: deps.identity,
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ChannelError("a2a-direct", "channel_closed", "a2a-direct channel is closed");
    }
  }

  private refOf(ref?: RemoteRef): RemoteRef {
    return {
      negotiation_id: this.deps.negotiationId,
      context_id: ref?.context_id ?? this.deps.openRemote.context_id,
      task_id: ref?.task_id ?? this.deps.openRemote.task_id,
    };
  }

  private envelopeToMessage(envelope: NegotiationEnvelope, ref: RemoteRef): A2AMessage {
    const message: A2AMessage = {
      role: "agent",
      parts: [{ kind: "data", data: { knp_envelope: envelope as unknown as Record<string, unknown> } }],
      messageId: envelope.message_id,
    };
    if (ref.context_id !== undefined) message.contextId = ref.context_id;
    if (ref.task_id !== undefined) message.taskId = ref.task_id;
    return message;
  }

  private toRemoteState(task: A2ATask): RemoteState {
    const messageIds = task.status.message?.messageId === undefined ? [] : [task.status.message.messageId];
    return {
      channel: "a2a-direct",
      state: task.status.state,
      stable: isStableTaskState(task.status.state),
      task,
      message_ids: messageIds,
      observed_at: this.deps.now(),
    };
  }

  private toChannelError(err: unknown): ChannelError {
    if (err instanceof ChannelError) return err;
    if (err instanceof A2AClientError) {
      return new ChannelError("a2a-direct", "send_failed", `A2A client error: ${err.message}`);
    }
    return new ChannelError("a2a-direct", "send_failed", err instanceof Error ? err.message : String(err));
  }

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    this.assertOpen();
    const envelope = input.envelope;
    // 出站校验 fail-closed（§4.6）：envelope schema + digest 一致性，绝不发送坏消息。
    try {
      validateEnvelope(envelope);
    } catch (err) {
      throw new ChannelError(
        "a2a-direct",
        "invalid_envelope",
        `KNP envelope failed validation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!verifyEnvelopeDigest(envelope)) {
      throw new ChannelError("a2a-direct", "invalid_envelope", "KNP envelope digest mismatch (integrity failure)");
    }

    const ref = this.refOf(input.ref);
    const message = this.envelopeToMessage(envelope, ref);

    // 审查 BUG-07：全临界区 ownership 租约——幂等 check→HTTP 发送→ledger→
    // commit 之间，同 key 并发（同进程异步或共享目录跨进程）会产生两次远端
    // 调用（commit 阶段的冲突检测已无法撤销前面的副作用）。文件租约（TTL +
    // 崩溃接管）覆盖整段，第二个并发 send fail-closed。
    const leaseKey = `${this.deps.senderIdentity}:${envelope.message_id}`;
    const leaseOwner = `${process.pid}:${cryptoRandomUUID()}`;
    if (this.deps.lease !== undefined && !this.deps.lease.acquire(leaseKey, leaseOwner, OUTBOUND_LEASE_TTL_MS)) {
      throw new ChannelError(
        "a2a-direct",
        "idempotency_conflict",
        `message_id ${envelope.message_id} send already in progress by another owner`,
      );
    }
    try {
      return await this.sendUnlocked(input, envelope, message, ref);
    } finally {
      this.deps.lease?.release(leaseKey, leaseOwner);
    }
  }

  /** 临界区主体（租约持有期间执行；见 send 的 BUG-07 注释）。 */
  private async sendUnlocked(
    input: ChannelSendInput,
    envelope: NegotiationEnvelope,
    message: A2AMessage,
    ref: RemoteRef,
  ): Promise<ChannelSendResult> {
    // 协议幂等 check（§20）：(sender_identity, message_id)。
    if (this.deps.idempotency !== undefined) {
      const decision = this.deps.idempotency.check({
        sender_identity: this.deps.senderIdentity,
        message_id: envelope.message_id,
        digest: envelope.digest,
      });
      if (decision.status === "conflict") {
        throw new ChannelError(
          "a2a-direct",
          "idempotency_conflict",
          `message_id ${envelope.message_id} already processed with a different digest (§20.3)`,
        );
      }
      if (decision.status === "replayed") {
        const result = decision.record.outcome.kind === "ok" ? decision.record.outcome.result : undefined;
        return {
          channel: "a2a-direct",
          ref: this.refOf(input.ref),
          task: this.replayTask(result),
          replayed: true,
        };
      }
    }

    let task: A2ATask;
    try {
      task = await this.deps.client.sendMessage(message, ref.context_id);
    } catch (err) {
      throw this.toChannelError(err);
    }

    // 出站落账（§22 / §23：message_sent 证据，含 wire_digest + wire_payload）。
    if (this.deps.ledger !== undefined) {
      this.deps.ledger.append({
        event_kind: "message_sent",
        negotiation_id: this.deps.negotiationId,
        exchange_id: envelope.exchange_id,
        message_id: envelope.message_id,
        in_reply_to: envelope.in_reply_to,
        remote_context_id: task.contextId ?? ref.context_id,
        remote_task_id: task.id,
        identity: { ...this.identitySnapshot, actor: envelope.actor },
        capability: {
          capability: envelope.capability,
          protocol_version: envelope.protocol_version,
        },
        wire_digest: envelope.digest,
        wire_payload: envelope as unknown as Record<string, unknown>,
        outcome: { kind: "ok" },
        occurred_at: this.deps.now(),
      });
    }

    // 幂等 commit（§20）。
    if (this.deps.idempotency !== undefined) {
      this.deps.idempotency.commit({
        sender_identity: this.deps.senderIdentity,
        message_id: envelope.message_id,
        digest: envelope.digest,
        negotiation_id: this.deps.negotiationId,
        outcome: { kind: "ok", result: { task } },
      });
    }

    const resultRef: RemoteRef = {
      negotiation_id: this.deps.negotiationId,
      context_id: task.contextId ?? ref.context_id,
      task_id: task.id,
    };
    return { channel: "a2a-direct", ref: resultRef, task };
  }

  /** 幂等重放：从记录结果还原 task（部分字段可能缺省，不伪造）。 */
  private replayTask(result: unknown): A2ATask | undefined {
    if (result === undefined || typeof result !== "object") return undefined;
    const rec = result as Record<string, unknown>;
    const stored = rec["task"];
    if (stored === undefined || typeof stored !== "object") return undefined;
    const t = stored as Record<string, unknown>;
    if (typeof t.id !== "string" || t.status === null || typeof t.status !== "object") return undefined;
    return t as unknown as A2ATask;
  }

  async getState(ref: RemoteRef): Promise<RemoteState> {
    this.assertOpen();
    const taskId = ref.task_id;
    if (taskId === undefined) {
      throw new ChannelError("a2a-direct", "get_state_failed", "getState requires ref.task_id for a2a-direct");
    }
    let task: A2ATask;
    try {
      task = await this.deps.client.getTask(taskId);
    } catch (err) {
      throw this.toChannelError(err);
    }
    if (this.deps.ledger !== undefined) {
      recordTaskObservation({
        ledger: this.deps.ledger,
        negotiation_id: this.deps.negotiationId,
        task_id: task.id,
        task_state: task.status.state,
        context_id: task.contextId ?? ref.context_id,
        message_id: task.status.message?.messageId,
        identity: this.identitySnapshot,
        capability: DIRECT_CAPABILITY,
        occurred_at: this.deps.now(),
      });
    }
    return this.toRemoteState(task);
  }

  async subscribe(ref: RemoteRef, handler: ChannelEventHandler): Promise<() => void | Promise<void>> {
    this.assertOpen();
    const taskId = ref.task_id;
    if (taskId === undefined) {
      throw new ChannelError("a2a-direct", "get_state_failed", "subscribe requires ref.task_id for a2a-direct");
    }
    let stopped = false;
    const poller = new A2ATaskPoller({
      client: { getTask: (id) => this.deps.client.getTask(id) },
      taskId,
      contextId: ref.context_id ?? this.deps.openRemote.context_id,
      ...(this.deps.ledger !== undefined
        ? {
            ledger: {
              ledger: this.deps.ledger,
              negotiation_id: this.deps.negotiationId,
              identity: this.identitySnapshot,
              capability: DIRECT_CAPABILITY,
            },
          }
        : {}),
      onStateChanged: (info) =>
        handler({
          channel: "a2a-direct",
          kind: "state_changed",
          ref: this.refOf(ref),
          state: this.toRemoteState(info.task),
        }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.parse(this.deps.now()),
    });

    const stop = (): void => {
      stopped = true;
    };
    this.subscriptions.add(stop);

    const run = async (): Promise<void> => {
      try {
        while (!stopped) {
          const result = await poller.poll();
          // 状态变化事件由 poller.onStateChanged 转发（每次 task_state 变化恰好一次）。
          if (result.status === "rejected") {
            await handler({
              channel: "a2a-direct",
              kind: "error",
              ref: this.refOf(ref),
              error: new ChannelError(
                "a2a-direct",
                "get_state_failed",
                result.reason ?? `poll rejected: ${result.lastError instanceof Error ? result.lastError.message : String(result.lastError)}`,
              ),
            });
            break;
          }
          if (result.status === "timeout" || result.status === "budget_exhausted") {
            await handler({
              channel: "a2a-direct",
              kind: "error",
              ref: this.refOf(ref),
              error: new ChannelError("a2a-direct", "get_state_failed", `poll ended: ${result.status}`),
            });
            break;
          }
          if (result.status === "input-required") continue;
          // terminal（completed/canceled/failed）→ 结束轮询。
          break;
        }
      } finally {
        this.subscriptions.delete(stop);
      }
    };
    void run();
    return stop;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const stop of this.subscriptions) await stop();
    this.subscriptions.clear();
  }
}
