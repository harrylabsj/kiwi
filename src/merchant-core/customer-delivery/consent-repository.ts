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
 * P1 收件人绑定/订阅持久化（M6-3）。
 *
 * 只保存脱敏地址引用与一次性同意证据引用；epoch 变化使旧快照/待发载荷失效。
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import {
  createNotificationSubscription,
  createRecipientBinding,
  revokeRecipientBinding,
  unsubscribe,
} from "./binding.js";
import {
  DeliveryGateError,
  type DeliveryChannel,
  type DeliveryPurpose,
  type NotificationSubscription,
  type RecipientBinding,
} from "./types.js";

interface BindingRow {
  merchant_id: string;
  binding_id: string;
  channel: string;
  address_ref: string;
  verified_at: string;
  revoked_at: string | null;
  binding_epoch: number;
}

interface SubscriptionRow {
  merchant_id: string;
  subscription_id: string;
  binding_id: string;
  purpose: string;
  max_per_day: number;
  granted_at: string;
  expires_at: string | null;
  unsubscribed_at: string | null;
  grant_epoch: number;
}

function toBinding(row: BindingRow): RecipientBinding {
  return {
    binding_id: row.binding_id,
    merchant_id: row.merchant_id,
    channel: row.channel as DeliveryChannel,
    address_ref: row.address_ref,
    verified_at: row.verified_at,
    revoked_at: row.revoked_at,
    binding_epoch: row.binding_epoch,
  };
}

function toSubscription(row: SubscriptionRow): NotificationSubscription {
  return {
    subscription_id: row.subscription_id,
    merchant_id: row.merchant_id,
    binding_id: row.binding_id,
    purpose: row.purpose as DeliveryPurpose,
    max_per_day: row.max_per_day,
    granted_at: row.granted_at,
    expires_at: row.expires_at,
    unsubscribed_at: row.unsubscribed_at,
    grant_epoch: row.grant_epoch,
  };
}

export class DeliveryConsentRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now: () => string }) {
    this.db = options.db;
    this.now = options.now;
  }

  createBinding(input: {
    merchant_id: string;
    channel: DeliveryChannel;
    address_ref: string;
    proof_ref: string;
  }): RecipientBinding {
    const binding = createRecipientBinding({
      binding_id: `bind_${randomUUID()}`,
      merchant_id: input.merchant_id,
      channel: input.channel,
      address_ref: input.address_ref,
      proof_ref: input.proof_ref,
      now: this.now(),
    });
    const stamp = this.now();
    this.db
      .prepare(
        `INSERT INTO customer_delivery_bindings
          (merchant_id, binding_id, channel, address_ref, verified_at, revoked_at,
           binding_epoch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        binding.merchant_id,
        binding.binding_id,
        binding.channel,
        binding.address_ref,
        binding.verified_at,
        binding.binding_epoch,
        stamp,
        stamp,
      );
    return binding;
  }

  getBinding(merchantId: string, bindingId: string): RecipientBinding | undefined {
    const row = this.db
      .prepare("SELECT * FROM customer_delivery_bindings WHERE merchant_id = ? AND binding_id = ?")
      .get(merchantId, bindingId) as unknown as BindingRow | undefined;
    return row === undefined ? undefined : toBinding(row);
  }

  listBindings(merchantId: string): RecipientBinding[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM customer_delivery_bindings WHERE merchant_id = ? ORDER BY created_at DESC",
      )
      .all(merchantId) as unknown as BindingRow[];
    return rows.map(toBinding);
  }

  revokeBinding(merchantId: string, bindingId: string, expectedEpoch: number): RecipientBinding {
    const current = this.getBinding(merchantId, bindingId);
    if (current === undefined) {
      throw new DeliveryGateError("binding_missing", "收件人绑定不存在");
    }
    const revoked = revokeRecipientBinding(current, {
      expected_epoch: expectedEpoch,
      now: this.now(),
    });
    const stamp = this.now();
    this.db
      .prepare(
        `UPDATE customer_delivery_bindings
            SET revoked_at = ?, binding_epoch = ?, updated_at = ?
          WHERE merchant_id = ? AND binding_id = ? AND binding_epoch = ?`,
      )
      .run(revoked.revoked_at, revoked.binding_epoch, stamp, merchantId, bindingId, expectedEpoch);
    return revoked;
  }

  createSubscription(input: {
    merchant_id: string;
    binding_id: string;
    purpose: DeliveryPurpose;
    max_per_day: number;
    expires_at: string | null;
    consent_evidence_ref: string;
  }): NotificationSubscription {
    const binding = this.getBinding(input.merchant_id, input.binding_id);
    if (binding === undefined) {
      throw new DeliveryGateError("binding_missing", "收件人绑定不存在");
    }
    const subscription = createNotificationSubscription({
      subscription_id: `sub_${randomUUID()}`,
      binding,
      purpose: input.purpose,
      max_per_day: input.max_per_day,
      expires_at: input.expires_at,
      consent_evidence_ref: input.consent_evidence_ref,
      now: this.now(),
    });
    const stamp = this.now();
    this.db
      .prepare(
        `INSERT INTO customer_delivery_subscriptions
          (merchant_id, subscription_id, binding_id, purpose, max_per_day, granted_at,
           expires_at, unsubscribed_at, grant_epoch, consent_evidence_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        subscription.merchant_id,
        subscription.subscription_id,
        subscription.binding_id,
        subscription.purpose,
        subscription.max_per_day,
        subscription.granted_at,
        subscription.expires_at,
        subscription.grant_epoch,
        input.consent_evidence_ref,
        stamp,
        stamp,
      );
    return subscription;
  }

  getSubscription(merchantId: string, subscriptionId: string): NotificationSubscription | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM customer_delivery_subscriptions WHERE merchant_id = ? AND subscription_id = ?",
      )
      .get(merchantId, subscriptionId) as unknown as SubscriptionRow | undefined;
    return row === undefined ? undefined : toSubscription(row);
  }

  listSubscriptions(merchantId: string, bindingId?: string): NotificationSubscription[] {
    const rows = (
      bindingId === undefined
        ? this.db
            .prepare(
              "SELECT * FROM customer_delivery_subscriptions WHERE merchant_id = ? ORDER BY created_at DESC",
            )
            .all(merchantId)
        : this.db
            .prepare(
              "SELECT * FROM customer_delivery_subscriptions WHERE merchant_id = ? AND binding_id = ? ORDER BY created_at DESC",
            )
            .all(merchantId, bindingId)
    ) as unknown as SubscriptionRow[];
    return rows.map(toSubscription);
  }

  unsubscribe(
    merchantId: string,
    subscriptionId: string,
    expectedEpoch: number,
  ): NotificationSubscription {
    const current = this.getSubscription(merchantId, subscriptionId);
    if (current === undefined) {
      throw new DeliveryGateError("subscription_missing", "订阅不存在");
    }
    const updated = unsubscribe(current, {
      expected_epoch: expectedEpoch,
      now: this.now(),
    });
    this.db
      .prepare(
        `UPDATE customer_delivery_subscriptions
            SET unsubscribed_at = ?, grant_epoch = ?, updated_at = ?
          WHERE merchant_id = ? AND subscription_id = ? AND grant_epoch = ?`,
      )
      .run(
        updated.unsubscribed_at,
        updated.grant_epoch,
        this.now(),
        merchantId,
        subscriptionId,
        expectedEpoch,
      );
    return updated;
  }
}
