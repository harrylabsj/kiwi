import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  recommendedRetentionPolicy,
  WorkbenchRetentionError,
  WorkbenchRetentionStore,
} from "../src/privacy/workbench-retention.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  let now = "2026-09-21T12:00:00.000Z";
  const store = new WorkbenchRetentionStore({ db, now: () => now });
  return { db, store, setNow: (value: string) => (now = value) };
}

function configure(store: WorkbenchRetentionStore): void {
  store.configurePolicy(
    recommendedRetentionPolicy({
      processor: "北京海纳福星文化传媒有限公司",
      basis: "试点前由数据处理责任人核准的必要处理依据",
      reviewAt: "2026-10-21T00:00:00.000Z",
    }),
  );
}

describe("Workbench retention and Buyer privacy requests", () => {
  it("fails closed until every category has an actual processor, basis and review date", () => {
    const { store } = fixture();
    expect(() =>
      store.receiveBuyerDeletionRequest({ merchantId: "m1", buyerPrincipalId: "buyer-1" }),
    ).toThrow(/lacks actual processor/);
    expect(() => store.configurePolicy([])).toThrowError(WorkbenchRetentionError);
    configure(store);
    expect(store.policyReady()).toBe(true);
  });

  it("receiving a request immediately stops marketing, increments consent generation and creates all cleanup tasks", () => {
    const { db, store } = fixture();
    configure(store);
    const first = store.receiveBuyerDeletionRequest({ merchantId: "m1", buyerPrincipalId: "buyer-1" });
    expect(first.status).toBe("RECEIVED");
    expect(first.consentGeneration).toBe(1);
    expect(store.marketingAllowed("m1", "buyer-1")).toBe(false);
    expect(
      (db.prepare("SELECT count(*) count FROM workbench_privacy_deletion_tasks").get() as {
        count: number;
      }).count,
    ).toBe(4);
    const second = store.receiveBuyerDeletionRequest({ merchantId: "m1", buyerPrincipalId: "buyer-1" });
    expect(second.consentGeneration).toBe(2);
  });

  it("enforces the request state machine and requires real per-node receipts before COMPLETED", () => {
    const { store } = fixture();
    configure(store);
    const request = store.receiveBuyerDeletionRequest({ merchantId: "m1", buyerPrincipalId: "buyer-1" });
    expect(() => store.transition(request.requestId, "PROCESSING")).toThrow(/cannot transition/);
    store.transition(request.requestId, "IDENTITY_CHECK");
    store.transition(request.requestId, "SCOPED");
    store.transition(request.requestId, "PROCESSING");
    expect(() => store.transition(request.requestId, "COMPLETED")).toThrow(/controlled nodes/);
    for (const nodeId of ["runtime-primary", "buyer-preferences", "runtime-cache", "controlled-backup"]) {
      store.recordDeletionTask({
        requestId: request.requestId,
        nodeId,
        status: "completed",
        receiptRef: `receipt-${nodeId}`,
      });
    }
    expect(store.transition(request.requestId, "COMPLETED").status).toBe("COMPLETED");
  });

  it("suppression prevents an older backup generation from reviving deleted consent", () => {
    const { store, setNow } = fixture();
    configure(store);
    const request = store.receiveBuyerDeletionRequest({ merchantId: "m1", buyerPrincipalId: "buyer-1" });
    expect(store.canRestoreSubject("m1", "buyer-1", request.consentGeneration - 1)).toBe(false);
    expect(store.canRestoreSubject("m1", "buyer-1", request.consentGeneration)).toBe(false);
    expect(store.canRestoreSubject("m1", "buyer-1", request.consentGeneration + 1)).toBe(true);
    setNow("2026-11-03T12:00:00.000Z");
    expect(store.canRestoreSubject("m1", "buyer-1", 0)).toBe(true);
  });
});
