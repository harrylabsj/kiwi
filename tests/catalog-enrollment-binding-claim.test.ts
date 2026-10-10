import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateA2aSigningIdentity, toJwsSigningIdentity } from "../src/a2a/signing-key.js";
import { CatalogClient, runtimePublicKey } from "../src/cloud/catalog-client.js";
import { buildBindingClaims, type BuildBindingClaimsInput } from "../src/trust/binding/claims.js";
import { jwkThumbprint } from "../src/trust/binding/thumbprint.js";
import { signCompactJws, verifyCompactJws } from "../src/trust/identity/jws.js";

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
  const requests: { url: string; method: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: Parameters<typeof fetch>[1]) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" });
    const value = String(url).endsWith("/issuer-keys")
      ? { issuer: CATALOG, keys: [{ kid: issuer.keyid, state: "ACTIVE", jwk, thumbprint: issuerThumbprint }] }
      : { binding_id: claims.binding_id, binding_version: claims.binding_version, key_thumbprint: keyThumbprint, binding_claim: bindingClaim };
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl, now: () => NOW });
  return { client, runtime, keyThumbprint, claims, bindingClaim, issuerPublicKey: issuerPair.publicKey, requests };
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

  it("rejects a cryptographically valid but expired declaration before returning or using binding authority", async () => {
    const fixture = setup({ issuedAt: new Date(NOW.getTime() - 60_000).toISOString(), ttlSeconds: 30 });
    // Independent signature proof: expiry is the only failing authority condition.
    const verified = verifyCompactJws(fixture.bindingClaim.claims_jws, fixture.issuerPublicKey);
    expect(JSON.parse(verified.payload.toString("utf8"))).toEqual(fixture.claims);
    expect(Date.parse(fixture.claims.expires_at)).toBeLessThan(NOW.getTime());
    const before = JSON.stringify(fixture.bindingClaim);
    let returnedBinding: unknown;
    await expect(bind(fixture.client, fixture.runtime).then(value => { returnedBinding = value; }))
      .rejects.toMatchObject({ code: "RESPONSE_INVALID", message: "Catalog signed binding is not current" });
    expect(returnedBinding).toBeUndefined();
    expect(JSON.stringify(fixture.bindingClaim)).toBe(before);
    // Only the requested bind and authenticated-key read occurred: no publication,
    // activation, retry, owner-token fallback or follow-up mutation was attempted.
    expect(fixture.requests).toEqual([
      { url: `${CATALOG}/v1/agents/${AGENT}/runtime-bindings`, method: "POST" },
      { url: `${CATALOG}/v1/issuer-keys`, method: "GET" },
    ]);
  });

  it.each([
    ["wrong agent", { agentId: "cagt_other" }, "agent_id"],
    ["wrong Runtime key id", { keyId: "other-runtime-key" }, "key_id"],
    ["wrong service epoch", { serviceEpoch: 2 }, "service_epoch"],
  ])("rejects a validly signed but mismatched %s", async (_label, overrides, expectedField) => {
    const { client, runtime } = setup(overrides);
    // A15：失配走独立稳定码 CLAIM_MISMATCH，并携带自有字段名词表供阶段码归类。
    const failure = (await bind(client, runtime).catch((err: unknown) => err as { code?: string; claimFields?: string[] })) as { code?: string; claimFields?: string[] };
    expect(failure).toMatchObject({ code: "CLAIM_MISMATCH" });
    expect(failure.claimFields).toContain(expectedField);
  });
});
