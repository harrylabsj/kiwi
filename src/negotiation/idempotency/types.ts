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
 * 协议级幂等模型（基线 §17 / 子规范 §20 Idempotency and Replay）。
 *
 * 主键 (sender_identity, message_id)：
 * - same id + same digest  → 不得重复执行业务效果，返回原结果或等价 ack（§20.2）；
 * - same id + different digest → idempotency_conflict，fail-closed，绝不应用新 payload
 *   （§20.3）。
 *
 * retention（§20.5 / 基线 §17）：至少覆盖
 *   max(offer validity, task lifetime, 24 hours)。
 * 参考实现以 24h 为地板，配合调用方给出的 offer_valid_until / task_lifetime_until
 * 计算过期时间；过期后按「新消息」处理（允许再次进入状态校验）。
 *
 * 与 Ledger 的关系：幂等索引可独立存储，但判定证据落 Ledger —— 每次 commit 都应
 * 携带对应的 ledger_event_id / ledger_event_digest，审计可交叉验证（§22）。
 */

/** 幂等记录：一次 (sender_identity, message_id) 的处理事实。 */
export interface IdempotencyRecord {
  sender_identity: string;
  message_id: string;
  /** wire digest（KNP envelope digest，§19.2）。replay 时必须逐字节一致。 */
  digest: string;
  negotiation_id: string;
  /** 原处理结果：成功（可带结构化 result）或协议错误（code 对齐 §18 词表）。 */
  outcome: { kind: "ok"; result?: unknown } | { kind: "error"; code: string; message: string };
  /** 判定证据的 Ledger 事件引用（§22：判定证据落 Ledger）。 */
  ledger_event_id?: string;
  ledger_event_digest?: string;
  /** 首处理时间（RFC 3339）。 */
  recorded_at: string;
  /** retention 截止（RFC 3339）；sweep 只清理 expires_at <= now 的记录。 */
  expires_at: string;
}

export type IdempotencyDecision =
  | { status: "new"; key: string }
  | { status: "replayed"; key: string; record: IdempotencyRecord }
  | { status: "conflict"; key: string; record: IdempotencyRecord };

export interface IdempotencyCheckInput {
  sender_identity: string;
  message_id: string;
  digest: string;
}

/** commit 的完整输入：除了持久化字段，还带 retention 计算所需的时限。 */
export interface IdempotencyCommitInput extends IdempotencyCheckInput {
  negotiation_id: string;
  outcome: IdempotencyRecord["outcome"];
  ledger_event_id?: string;
  ledger_event_digest?: string;
  retention?: RetentionInput;
}

/** retention 时限提示；offer_valid_until / task_lifetime_until 均优先于 24h 地板。 */
export interface RetentionInput {
  /** 仍有效的 offer 截止（RFC 3339），即 offer terms 的 valid_until。 */
  offer_valid_until?: string;
  /** A2A task 生命周期截止（RFC 3339）。 */
  task_lifetime_until?: string;
}

/** 幂等键：null 字节分隔，避免 (a, b) 与 (ab, "") 之类碰撞。 */
export function idempotencyKey(senderIdentity: string, messageId: string): string {
  return `${senderIdentity}\u0000${messageId}`;
}

/** 24 小时 retention 地板（基线 §17 / 子规范 §20.5）。 */
export const IDEMPOTENCY_FLOOR_MS = 24 * 60 * 60 * 1000;

/**
 * 计算过期截止 = max(now + 24h, offer_valid_until, task_lifetime_until)。
 * 无效/过去的时限自动被地板覆盖。
 */
export function computeRetentionDeadline(now: Date, input: RetentionInput = {}): Date {
  let deadline = now.getTime() + IDEMPOTENCY_FLOOR_MS;
  for (const iso of [input.offer_valid_until, input.task_lifetime_until]) {
    if (iso === undefined) continue;
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && t > deadline) deadline = t;
  }
  return new Date(deadline);
}

/** same id + different digest → idempotency_conflict（§20.3 / §18 词表）。 */
export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_conflict" as const;
  readonly record: IdempotencyRecord;
  constructor(record: IdempotencyRecord, digest: string) {
    super(
      `idempotency_conflict: (${record.sender_identity}, ${record.message_id}) already processed with digest ${record.digest}, got ${digest}`,
    );
    this.name = "IdempotencyConflictError";
    this.record = record;
  }
}
