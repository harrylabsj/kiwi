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
 * ShoppingCliHostedChannel — 包装现有 commerce client 的 hosted 通道
 * （基线 §5 / §24 Hosted Reliability / §21 Authority Model）。
 *
 * 边界（§24）：
 *   - claim / heartbeat / complete / fail / abandon 是**通道内部机制**，
 *     不暴露到 CounterpartyChannel 接口；上层只看到 send/getState/subscribe/close。
 *   - 不伪造 A2A claim/heartbeat 语义——它们是 shopping-cli 权威生命周期的一部分。
 *
 * 生命周期（对齐 runtime/negotiation-turn.ts）：
 *   - open    内部 claim 待处理消息（消息未绑定 claim 时 open 仍可成功，send 前再 claim）；
 *   - getState 返回 shopping-cli 权威快照（§21：authoritative snapshot >
 *            local cache > reasoning state）；claim 存活期内可读；
 *   - send    KNP→legacy 转译（LegacyNegotiationAdapter，§35：lossless→translate，
 *            lossy→fail closed，unsupported→human/fallback）→ submitNegotiationDecision
 *            → 按 PolicyResult 结算 claim（accepted/human_required→complete；
 *            rejected_retryable→fail 可重claim）；
 *   - subscribe 轮询 + heartbeat 保持 claim 存活，会话状态变化发 RemoteEvent；
 *   - close   未结算的 claim 转 abandon（release，可被其他 worker 重claim）。
 *
 * 任何失败抛 ChannelError，绝不自动降级到其他通道（不变量 21）。
 */

import { CommerceError, idempotencyKey } from "../../commerce/types.js";
import type { ClaimResult, CommerceClient, ProcessResult } from "../../commerce/types.js";
import type { PolicyResult } from "../../negotiation/types.js";
import { LegacyNegotiationAdapter } from "../../protocol/legacy-shopping-negotiation/adapter.js";
import { legacyMessageIdToKnp } from "../../protocol/legacy-shopping-negotiation/mapping.js";
import { PROTOCOL_VERSION, type NegotiationSnapshot } from "../../negotiation/types.js";
import type { LedgerStore } from "../../negotiation/ledger/index.js";
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
} from "../channel.js";

export interface ShoppingCliHostedChannelOptions {
  /** shopping-cli 客户端（HttpCommerceClient / FakeCommerceClient）。 */
  client: CommerceClient;
  ledger?: LedgerStore;
  now?: () => string;
  /** 本方 agent 标识（幂等键前缀）；缺省 "kiwi.hosted"。 */
  agentId?: string;
}

const HOSTED_CAPABILITY = { capability: "shopping.negotiation.hosted", protocol_version: "0.1" } as const;

/** 会话状态 → 稳定观察点判定（终态或等待输入）。 */
function isStableConversationStatus(status: string): boolean {
  return status === "human_required" || status === "closed";
}

export class ShoppingCliHostedChannel implements CounterpartyChannel {
  readonly kind = "shopping-cli-hosted" as const;
  private readonly client: CommerceClient;
  private readonly ledger?: LedgerStore;
  private readonly now: () => string;
  private readonly agentId: string;
  private readonly adapter = new LegacyNegotiationAdapter();

  constructor(options: ShoppingCliHostedChannelOptions) {
    this.client = options.client;
    this.ledger = options.ledger;
    this.now = options.now ?? (() => new Date().toISOString());
    this.agentId = options.agentId ?? "kiwi.hosted";
  }

  async open(input: ChannelOpenInput): Promise<ChannelHandle> {
    const handle = new ShoppingCliHostedHandle({
      client: this.client,
      ledger: this.ledger,
      now: this.now,
      agentId: this.agentId,
      adapter: this.adapter,
      negotiationId: input.negotiation_id,
      senderIdentity: input.sender_identity,
      identity: input.identity,
      openConversationId: input.remote?.conversation_id,
      openMessageId: input.remote?.message_id,
    });
    await handle.acquireClaim();
    return handle;
  }
}

interface ShoppingCliHostedHandleDeps {
  client: CommerceClient;
  ledger?: LedgerStore;
  now: () => string;
  agentId: string;
  adapter: LegacyNegotiationAdapter;
  negotiationId: string;
  senderIdentity: string;
  identity: string;
  openConversationId?: string;
  openMessageId?: number;
}

class ShoppingCliHostedHandle implements ChannelHandle {
  readonly kind = "shopping-cli-hosted" as const;
  readonly identity: string;
  private readonly deps: ShoppingCliHostedHandleDeps;
  private closed = false;
  private readonly subscriptions = new Set<() => void | Promise<void>>();
  private claimHeld = false;
  private settled = false;

