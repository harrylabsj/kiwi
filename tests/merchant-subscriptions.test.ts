import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MerchantSubscriptionClient } from "../src/discovery/merchant-subscriptions.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-buyer-subscriptions-"));
  dirs.push(dir);
  let following = false;
  let revision = 0;
  let cursor = "cursor-0";
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });
    if (url.endsWith("/buyer/v1/follow") && init?.method === "GET") {
      return Response.json(
        {
          follow: { merchant_id: "m1", following, revision, epoch: 0 },
          mutation_contexts: {
            follow: { ref: `follow-${revision}` },
            unfollow: { ref: `unfollow-${revision}` },
          },
        },
        { headers: { etag: `"follow-0-${revision}"` } },
      );
    }
    if (url.endsWith("/buyer/v1/follow") && init?.method === "PUT") {
      following = true;
      revision += 1;
      return Response.json({
        follow: { merchant_id: "m1", following, revision, epoch: 0, category: "office" },
        created: true,
      });
    }
    if (url.endsWith("/buyer/v1/follow") && init?.method === "DELETE") {
      following = false;
      revision += 1;
      return Response.json({ follow: { merchant_id: "m1", following, revision, epoch: 0 } });
    }
    if (url.includes("/public/v1/updates")) {
      const event = {
        event_id: "event-1",
        event_type: "published",
        broadcast_id: "broadcast-1",
        revision: 1,
        payload: { title: "New" },
        created_at: "2026-09-21T12:00:00Z",
      };
      cursor = "cursor-1";
      return Response.json({ events: [event], next_cursor: cursor, has_more: false });
    }
    return new Response("not found", { status: 404 });
  };
  const client = new MerchantSubscriptionClient({
    dbPath: path.join(dir, "buyer.sqlite"),
    resolver: {
      resolve: async () => ({ origin: "https://merchant.example", bearerToken: "buyer-token" }),
    },
    fetchImpl,
    now: () => "2026-09-21T12:00:00Z",
  });
  return { client, calls };
}

describe("Buyer MerchantSubscriptionClient", () => {
  it("follows via merchant authority, persists preference, pulls Feed without leaking credential", async () => {
    const { client, calls } = fixture();
    const followed = await client.follow("m1", { category: "office", consent_version: "v1" });
    expect(followed).toMatchObject({ created: true, follow: { merchant_id: "m1", status: "active" } });
    expect(await client.listFollows()).toMatchObject([
      { merchant_id: "m1", status: "active", category: "office", consent_version: "v1" },
    ]);
    const updates = await client.getUpdates();
    expect(updates[0]?.events).toMatchObject([
      { event_id: "event-1", publication_id: "broadcast-1", version: 1 },
    ]);
    const publicCalls = calls.filter((call) => call.url.includes("/public/v1/updates"));
    expect(publicCalls.every((call) => call.auth === null)).toBe(true);
    expect(calls.filter((call) => call.url.includes("/buyer/v1/follow")).every((call) => call.auth === "Bearer buyer-token")).toBe(true);
    client.close();
  });

  it("unfollow persists locally and removes the merchant from future pulls", async () => {
    const { client, calls } = fixture();
    await client.follow("m1");
    await client.unfollow("m1");
    expect(await client.listFollows()).toEqual([]);
    const before = calls.length;
    expect(await client.getUpdates()).toEqual([]);
    expect(calls).toHaveLength(before);
    client.close();
  });

  it("rejects untrusted non-HTTPS origins before transmitting the Buyer credential", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-buyer-subscriptions-"));
    dirs.push(dir);
    let called = false;
    const client = new MerchantSubscriptionClient({
      dbPath: path.join(dir, "buyer.sqlite"),
      resolver: { resolve: async () => ({ origin: "http://127.0.0.1:9999", bearerToken: "secret" }) },
      fetchImpl: async () => {
        called = true;
        return new Response();
      },
    });
    await expect(client.follow("m1")).rejects.toThrow(/HTTPS origin/);
    expect(called).toBe(false);
    client.close();
  });
});
