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
  type DeliveryRecord,
  type DeliveryStore,
} from "./dispatcher.js";

export type ChannelSendOutcome =
  | { outcome: "accepted"; provider_request_id?: string; receipt?: Record<string, unknown> }
  | { outcome: "unknown"; provider_request_id?: string; receipt?: Record<string, unknown> }
  | { outcome: "not_sent"; reason: string };

export interface DeliveryChannelAdapter {
  /** 同一 delivery_id 必须作为渠道幂等键；不得换 ID 重发。 */
  send(input: {
    delivery: DeliveryRecord;
    idempotency_key: string;
    timeout_ms: number;
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
  readonly adapter: DeliveryChannelAdapter;
  /** 与接待回复共用的流门；缺省仅依赖 DeliveryStore 的单流约束。 */
  readonly stream_gate?: StreamGate;
}

/**
 * 领取 → 渠道发送 → 回执。not_sent 时释放回 PENDING（可修正后同 ID 重试）；
 * unknown 保留 UNKNOWN 阻塞流；accepted 写 SENT。
 */
export async function dispatchDelivery(
  input: DispatchDeliveryInput,
): Promise<DeliveryRecord> {
  input.stream_gate?.enter({
    stream_key: input.store.get(input.merchant_id, input.delivery_id)?.stream_key ?? input.delivery_id,
    holder_id: input.worker_id,
    lease_ms: input.lease_ms,
    now: input.now,
  });
  const claimed = claimDelivery({
    store: input.store,
    merchant_id: input.merchant_id,
    delivery_id: input.delivery_id,
    worker_id: input.worker_id,
    lease_ms: input.lease_ms,
    now: input.now,
  });
  let result: ChannelSendOutcome;
  try {
    result = await input.adapter.send({
      delivery: claimed,
      idempotency_key: claimed.delivery_id,
      timeout_ms: input.timeout_ms,
    });
  } catch {
    result = { outcome: "unknown" };
  }
  if (result.outcome === "not_sent") {
    input.stream_gate?.leave(claimed.stream_key, input.worker_id);
    const released: DeliveryRecord = {
      ...claimed,
      lease_owner: undefined,
      lease_expires_at: undefined,
      started_at: undefined,
      blocked_reason: `not_sent:${result.reason}`,
    };
    input.store.save(released);
    return released;
  }
  if (result.outcome === "accepted") {
    input.stream_gate?.leave(claimed.stream_key, input.worker_id);
  }
  return completeDelivery({
    store: input.store,
    merchant_id: input.merchant_id,
    delivery_id: input.delivery_id,
    worker_id: input.worker_id,
    outcome: result.outcome,
    now: input.now,
    ...(result.provider_request_id !== undefined
      ? { provider_request_id: result.provider_request_id }
      : {}),
    ...(result.receipt !== undefined ? { receipt: result.receipt } : {}),
  });
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

