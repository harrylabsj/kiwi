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
 * P1 发送领取/回执/未知结果（设计 §16.3 / C13–C14）。
 *
 * 与持久化的关系由 `DeliveryStore` 抽象；本文件只定义状态迁移，便于用
 * 内存存储做确定性验收。关键不变量：
 * - 同一 stream 只允许一条在途（PENDING 且已领取，或 UNKNOWN 未核对）。
 * - accepted ≠ read；read 必须另有证据。
 * - 发送开始后结果不明进入 UNKNOWN 并阻塞该流，不得换 ID 重做。
 * - 只有渠道明确支持同 ID 幂等恢复且已证实未执行，才能按原 ID 重试。
 */

import type { DeliveryStatus, PreparedDelivery } from "./types.js";

export interface DeliveryRecord extends PreparedDelivery {
  readonly status: DeliveryStatus;
  readonly lease_owner?: string;
  readonly lease_expires_at?: string;
  readonly started_at?: string;
  /** 已尝试发送次数（含当前在途）。 */
  readonly attempts?: number;
  /** not_sent 退避：早于该时刻不重新领取。 */
  readonly next_attempt_at?: string;
  readonly provider_request_id?: string;
  readonly receipt?: Readonly<Record<string, unknown>>;
  readonly accepted_at?: string;
  readonly read_at?: string;
  readonly read_evidence_ref?: string;
  readonly blocked_reason?: string;
}

export interface DeliveryStore {
  get(merchantId: string, deliveryId: string): DeliveryRecord | undefined;
  /** 返回该 stream 上已在途/未知的记录（不含当前 delivery）。 */
  findBlocking(
    merchantId: string,
    streamKey: string,
    deliveryId: string,
  ): DeliveryRecord | undefined;
  save(record: DeliveryRecord): void;
  /** 持久存储可提供写事务；领取/复核在同一 IMMEDIATE 事务内执行。 */
  transaction?<T>(work: () => T): T;
}

export type DeliveryDispatchErrorCode =
  | "not_found"
  | "not_pending"
  | "stream_busy"
  | "lease_lost"
  | "lease_busy"
  | "backoff"
  | "expired"
  | "invalid_transition"
  | "read_requires_evidence";

export class DeliveryDispatchError extends Error {
  readonly code: DeliveryDispatchErrorCode;
  constructor(code: DeliveryDispatchErrorCode, message: string) {
    super(message);
    this.name = "DeliveryDispatchError";
    this.code = code;
  }
}

export interface ClaimDeliveryInput {
  readonly store: DeliveryStore;
  readonly merchant_id: string;
  readonly delivery_id: string;
  readonly worker_id: string;
  readonly lease_ms: number;
  readonly now: string;
  /**
   * 领取前的发送时复核（P1-4）：重读绑定/订阅/授权并抛错阻止发送。
   * 在同一事务内由调用方提供；抛错即不领取。
   */
  readonly authorize?: (record: DeliveryRecord) => void;
}

/**
 * 领取一条 PENDING 通知；同 stream 已有在途/UNKNOWN 时拒绝。
 * 已开始外发的记录须先核对上一轮结果。
 */
export function claimDelivery(input: ClaimDeliveryInput): DeliveryRecord {
  const record = requireRecord(input.store, input.merchant_id, input.delivery_id);
  if (record.status !== "PENDING") {
    throw new DeliveryDispatchError("not_pending", `状态 ${record.status} 不能领取`);
  }
  if (Date.parse(record.valid_until) <= Date.parse(input.now)) {
    throw new DeliveryDispatchError("expired", "valid_until 已到，不发送");
  }
  if (!Number.isSafeInteger(input.lease_ms) || input.lease_ms <= 0) {
    throw new DeliveryDispatchError("invalid_transition", "lease_ms 必须是正整数");
  }
  if (record.started_at !== undefined || record.lease_owner !== undefined) {
    throw new DeliveryDispatchError("lease_busy", "该通知已开始派发，须先核对上一轮的发送结果");
  }
  if (record.next_attempt_at !== undefined && Date.parse(record.next_attempt_at) > Date.parse(input.now)) {
    throw new DeliveryDispatchError("backoff", "尚未到重试时间");
  }
  const blocking = input.store.findBlocking(input.merchant_id, record.stream_key, record.delivery_id);
  if (blocking !== undefined) {
    throw new DeliveryDispatchError("stream_busy", "同一发送流已有未完成通知");
  }
  input.authorize?.(record);
  const claimed: DeliveryRecord = {
    ...record,
    lease_owner: input.worker_id,
    lease_expires_at: new Date(Date.parse(input.now) + input.lease_ms).toISOString(),
    started_at: input.now,
    attempts: (record.attempts ?? 0) + 1,
  };
  input.store.save(claimed);
  return claimed;
}

/**
 * not_sent 释放：必须仍持有未过期租约（P2-1）。租约已被其他 worker 接管时
 * 抛 `lease_lost`，不得把对方在途记录无条件重置为 PENDING。
 */
