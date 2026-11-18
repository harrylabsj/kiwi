/**
 * M6-3 绑定/订阅持久化：epoch、退订与撤销后不可订阅。
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { DeliveryConsentRepository } from "../src/merchant-core/customer-delivery/consent-repository.js";
import { DeliveryGateError } from "../src/merchant-core/customer-delivery/types.js";

const NOW = "2026-11-18T00:00:00.000Z";
const MERCHANT = "m-1";

describe("P1 绑定/订阅持久化", () => {
  let db: DatabaseSync;
  let repository: DeliveryConsentRepository;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    migrateMerchantOpsSchema(db);
    repository = new DeliveryConsentRepository({ db, now: () => NOW });
  });

  it("绑定落库、按商家列出；epoch 不符拒绝撤销", () => {
    const binding = repository.createBinding({
      merchant_id: MERCHANT,
      channel: "wechat",
      address_ref: "wxref:abc",
      proof_ref: "proof-1",
    });
    expect(repository.getBinding(MERCHANT, binding.binding_id)).toMatchObject({
      channel: "wechat",
      binding_epoch: 1,
      revoked_at: null,
    });
    expect(repository.listBindings(MERCHANT)).toHaveLength(1);
    expect(() => repository.revokeBinding(MERCHANT, binding.binding_id, 2)).toThrow(
      DeliveryGateError,
    );
    expect(repository.revokeBinding(MERCHANT, binding.binding_id, 1)).toMatchObject({
      revoked_at: NOW,
      binding_epoch: 2,
    });
  });

  it("订阅落库/退订；撤销绑定后不能新建订阅", () => {
    const binding = repository.createBinding({
      merchant_id: MERCHANT,
      channel: "wechat",
      address_ref: "wxref:abc",
      proof_ref: "proof-1",
    });
    const subscription = repository.createSubscription({
      merchant_id: MERCHANT,
      binding_id: binding.binding_id,
      purpose: "arrival_notification",
      max_per_day: 2,
      expires_at: "2026-11-19T00:00:00.000Z",
      consent_evidence_ref: "phrase:confirm-1",
    });
    expect(repository.listSubscriptions(MERCHANT, binding.binding_id)).toHaveLength(1);
    expect(repository.unsubscribe(MERCHANT, subscription.subscription_id, 1)).toMatchObject({
      unsubscribed_at: NOW,
      grant_epoch: 2,
    });
    expect(() => repository.unsubscribe(MERCHANT, subscription.subscription_id, 1)).toThrow(
      DeliveryGateError,
    );

    repository.revokeBinding(MERCHANT, binding.binding_id, 1);
    expect(() =>
      repository.createSubscription({
        merchant_id: MERCHANT,
        binding_id: binding.binding_id,
        purpose: "status_notification",
        max_per_day: 1,
        expires_at: null,
        consent_evidence_ref: "phrase:confirm-2",
      }),
    ).toThrow(DeliveryGateError);
  });
});
