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
 * P1 渠道适配与发送编排（设计 §16.3 / M6-6）。
 *
 * 渠道只返回 accepted（目标系统接受）/ unknown（结果不明）/ not_sent（可证明
 * 未发送）；本模块负责领取、冻结载荷、回执落库。accepted 不等于 read。
 */

import type { StreamGate } from "./stream-gate.js";
import {
  claimDelivery,
  completeDelivery,
  releaseDelivery,
  type DeliveryRecord,
  type DeliveryStore,
} from "./dispatcher.js";

/** not_sent 重试上限与退避：15s 起，指数增长，封顶 5 分钟。 */
const MAX_NOT_SENT_ATTEMPTS = 5;
const NOT_SENT_BASE_BACKOFF_MS = 15_000;
const NOT_SENT_MAX_BACKOFF_MS = 5 * 60_000;

function notSentBackoff(attempts: number): number {
  return Math.min(NOT_SENT_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), NOT_SENT_MAX_BACKOFF_MS);
}

export type ChannelSendOutcome =
  | { outcome: "accepted"; provider_request_id?: string; receipt?: Record<string, unknown> }
  | { outcome: "unknown"; provider_request_id?: string; receipt?: Record<string, unknown> }
  | { outcome: "not_sent"; reason: string; retry_after_ms?: number };

export interface DeliveryChannelAdapter {
  /** 同一 delivery_id 必须作为渠道幂等键；不得换 ID 重发。 */
  send(input: {
    delivery: DeliveryRecord;
    idempotency_key: string;
    timeout_ms: number;
    /** 由宿主按授权绑定解析的实际收件人；适配器不得回退到固定地址。 */
    recipient?: string;
  }): Promise<ChannelSendOutcome>;
}

export interface DispatchDeliveryInput {
  readonly store: DeliveryStore;
  readonly merchant_id: string;
  readonly delivery_id: string;
  readonly worker_id: string;
  readonly lease_ms: number;
  readonly timeout_ms: number;
  readonly now: string;
  readonly clock?: () => string;
  readonly write?: <T>(work: () => T) => T;
  readonly adapter: DeliveryChannelAdapter;
  /** 与接待回复共用的流门；缺省仅依赖 DeliveryStore 的单流约束。 */
  readonly stream_gate?: StreamGate;
  /** 发送时复核：重读绑定/订阅/授权；抛错则不领取（P1-4）。 */
  readonly authorize?: (record: DeliveryRecord) => void;
  /** 从授权绑定解析收件人；缺省视为不可发送（P1-5）。 */
  readonly resolveRecipient?: (record: DeliveryRecord) => string | undefined;
}

/**
 * 领取 → 渠道发送 → 回执。not_sent 时释放回 PENDING（可修正后同 ID 重试）；
 * unknown 保留 UNKNOWN 阻塞流；accepted 写 SENT。
 */
export async function dispatchDelivery(
  input: DispatchDeliveryInput,
): Promise<DeliveryRecord> {
  const streamKey = input.store.get(input.merchant_id, input.delivery_id)?.stream_key ?? input.delivery_id;
  const holderId = crypto.randomUUID();
  input.stream_gate?.enter({
    stream_key: streamKey,
    holder_id: holderId,
    lease_ms: input.lease_ms,
    now: input.now,
  });
  const claim = () =>
    claimDelivery({
      store: input.store,
      merchant_id: input.merchant_id,
      delivery_id: input.delivery_id,
      worker_id: input.worker_id,
      lease_ms: input.lease_ms,
      now: input.now,
      ...(input.authorize !== undefined ? { authorize: input.authorize } : {}),
    });
  // P1-2/P1-4：持久存储下，租约检查、发送时复核与领取写入必须在同一
  // IMMEDIATE 事务内，跨进程的两个 worker 不能同时领取。
  const write = input.write ?? input.store.transaction?.bind(input.store) ?? ((work) => work());
  let claimed: DeliveryRecord;
  try {
    claimed = write(claim);
  } catch (error) {
    input.stream_gate?.leave(streamKey, holderId);
    throw error;
  }
  const recipient = input.resolveRecipient?.(claimed);
  let result: ChannelSendOutcome;
  try {
    result = await input.adapter.send({
      delivery: claimed,
      idempotency_key: claimed.delivery_id,
      timeout_ms: input.timeout_ms,
      ...(recipient !== undefined ? { recipient } : {}),
    });
  } catch {
    result = { outcome: "unknown" };
  }
  const settled = write(() => {
    const now = input.clock?.() ?? input.now;
    const delivery = {
      store: input.store,
      merchant_id: input.merchant_id,
      delivery_id: claimed.delivery_id,
      worker_id: input.worker_id,
      now,
    };
    if (result.outcome === "not_sent") {
      const attempts = claimed.attempts ?? 1;
      const nextAttempt = Math.min(
        Date.parse(claimed.valid_until),
        Date.parse(now) + Math.max(notSentBackoff(attempts), result.retry_after_ms ?? 0),
      );
      return releaseDelivery({
        ...delivery,
        reason: result.reason,
        next_attempt_at: result.retry_after_ms === undefined && attempts >= MAX_NOT_SENT_ATTEMPTS
          ? claimed.valid_until
          : new Date(nextAttempt).toISOString(),
      });
    }
    return completeDelivery({
      ...delivery,
      outcome: result.outcome,
      ...(result.provider_request_id !== undefined ? { provider_request_id: result.provider_request_id } : {}),
      ...(result.receipt !== undefined ? { receipt: result.receipt } : {}),
    });
  });
  // The durable outbox blocks UNKNOWN streams after the network lease is released.
  input.stream_gate?.leave(claimed.stream_key, holderId);
  return settled;
}

/** 本地/联调用的 HTTP webhook 适配器；生产渠道按同一接口实现。 */
export function createWebhookChannelAdapter(options: {
  endpoint: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}): DeliveryChannelAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async send({ delivery, idempotency_key, timeout_ms }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout_ms);
      try {
        const response = await fetchImpl(options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotency_key,
            ...options.headers,
          },
          body: JSON.stringify({
            delivery_id: delivery.delivery_id,
            channel: delivery.channel,
            purpose: delivery.purpose,
            payload: delivery.payload,
            payload_digest: delivery.payload_digest,
            valid_until: delivery.valid_until,
          }),
          signal: controller.signal,
        });
        const text = await response.text();
        let receipt: Record<string, unknown> = {};
        try {
          receipt = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
        } catch {
          receipt = { raw: text.slice(0, 500) };
        }
        if (response.status === 202 || response.status === 200) {
          return {
            outcome: "accepted",
            ...(typeof receipt.request_id === "string"
              ? { provider_request_id: receipt.request_id }
              : {}),
            receipt,
          };
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          return { outcome: "not_sent", reason: `http_${response.status}` };
        }
        return { outcome: "unknown", receipt: { status: response.status, ...receipt } };
      } catch {
        return { outcome: "unknown" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

