import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMerchantFollowApiHandler } from "../src/http/merchant-follow-api.js";
import { MerchantFollowStore } from "../src/merchant/follow-store.js";

const store = new MerchantFollowStore({ db: new DatabaseSync(":memory:") });
let server: Server;
let base: string;
let authenticatedBody: Buffer | undefined;

beforeAll(async () => {
  server = createServer(
    createMerchantFollowApiHandler({
      merchantId: "m1",
      store,
      resolveBuyer: (req, body) => {
        authenticatedBody = body;
        const auth = req.headers.authorization;
        if (auth === "Bearer buyer-1") return { merchantId: "m1", buyerPrincipalId: "buyer-1" };
        if (auth === "Bearer wrong-merchant") {
          return { merchantId: "m2", buyerPrincipalId: "buyer-1" };
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

async function request(
  method: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Response> {
  return await fetch(`${base}/buyer/v1/follow`, {
    method,
    headers: { authorization: "Bearer buyer-1", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("merchant-follow/1 HTTP adapter", () => {
  it("does not accept request-body identity and requires verified authentication", async () => {
    const unauthenticated = await fetch(`${base}/buyer/v1/follow`);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    const crossMerchant = await fetch(`${base}/buyer/v1/follow`, {
      headers: { authorization: "Bearer wrong-merchant" },
    });
    expect(crossMerchant.status).toBe(404);
  });

  it("GET supplies ETag/action contexts; PUT and DELETE enforce them", async () => {
    const initial = await request("GET");
    expect(initial.status).toBe(200);
    const etag0 = initial.headers.get("etag")!;
    const view0 = (await initial.json()) as {
      follow: { following: boolean; revision: number };
      mutation_contexts: { follow: { ref: string }; unfollow: { ref: string } };
    };
    expect(view0.follow).toMatchObject({ following: false, revision: 0 });

    const missingIfMatch = await request("PUT", {}, { category: "office" });
    expect(missingIfMatch.status).toBe(428);
    const followed = await request(
      "PUT",
      {
        "if-match": etag0,
        "idempotency-key": "follow-1",
        "x-mutation-context": view0.mutation_contexts.follow.ref,
      },
      { category: "office", consent_version: "v1" },
    );
    expect(followed.status).toBe(200);
    expect(JSON.parse(authenticatedBody?.toString("utf8") ?? "{}")).toEqual({
      category: "office",
      consent_version: "v1",
    });
    const etag1 = followed.headers.get("etag")!;
    expect(await followed.json()).toMatchObject({ follow: { following: true, revision: 1 } });

    const stale = await request("DELETE", {
      "if-match": etag0,
      "idempotency-key": "unfollow-stale",
      "x-mutation-context": view0.mutation_contexts.unfollow.ref,
    });
    expect(stale.status).toBe(412);

    const current = await request("GET");
    const view1 = (await current.json()) as {
      mutation_contexts: { unfollow: { ref: string } };
    };
    const unfollowed = await request("DELETE", {
      "if-match": etag1,
      "idempotency-key": "unfollow-1",
      "x-mutation-context": view1.mutation_contexts.unfollow.ref,
    });
    expect(unfollowed.status).toBe(200);
    expect(await unfollowed.json()).toMatchObject({ follow: { following: false, revision: 2 } });
  });

  it("rejects unknown body fields and mismatched action contexts", async () => {
    const state = await request("GET");
    const etag = state.headers.get("etag")!;
    const view = (await state.json()) as { mutation_contexts: { unfollow: { ref: string } } };
    const unknown = await request(
      "PUT",
      {
        "if-match": etag,
        "idempotency-key": "bad-fields",
        "x-mutation-context": view.mutation_contexts.unfollow.ref,
      },
      { buyer_principal_id: "attacker" },
    );
    expect(unknown.status).toBe(422);
  });
});
