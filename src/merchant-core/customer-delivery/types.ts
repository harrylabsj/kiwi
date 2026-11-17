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
 * P1 客户外发发送门（设计 v1.1 §16.3 / M6）。
 *
 * P0 的 `customer_delivery_enabled` 固定关闭，本模块只在 P1 验收后启用。
 * 发送前必须同时具备：可信收件人绑定、目的/频率授权、退订入口、有效期、
 * 冻结消息与持久回执；任一缺失都保持工作台草稿，不出网。
 *
 * 本文件只定义不可变输入与错误码；所有字段都是服务端注入的引用，模型
 * 不能自报收件人、渠道或授权。
 */

import type { GovernanceFeatureFlags } from "../context-governance/feature-flags.js";

export const DELIVERY_CHANNELS = ["wechat", "sms", "email", "in_app"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const DELIVERY_PURPOSES = [
  "arrival_notification",
  "status_notification",
  "service_reply",
] as const;
export type DeliveryPurpose = (typeof DELIVERY_PURPOSES)[number];

/** 发送状态与既有 followup_outbox 对齐：PENDING / SENT / UNKNOWN。 */
export const DELIVERY_STATUSES = ["PENDING", "SENT", "UNKNOWN"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface RecipientBinding {
  readonly binding_id: string;
  readonly merchant_id: string;
  readonly channel: DeliveryChannel;
  /** 渠道地址的脱敏引用；不得是明文手机号/邮箱。 */
  readonly address_ref: string;
  readonly verified_at: string;
  readonly revoked_at: string | null;
  readonly binding_epoch: number;
}

export interface NotificationSubscription {
  readonly subscription_id: string;
  readonly merchant_id: string;
  readonly binding_id: string;
  readonly purpose: DeliveryPurpose;
  /** 授权频率上限；0 表示不允许主动通知。 */
  readonly max_per_day: number;
  readonly granted_at: string;
  readonly expires_at: string | null;
  readonly unsubscribed_at: string | null;
  readonly grant_epoch: number;
}

export interface DeliverySourceGrant {
  readonly grant_id: string;
  readonly grant_epoch: number;
  readonly purpose: string;
  readonly status: "ACTIVE" | "REVOKED" | "EXPIRED";
  readonly expires_at: string | null;
}

/** 已冻结的待发送载荷；审批后修改任何字段都必须重新准备。 */
export interface PreparedDelivery {
  readonly delivery_id: string;
  readonly merchant_id: string;
  readonly stream_key: string;
  readonly binding_id: string;
  readonly binding_epoch: number;
  readonly channel: DeliveryChannel;
  readonly purpose: DeliveryPurpose;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payload_digest: string;
  readonly seq: number;
  readonly valid_until: string;
  readonly subscription_id: string;
  readonly subscription_epoch: number;
  readonly source_grants: readonly DeliverySourceGrant[];
  readonly created_at: string;
  readonly status: DeliveryStatus;
}

export interface PrepareDeliveryInput {
  readonly flags: GovernanceFeatureFlags;
  readonly merchant_id: string;
  readonly binding: RecipientBinding | undefined;
  readonly subscription: NotificationSubscription | undefined;
  readonly source_grants: readonly DeliverySourceGrant[];
  readonly payload: Record<string, unknown>;
  readonly purpose: DeliveryPurpose;
  readonly seq: number;
  readonly valid_until: string;
  readonly now: string;
  /** 当日同一 stream 已发送数量（服务端从持久回执统计，不由模型提供）。 */
  readonly sent_today: number;
  /** 同一 stream 是否已有在途（PENDING/UNKNOWN）发送。 */
  readonly stream_busy: boolean;
  readonly delivery_id: string;
}

export type DeliveryGateErrorCode =
  | "feature_disabled"
  | "binding_missing"
  | "binding_revoked"
  | "binding_unverified"
  | "binding_mismatch"
  | "subscription_missing"
  | "subscription_revoked"
  | "subscription_expired"
  | "subscription_mismatch"
  | "frequency_exceeded"
  | "grant_revoked"
  | "grant_expired"
  | "payload_invalid"
  | "seq_invalid"
  | "valid_until_invalid"
  | "stream_busy";

export class DeliveryGateError extends Error {
  readonly code: DeliveryGateErrorCode;
  constructor(code: DeliveryGateErrorCode, message: string) {
    super(message);
    this.name = "DeliveryGateError";
    this.code = code;
  }
}
