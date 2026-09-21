import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMerchantFeedApiHandler } from "../src/http/merchant-feed-api.js";
import { MerchantFeedStore } from "../src/merchant/feed-store.js";

const store = new MerchantFeedStore({ db: new DatabaseSync(":memory:"), cursorKey: randomBytes(32) });
let server: Server;
let base: string;

beforeAll(async () => {
  store.publish("m1", {
    kind: "product_added",
    title: "New item",
    body: "Plain text",
    audience: "public",
  });
  server = createServer(createMerchantFeedApiHandler({ merchantId: "m1", store }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("merchant-feed/1 HTTP adapter", () => {
  it("serves anonymous cursor pages with public revalidation caching", async () => {
    const response = await fetch(`${base}/public/v1/updates?limit=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const etag = response.headers.get("etag")!;
    const body = (await response.json()) as { events: unknown[]; next_cursor: string };
    expect(body.events).toHaveLength(1);
    const unchanged = await fetch(`${base}/public/v1/updates?limit=1`, {
      headers: { "if-none-match": etag },
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
  });

  it("rejects credentials on public routes and returns Problem Details", async () => {
    const response = await fetch(`${base}/public/v1/updates`, {
      headers: { authorization: "Bearer must-not-be-forwarded" },
    });
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("creates an immutable snapshot and pages it separately from later events", async () => {
    const created = await fetch(`${base}/public/v1/updates/snapshot`);
    const snapshot = (await created.json()) as { snapshot_id: string; high_water_cursor: string };
    store.publish("m1", {
      kind: "service_notice",
      title: "Later",
      body: "After snapshot",
      audience: "public",
    });
    const page = await fetch(
      `${base}/public/v1/updates/snapshots/${encodeURIComponent(snapshot.snapshot_id)}?limit=50`,
    );
    expect(page.status).toBe(200);
    const body = (await page.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
    const delta = await fetch(
      `${base}/public/v1/updates?cursor=${encodeURIComponent(snapshot.high_water_cursor)}`,
    );
    expect((await delta.json()) as { events: unknown[] }).toMatchObject({ events: [{}] });
  });

  it("invalid cursors fail before an ETag can produce 304", async () => {
    const response = await fetch(`${base}/public/v1/updates?cursor=bad`, {
      headers: { "if-none-match": '"anything"' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "FEED_CURSOR_INVALID" });
  });
});
