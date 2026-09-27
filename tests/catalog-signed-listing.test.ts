import { generateA2aSigningIdentity, toJwsSigningIdentity } from "../src/a2a/signing-key.js";
import { CatalogClient } from "../src/cloud/catalog-client.js";
import { canonicalize } from "../src/negotiation/jcs.js";
import { verifyCompactJws } from "../src/trust/identity/jws.js";
import { createPublicKey, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const CATALOG = "https://catalog.example";
const AGENT = "cagt_signed_001";
const MERCHANT = "mkt_signed_001";
const BINDING = "binding_signed_001";

function identity() {
  const raw = generateA2aSigningIdentity("https://shop.example");
  return { raw, runtime: { signingIdentity: toJwsSigningIdentity(raw), keyId: raw.keyid } };
}

const listing = {
  listing_type: "product",
  owner_agent_id: AGENT,
  merchant_id: MERCHANT,
  source_product_ref: "SKU-1",
  title: "Public Widget",
  category: "widgets",
};

describe("Catalog binding-signed listing publish", () => {
  it("signs the canonical listing and sends no owner credential", async () => {
    const { raw, runtime } = identity();
    let requestHeaders: Headers | undefined;
    let requestBody: Record<string, unknown> | undefined;
    let claims: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string | URL, init?: Parameters<typeof fetch>[1]) => {
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const signature = requestHeaders.get("x-kiwi-binding-jws");
      if (signature === null) throw new Error("missing binding signature");
      claims = JSON.parse(verifyCompactJws(signature, createPublicKey(raw.publicKeyPem)).payload.toString("utf8")) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, idempotent: false, listing: { listing_id: "lst_001" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl, now: () => new Date("2026-09-27T00:00:00.000Z"), nonceFactory: () => "distinct-runtime-nonce-123456" });
    const digest = `sha256:${createHash("sha256").update(canonicalize(listing), "utf8").digest("hex")}`;
    const result = await client.publishSignedListing({
      catalogAgentId: AGENT,
      merchantId: MERCHANT,
      bindingId: BINDING,
      idempotencyKey: "kiwi-listing:stable-key",
      listingDigest: digest,
      listing,
    }, runtime);

    expect(result).toEqual({ listingId: "lst_001", idempotent: false });
    expect(requestBody).toEqual(listing);
    expect(requestBody).not.toHaveProperty("owner_token");
    expect(requestHeaders?.has("authorization")).toBe(false);
    expect(requestHeaders?.get("Idempotency-Key")).toBe("kiwi-listing:stable-key");
    expect(claims).toMatchObject({
      method: "POST",
      path: "/v1/listings/publish",
      audience: "kiwi-catalog",
      agent_id: AGENT,
      merchant_id: MERCHANT,
      binding_id: BINDING,
      key_id: runtime.keyId,
      listing_digest: digest,
      idempotency_key: "kiwi-listing:stable-key",
    });
    expect(typeof claims?.["nonce"]).toBe("string");
  });

  it("rejects an enrollment without current admin-approved listing entitlement without owner-token fallback", async () => {
    const { runtime } = identity();
    let requestCount = 0;
    const fetchImpl = (async (_url: string | URL, init?: Parameters<typeof fetch>[1]) => {
      requestCount += 1;
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(String(init?.body)).not.toContain("owner_token");
      return new Response(JSON.stringify({ error: "LISTINGS_APPROVAL_REQUIRED" }), { status: 403, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    const digest = `sha256:${createHash("sha256").update(canonicalize(listing), "utf8").digest("hex")}`;
    await expect(client.publishSignedListing({
      catalogAgentId: AGENT,
      merchantId: MERCHANT,
      bindingId: BINDING,
      idempotencyKey: "kiwi-listing:stable-key",
      listingDigest: digest,
      listing,
    }, runtime)).rejects.toMatchObject({
      code: "REQUEST_REJECTED",
      remoteCode: "LISTINGS_APPROVAL_REQUIRED",
    });
    expect(requestCount).toBe(1);
  });

  it("rejects a body whose route identity does not match before sending", async () => {
    const { runtime } = identity();
    const fetchImpl = (async () => { throw new Error("must not send mismatched body"); }) as typeof fetch;
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    await expect(client.publishSignedListing({
      catalogAgentId: AGENT,
      merchantId: MERCHANT,
      bindingId: BINDING,
      idempotencyKey: "kiwi-listing:stable-key",
      listingDigest: `sha256:${"a".repeat(64)}`,
      listing: { ...listing, merchant_id: "mkt_other" },
    }, runtime)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
