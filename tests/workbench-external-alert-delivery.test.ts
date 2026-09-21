import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  ExternalAlertDeliveryStore,
  ExternalAlertDeliveryWorker,
} from "../src/alerts/external-delivery.js";
import { WorkbenchConfirmationStore } from "../src/http/merchant-management/webauthn-confirmation.js";
import { WorkbenchReconciliationStore } from "../src/http/merchant-management/reconciliation-worker.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  new WorkbenchConfirmationStore({ db });
  new WorkbenchReconciliationStore({ db });
  let nowMs = Date.parse("2026-09-22T00:00:00.000Z");
  const store = new ExternalAlertDeliveryStore({
    db,
    now: () => new Date(nowMs).toISOString(),
  });
  db.prepare(
    `INSERT INTO workbench_alerts
     (alert_id, merchant_id, category, resource, episode, severity, summary, created_at)
     VALUES ('alert-1', 'merchant-1', 'operation_unknown', 'operation-1', 'episode-1',
             'critical', 'timeout token=secret original inquiry omitted', ?)`,
  ).run(new Date(nowMs).toISOString());
  return {
    db,
    store,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("standalone external alert delivery", () => {
  it("leases, sanitizes, retries and delivers a persistent alert", async () => {
    const { db, store, advance } = fixture();
    const send = vi
      .fn<(payload: Record<string, unknown>) => Promise<void>>()
      .mockRejectedValueOnce(new Error("webhook token=private failed"))
      .mockResolvedValue(undefined);
    const worker = new ExternalAlertDeliveryWorker(store, {
      workerId: "external-worker",
      send,
    });
    expect(await worker.runOnce()).toBe("retry");
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls[0]?.[0])).not.toContain("secret");
    expect(store.status("alert-1")).toMatchObject({ status: "pending", attempts: 1 });
    expect(store.status("alert-1")?.last_error).not.toContain("private");
    advance(5_000);
    expect(await worker.runOnce()).toBe("delivered");
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.status("alert-1")).toMatchObject({ status: "delivered", attempts: 2 });
    db.close();
  });

  it("fences an expired old lease", () => {
    const { db, store, advance } = fixture();
    store.enqueueOutstanding();
    const oldLease = store.lease("old-worker", 1_000)!;
    advance(1_001);
    const newLease = store.lease("new-worker", 1_000)!;
    expect(newLease.fencingToken).toBeGreaterThan(oldLease.fencingToken);
    expect(store.finish(oldLease, { delivered: true })).toBe(false);
    expect(store.finish(newLease, { delivered: true })).toBe(true);
    db.close();
  });
});