export function releaseDelivery(input: {
  store: DeliveryStore;
  merchant_id: string;
  delivery_id: string;
  worker_id: string;
  now: string;
  reason: string;
  next_attempt_at?: string;
}): DeliveryRecord {
  const record = requireRecord(input.store, input.merchant_id, input.delivery_id);
  if (record.status !== "PENDING") {
    throw new DeliveryDispatchError("invalid_transition", `状态 ${record.status} 不能释放`);
  }
  requireLease(record, input.worker_id, input.now);
  const released: DeliveryRecord = {
    ...record,
    lease_owner: undefined,
    lease_expires_at: undefined,
    started_at: undefined,
    blocked_reason: `not_sent:${input.reason}`,
    ...(input.next_attempt_at !== undefined ? { next_attempt_at: input.next_attempt_at } : {}),
  };
  input.store.save(released);
  return released;
}

function requireRecord(
  store: DeliveryStore,
  merchantId: string,
  deliveryId: string,
): DeliveryRecord {
  const record = store.get(merchantId, deliveryId);
  if (record === undefined) throw new DeliveryDispatchError("not_found", "通知不存在");
  return record;
}

function requireLease(record: DeliveryRecord, workerId: string, now: string): void {
  if (record.lease_owner !== workerId) {
    throw new DeliveryDispatchError("lease_lost", "领取者不匹配");
  }
  if (record.lease_expires_at !== undefined && Date.parse(record.lease_expires_at) <= Date.parse(now)) {
    throw new DeliveryDispatchError("lease_lost", "租约已过期");
  }
}

export interface CompleteDeliveryInput {
  readonly store: DeliveryStore;
  readonly merchant_id: string;
  readonly delivery_id: string;
  readonly worker_id: string;
  readonly outcome: "accepted" | "unknown";
  readonly now: string;
  readonly provider_request_id?: string;
  readonly receipt?: Record<string, unknown>;
}

/** 写入渠道结果：accepted → SENT；结果不明 → UNKNOWN（保留 ID/载荷）。 */
export function completeDelivery(input: CompleteDeliveryInput): DeliveryRecord {
  const record = requireRecord(input.store, input.merchant_id, input.delivery_id);
  if (record.status !== "PENDING") {
    throw new DeliveryDispatchError("invalid_transition", `状态 ${record.status} 不能回执`);
  }
  requireLease(record, input.worker_id, input.now);
  const completed: DeliveryRecord =
    input.outcome === "accepted"
      ? {
          ...record,
          status: "SENT",
          accepted_at: input.now,
          ...(input.provider_request_id !== undefined
            ? { provider_request_id: input.provider_request_id }
            : {}),
          ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
        }
      : {
          ...record,
          status: "UNKNOWN",
          ...(input.provider_request_id !== undefined
            ? { provider_request_id: input.provider_request_id }
            : {}),
          ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
        };
  input.store.save(completed);
  return completed;
}

/** accepted 只表示目标系统接收；read 必须另有证据。 */
export function markDeliveryRead(input: {
  store: DeliveryStore;
  merchant_id: string;
  delivery_id: string;
  evidence_ref: string;
  now: string;
}): DeliveryRecord {
  const record = requireRecord(input.store, input.merchant_id, input.delivery_id);
  if (record.status !== "SENT" || record.accepted_at === undefined) {
    throw new DeliveryDispatchError("invalid_transition", "未 accepted 不能标记 read");
  }
  if (input.evidence_ref.trim() === "") {
    throw new DeliveryDispatchError("read_requires_evidence", "read 必须提供渠道证据");
  }
  const read: DeliveryRecord = {
    ...record,
    read_at: input.now,
    read_evidence_ref: input.evidence_ref,
  };
  input.store.save(read);
  return read;
}

/**
 * UNKNOWN 核对为“确未执行”后按原 ID/原载荷重试；渠道必须支持同 ID 幂等。
 * 返回 PENDING 记录，等待下一次领取。
 */
export function retryUnknownDelivery(input: {
  store: DeliveryStore;
  merchant_id: string;
  delivery_id: string;
  now: string;
  verified_not_executed: boolean;
  channel_idempotent: boolean;
}): DeliveryRecord {
  const record = requireRecord(input.store, input.merchant_id, input.delivery_id);
  if (record.status !== "UNKNOWN") {
    throw new DeliveryDispatchError("invalid_transition", `状态 ${record.status} 不能重试`);
  }
  if (!input.verified_not_executed) {
    throw new DeliveryDispatchError("invalid_transition", "未证实未执行，不能重试");
  }
  if (!input.channel_idempotent) {
    throw new DeliveryDispatchError("invalid_transition", "渠道不支持同 ID 幂等恢复");
  }
  const retried: DeliveryRecord = {
    ...record,
    status: "PENDING",
    lease_owner: undefined,
    lease_expires_at: undefined,
    started_at: undefined,
    blocked_reason: undefined,
  };
  input.store.save(retried);
  return retried;
}
