import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMerchantEngagementApiHandler } from "../src/http/merchant-engagement-api.js";
import { MerchantEngagementStore } from "../src/merchant/engagement-store.js";

const store = new MerchantEngagementStore({ db: new DatabaseSync(":memory:") });
let server: Server;
let base: string;
let signedBody = "";

beforeAll(async () => {
  server = createServer(
    createMerchantEngagementApiHandler({
      merchantId: "m1",
      store,
      broadcastExists: (id) => id === "broadcast-1",
      resolveBuyer: (request, body) => {
        signedBody = body.toString("utf8");
        return request.headers.authorization === "Signature verified"
          ? { merchantId: "m1", buyerPrincipalId: "buyer-1" }
          : undefined;
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(event_type: string, key: string): Promise<Response> {
  return await fetch(`${base}/buyer/v1/broadcast-events`, {
    method: "POST",
    headers: {
      authorization: "Signature verified",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({
      broadcast_id: "broadcast-1",
      event_type,
      occurred_at: "2026-09-22T00:00:00.000Z",
    }),
  });
}

describe("verified Buyer broadcast engagement API", () => {
  it("requires verified identity and passes exact body bytes to authentication", async () => {
    const unauthorized = await fetch(`${base}/buyer/v1/broadcast-events`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "unauthorized" },
      body: JSON.stringify({
        broadcast_id: "broadcast-1",
        event_type: "received",
        occurred_at: "2026-09-22T00:00:00.000Z",
      }),
    });
    expect(unauthorized.status).toBe(401);
    const received = await post("received", "received-1");
    expect(received.status).toBe(201);
    expect(JSON.parse(signedBody)).toMatchObject({ event_type: "received" });
  });

  it("does not infer presentation/click from HTTP success and enforces sequence", async () => {
    expect(store.summary("m1")).toEqual({ received: 1, presented: 0, clicked: 0 });
    expect((await post("clicked", "clicked-too-soon")).status).toBe(412);
    expect((await post("presented", "presented-1")).status).toBe(201);
    expect((await post("clicked", "clicked-1")).status).toBe(201);
    expect(store.summary("m1")).toEqual({ received: 1, presented: 1, clicked: 1 });
  });
});
