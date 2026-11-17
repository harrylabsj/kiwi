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
 * P1 客户发送门的纯判定（设计 §16.3）。
 *
 * 只做校验与冻结：不调用渠道、不写数据库。任何一项不满足都抛
 * `DeliveryGateError`，调用方保持工作台草稿（C12）。
 */

import { assertFeatureEnabled } from "../context-governance/feature-flags.js";
import { contentDigest } from "../../negotiation/jcs.js";
import {
  DeliveryGateError,
  type DeliveryPurpose,
  type DeliverySourceGrant,
  type NotificationSubscription,
  type PrepareDeliveryInput,
  type PreparedDelivery,
  type RecipientBinding,
} from "./types.js";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** 明文渠道地址形态（手机号/邮箱）不得进入 payload。 */
const RAW_ADDRESS_PATTERNS = [
  /\+?\d[\d\s-]{6,}\d/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

function isAtOrBefore(a: string, b: string): boolean {
  return Date.parse(a) <= Date.parse(b);
}

function requireIso(value: string, field: string): string {
  if (!ISO_UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new DeliveryGateError("valid_until_invalid", `${field} 必须是 RFC3339 UTC`);
  }
  return value;
}

function containsRawAddress(value: unknown): boolean {
  if (typeof value === "string") return RAW_ADDRESS_PATTERNS.some((pattern) => pattern.test(value));
  if (Array.isArray(value)) return value.some(containsRawAddress);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsRawAddress);
  }
  return false;
}

function checkBinding(
  merchantId: string,
  binding: RecipientBinding | undefined,
): RecipientBinding {
  if (binding === undefined) {
    throw new DeliveryGateError("binding_missing", "收件人绑定不存在");
  }
  if (binding.merchant_id !== merchantId) {
    throw new DeliveryGateError("binding_mismatch", "收件人绑定不属于本商家");
  }
  if (binding.revoked_at !== null) {
    throw new DeliveryGateError("binding_revoked", "收件人绑定已撤销");
  }
  if (binding.verified_at.trim() === "") {
    throw new DeliveryGateError("binding_unverified", "收件人绑定未验证");
  }
  if (binding.address_ref.trim() === "") {
    throw new DeliveryGateError("binding_unverified", "收件人地址引用为空");
  }
  return binding;
}

function checkSubscription(input: {
  merchantId: string;
  binding: RecipientBinding;
  purpose: DeliveryPurpose;
  subscription: NotificationSubscription | undefined;
  now: string;
  sentToday: number;
}): NotificationSubscription {
  const subscription = input.subscription;
  if (subscription === undefined) {
    throw new DeliveryGateError("subscription_missing", "缺少目的授权");
  }
  if (subscription.merchant_id !== input.merchantId) {
    throw new DeliveryGateError("subscription_mismatch", "授权不属于本商家");
  }
  if (subscription.binding_id !== input.binding.binding_id) {
    throw new DeliveryGateError("subscription_mismatch", "授权与收件人绑定不一致");
  }
  if (subscription.purpose !== input.purpose) {
    throw new DeliveryGateError("subscription_mismatch", "授权用途不一致");
  }
  if (subscription.unsubscribed_at !== null) {
    throw new DeliveryGateError("subscription_revoked", "客户已退订");
  }
  if (subscription.expires_at !== null && isAtOrBefore(subscription.expires_at, input.now)) {
    throw new DeliveryGateError("subscription_expired", "授权已过期");
  }
  if (!Number.isSafeInteger(subscription.max_per_day) || subscription.max_per_day <= 0) {
    throw new DeliveryGateError("frequency_exceeded", "该目的不允许主动通知");
  }
  if (input.sentToday >= subscription.max_per_day) {
    throw new DeliveryGateError("frequency_exceeded", "超过当日发送频率");
  }
  return subscription;
}

function checkGrants(grants: readonly DeliverySourceGrant[], now: string): void {
  for (const grant of grants) {
    if (grant.status === "REVOKED") {
      throw new DeliveryGateError("grant_revoked", `来源授权 ${grant.grant_id} 已撤销`);
    }
    if (grant.status === "EXPIRED" || (grant.expires_at !== null && isAtOrBefore(grant.expires_at, now))) {
      throw new DeliveryGateError("grant_expired", `来源授权 ${grant.grant_id} 已过期`);
    }
  }
}

/**
 * 校验并冻结一条 P1 待发送通知。成功返回 PENDING 记录；失败抛错，
 * 调用方不得落发送队列。
 */
export function prepareDelivery(input: PrepareDeliveryInput): PreparedDelivery {
  assertFeatureEnabled(input.flags, "customer_delivery_enabled");

  const now = requireIso(input.now, "now");
  const validUntil = requireIso(input.valid_until, "valid_until");
  if (!isAtOrBefore(now, validUntil)) {
    throw new DeliveryGateError("valid_until_invalid", "valid_until 不得早于当前时间");
  }
  if (!Number.isSafeInteger(input.seq) || input.seq <= 0) {
    throw new DeliveryGateError("seq_invalid", "seq 必须是正整数");
  }
  if (input.stream_busy) {
    throw new DeliveryGateError("stream_busy", "该发送流已有在途通知");
  }

  const binding = checkBinding(input.merchant_id, input.binding);
  const subscription = checkSubscription({
    merchantId: input.merchant_id,
    binding,
    purpose: input.purpose,
    subscription: input.subscription,
    now,
    sentToday: input.sent_today,
  });
  checkGrants(input.source_grants, now);

  if (subscription.expires_at !== null && isAtOrBefore(validUntil, now)) {
    throw new DeliveryGateError("valid_until_invalid", "valid_until 已失效");
  }
  if (subscription.expires_at !== null && Date.parse(validUntil) > Date.parse(subscription.expires_at)) {
    throw new DeliveryGateError("valid_until_invalid", "valid_until 超过授权有效期");
  }

  if (input.payload === null || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new DeliveryGateError("payload_invalid", "payload 必须是对象");
  }
  if (Object.keys(input.payload).length === 0) {
    throw new DeliveryGateError("payload_invalid", "payload 不能为空");
  }
  if (containsRawAddress(input.payload)) {
    throw new DeliveryGateError("payload_invalid", "payload 不得包含明文渠道地址");
  }

  const payload = Object.freeze({ ...input.payload });
  const streamKey = `${input.merchant_id}:${binding.channel}:${binding.binding_id}:${input.purpose}`;
  return Object.freeze({
    delivery_id: input.delivery_id,
    merchant_id: input.merchant_id,
    stream_key: streamKey,
    binding_id: binding.binding_id,
    binding_epoch: binding.binding_epoch,
    channel: binding.channel,
    purpose: input.purpose,
    payload,
    payload_digest: contentDigest(payload),
    seq: input.seq,
    valid_until: validUntil,
    subscription_id: subscription.subscription_id,
    subscription_epoch: subscription.grant_epoch,
    source_grants: Object.freeze([...input.source_grants]),
    created_at: now,
    status: "PENDING",
  });
}
