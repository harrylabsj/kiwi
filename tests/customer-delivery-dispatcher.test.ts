/**
 * M6 P1 领取/回执/UNKNOWN：单流在途、accepted≠read、原 ID 重试。
 */
import { describe, expect, it } from "vitest";
import { prepareDelivery } from "../src/merchant-core/customer-delivery/gate.js";
import {
  claimDelivery,
  completeDelivery,
  markDeliveryRead,
  retryUnknownDelivery,
  DeliveryDispatchError,
  type DeliveryRecord,
  type DeliveryStore,
} from "../src/merchant-core/customer-delivery/dispatcher.js";
import type { PrepareDeliveryInput } from "../src/merchant-core/customer-delivery/types.js";
import {
  GOVERNANCE_FLAGS_DEFAULT,
  type GovernanceFeatureFlags,
} from "../src/merchant-core/context-governance/feature-flags.js";

const MERCHANT = "m-1";
const NOW = "2026-11-18T00:00:00.000Z";
const P1_FLAGS = {
  ...GOVERNANCE_FLAGS_DEFAULT,
  customer_delivery_enabled: true,
} as unknown as GovernanceFeatureFlags;

class MemoryStore implements DeliveryStore {
  readonly records = new Map<string, DeliveryRecord>();
  get(merchantId: string, deliveryId: string): DeliveryRecord | undefined {
    const record = this.records.get(deliveryId);
    return record?.merchant_id === merchantId ? record : undefined;
  }
  findBlocking(
    merchantId: string,
    streamKey: string,
    deliveryId: string,
  ): DeliveryRecord | undefined {
    return [...this.records.values()].find(
      (record) =>
        record.merchant_id === merchantId &&
        record.stream_key === streamKey &&
        record.delivery_id !== deliveryId &&
        (record.status === "UNKNOWN" ||
          (record.status === "PENDING" && record.started_at !== undefined)),
    );
  }
  save(record: DeliveryRecord): void {
    this.records.set(record.delivery_id, record);
  }
}

function prepare(overrides: Partial<PrepareDeliveryInput> = {}): DeliveryRecord {
  const input: PrepareDeliveryInput = {
    flags: P1_FLAGS,
    merchant_id: MERCHANT,
    binding: {
      binding_id: "bind-1",
      merchant_id: MERCHANT,
      channel: "wechat",
      address_ref: "wxref:abc",
      verified_at: "2026-11-17T00:00:00.000Z",
      revoked_at: null,
      binding_epoch: 1,
    },
    subscription: {
      subscription_id: "sub-1",
      merchant_id: MERCHANT,
      binding_id: "bind-1",
      purpose: "arrival_notification",
      max_per_day: 5,
      granted_at: "2026-11-17T00:00:00.000Z",
      expires_at: "2026-11-19T00:00:00.000Z",
      unsubscribed_at: null,
      grant_epoch: 1,
    },
    source_grants: [
      {
        grant_id: "g1",
        grant_epoch: 1,
        purpose: "customer_memory",
        status: "ACTIVE",
        expires_at: "2026-11-19T00:00:00.000Z",
      },
    ],
    payload: { title: "到货通知", body: "您关注的商品已到货" },
    purpose: "arrival_notification",
    seq: 1,
    valid_until: "2026-11-18T01:00:00.000Z",
    now: NOW,
    sent_today: 0,
    stream_busy: false,
    delivery_id: "dlv-1",
    ...overrides,
  };
  return { ...prepareDelivery(input) };
}

function codeOf(run: () => unknown): string {
  try {
    run();
    return "none";
  } catch (err) {
    return err instanceof DeliveryDispatchError ? err.code : "unexpected";
  }
}

