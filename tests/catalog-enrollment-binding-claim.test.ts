import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateA2aSigningIdentity, toJwsSigningIdentity } from "../src/a2a/signing-key.js";
import { CatalogClient, runtimePublicKey } from "../src/cloud/catalog-client.js";
import { buildBindingClaims, type BuildBindingClaimsInput } from "../src/trust/binding/claims.js";
import { jwkThumbprint } from "../src/trust/binding/thumbprint.js";
import { signCompactJws } from "../src/trust/identity/jws.js";

const CATALOG = "https://catalog.example";
const ORIGIN = "https://shop.example";
const AGENT = "cagt_demo";
const NOW = new Date("2026-09-27T00:00:00.000Z");

function setup(overrides: Partial<BuildBindingClaimsInput> = {}) {
  const runtimeKey = generateA2aSigningIdentity(ORIGIN);
  const runtime = { signingIdentity: toJwsSigningIdentity(runtimeKey), keyId: runtimeKey.keyid };
  const { keyThumbprint } = runtimePublicKey(runtime);
  const issuerPair = generateKeyPairSync("ed25519");
  const issuer = { keyid: "catalog-issuer-1", algorithm: "ed25519" as const, privateKey: issuerPair.privateKey };
  const jwk = createPublicKey(issuerPair.privateKey).export({ format: "jwk" }) as Record<string, unknown>;
  const issuerThumbprint = jwkThumbprint(jwk);
  const claims = buildBindingClaims({
    bindingId: "binding_demo",
    bindingVersion: 1,
    merchantId: "merchant_demo",
    agentId: AGENT,
    workloadRef: "enrollment_demo",
    runtimeOrigin: ORIGIN,
    a2aEndpoint: `${ORIGIN}/a2a`,
    cardUrl: `${CATALOG}/v1/agents/${AGENT}/agent-card.json`,
    keyId: runtime.keyId,
    keyThumbprint,
    serviceEpoch: 1,
    issuedAt: NOW.toISOString(),
    ttlSeconds: 300,
    issuer: CATALOG,
    ...overrides,
  });
  const bindingClaim = {
    claims,
    claims_jws: signCompactJws(claims as unknown as Record<string, unknown>, issuer),
    issuer_kid: issuer.keyid,
    issuer_thumbprint: issuerThumbprint,
    governance: { publication_state: "UNPUBLISHED" },
    card_revision: null,
    card_etag: null,
  };
  const fetchImpl = (async (url: string | URL) => {
    const value = String(url).endsWith("/issuer-keys")
      ? { issuer: CATALOG, keys: [{ kid: issuer.keyid, state: "ACTIVE", jwk, thumbprint: issuerThumbprint }] }
      : { binding_id: claims.binding_id, binding_version: claims.binding_version, key_thumbprint: keyThumbprint, binding_claim: bindingClaim };
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl, now: () => NOW });
  return { client, runtime, keyThumbprint };
}

async function bind(client: CatalogClient, runtime: ReturnType<typeof setup>["runtime"]) {
  return await client.bindEnrollment({
    enrollmentId: "enroll_demo_123",
    grant: "opaque-grant-secret-for-test",
    catalogAgentId: AGENT,
    merchantId: "merchant_demo",
    runtimeOrigin: ORIGIN,
    a2aEndpoint: `${ORIGIN}/a2a`,
    generation: 1,
    serviceEpoch: 1,
    authorizationEpoch: 1,
  }, runtime);
}

describe("enrollment binding declaration trust", () => {
  it("verifies the Catalog JWS through the configured Catalog origin JWKS and matches the frozen identity", async () => {
    const { client, runtime, keyThumbprint } = setup();
    const result = await bind(client, runtime);
    expect(result).toMatchObject({ bindingId: "binding_demo", bindingVersion: 1, keyThumbprint });
  });

  it.each([
    ["expired declaration", { issuedAt: new Date(NOW.getTime() - 60_000).toISOString(), ttlSeconds: 30 }],
    ["wrong agent", { agentId: "cagt_other" }],
    ["wrong Runtime key id", { keyId: "other-runtime-key" }],
    ["wrong service epoch", { serviceEpoch: 2 }],
  ])("rejects a validly signed but mismatched %s", async (_label, overrides) => {
    const { client, runtime } = setup(overrides);
    await expect(bind(client, runtime)).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  });
});
