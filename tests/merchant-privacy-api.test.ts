import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMerchantPrivacyApiHandler } from "../src/http/merchant-privacy-api.js";
import {
  recommendedRetentionPolicy,
  WorkbenchRetentionStore,
} from "../src/privacy/workbench-retention.js";

const store = new WorkbenchRetentionStore({ db: new DatabaseSync(":memory:") });
let server: Server;
let base: string;

beforeAll(async () => {
  store.configurePolicy(
    recommendedRetentionPolicy({
      processor: "test processor",
      basis: "test-approved necessary processing basis",
      reviewAt: "2026-10-22T00:00:00.000Z",
    }),
  );
  server = createServer(
    createMerchantPrivacyApiHandler({
      merchantId: "m1",
      store,
      resolveBuyer: (request) => {
        if (request.headers.authorization === "Signature buyer-1") {
          return { merchantId: "m1", buyerPrincipalId: "buyer-1" };
        }
        if (request.headers.authorization === "Signature buyer-2") {
          return { merchantId: "m1", buyerPrincipalId: "buyer-2" };
        }
        return undefined;
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

describe("verified Buyer privacy request API", () => {
  it("accepts deletion without merchant approval and scopes status to the same Buyer", async () => {
    const unauthorized = await fetch(`${base}/buyer/v1/privacy-requests`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    const accepted = await fetch(`${base}/buyer/v1/privacy-requests`, {
      method: "POST",
      headers: { authorization: "Signature buyer-1" },
    });
    expect(accepted.status).toBe(202);
    const request = (await accepted.json()) as { request_id: string; status: string };
    expect(request.status).toBe("RECEIVED");

    const own = await fetch(`${base}/buyer/v1/privacy-requests/${request.request_id}`, {
      headers: { authorization: "Signature buyer-1" },
    });
    expect(own.status).toBe(200);
    const other = await fetch(`${base}/buyer/v1/privacy-requests/${request.request_id}`, {
      headers: { authorization: "Signature buyer-2" },
    });
    expect(other.status).toBe(404);
  });
});
