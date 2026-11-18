/**
 * M6 P1 发送门：P0 固定关闭；P1 需绑定/授权/频率/有效期/冻结载荷齐全。
 */
import { describe, expect, it } from "vitest";
import {
  DeliveryGateError,
  type NotificationSubscription,
  type PrepareDeliveryInput,
  type RecipientBinding,
} from "../src/merchant-core/customer-delivery/types.js";
import {
  assertDeliveryStillAuthorized,
  prepareDelivery,
} from "../src/merchant-core/customer-delivery/gate.js";
import {
  GOVERNANCE_FLAGS_DEFAULT,
  type GovernanceFeatureFlags,
} from "../src/merchant-core/context-governance/feature-flags.js";

const MERCHANT = "m-1";
const NOW = "2026-11-18T00:00:00.000Z";
const VALID_UNTIL = "2026-11-18T01:00:00.000Z";

// P0 的类型固定为 false；P1 验收时才会放宽。测试用显式 cast 模拟 P1 开关。
const P1_FLAGS = {
  ...GOVERNANCE_FLAGS_DEFAULT,
  customer_delivery_enabled: true,
} as unknown as GovernanceFeatureFlags;

const BINDING: RecipientBinding = {
  binding_id: "bind-1",
  merchant_id: MERCHANT,
  channel: "wechat",
  address_ref: "wxref:abc",
  verified_at: "2026-11-17T00:00:00.000Z",
  revoked_at: null,
  binding_epoch: 3,
};

const SUBSCRIPTION: NotificationSubscription = {
  subscription_id: "sub-1",
  merchant_id: MERCHANT,
  binding_id: "bind-1",
  purpose: "arrival_notification",
  max_per_day: 2,
  granted_at: "2026-11-17T00:00:00.000Z",
  expires_at: "2026-11-19T00:00:00.000Z",
  unsubscribed_at: null,
  grant_epoch: 1,
};

const GRANT = {
  grant_id: "grant-1",
  grant_epoch: 2,
  purpose: "customer_memory",
  status: "ACTIVE" as const,
  expires_at: "2026-11-19T00:00:00.000Z",
};

function input(overrides: Partial<PrepareDeliveryInput> = {}): PrepareDeliveryInput {
  return {
    flags: P1_FLAGS,
    merchant_id: MERCHANT,
    binding: BINDING,
    subscription: SUBSCRIPTION,
    source_grants: [GRANT],
    payload: { title: "到货通知", body: "您关注的商品已到货", sku: "VQ-001" },
    purpose: "arrival_notification",
    seq: 1,
    valid_until: VALID_UNTIL,
    now: NOW,
    sent_today: 0,
    stream_busy: false,
    delivery_id: "dlv-1",
    ...overrides,
  };
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return "none";
  } catch (err) {
    if (err instanceof DeliveryGateError) return err.code;
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : "unexpected";
  }
}

