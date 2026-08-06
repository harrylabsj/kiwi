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
 * 出站消息证据落账（基线 §23 / 子规范 §27、§28）。
 *
 * 恢复第 5 步「compare acknowledged messages」需要知道本地发过哪些消息、其
 * wire digest 与 wire payload。KNP 出站路径（后续 WP 接线）在发送前调用
 * recordOutboundMessage 落一条 message_sent 事件；恢复时据此：
 *
 *   - 同 message_id + 同 digest → 安全幂等重放（§20 / §23 local pending）；
 *   - 同 message_id + 异 digest → 不可调和（idempotency_conflict，fail-closed）。
 *
 * 该事件是审计证据：wire_payload 保存发送时的 KNP envelope（不含 transport
 * signature），digest 可重算核对。不保存 raw chain-of-thought（§28 禁词由
 * LedgerStore.append 强制）。
 */

import type { LedgerStore, LedgerEvent, LedgerEventContent } from "../ledger/index.js";
import type {
  LedgerCapabilitySnapshot,
  LedgerIdentitySnapshot,
} from "../ledger/index.js";

export interface OutboundMessageInput {
  ledger: LedgerStore;
  negotiation_id: string;
  exchange_id?: string;
  message_id: string;
  /** KNP envelope digest（§19.2）。 */
  wire_digest: string;
  /** 发送时的 KNP envelope（未含 digest 的字段亦可；digest 由 wire_digest 记录）。 */
  wire_payload: Record<string, unknown>;
  /** 远端 A2A contextId（opaque）。 */
  remote_context_id?: string;
  remote_task_id?: string;
  identity: LedgerIdentitySnapshot;
  capability: LedgerCapabilitySnapshot;
  occurred_at: string;
}

/** 落一条 message_sent 事件；返回完整 Ledger 事件（含 digest / 链指针）。 */
export function recordOutboundMessage(input: OutboundMessageInput): LedgerEvent {
  const content: LedgerEventContent = {
    event_kind: "message_sent",
    negotiation_id: input.negotiation_id,
    exchange_id: input.exchange_id,
    message_id: input.message_id,
    remote_context_id: input.remote_context_id,
    remote_task_id: input.remote_task_id,
    identity: input.identity,
    capability: input.capability,
    wire_digest: input.wire_digest,
    wire_payload: input.wire_payload,
    outcome: { kind: "ok" },
    occurred_at: input.occurred_at,
  };
  return input.ledger.append(content);
}
