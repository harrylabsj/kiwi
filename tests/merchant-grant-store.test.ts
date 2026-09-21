import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createVerifiedActorContext } from "../src/merchant/application/actor.js";
import {
  isCurrentGrantAuthorization,
  MerchantGrantStore,
} from "../src/merchant/grant-store.js";

const EXPIRES = "2026-10-21T00:00:00.000Z";
const actor = (role: "owner" | "operator" | "viewer", id: string = role) =>
  createVerifiedActorContext({
    actorId: id,
    merchantId: "m1",
    role,
    authMethod: "admin-session",
    generation: 1,
    requestId: `req-${id}`,
    expiresAt: "2026-09-22T00:00:00.000Z",
  });

describe("Merchant scoped grants", () => {
  it("requires owner grant administration and explicit merchant action grants", () => {
    const store = new MerchantGrantStore({
      db: new DatabaseSync(":memory:"),
      now: () => "2026-09-21T00:00:00.000Z",
    });
    expect(() =>
      store.createGrant(actor("operator"), {
        subjectId: "op-1",
        action: "broadcast.decide",
        resourceType: "merchant",
        resourceSelector: "merchant",
        expiresAt: EXPIRES,
      }),
    ).toThrow(/only owner/);
    const grant = store.createGrant(actor("owner"), {
      subjectId: "op-1",
      action: "broadcast.decide",
      resourceType: "merchant",
      resourceSelector: "merchant",
      expiresAt: EXPIRES,
    });
    expect(
      store.authorize(actor("operator", "op-1"), {
        action: "broadcast.decide",
        resourceType: "merchant",
      }),
    ).toMatchObject({ authorized: true, generation: 1, grantIds: [grant.grant_id] });
    expect(
      store.authorize(actor("operator", "op-1"), {
        action: "runtime.safety_stop",
        resourceType: "merchant",
      }).authorized,
    ).toBe(false);
  });

  it("requires every SKU in a multi-product candidate to be covered", () => {
    const store = new MerchantGrantStore({
      db: new DatabaseSync(":memory:"),
      now: () => "2026-09-21T00:00:00.000Z",
    });
    store.createGrant(actor("owner"), {
      subjectId: "op-1",
      action: "product.decide",
      resourceType: "product",
      resourceSelector: ["sku-a", "sku-b"],
      expiresAt: EXPIRES,
    });
    expect(
      store.authorize(actor("operator", "op-1"), {
        action: "product.decide",
        resourceType: "product",
        resourceIds: ["sku-a", "sku-b"],
      }).authorized,
    ).toBe(true);
    expect(
      store.authorize(actor("operator", "op-1"), {
        action: "product.decide",
        resourceType: "product",
        resourceIds: ["sku-a", "sku-c"],
      }).authorized,
    ).toBe(false);
  });

  it("revocation advances generation and invalidates authorization; owner remains authorized", () => {
    const store = new MerchantGrantStore({
      db: new DatabaseSync(":memory:"),
      now: () => "2026-09-21T00:00:00.000Z",
    });
    const grant = store.createGrant(actor("owner"), {
      subjectId: "op-1",
      action: "product.create",
      resourceType: "merchant",
      resourceSelector: "merchant",
      expiresAt: EXPIRES,
    });
    expect(store.revokeGrant(actor("owner"), grant.grant_id)).toBe(2);
    expect(
      store.authorize(actor("operator", "op-1"), {
        action: "product.create",
        resourceType: "merchant",
      }),
    ).toMatchObject({ authorized: false, generation: 2 });
    expect(
      store.authorize(actor("owner"), {
        action: "broadcast.decide",
        resourceType: "merchant",
      }).authorized,
    ).toBe(true);
  });

  it("invalidates a frozen decision authorization before worker execution", () => {
    const store = new MerchantGrantStore({
      db: new DatabaseSync(":memory:"),
      now: () => "2026-09-21T00:00:00.000Z",
    });
    const grant = store.createGrant(actor("owner"), {
      subjectId: "op-1",
      action: "broadcast.decide",
      resourceType: "merchant",
      resourceSelector: "merchant",
      expiresAt: EXPIRES,
    });
    const snapshot = {
      actor_id: "op-1",
      actor_role: "operator",
      action: "broadcast.decide",
      authorization_generation: 1,
      matched_grant_ids: [grant.grant_id],
    };
    expect(
      isCurrentGrantAuthorization(store, {
        merchantId: "m1",
        actorId: "op-1",
        action: "broadcast.decide",
        snapshot,
      }),
    ).toBe(true);
    store.revokeGrant(actor("owner"), grant.grant_id);
    expect(
      isCurrentGrantAuthorization(store, {
        merchantId: "m1",
        actorId: "op-1",
        action: "broadcast.decide",
        snapshot,
      }),
    ).toBe(false);
  });
});
