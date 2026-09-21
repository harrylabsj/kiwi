import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  followRequestDigest,
  MerchantFollowError,
  MerchantFollowStore,
} from "../src/merchant/follow-store.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  let nowMs = Date.parse("2026-09-21T12:00:00.000Z");
  const store = new MerchantFollowStore({ db, now: () => new Date(nowMs).toISOString() });
  return { store, advance: (ms: number) => (nowMs += ms) };
}

function mutate(
  store: MerchantFollowStore,
  action: "follow" | "unfollow",
  context: string,
  revision: number,
  key: string,
) {
  return store.mutate({
    merchantId: "m1",
    buyerPrincipalId: "buyer-1",
    action,
    expectedRevision: revision,
    mutationContext: context,
    idempotencyKey: key,
    requestDigest: followRequestDigest({ action, revision }),
    consentVersion: "v1",
    category: "office",
  });
}

describe("Merchant-authoritative follow store", () => {
  it("requires a fresh action-bound context and atomically revisions follow/unfollow", () => {
    const { store } = fixture();
    const initial = store.read("m1", "buyer-1");
    expect(initial.follow).toMatchObject({ following: false, revision: 0, epoch: 0 });
    const followed = mutate(store, "follow", initial.mutation_contexts.follow.ref, 0, "key-follow");
    expect(followed).toMatchObject({ created: true, replayed: false });
    expect(followed.follow).toMatchObject({ following: true, revision: 1 });
    expect(store.activeCount("m1")).toBe(1);

    expect(() =>
      mutate(store, "unfollow", initial.mutation_contexts.unfollow.ref, 0, "stale"),
    ).toThrow(MerchantFollowError);
    const current = store.read("m1", "buyer-1");
    const cancelled = mutate(store, "unfollow", current.mutation_contexts.unfollow.ref, 1, "key-unfollow");
    expect(cancelled.follow).toMatchObject({ following: false, revision: 2 });
    expect(store.activeCount("m1")).toBe(0);
  });

  it("replays the original receipt but also reports current relationship state", () => {
    const { store } = fixture();
    const initial = store.read("m1", "buyer-1");
    const first = mutate(store, "follow", initial.mutation_contexts.follow.ref, 0, "same-key");
    const replay = mutate(store, "follow", initial.mutation_contexts.follow.ref, 0, "same-key");
    expect(replay.replayed).toBe(true);
    expect(replay.follow.revision).toBe(first.follow.revision);
    expect(() =>
      store.mutate({
        merchantId: "m1",
        buyerPrincipalId: "buyer-1",
        action: "unfollow",
        expectedRevision: 1,
        mutationContext: initial.mutation_contexts.unfollow.ref,
        idempotencyKey: "same-key",
        requestDigest: followRequestDigest({ action: "unfollow", revision: 1 }),
      }),
    ).toThrow(/reused/);
  });

  it("old delayed follow cannot revive a cancellation or privacy invalidation", () => {
    const { store } = fixture();
    const initial = store.read("m1", "buyer-1");
    mutate(store, "follow", initial.mutation_contexts.follow.ref, 0, "f1");
    const active = store.read("m1", "buyer-1");
    const delayedFollow = active.mutation_contexts.follow.ref;
    mutate(store, "unfollow", active.mutation_contexts.unfollow.ref, 1, "u1");
    expect(() => mutate(store, "follow", delayedFollow, 1, "late-follow")).toThrow(/revision is 2/);

    const beforeDeletion = store.read("m1", "buyer-1");
    const contextBeforeDeletion = beforeDeletion.mutation_contexts.follow.ref;
    const invalidated = store.invalidateBuyer("m1", "buyer-1");
    expect(invalidated.epoch).toBe(1);
    expect(invalidated.following).toBe(false);
    expect(() =>
      mutate(store, "follow", contextBeforeDeletion, beforeDeletion.follow.revision, "after-delete"),
    ).toThrow(/expired, used or bound/);
  });

  it("contexts expire in five minutes; tombstone cleanup does not make an old context valid", () => {
    const { store, advance } = fixture();
    const initial = store.read("m1", "buyer-1");
    advance(5 * 60 * 1000 + 1);
    expect(() => mutate(store, "follow", initial.mutation_contexts.follow.ref, 0, "expired")).toThrow(
      /expired/,
    );

    const fresh = store.read("m1", "buyer-1");
    mutate(store, "follow", fresh.mutation_contexts.follow.ref, 0, "f2");
    const active = store.read("m1", "buyer-1");
    mutate(store, "unfollow", active.mutation_contexts.unfollow.ref, 1, "u2");
    advance(31 * 24 * 60 * 60 * 1000);
    expect(store.sweep().tombstones).toBe(1);
    expect(store.read("m1", "buyer-1").follow.following).toBe(false);
  });
});
