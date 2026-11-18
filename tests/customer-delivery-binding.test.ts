/**
 * M6-3 收件人绑定/订阅/退订：可信证明、明确同意、epoch 失效。
 */
import { describe, expect, it } from "vitest";
import {
  createNotificationSubscription,
  createRecipientBinding,
  revokeRecipientBinding,
  unsubscribe,
} from "../src/merchant-core/customer-delivery/binding.js";
import { DeliveryGateError } from "../src/merchant-core/customer-delivery/types.js";

const NOW = "2026-11-18T00:00:00.000Z";

function codeOf(run: () => unknown): string {
  try {
    run();
    return "none";
  } catch (err) {
    return err instanceof DeliveryGateError ? err.code : "unexpected";
  }
}

function binding() {
  return createRecipientBinding({
    binding_id: "bind-1",
    merchant_id: "m-1",
    channel: "wechat",
    address_ref: "wxref:abc",
    proof_ref: "channel-proof-1",
    now: NOW,
  });
}

describe("P1 收件人绑定与订阅", () => {
  it("绑定需要可信证明与脱敏地址；明文手机号/邮箱拒绝", () => {
    expect(binding()).toMatchObject({
      binding_id: "bind-1",
      channel: "wechat",
      verified_at: NOW,
      revoked_at: null,
      binding_epoch: 1,
    });
    expect(
      codeOf(() =>
        createRecipientBinding({
          binding_id: "b2",
          merchant_id: "m-1",
          channel: "wechat",
          address_ref: "13800138000",
          proof_ref: "proof",
          now: NOW,
        }),
      ),
    ).toBe("address_invalid");
    expect(
      codeOf(() =>
        createRecipientBinding({
          binding_id: "b2",
          merchant_id: "m-1",
          channel: "wechat",
          address_ref: "a@b.com",
          proof_ref: "proof",
          now: NOW,
        }),
      ),
    ).toBe("address_invalid");
    expect(
      codeOf(() =>
        createRecipientBinding({
          binding_id: "b2",
          merchant_id: "m-1",
          channel: "wechat",
          address_ref: "wxref:abc",
          proof_ref: "",
          now: NOW,
        }),
      ),
    ).toBe("invalid_transition");
  });

  it("订阅需要客户明确同意证据；自由文本不是证据", () => {
    const bind = binding();
    expect(
      createNotificationSubscription({
        subscription_id: "sub-1",
        binding: bind,
        purpose: "arrival_notification",
        max_per_day: 2,
        expires_at: "2026-11-19T00:00:00.000Z",
        consent_evidence_ref: "phrase:confirm-1",
        now: NOW,
      }),
    ).toMatchObject({ grant_epoch: 1, unsubscribed_at: null });
    expect(
      codeOf(() =>
        createNotificationSubscription({
          subscription_id: "sub-2",
          binding: bind,
          purpose: "arrival_notification",
          max_per_day: 2,
          expires_at: null,
          consent_evidence_ref: "",
          now: NOW,
        }),
      ),
    ).toBe("consent_missing");
  });

  it("撤销绑定/退订递增 epoch；旧 epoch 提交被拒", () => {
    const bind = binding();
    expect(
      codeOf(() => revokeRecipientBinding(bind, { expected_epoch: 2, now: NOW })),
    ).toBe("epoch_mismatch");
    const revoked = revokeRecipientBinding(bind, { expected_epoch: 1, now: NOW });
    expect(revoked).toMatchObject({ revoked_at: NOW, binding_epoch: 2 });
    expect(
      codeOf(() =>
        createNotificationSubscription({
          subscription_id: "sub-1",
          binding: revoked,
          purpose: "arrival_notification",
          max_per_day: 2,
          expires_at: null,
          consent_evidence_ref: "phrase:confirm-1",
          now: NOW,
        }),
      ),
    ).toBe("binding_revoked");

    const subscription = createNotificationSubscription({
      subscription_id: "sub-1",
      binding: bind,
      purpose: "status_notification",
      max_per_day: 1,
      expires_at: null,
      consent_evidence_ref: "phrase:confirm-2",
      now: NOW,
    });
    expect(
      codeOf(() => unsubscribe(subscription, { expected_epoch: 2, now: NOW })),
    ).toBe("epoch_mismatch");
    expect(unsubscribe(subscription, { expected_epoch: 1, now: NOW })).toMatchObject({
      unsubscribed_at: NOW,
      grant_epoch: 2,
    });
  });

  it("订阅有效期必须晚于当前时间", () => {
    expect(
      codeOf(() =>
        createNotificationSubscription({
          subscription_id: "sub-1",
          binding: binding(),
          purpose: "arrival_notification",
          max_per_day: 1,
          expires_at: NOW,
          consent_evidence_ref: "phrase:confirm-1",
          now: NOW,
        }),
      ),
    ).toBe("subscription_expired");
  });
});
