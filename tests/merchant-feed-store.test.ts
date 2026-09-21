import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { MerchantFeedError, MerchantFeedStore } from "../src/merchant/feed-store.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  let nowMs = Date.parse("2026-09-21T12:00:00.000Z");
  const store = new MerchantFeedStore({
    db,
    cursorKey: randomBytes(32),
    now: () => new Date(nowMs).toISOString(),
  });
  return { store, advance: (ms: number) => (nowMs += ms) };
}

function input(title = "New product") {
  return {
    kind: "product_added",
    title,
    body: "Plain text update",
    skuRefs: ["sku-1"],
    audience: "public" as const,
  };
}

describe("Merchant public Feed", () => {
  it("publishes, revises and withdraws as strictly increasing cursor events", () => {
    const { store } = fixture();
    const published = store.publish("m1", input());
    const first = store.read("m1");
    expect(first.kind).toBe("events");
    if (first.kind !== "events") return;
    expect(first.events.map((event) => [event.seq, event.event_type])).toEqual([[1, "published"]]);
    const revised = store.revise("m1", published.broadcast_id, 1, input("Revised"));
    expect(revised.revision).toBe(2);
    store.withdraw("m1", published.broadcast_id, 2);
    expect(store.summary("m1")).toEqual({ total: 1, published: 0, withdrawn: 1 });
    const remaining = store.read("m1", { cursor: first.next_cursor });
    expect(remaining.kind).toBe("events");
    if (remaining.kind === "events") {
      expect(remaining.events.map((event) => [event.seq, event.event_type])).toEqual([
        [2, "revised"],
        [3, "withdrawn"],
      ]);
    }
  });

  it("validates cursor/reset before ETag and 304 never advances progress", () => {
    const { store, advance } = fixture();
    store.publish("m1", input());
    const first = store.read("m1");
    expect(first.kind).toBe("events");
    if (first.kind !== "events") return;
    expect(store.read("m1", { ifNoneMatch: first.etag })).toEqual({
      kind: "not_modified",
      etag: first.etag,
    });
    expect(() =>
      store.read("m1", { cursor: `${first.next_cursor}tampered`, ifNoneMatch: first.etag }),
    ).toThrow(/cursor/);

    store.publish("m1", input("also expired"));
    advance(31 * 24 * 60 * 60 * 1000);
    store.publish("m1", input("new retained"));
    store.sweep();
    expect(() =>
      store.read("m1", { cursor: first.next_cursor, ifNoneMatch: first.etag }),
    ).toThrowError(MerchantFeedError);
  });

  it("creates a consistent paged snapshot with a high-water cursor", () => {
    const { store } = fixture();
    for (let index = 0; index < 3; index += 1) store.publish("m1", input(`title-${index}`));
    const snapshot = store.createSnapshot("m1");
    const first = store.readSnapshotPage("m1", snapshot.snapshot_id, 0, 2);
    expect(first.items).toHaveLength(2);
    expect(first.next_offset).toBe(2);
    store.publish("m1", input("after-snapshot"));
    const second = store.readSnapshotPage("m1", snapshot.snapshot_id, 2, 2);
    expect(second.items).toHaveLength(1);
    expect(second.next_offset).toBeNull();
    const delta = store.read("m1", { cursor: snapshot.high_water_cursor });
    expect(delta.kind).toBe("events");
    if (delta.kind === "events") expect(delta.events).toHaveLength(1);
  });

  it("rejects non-public audience, rich/control content, invalid precision and stale revisions", () => {
    const { store } = fixture();
    expect(() => store.publish("m1", { ...input(), audience: "private" as never })).toThrow(
      /audience/,
    );
    expect(() => store.publish("m1", { ...input(), body: "bad\u202Etext" })).toThrow(/content/);
    expect(() => store.publish("m1", { ...input(), body: "x".repeat(4001) })).toThrow(/content/);
    const item = store.publish("m1", input());
    expect(() => store.revise("m1", item.broadcast_id, 99, input("stale"))).toThrow(/revision/);
  });
});
