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
 * 渠道订单事实 → Catalog 回执（买家识别与交易回执 · K7）。
 *
 * 只有渠道成功生成订单（已校验的 completed checkout / 商家权威订单记录）
 * 并出具可验证的订单引用后才投递——复用只读 `OrderRecord` 摄取点
 * （`ingestOrderRecord` fail-closed 校验：标识符、permalink 安全、terms
 * digest、ISO 时间）。摄取成功且订单状态表明订单已创建时，经 K5 投递组件
 * 上报 `merchant_order_created`：
 *
 * - 来源渠道：permalink 主机（渠道内的稳定订单引用是 order_id）。
 * - 可验证关联：agreement_id（协议）与 session_ref（结账会话）随行。
 * - 事件 ID 绑定渠道订单引用（order_id）——同渠道重试只计一次（Catalog
 *   侧再按（商家、渠道、订单引用）业务键去重，B3/B4）。
 * - 订单已创建不推断已付款；一个协议可对应多个真实订单（每笔独立
 *   order_id → 独立事件）。
 *
 * 外链（无回调）和失败 checkout 不会进入本函数——调用方只在渠道回调
 * 出具可验证 order 后构造 `OrderRecordSource`；status 非订单创建态
 * （completed/fulfilled/confirmed 之外的语义由调用方把关）时本模块
 * 拒绝上报（宁可少报也不错报）。
 */

import type { OrderRecordStore, OrderRecordSource } from "./order-record.js";
import { ingestOrderRecord } from "./order-record.js";
import type { ReceiptDispatcher } from "../commerce/receipt/dispatcher.js";
import type { OrderReceipt } from "../commerce/receipt/receipts.js";

/** 订单已创建的可接受状态词表（merchant 权威状态；Kiwi 不解释其余语义）。 */
const ORDER_CREATED_STATUSES = new Set(["completed", "fulfilled", "confirmed", "shipped"]);

function channelFromPermalink(permalinkUrl: string): string | undefined {
  try {
    const host = new URL(permalinkUrl).hostname.toLowerCase();
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

export interface OrderReceiptReportInput {
  merchantId: string;
  channel?: string;
  store: OrderRecordStore;
  dispatcher: ReceiptDispatcher;
  source: OrderRecordSource;
  /** 注入时钟（RFC 3339）；缺省取 source.recorded_at 或当前时间。 */
  now?: () => string;
}

export type OrderReceiptReportOutcome =
  | { status: "reported"; event_id: string; order_id: string }
  /** 非订单创建态 / 摄取失败：不产生事实（外链与失败 checkout 不上报）。 */
  | { status: "skipped"; reason: string };

/**
 * 摄取渠道订单并上报“订单已创建”。摄取失败（校验/重绑拒绝）按 skipped
 * 处理——事实不进入本地存储，更不上报；投递失败由 outbox 退避重试（B4）。
 */
export function ingestAndReportOrderRecord(input: OrderReceiptReportInput): OrderReceiptReportOutcome {
  const statusLower = input.source.status.trim().toLowerCase();
  if (!ORDER_CREATED_STATUSES.has(statusLower)) {
    return { status: "skipped", reason: `order status ${input.source.status} is not an order-created state` };
  }
  let record;
  const recordedAt = input.source.recorded_at ?? input.now?.() ?? new Date().toISOString();
  try {
    record = ingestOrderRecord(input.store, input.source, () => recordedAt);
  } catch (err) {
    return {
      status: "skipped",
      reason: `order record ingest rejected: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (record === undefined || record === null) {
    return { status: "skipped", reason: "order record ingest returned no record" };
  }
  const channel = input.channel ?? channelFromPermalink(record.permalink_url);
  if (channel === undefined) {
    return { status: "skipped", reason: "permalink has no channel host" };
  }
  const receipt: OrderReceipt = {
    event_id: `merchant-order:${channel}:${record.order_id}`,
    event_type: "merchant_order_created",
    merchant_id: input.merchantId,
    order_channel: channel,
    order_ref: record.order_id,
    order_evidence: {
      merchant_agreement_ref: record.agreement_id,
      checkout_session_ref: record.session_ref,
      channel_evidence: record.order_id,
    },
    occurred_at: record.recorded_at,
  };
  void input.dispatcher.enqueueAndDeliver(receipt).catch(() => {});
  return { status: "reported", event_id: receipt.event_id, order_id: record.order_id };
}
