import { mkdtempSync, rmSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateA2aSigningIdentity } from "../src/a2a/signing-key.js";
import { CatalogClient } from "../src/cloud/catalog-client.js";
import { priorPublishedCatalogAgentId, selectReusableEnrollment } from "../src/cloud/merchant-connect.js";
import { resolveSignedListingContext } from "../src/cloud/listing-publisher.js";
import { enrollmentStorePath, type EnrollmentChallengeStore } from "../src/cloud/binding/enrollment-challenge.js";
import { buildBindingClaims } from "../src/trust/binding/claims.js";
import { publicKeyThumbprint } from "../src/trust/binding/thumbprint.js";
import { testProfile } from "./helpers.js";

const CATALOG = "https://catalog.example";
const ORIGIN = "https://shop.example";
const MERCHANT = "mkt_catalog_account";
const AGENT = "cagt_catalog_account";
const BINDING = "binding_old";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-connect-migration-"));
  dirs.push(dataDir);
  const identity = loadOrCreateA2aSigningIdentity(dataDir, ORIGIN);
  const thumbprint = publicKeyThumbprint(identity.publicKeyPem);
  const profile = testProfile({ agent_id: "local-shopping-merchant", owner_id: "local-owner" });
  const claims = buildBindingClaims({
    bindingId: BINDING,
    bindingVersion: 1,
    merchantId: MERCHANT,
    agentId: AGENT,
    workloadRef: "enrollment_old",
    runtimeOrigin: ORIGIN,
    a2aEndpoint: `${ORIGIN}/a2a`,
    cardUrl: `${CATALOG}/v1/agents/${AGENT}/agent-card.json`,
    keyId: identity.keyid,
    keyThumbprint: thumbprint,
    serviceEpoch: 1,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    ttlSeconds: 600,
    issuer: CATALOG,
  });
  const store = {
    version: 1,
    sessions: [{
      enrollment_id: "enrollment_old",
      runtime_origin: ORIGIN,
      key_thumbprint: thumbprint,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      status: "published",
      catalog_origin: CATALOG,
      catalog_agent_id: AGENT,
      merchant_id: MERCHANT,
      binding_id: BINDING,
    } as EnrollmentChallengeStore["sessions"][number]],
    consumed: [],
  };
  writeFileSync(enrollmentStorePath(dataDir), JSON.stringify(store), { mode: 0o600 });
  const fetchBinding = (publicationState = "ACTIVE") => (async () => new Response(JSON.stringify({
    claims,
    claims_jws: "tls-trusted-public-document",
    issuer_kid: "catalog-kid",
    issuer_thumbprint: `sha256:${"a".repeat(64)}`,
    governance: { publication_state: publicationState },
    card_revision: 1,
    card_etag: "etag-v1",
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  return { dataDir, identity, thumbprint, profile, store, fetchBinding };
}

describe("Runtime enrollment migration and key-loss safety", () => {
  it("reuses a grant only for the exact key and origin; key loss/origin migration creates a fresh-enrollment decision preserving the Catalog agent", () => {
    const old = {
      enrollment_id: "old",
      runtime_origin: ORIGIN,
      key_thumbprint: "sha256:old-key",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      status: "published" as const,
      catalog_origin: CATALOG,
      catalog_agent_id: AGENT,
      binding_id: BINDING,
    };
    expect(selectReusableEnrollment([old], { runtimeOrigin: ORIGIN, keyThumbprint: "sha256:old-key", nowMs: Date.now() })?.enrollment_id).toBe("old");
    expect(selectReusableEnrollment([old], { runtimeOrigin: ORIGIN, keyThumbprint: "sha256:new-key", nowMs: Date.now() })).toBeUndefined();
    expect(selectReusableEnrollment([old], { runtimeOrigin: "https://new-shop.example", keyThumbprint: "sha256:old-key", nowMs: Date.now() })).toBeUndefined();
    expect(priorPublishedCatalogAgentId([old])).toBe(AGENT);
  });

  it("preserves the historic enrollment for audit and refuses tokenless listing until the replacement key is approved", async () => {
    const f = fixture();
    unlinkSync(path.join(f.dataDir, "a2a-signing-key.json")); // isolated temporary test fixture only
    const catalog = new CatalogClient({ baseUrl: CATALOG, fetchImpl: f.fetchBinding() });
    await expect(resolveSignedListingContext({
      dataDir: f.dataDir,
      profile: f.profile,
      catalogBaseUrl: CATALOG,
      runtimeOrigin: ORIGIN,
      client: catalog,
    })).rejects.toMatchObject({ code: "ENROLLMENT_KEY_MISSING" });
    const persisted = JSON.parse(readFileSync(enrollmentStorePath(f.dataDir), "utf8")) as EnrollmentChallengeStore;
    expect(persisted.sessions[0]?.status).toBe("published");
    expect((persisted.sessions[0] as unknown as { binding_id?: string })?.binding_id).toBe(BINDING);
  });

  it("requires fresh enrollment after key rotation or origin change and preserves the previous Catalog agent", async () => {
    const f = fixture();
    unlinkSync(path.join(f.dataDir, "a2a-signing-key.json"));
    const rotated = loadOrCreateA2aSigningIdentity(f.dataDir, ORIGIN);
    expect(publicKeyThumbprint(rotated.publicKeyPem)).not.toBe(f.thumbprint);
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl: f.fetchBinding() });
    await expect(resolveSignedListingContext({ dataDir: f.dataDir, profile: f.profile, catalogBaseUrl: CATALOG, runtimeOrigin: ORIGIN, client }))
      .rejects.toMatchObject({ code: "ENROLLMENT_REAUTH_REQUIRED" });
    await expect(resolveSignedListingContext({ dataDir: f.dataDir, profile: f.profile, catalogBaseUrl: CATALOG, runtimeOrigin: "https://new-shop.example", client }))
      .rejects.toMatchObject({ code: "ENROLLMENT_REAUTH_REQUIRED" });
    expect(priorPublishedCatalogAgentId(f.store.sessions)).toBe(AGENT);
  });

  it("does not resolve paused publication as online", async () => {
    const f = fixture();
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl: f.fetchBinding("PAUSED") });
    await expect(resolveSignedListingContext({ dataDir: f.dataDir, profile: f.profile, catalogBaseUrl: CATALOG, runtimeOrigin: ORIGIN, client }))
      .rejects.toMatchObject({ code: "ENROLLMENT_BINDING_NOT_ACTIVE" });
  });

  it("uses Catalog enrollment merchant_id rather than a local shopping merchant/profile ID", async () => {
    const f = fixture();
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl: f.fetchBinding() });
    const context = await resolveSignedListingContext({ dataDir: f.dataDir, profile: f.profile, catalogBaseUrl: CATALOG, runtimeOrigin: ORIGIN, client });
    expect(context?.merchantId).toBe(MERCHANT);
    expect(context?.agentId).toBe(AGENT);
    expect(context?.merchantId).not.toBe(f.profile.agent_id);
  });
});