describe("P1 发送领取与回执", () => {
  it("领取写入租约；同流另一条通知被阻塞", () => {
    const store = new MemoryStore();
    store.save(prepare());
    store.save(prepare({ delivery_id: "dlv-2", seq: 2 }));
    const claimed = claimDelivery({
      store,
      merchant_id: MERCHANT,
      delivery_id: "dlv-1",
      worker_id: "w1",
      lease_ms: 30_000,
      now: NOW,
    });
    expect(claimed.lease_owner).toBe("w1");
    expect(claimed.started_at).toBe(NOW);
    expect(
      codeOf(() =>
        claimDelivery({
          store,
          merchant_id: MERCHANT,
          delivery_id: "dlv-2",
          worker_id: "w2",
          lease_ms: 30_000,
          now: NOW,
        }),
      ),
    ).toBe("stream_busy");
  });

  it("accepted → SENT；read 必须另有证据", () => {
    const store = new MemoryStore();
    store.save(prepare());
    claimDelivery({
      store,
      merchant_id: MERCHANT,
      delivery_id: "dlv-1",
      worker_id: "w1",
      lease_ms: 30_000,
      now: NOW,
    });
    const sent = completeDelivery({
      store,
      merchant_id: MERCHANT,
      delivery_id: "dlv-1",
      worker_id: "w1",
      outcome: "accepted",
      now: "2026-11-18T00:00:10.000Z",
      provider_request_id: "prov-1",
      receipt: { accepted: true },
    });
    expect(sent.status).toBe("SENT");
    expect(sent.accepted_at).toBe("2026-11-18T00:00:10.000Z");
    expect(sent.read_at).toBeUndefined();
    expect(
      codeOf(() =>
        markDeliveryRead({
          store,
          merchant_id: MERCHANT,
          delivery_id: "dlv-1",
          evidence_ref: "",
          now: "2026-11-18T00:00:20.000Z",
        }),
      ),
    ).toBe("read_requires_evidence");
    const read = markDeliveryRead({
      store,
      merchant_id: MERCHANT,
      delivery_id: "dlv-1",
      evidence_ref: "channel:read-receipt-1",
      now: "2026-11-18T00:00:20.000Z",
    });
    expect(read.read_at).toBe("2026-11-18T00:00:20.000Z");
  });

  it("结果不明 → UNKNOWN 且阻塞同流；租约过期不能回执", () => {
    const store = new MemoryStore();
    store.save(prepare());
    store.save(prepare({ delivery_id: "dlv-2", seq: 2 }));
    claimDelivery({
      store,
      merchant_id: MERCHANT,
      delivery_id: "dlv-1",
      worker_id: "w1",
      lease_ms: 10_000,
      now: NOW,
    });
    expect(
      codeOf(() =>
        completeDelivery({
          store,
          merchant_id: MERCHANT,
          delivery_id: "dlv-1",
          worker_id: "w1",
          outcome: "accepted",
          now: "2026-11-18T00:00:11.000Z",
        }),
      ),
    ).toBe("lease_lost");
    const unknown = completeDelivery({
      store,
      merchant_id: MERCHANT,
      delivery_id: "dlv-1",
      worker_id: "w1",
      outcome: "unknown",
      now: "2026-11-18T00:00:05.000Z",
    });
    expect(unknown.status).toBe("UNKNOWN");
    expect(
      codeOf(() =>
        claimDelivery({
          store,
          merchant_id: MERCHANT,
          delivery_id: "dlv-2",
          worker_id: "w2",
          lease_ms: 10_000,
          now: "2026-11-18T00:00:06.000Z",
        }),
      ),
    ).toBe("stream_busy");
  });

  it("UNKNOWN 仅在同 ID 幂等且证实未执行时按原载荷重试", () => {
    const store = new MemoryStore();
    store.save(prepare());
    claimDelivery({
      store,
      merchant_id: MERCHANT,
      delivery_id: "dlv-1",
      worker_id: "w1",
      lease_ms: 10_000,
      now: NOW,
    });
    completeDelivery({
      store,
      merchant_id: MERCHANT,
      delivery_id: "dlv-1",
      worker_id: "w1",
      outcome: "unknown",
      now: "2026-11-18T00:00:05.000Z",
    });
    expect(
      codeOf(() =>
        retryUnknownDelivery({
          store,
          merchant_id: MERCHANT,
          delivery_id: "dlv-1",
          now: "2026-11-18T00:00:06.000Z",
          verified_not_executed: false,
          channel_idempotent: true,
        }),
      ),
    ).toBe("invalid_transition");
    expect(
      codeOf(() =>
        retryUnknownDelivery({
          store,
          merchant_id: MERCHANT,
          delivery_id: "dlv-1",
          now: "2026-11-18T00:00:06.000Z",
          verified_not_executed: true,
          channel_idempotent: false,
        }),
      ),
    ).toBe("invalid_transition");
    const retried = retryUnknownDelivery({
      store,
      merchant_id: MERCHANT,
      delivery_id: "dlv-1",
      now: "2026-11-18T00:00:06.000Z",
      verified_not_executed: true,
      channel_idempotent: true,
    });
    expect(retried).toMatchObject({
      delivery_id: "dlv-1",
      status: "PENDING",
      payload_digest: store.records.get("dlv-1")?.payload_digest,
    });
  });

  it("valid_until 到期后不领取", () => {
    const store = new MemoryStore();
    store.save(prepare({ valid_until: "2026-11-18T00:00:05.000Z" }));
    expect(
      codeOf(() =>
        claimDelivery({
          store,
          merchant_id: MERCHANT,
          delivery_id: "dlv-1",
          worker_id: "w1",
          lease_ms: 10_000,
          now: "2026-11-18T00:00:06.000Z",
        }),
      ),
    ).toBe("expired");
  });
});
