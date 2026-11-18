/**
 * M6-6 渠道适配：accepted/not_sent/unknown 与 webhook 映射。
 */
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { prepareDelivery } from "../src/merchant-core/customer-delivery/gate.js";
import {
  dispatchDelivery,
  createWebhookChannelAdapter,
  type DeliveryChannelAdapter,
} from "../src/merchant-core/customer-delivery/channel.js";
import type { DeliveryRecord, DeliveryStore } from "../src/merchant-core/customer-delivery/dispatcher.js";
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
  findBlocking(merchantId: string, streamKey: string, deliveryId: string): DeliveryRecord | undefined {
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

function record(): DeliveryRecord {
  const input: PrepareDeliveryInput = {
    flags: P1_FLAGS,
    merchant_id: MERCHANT,
    binding: {
      binding_id: "bind-1",
      merchant_id: MERCHANT,
      channel: "wechat",
      address_ref: "hook:1",
      verified_at: NOW,
      revoked_at: null,
      binding_epoch: 1,
    },
    subscription: {
      subscription_id: "sub-1",
      merchant_id: MERCHANT,
      binding_id: "bind-1",
      purpose: "arrival_notification",
      max_per_day: 5,
      granted_at: NOW,
      expires_at: "2026-11-19T00:00:00.000Z",
      unsubscribed_at: null,
      grant_epoch: 1,
    },
    source_grants: [
      { grant_id: "g1", grant_epoch: 1, purpose: "customer_memory", status: "ACTIVE", expires_at: "2026-11-19T00:00:00.000Z" },
    ],
    payload: { title: "到货", body: "已到货" },
    purpose: "arrival_notification",
    seq: 1,
    valid_until: "2026-11-18T01:00:00.000Z",
    now: NOW,
    sent_today: 0,
    stream_busy: false,
    delivery_id: "dlv-1",
  };
  return { ...prepareDelivery(input) };
}

const accepted: DeliveryChannelAdapter = {
  async send() {
    return { outcome: "accepted", provider_request_id: "prov-1", receipt: { accepted: true } };
  },
};

describe("M6-6 渠道发送", () => {
  it("accepted → SENT；not_sent → PENDING 且保留同 ID/载荷", async () => {
    const store = new MemoryStore();
    store.save(record());
    const sent = await dispatchDelivery({
      store,
      merchant_id: MERCHANT,
      delivery_id: "dlv-1",
      worker_id: "w1",
      lease_ms: 30_000,
      timeout_ms: 5_000,
      now: NOW,
      adapter: accepted,
    });
    expect(sent).toMatchObject({ status: "SENT", provider_request_id: "prov-1" });

    const store2 = new MemoryStore();
    store2.save(record());
    const released = await dispatchDelivery({
      store: store2,
      merchant_id: MERCHANT,
      delivery_id: "dlv-1",
      worker_id: "w1",
      lease_ms: 30_000,
      timeout_ms: 5_000,
      now: NOW,
      adapter: { async send() { return { outcome: "not_sent", reason: "rate_limited" }; } },
    });
    expect(released).toMatchObject({ status: "PENDING", blocked_reason: "not_sent:rate_limited" });
    expect(released.lease_owner).toBeUndefined();
    expect(released.payload_digest).toBe(store2.records.get("dlv-1")?.payload_digest);
  });

  it("unknown/异常 → UNKNOWN 并阻塞该流", async () => {
    const store = new MemoryStore();
    store.save(record());
    const unknown = await dispatchDelivery({
      store,
      merchant_id: MERCHANT,
      delivery_id: "dlv-1",
      worker_id: "w1",
      lease_ms: 30_000,
      timeout_ms: 5_000,
      now: NOW,
      adapter: { async send() { throw new Error("timeout"); } },
    });
    expect(unknown.status).toBe("UNKNOWN");
    store.save({ ...record(), delivery_id: "dlv-2", seq: 2 });
    expect(() =>
      store.findBlocking(MERCHANT, record().stream_key, "dlv-2"),
    ).not.toThrow();
  });

  it("webhook：202 accepted；4xx not_sent；5xx unknown", async () => {
    let status = 202;
    const server = createServer((req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ request_id: "req-1" }));
      req.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const adapter = createWebhookChannelAdapter({ endpoint: `http://127.0.0.1:${port}/hook` });
      const delivery = record();
      expect(await adapter.send({ delivery, idempotency_key: "dlv-1", timeout_ms: 2_000 })).toMatchObject({
        outcome: "accepted",
        provider_request_id: "req-1",
      });
      status = 400;
      expect(
        (await adapter.send({ delivery, idempotency_key: "dlv-1", timeout_ms: 2_000 })).outcome,
      ).toBe("not_sent");
      status = 503;
      expect(
        (await adapter.send({ delivery, idempotency_key: "dlv-1", timeout_ms: 2_000 })).outcome,
      ).toBe("unknown");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
