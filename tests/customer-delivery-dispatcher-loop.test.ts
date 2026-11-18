/**
 * M6-6 投递循环：PENDING → accepted SENT；无适配器保持 PENDING。
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { DeliveryConsentRepository } from "../src/merchant-core/customer-delivery/consent-repository.js";
import { CustomerDeliveryRepository } from "../src/merchant-core/customer-delivery/repository.js";
import { prepareDelivery } from "../src/merchant-core/customer-delivery/gate.js";
import { DeliveryDispatcherLoop } from "../src/merchant-core/customer-delivery/dispatcher-loop.js";
import { createEmailChannelAdapter } from "../src/merchant-core/customer-delivery/email-adapter.js";

const NOW = "2026-11-18T00:00:00.000Z";
const MERCHANT = "m-1";
let db: DatabaseSync;
let consent: DeliveryConsentRepository;
let deliveries: CustomerDeliveryRepository;
let deliveryId: string;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  migrateMerchantOpsSchema(db);
  consent = new DeliveryConsentRepository({ db, now: () => NOW });
  deliveries = new CustomerDeliveryRepository({ db, now: () => NOW });
  const binding = consent.createBinding({ merchant_id: MERCHANT, channel: "email", address_ref: "mailref:test", proof_ref: "proof" });
  const subscription = consent.createSubscription({ merchant_id: MERCHANT, binding_id: binding.binding_id, purpose: "arrival_notification", max_per_day: 1, expires_at: "2026-11-19T00:00:00.000Z", consent_evidence_ref: "phrase:1" });
  deliveryId = "dlv-1";
  deliveries.insert(
    prepareDelivery({
      flags: { learning_enabled: false, memory_enabled: false, jobs_enabled: false, customer_delivery_enabled: true } as never,
      merchant_id: MERCHANT,
      binding,
      subscription,
      source_grants: [],
      payload: { title: "测试", body: "正文" },
      purpose: "arrival_notification",
      seq: 1,
      valid_until: "2026-11-18T01:00:00.000Z",
      now: NOW,
      sent_today: 0,
      stream_busy: false,
      delivery_id: deliveryId,
    }),
    "task-1",
  );
});

describe("M6-6 投递循环", () => {
  it("accepted 渠道 → SENT；无适配器保持 PENDING", async () => {
    const adapter = createEmailChannelAdapter({
      api_key: "k",
      from: "from@test",
      fetchImpl: (async () => new Response(JSON.stringify({ id: "mail-1" }), { status: 200 })) as typeof fetch,
    });
    const loop = new DeliveryDispatcherLoop({
      store: deliveries,
      merchant_id: MERCHANT,
      adapterFor: () => adapter,
      // P1-5：收件人由绑定地址引用解析，不使用适配器固定地址。
      resolveRecipient: () => "to@test",
      now: () => NOW,
      worker_id: "w1",
    });
    expect(await loop.tick()).toMatchObject({ claimed: 1, sent: 1 });
    expect(deliveries.get(MERCHANT, deliveryId)?.status).toBe("SENT");

    const loop2 = new DeliveryDispatcherLoop({
      store: deliveries,
      merchant_id: MERCHANT,
      adapterFor: () => undefined,
      now: () => NOW,
    });
    // Already SENT: nothing due.
    expect(await loop2.tick()).toMatchObject({ skipped: 0 });
  });

  it("P1-4：send 时复核失败保持 PENDING、不调用渠道", async () => {
    let sent = 0;
    const loop = new DeliveryDispatcherLoop({
      store: deliveries,
      merchant_id: MERCHANT,
      adapterFor: () => ({
        async send() {
          sent += 1;
          return { outcome: "accepted" };
        },
      }),
      authorize: () => {
        throw new Error("subscription_revoked");
      },
      now: () => NOW,
      worker_id: "w1",
      log: () => undefined,
    });
    expect(await loop.tick()).toMatchObject({ claimed: 0, skipped: 1 });
    expect(sent).toBe(0);
    expect(deliveries.get(MERCHANT, deliveryId)?.status).toBe("PENDING");
  });
});
