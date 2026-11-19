/**
 * M6-2 持久化：followup_outbox 唯一发送真相；单流在途与回执落库。
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { prepareDelivery } from "../src/merchant-core/customer-delivery/gate.js";
import {
  claimDelivery,
  completeDelivery,
  type DeliveryRecord,
} from "../src/merchant-core/customer-delivery/dispatcher.js";
import { CustomerDeliveryRepository } from "../src/merchant-core/customer-delivery/repository.js";
import { DeliveryDispatcherLoop } from "../src/merchant-core/customer-delivery/dispatcher-loop.js";
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

function record(overrides: Partial<PrepareDeliveryInput> = {}): DeliveryRecord {
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

describe("P1 发送持久化", () => {
  let db: DatabaseSync;
  let repository: CustomerDeliveryRepository;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    migrateMerchantOpsSchema(db);
    repository = new CustomerDeliveryRepository({ db, now: () => NOW });
  });

  it("插入/读取冻结通知；旧 outbox 行不被当作 P1 通知", () => {
    repository.insert(record(), "task-1");
    expect(repository.get(MERCHANT, "dlv-1")).toMatchObject({
      delivery_id: "dlv-1",
      status: "PENDING",
      payload_digest: expect.stringMatching(/^sha256:/),
    });
    db.prepare(
      `INSERT INTO followup_outbox
        (outbox_id, task_id, merchant_id, payload_json, status, created_at, updated_at)
       VALUES ('legacy-1', 'task-legacy', ?, '{}', 'PENDING', ?, ?)`,
    ).run(MERCHANT, NOW, NOW);
    expect(repository.listDue(MERCHANT, NOW)).toHaveLength(1);
    expect(repository.get(MERCHANT, "legacy-1")).toBeUndefined();
  });

  it("领取与回执落库；同流第二条被阻塞", () => {
    repository.insert(record(), "task-1");
    repository.insert(record({ delivery_id: "dlv-2", seq: 2 }), "task-1");
    const claimed = repository.inTransaction(() =>
      claimDelivery({
        store: repository,
        merchant_id: MERCHANT,
        delivery_id: "dlv-1",
        worker_id: "w1",
        lease_ms: 30_000,
        now: NOW,
      }),
    );
    expect(claimed.lease_owner).toBe("w1");
    expect(repository.get(MERCHANT, "dlv-1")?.started_at).toBe(NOW);
    expect(() =>
      repository.inTransaction(() =>
        claimDelivery({
          store: repository,
          merchant_id: MERCHANT,
          delivery_id: "dlv-2",
          worker_id: "w2",
          lease_ms: 30_000,
          now: NOW,
        }),
      ),
    ).toThrow(/同一发送流/);
    const sent = repository.inTransaction(() =>
      completeDelivery({
        store: repository,
        merchant_id: MERCHANT,
        delivery_id: "dlv-1",
        worker_id: "w1",
        outcome: "accepted",
        now: "2026-11-18T00:00:10.000Z",
        provider_request_id: "prov-1",
        receipt: { accepted: true },
      }),
    );
    expect(sent.status).toBe("SENT");
    expect(repository.get(MERCHANT, "dlv-1")).toMatchObject({
      status: "SENT",
      provider_request_id: "prov-1",
      accepted_at: "2026-11-18T00:00:10.000Z",
    });
    expect(repository.listDue(MERCHANT, NOW)).toHaveLength(1);
  });

  it("UNKNOWN 落库并阻塞同流；过期/未到期扫描正确", () => {
    repository.insert(record(), "task-1");
    repository.insert(record({ delivery_id: "dlv-2", seq: 2 }), "task-1");
    repository.inTransaction(() =>
      claimDelivery({
        store: repository,
        merchant_id: MERCHANT,
        delivery_id: "dlv-1",
        worker_id: "w1",
        lease_ms: 10_000,
        now: NOW,
      }),
    );
    repository.inTransaction(() =>
      completeDelivery({
        store: repository,
        merchant_id: MERCHANT,
        delivery_id: "dlv-1",
        worker_id: "w1",
        outcome: "unknown",
        now: "2026-11-18T00:00:05.000Z",
      }),
    );
    expect(repository.get(MERCHANT, "dlv-1")?.status).toBe("UNKNOWN");
    expect(() =>
      repository.inTransaction(() =>
        claimDelivery({
          store: repository,
          merchant_id: MERCHANT,
          delivery_id: "dlv-2",
          worker_id: "w2",
          lease_ms: 10_000,
          now: "2026-11-18T00:00:06.000Z",
        }),
      ),
    ).toThrow(/同一发送流/);
    expect(repository.listDue(MERCHANT, "2026-11-18T00:00:06.000Z")).toHaveLength(1);
    expect(repository.listDue(MERCHANT, "2026-11-18T02:00:00.000Z")).toHaveLength(0);
  });

  it("恢复中断的派发时保留原通知并阻塞该流，不再次调用渠道", async () => {
    const first = record();
    repository.insert(first, "task-1");
    repository.insert(record({ delivery_id: "dlv-2", seq: 2 }), "task-1");
    repository.inTransaction(() => claimDelivery({
      store: repository,
      merchant_id: MERCHANT,
      delivery_id: first.delivery_id,
      worker_id: "old-worker",
      lease_ms: 10_000,
      now: NOW,
    }));
    expect(repository.recoverExpiredClaims(MERCHANT, "2026-11-18T00:00:09.000Z")).toBe(0);

    const send = vi.fn(async () => ({ outcome: "accepted" as const }));
    const loop = new DeliveryDispatcherLoop({
      store: repository,
      merchant_id: MERCHANT,
      worker_id: "new-worker",
      adapterFor: () => ({ send }),
      now: () => "2026-11-18T00:00:10.000Z",
    });
    expect(await loop.tick()).toMatchObject({ unknown: 1, sent: 0 });
    expect(await loop.tick()).toMatchObject({ unknown: 0, sent: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(repository.get(MERCHANT, first.delivery_id)).toMatchObject({
      status: "UNKNOWN",
      payload: first.payload,
      payload_digest: first.payload_digest,
      started_at: NOW,
      blocked_reason: "send_lease_expired",
      attempts: 1,
    });
  });
});