describe("P1 客户发送门", () => {
  it("P0 固定关闭：customer_delivery=false 时拒绝准备", () => {
    expect(codeOf(() => prepareDelivery(input({ flags: GOVERNANCE_FLAGS_DEFAULT })))).toBe(
      "unsupported_capability",
    );
  });

  it("绑定/授权/频率/有效期齐全时冻结载荷与摘要", () => {
    const delivery = prepareDelivery(input());
    expect(delivery).toMatchObject({
      delivery_id: "dlv-1",
      merchant_id: MERCHANT,
      channel: "wechat",
      purpose: "arrival_notification",
      seq: 1,
      status: "PENDING",
      binding_epoch: 3,
      subscription_epoch: 1,
    });
    expect(delivery.stream_key).toBe(`${MERCHANT}:wechat:bind-1`);
    expect(delivery.payload_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("缺少/撤销/未验证绑定或跨商家绑定一律拒绝", () => {
    expect(codeOf(() => prepareDelivery(input({ binding: undefined })))).toBe("binding_missing");
    expect(
      codeOf(() => prepareDelivery(input({ binding: { ...BINDING, revoked_at: NOW } }))),
    ).toBe("binding_revoked");
    expect(
      codeOf(() => prepareDelivery(input({ binding: { ...BINDING, verified_at: "" } }))),
    ).toBe("binding_unverified");
    expect(
      codeOf(() => prepareDelivery(input({ binding: { ...BINDING, merchant_id: "m-2" } }))),
    ).toBe("binding_mismatch");
  });

  it("缺少/退订/过期/频率超限的目的授权一律拒绝", () => {
    expect(codeOf(() => prepareDelivery(input({ subscription: undefined })))).toBe(
      "subscription_missing",
    );
    expect(
      codeOf(() =>
        prepareDelivery(input({ subscription: { ...SUBSCRIPTION, unsubscribed_at: NOW } })),
      ),
    ).toBe("subscription_revoked");
    expect(
      codeOf(() =>
        prepareDelivery(input({ subscription: { ...SUBSCRIPTION, expires_at: NOW } })),
      ),
    ).toBe("subscription_expired");
    expect(
      codeOf(() =>
        prepareDelivery(input({ subscription: { ...SUBSCRIPTION, max_per_day: 0 } })),
      ),
    ).toBe("frequency_exceeded");
    expect(codeOf(() => prepareDelivery(input({ sent_today: 2 })))).toBe("frequency_exceeded");
  });

  it("来源授权撤销/过期或流已在途时拒绝", () => {
    expect(
      codeOf(() =>
        prepareDelivery(input({ source_grants: [{ ...GRANT, status: "REVOKED" }] })),
      ),
    ).toBe("grant_revoked");
    expect(
      codeOf(() =>
        prepareDelivery(input({ source_grants: [{ ...GRANT, expires_at: NOW }] })),
      ),
    ).toBe("grant_expired");
    expect(codeOf(() => prepareDelivery(input({ stream_busy: true })))).toBe("stream_busy");
  });

  it("有效期不得早于现在或超过授权期限", () => {
    expect(
      codeOf(() => prepareDelivery(input({ valid_until: "2026-11-17T23:59:59.000Z" }))),
    ).toBe("valid_until_invalid");
    expect(
      codeOf(() => prepareDelivery(input({ valid_until: "2026-11-20T00:00:00.000Z" }))),
    ).toBe("valid_until_invalid");
  });

  it("P1-4：发送时复核退订/频控/epoch 变化", () => {
    const check = (overrides: Partial<Parameters<typeof assertDeliveryStillAuthorized>[0]> = {}) =>
      assertDeliveryStillAuthorized({
        merchant_id: MERCHANT,
        binding: BINDING,
        subscription: SUBSCRIPTION,
        purpose: "arrival_notification",
        source_grants: [GRANT],
        now: NOW,
        sent_today: 0,
        expected_binding_epoch: 3,
        expected_subscription_epoch: 1,
        ...overrides,
      });
    expect(() => check()).not.toThrow();
    expect(() =>
      check({ subscription: { ...SUBSCRIPTION, unsubscribed_at: NOW } }),
    ).toThrowError(DeliveryGateError);
    expect(() => check({ sent_today: 2 })).toThrowError(DeliveryGateError);
    expect(() => check({ binding: { ...BINDING, binding_epoch: 4 } })).toThrowError(
      DeliveryGateError,
    );
    expect(() =>
      check({ subscription: { ...SUBSCRIPTION, grant_epoch: 2 } }),
    ).toThrowError(DeliveryGateError);
  });

  it("payload 为空或含明文手机号/邮箱时拒绝", () => {
    expect(codeOf(() => prepareDelivery(input({ payload: {} })))).toBe("payload_invalid");
    expect(
      codeOf(() => prepareDelivery(input({ payload: { body: "请联系 13800138000" } }))),
    ).toBe("payload_invalid");
    expect(
      codeOf(() => prepareDelivery(input({ payload: { body: "a@b.com" } }))),
    ).toBe("payload_invalid");
  });
});