  constructor(deps: ShoppingCliHostedHandleDeps) {
    this.deps = deps;
    this.identity = deps.identity;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ChannelError("shopping-cli-hosted", "channel_closed", "shopping-cli-hosted channel is closed");
    }
  }

  /** ref 解析：调用方 ref 优先，回落 open 绑定的会话/消息。 */
  private refOf(ref?: RemoteRef): { conversation_id: string; message_id: number } {
    const conversationId = ref?.conversation_id ?? this.deps.openConversationId;
    const messageId = ref?.message_id ?? this.deps.openMessageId;
    if (conversationId === undefined || messageId === undefined) {
      throw new ChannelError(
        "shopping-cli-hosted",
        "send_failed",
        "shopping-cli-hosted requires conversation_id + message_id in ref",
      );
    }
    return { conversation_id: conversationId, message_id: messageId };
  }

  private toChannelError(err: unknown): ChannelError {
    if (err instanceof ChannelError) return err;
    if (err instanceof CommerceError) {
      return new ChannelError(
        "shopping-cli-hosted",
        "send_failed",
        `commerce client error (${err.kind}): ${err.message}`,
      );
    }
    return new ChannelError("shopping-cli-hosted", "send_failed", err instanceof Error ? err.message : String(err));
  }

  private claimKey(messageId: number): string {
    return idempotencyKey(this.deps.agentId, messageId, PROTOCOL_VERSION);
  }

  /** 内部 claim（§24，open/send 时触发）：失败/不可 claim → 抛 ChannelError。 */
  private async claim(conversation_id: string, message_id: number): Promise<ClaimResult> {
    const result = await this.deps.client.claimMessage({
      conversation_id,
      message_id,
      idempotency_key: this.claimKey(message_id),
    });
    if (!result.claimed) {
      throw new ChannelError(
        "shopping-cli-hosted",
        "send_failed",
        `claim denied for message ${message_id} (status ${result.status})`,
      );
    }
    return result;
  }

  /** open 时获取 claim（内部机制）；无会话锚点时不强制。 */
  async acquireClaim(): Promise<void> {
    if (this.deps.openConversationId === undefined || this.deps.openMessageId === undefined) {
      return;
    }
    await this.claim(this.deps.openConversationId, this.deps.openMessageId);
    this.claimHeld = true;
  }

  /** 内部结算：accepted/human_required → complete；rejected_retryable → fail（可重claim）。 */
  private async settleClaim(message_id: number, result: PolicyResult): Promise<ProcessResult> {
    if (result.result === "accepted" || result.result === "human_required") {
      return this.deps.client.completeClaim({
        message_id,
        idempotency_key: this.claimKey(message_id),
      });
    }
    return this.deps.client.failClaim({
      message_id,
      idempotency_key: this.claimKey(message_id),
      error: `policy rejected: ${result.public_reason}`,
    });
  }

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    this.assertOpen();
    const envelope = input.envelope;
    const { conversation_id, message_id } = this.refOf(input.ref);

    // 1. claim（通道内部机制，§24）。open 已持有时不重复 claim（同键重claim返回
    //    claimed=false，会误判为失败）。
    if (!this.claimHeld) {
      try {
        await this.claim(conversation_id, message_id);
        this.claimHeld = true;
      } catch (err) {
        throw this.toChannelError(err);
      }
    }

    // 2. KNP → legacy 转译（§35：lossless→translate，lossy→fail closed，unsupported→human）。
    const translation = this.deps.adapter.envelopeToLegacyDecision(envelope);
    if (!("translated" in translation)) {
      // 受保护语义不可表达：release claim（可重claim），fail-closed。
      const translationError = `translation ${"fail_closed" in translation ? "fail_closed" : "requires_human"}: ${translation.reason}`;
      await this.deps.client
        .failClaim({
          message_id,
          idempotency_key: this.claimKey(message_id),
          error: translationError,
        })
        .catch(() => undefined);
      this.settled = true;
      throw new ChannelError(
        "shopping-cli-hosted",
        "unsupported_action",
        `KNP envelope cannot be expressed in shopping.negotiation/0.1: ${translation.reason}`,
      );
    }
    const decision = translation.translated;

    // 3. 提交决策（policy gate 权威，§21）。
    let policy: PolicyResult;
    try {
      policy = await this.deps.client.submitNegotiationDecision({
        decision,
        idempotency_key: this.claimKey(message_id),
      });
    } catch (err) {
      await this.deps.client
        .failClaim({
          message_id,
          idempotency_key: this.claimKey(message_id),
          error: `submit failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        .catch(() => undefined);
      this.settled = true;
      throw this.toChannelError(err);
    }

    // 4. 结算 claim（内部，§24）。审查 P2-R：completeClaim/failClaim 瞬时
    // 失败不得静默吞掉——此前 .catch(() => undefined) 后照常 settled=true，
    // claim 滞留 processing 直到网关 300s stale TTL（消息被
    // listPendingMessages 隐藏、白等 5 分钟），且 settled=true 让 close()
    // 跳过 abandon 兜底。失败时按 runtime M1 同款模式 best-effort abandon
    //（释放 claim，内容寻址幂等保证重处理无重复效果），保持 settled=false
    // 让 close() 兜底仍生效，然后向外传播原始错误。
    try {
      await this.settleClaim(message_id, policy);
    } catch (err) {
      this.settled = false;
      try {
        await this.deps.client.abandonClaim({
          message_id,
          idempotency_key: this.claimKey(message_id),
          error: `claim settle failed, released: ${err instanceof Error ? err.message : String(err)}`,
        });
      } catch {
        // abandon 也失败：保持 settled=false，close() 再兜底一次
      }
      throw this.toChannelError(err);
    }
    this.settled = true;

    // 5. 出站落账（§22：message_sent 证据）。
    if (this.deps.ledger !== undefined) {
      this.deps.ledger.append({
        event_kind: "message_sent",
        negotiation_id: this.deps.negotiationId,
        message_id: envelope.message_id,
        remote_context_id: conversation_id,
        identity: {
          sender_identity: this.deps.senderIdentity,
          counterparty_identity: this.deps.identity,
          actor: envelope.actor,
        },
        capability: { ...HOSTED_CAPABILITY },
        wire_digest: envelope.digest,
        wire_payload: envelope as unknown as Record<string, unknown>,
        outcome: {
          kind: "ok",
          result: { policy_result: policy.result, message_id: policy.message_id },
        },
        occurred_at: this.deps.now(),
      });
    }

    // ref 指向被 claim 的消息（getState 的权威快照仍以 claim 为锚，§21）。
    const ref: RemoteRef = {
      negotiation_id: this.deps.negotiationId,
      conversation_id,
      message_id,
    };
    return { channel: "shopping-cli-hosted", ref, policy };
  }

  async getState(ref: RemoteRef): Promise<RemoteState> {
    this.assertOpen();
    const { conversation_id, message_id } = this.refOf(ref);
    let snapshot: NegotiationSnapshot;
    try {
      snapshot = await this.deps.client.getNegotiationSnapshot({
        conversation_id,
        message_id,
      });
    } catch (err) {
      throw this.toChannelError(err);
    }

    if (this.deps.ledger !== undefined) {
      this.deps.ledger.append({
        event_kind: "system",
        negotiation_id: this.deps.negotiationId,
        remote_context_id: conversation_id,
        identity: {
          sender_identity: this.deps.senderIdentity,
          counterparty_identity: this.deps.identity,
        },
        capability: { ...HOSTED_CAPABILITY },
        outcome: {
          kind: "ok",
          result: { snapshot_state: snapshot.conversation.status },
        },
        occurred_at: this.deps.now(),
      });
    }

    const messageIds = snapshot.messages
      .map((m) => legacyMessageIdToKnp(m.id))
      .filter((id): id is string => id !== null);
    return {
      channel: "shopping-cli-hosted",
      state: snapshot.conversation.status,
      stable: isStableConversationStatus(snapshot.conversation.status),
      snapshot,
      message_ids: messageIds,
      observed_at: this.deps.now(),
    };
  }

  async subscribe(ref: RemoteRef, handler: ChannelEventHandler): Promise<() => void | Promise<void>> {
    this.assertOpen();
    const { conversation_id, message_id } = this.refOf(ref);
    let stopped = false;

    const stop = (): void => {
      stopped = true;
    };
    this.subscriptions.add(stop);

    const run = async (): Promise<void> => {
      try {
        // 首个 tick 推送当前权威快照（§21）。
        let state = await this.getState({ negotiation_id: this.deps.negotiationId, conversation_id, message_id });
        await handler({
          channel: "shopping-cli-hosted",
          kind: "state_changed",
          ref: { negotiation_id: this.deps.negotiationId, conversation_id, message_id },
          state,
        });
        while (!stopped && !state.stable) {
          // heartbeat 保持 claim 存活（§24 Hosted Reliability，内部机制）。
          await this.deps.client.heartbeat({ message_id }).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 100));
          state = await this.getState({ negotiation_id: this.deps.negotiationId, conversation_id, message_id });
          await handler({
            channel: "shopping-cli-hosted",
            kind: "state_changed",
            ref: { negotiation_id: this.deps.negotiationId, conversation_id, message_id },
            state,
          });
        }
      } catch (err) {
        await handler({
          channel: "shopping-cli-hosted",
          kind: "error",
          ref: { negotiation_id: this.deps.negotiationId, conversation_id, message_id },
          error: this.toChannelError(err),
        });
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
    // 未结算的 claim 转 abandon（release，可被其他 worker 重claim；§16.2 语义）。
    if (this.claimHeld && !this.settled && this.deps.openMessageId !== undefined) {
      await this.deps.client
        .abandonClaim({
          message_id: this.deps.openMessageId,
          idempotency_key: this.claimKey(this.deps.openMessageId),
          error: "hosted channel closed before the claim was settled",
        })
        .catch(() => undefined);
    }
  }
}
