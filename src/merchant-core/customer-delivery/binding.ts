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
 * P1 收件人绑定与目的订阅（设计 §16.3 / C12）。
 *
 * 绑定必须由可信通道验证（proof_ref），地址只保存脱敏引用；订阅必须由客户
 * 明确同意（一次性短语/卡片引用），并带 frequencies/有效期/退订。自由文本
 * “好的/可以”不是同意证据。
 *
 * 本文件是纯领域函数；持久化与 HTTP 入口在后续切片接入。
 */

import {
  DeliveryGateError,
  DELIVERY_CHANNELS,
  DELIVERY_PURPOSES,
  type DeliveryChannel,
  type DeliveryPurpose,
  type NotificationSubscription,
  type RecipientBinding,
} from "./types.js";

function requireText(value: string, field: string): string {
  if (value.trim() === "") {
    throw new DeliveryGateError("invalid_transition", `${field} 不能为空`);
  }
  return value;
}

function requireIso(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new DeliveryGateError("valid_until_invalid", `${field} 必须是 RFC3339 UTC`);
  }
  return value;
}

/** 明文手机号/邮箱不能作为 address_ref；必须使用渠道侧脱敏引用。 */
function assertOpaqueAddress(addressRef: string): string {
  if (
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(addressRef) ||
    /\+?\d[\d\s-]{6,}\d/.test(addressRef)
  ) {
    throw new DeliveryGateError("address_invalid", "address_ref 必须是脱敏引用，不能是明文地址");
  }
  return addressRef;
}

export interface CreateBindingInput {
  readonly binding_id: string;
  readonly merchant_id: string;
  readonly channel: DeliveryChannel;
  readonly address_ref: string;
  readonly proof_ref: string;
  readonly now: string;
}

export function createRecipientBinding(input: CreateBindingInput): RecipientBinding {
  if (!(DELIVERY_CHANNELS as readonly string[]).includes(input.channel)) {
    throw new DeliveryGateError("channel_unknown", "未知渠道");
  }
  requireText(input.merchant_id, "merchant_id");
  requireText(input.binding_id, "binding_id");
  requireText(input.proof_ref, "proof_ref");
  const now = requireIso(input.now, "now");
  return Object.freeze({
    binding_id: input.binding_id,
    merchant_id: input.merchant_id,
    channel: input.channel,
    address_ref: assertOpaqueAddress(requireText(input.address_ref, "address_ref")),
    verified_at: now,
    revoked_at: null,
    binding_epoch: 1,
  });
}

/** 撤销绑定：epoch 递增，旧快照/在途载荷随 publish 门失效。 */
export function revokeRecipientBinding(
  binding: RecipientBinding,
  input: { expected_epoch: number; now: string },
): RecipientBinding {
  if (binding.binding_epoch !== input.expected_epoch) {
    throw new DeliveryGateError("epoch_mismatch", "绑定版本已变化");
  }
  const now = requireIso(input.now, "now");
  return Object.freeze({
    ...binding,
    revoked_at: now,
    binding_epoch: binding.binding_epoch + 1,
  });
}

export interface CreateSubscriptionInput {
  readonly subscription_id: string;
  readonly binding: RecipientBinding;
  readonly purpose: DeliveryPurpose;
  readonly max_per_day: number;
  readonly expires_at: string | null;
  /** 客户明确同意的证据引用（一次性短语/卡片）；自由文本不算。 */
  readonly consent_evidence_ref: string;
  readonly now: string;
}

export function createNotificationSubscription(
  input: CreateSubscriptionInput,
): NotificationSubscription {
  if (!(DELIVERY_PURPOSES as readonly string[]).includes(input.purpose)) {
    throw new DeliveryGateError("subscription_mismatch", "未知通知目的");
  }
  if (input.binding.revoked_at !== null) {
    throw new DeliveryGateError("binding_revoked", "绑定已撤销，不能创建订阅");
  }
  if (input.consent_evidence_ref.trim() === "") {
    throw new DeliveryGateError("consent_missing", "缺少客户明确同意证据");
  }
  if (!Number.isSafeInteger(input.max_per_day) || input.max_per_day <= 0) {
    throw new DeliveryGateError("frequency_exceeded", "max_per_day 必须是正整数");
  }
  const now = requireIso(input.now, "now");
  if (input.expires_at !== null) {
    requireIso(input.expires_at, "expires_at");
    if (Date.parse(input.expires_at) <= Date.parse(now)) {
      throw new DeliveryGateError("subscription_expired", "订阅有效期必须晚于当前时间");
    }
  }
  requireText(input.subscription_id, "subscription_id");
  return Object.freeze({
    subscription_id: input.subscription_id,
    merchant_id: input.binding.merchant_id,
    binding_id: input.binding.binding_id,
    purpose: input.purpose,
    max_per_day: input.max_per_day,
    granted_at: now,
    expires_at: input.expires_at,
    unsubscribed_at: null,
    grant_epoch: 1,
  });
}

/** 退订：epoch 递增；退订后发送门拒绝（C12）。 */
export function unsubscribe(
  subscription: NotificationSubscription,
  input: { expected_epoch: number; now: string },
): NotificationSubscription {
  if (subscription.grant_epoch !== input.expected_epoch) {
    throw new DeliveryGateError("epoch_mismatch", "订阅版本已变化");
  }
  const now = requireIso(input.now, "now");
  return Object.freeze({
    ...subscription,
    unsubscribed_at: now,
    grant_epoch: subscription.grant_epoch + 1,
  });
}
