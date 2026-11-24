/**
 * Copyright 2026 harrylabsj
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ManualSupportService } from "../src/merchant-core/support/manual-service.js";
import { createVerifiedActorContext } from "../src/merchant/application/actor.js";

const DAY = 86_400_000;
const START = Date.parse("2026-11-24T00:00:00.000Z");
const databases: DatabaseSync[] = [];

afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  let now = START;
  let ownershipChecksLeft = Infinity;
  const service = new ManualSupportService(db, {
    merchantId: "fixture-merchant", now: () => now,
    assertOwner: () => { if (ownershipChecksLeft-- <= 0) throw new Error("lease lost"); },
  });
  const staff = (overrides: Partial<Parameters<typeof createVerifiedActorContext>[0]> = {}) => createVerifiedActorContext({
    actorId: "fixture-owner", merchantId: "fixture-merchant", role: "owner", authMethod: "admin-session",
    generation: 1, requestId: "fixture-request", expiresAt: new Date(START + 120 * DAY).toISOString(), ...overrides,
  });
  const input = { client_message_id: randomUUID(), description: "合成售后请求", sku: "A-1" };
  return {
    db, service, staff, input,
    advance(days: number) { now += days * DAY; },
    allowOwnerChecks(count: number) { ownershipChecksLeft = count; },
  };
}

describe("manual support", () => {
  it("rolls back both the case and receipt if ownership expires before commit", () => {
    const f = fixture();
    const cookie = f.service.begin().token!;
    const session = f.db.prepare("SELECT token_digest FROM support_sessions").get();
    expect(session?.token_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(session)).not.toContain(cookie);
    f.allowOwnerChecks(1);
    expect(() => f.service.confirmCase(cookie, f.input)).toThrow(expect.objectContaining({ code: "unavailable" }));
    expect(() => f.service.updates(cookie, {})).toThrow(expect.objectContaining({ code: "unavailable" }));
    f.allowOwnerChecks(Infinity);
    expect(f.service.list(f.staff())).toEqual([]);
    expect(f.service.updates(cookie, {}).events).toEqual([]);
    const accepted = f.service.confirmCase(cookie, f.input);
    expect(f.service.confirmCase(cookie, f.input)).toEqual(accepted);
    expect(f.service.updates(cookie, {}).events).toHaveLength(1);
  });

  it("renews a valid idle window but never extends the absolute expiry or restores an expired case", () => {
    const f = fixture();
    const cookie = f.service.begin().token!;
    f.service.confirmCase(cookie, f.input);
    const id = f.service.list(f.staff())[0]!.case_id;
    f.advance(29);
    expect(f.service.begin(cookie)).toEqual({ reset: false });
    const staysIdle = f.service.begin().token!;
    f.advance(29);
    expect(f.service.ownCase(cookie, id)).toMatchObject({ case_id: id });
    f.advance(1);
    expect(() => f.service.updates(staysIdle, {})).toThrow(expect.objectContaining({ code: "unauthorized" }));
    f.advance(28);
    const cursor = f.service.updates(cookie, {}).next_cursor;
    f.advance(3);
    expect(() => f.service.updates(cookie, { after: cursor })).toThrow(expect.objectContaining({ code: "unauthorized" }));
    expect(() => f.service.confirmCase(cookie, f.input)).toThrow(expect.objectContaining({ code: "unauthorized" }));
    const replacement = f.service.begin(cookie);
    expect(replacement.reset).toBe(true);
    expect(() => f.service.ownCase(replacement.token, id)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(f.service.detail(f.staff(), id)).toMatchObject({ access_active: false, state: "WAITING_MERCHANT" });
  });

  it("binds manual replies to the current claimant and revision, including resolution notes", () => {
    const f = fixture();
    const cookie = f.service.begin().token!;
    f.service.confirmCase(cookie, f.input);
    const id = f.service.list(f.staff())[0]!.case_id;
    for (const actor of [f.staff({ role: "operator" }), f.staff({ merchantId: "other-merchant" }), f.staff({ authMethod: "service-identity" })]) {
      expect(() => f.service.detail(actor, id)).toThrow(expect.objectContaining({ code: "forbidden" }));
      expect(() => f.service.change(actor, id, 1, { kind: "claim" })).toThrow(expect.objectContaining({ code: "forbidden" }));
    }
    expect(f.service.change(f.staff(), id, 1, { kind: "claim" })).toMatchObject({ revision: 2, state: "IN_PROGRESS" });
    expect(() => f.service.change(f.staff({ actorId: "different-owner" }), id, 2, { kind: "reply", text: "wrong assignee" }))
      .toThrow(expect.objectContaining({ code: "conflict" }));
    expect(f.service.change(f.staff(), id, 2, { kind: "reply", text: "合成回复" })).toMatchObject({ revision: 3 });
    expect(() => f.service.change(f.staff(), id, 2, { kind: "resolve", text: "stale" })).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(f.service.change(f.staff(), id, 3, { kind: "resolve", text: "合成解决说明" })).toMatchObject({ revision: 4, state: "RESOLVED" });
    const replies = [{ kind: "human_reply", text: "合成回复" }, { kind: "resolved", text: "合成解决说明" }];
    expect(f.service.detail(f.staff(), id)).toMatchObject({ replies });
    expect(f.service.updates(cookie, {}).events.slice(2)).toMatchObject(replies);
  });

  it("pages the buyer feed in both directions without duplicating or crossing sessions", () => {
    const f = fixture();
    const cookie = f.service.begin().token!;
    const empty = f.service.updates(cookie, {});
    const other = f.service.begin().token!;
    f.service.confirmCase(cookie, f.input);
    f.service.confirmCase(other, f.input);
    const id = f.service.updates(cookie, {}).events[0]!.case_id;
    const staff = f.staff();
    f.service.change(staff, id, 1, { kind: "claim" });
    for (let n = 0; n < 81; n++) f.service.change(staff, id, n + 2, { kind: "reply", text: `reply ${n}` });
    const latest = f.service.updates(cookie, {});
    const older = f.service.updates(cookie, { before: latest.previous_cursor! });
    const earliest = f.service.updates(cookie, { before: older.previous_cursor! });
    expect([latest.events.length, older.events.length, earliest.events.length]).toEqual([40, 40, 3]);
    expect(earliest.previous_cursor).toBeNull();
    const feed = [...earliest.events, ...older.events, ...latest.events];
    expect(feed.every((event) => event.case_id === id)).toBe(true);
    expect(new Set(feed.map((event) => event.id)).size).toBe(83);
    const first = f.service.updates(cookie, { after: empty.next_cursor });
    const second = f.service.updates(cookie, { after: first.next_cursor });
    const third = f.service.updates(cookie, { after: second.next_cursor });
    expect([...first.events, ...second.events, ...third.events]).toEqual(feed);
    expect(f.service.updates(cookie, { after: third.next_cursor })).toMatchObject({ events: [], next_cursor: third.next_cursor });
    expect(() => f.service.updates(other, { before: latest.previous_cursor! })).toThrow(expect.objectContaining({ code: "validation" }));
  });
});
