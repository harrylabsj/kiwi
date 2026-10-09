import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPublicKey, generateKeyPairSync, createHash } from "node:crypto";
import { loadOrCreateA2aSigningIdentity } from "../src/a2a/signing-key.js";
import { merchantPublish } from "../src/product-publish.js";
import { buildBindingClaims } from "../src/trust/binding/claims.js";
import { publicKeyThumbprint } from "../src/trust/binding/thumbprint.js";
import { verifyCompactJws, signCompactJws } from "../src/trust/identity/jws.js";
import type { AgentProfile } from "../src/config/profile.js";
import { testProfile } from "./helpers.js";

const CATALOG = "https://catalog.example";
const ORIGIN = "https://shop.example";
const CATALOG_AGENT = "cagt_connected_001";
const BINDING_ID = "binding_connected_001";
const MERCHANT = "mkt_account_001";
const OWNER_TOKEN = "must-not-be-forwarded";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("merchant publish using a connected Runtime binding", () => {
  it("publishes canonical projections with a binding signature and no owner credentials", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "kiwi-signed-listings-"));
    dirs.push(dataDir);
    const identity = loadOrCreateA2aSigningIdentity(dataDir, ORIGIN);
    const thumbprint = publicKeyThumbprint(identity.publicKeyPem);
    const exp = new Date(Date.now() + 10 * 60_000).toISOString();
    const claims = buildBindingClaims({
      bindingId: BINDING_ID,
      bindingVersion: 2,
      merchantId: MERCHANT,
      agentId: CATALOG_AGENT,
      workloadRef: "enrollment_test",
      runtimeOrigin: ORIGIN,
      a2aEndpoint: `${ORIGIN}/a2a`,
      cardUrl: `${CATALOG}/v1/agents/${CATALOG_AGENT}/agent-card.json`,
      keyId: identity.keyid,
      keyThumbprint: thumbprint,
      serviceEpoch: 1,
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      ttlSeconds: 600,
      issuer: CATALOG,
    });
    // Synthetic issuer fixture exercises the real current binding verifier.
    const issuer = generateKeyPairSync("ed25519");
    const jwk = issuer.publicKey.export({ format: "jwk" });
    const issuerThumbprint = `sha256:${createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("hex")}`;
    const bindingDocument = {
      claims,
      claims_jws: signCompactJws({ ...claims }, { keyid: "catalog-issuer", algorithm: "ed25519", privateKey: issuer.privateKey }),
      issuer_kid: "catalog-issuer",
      issuer_thumbprint: issuerThumbprint,
      governance: { publication_state: "ACTIVE" },
      card_revision: 1,
      card_etag: '"card-v1"',
    };
    writeFileSync(path.join(dataDir, "merchant-enrollments.json"), JSON.stringify({
      version: 1,
      sessions: [{
        enrollment_id: "enrollment_test",
        runtime_origin: ORIGIN,
        key_thumbprint: thumbprint,
        catalog_origin: CATALOG,
        catalog_agent_id: CATALOG_AGENT,
        merchant_id: MERCHANT,
        binding_id: BINDING_ID,
        status: "published",
        expires_at: exp,
        grant: "private-grant-in-local-0600-file",
      }],
      consumed: [],
    }), { mode: 0o600 });

    const calls: Array<{ url: string; method: string; headers: Headers; body?: Record<string, unknown> }> = [];
    let publishCount = 0;
    const fetchImpl = (async (url: string | URL, init?: Parameters<typeof fetch>[1]) => {
      const parsed = new URL(String(url));
      const method = String(init?.method ?? "GET");
      const headers = new Headers(init?.headers);
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      const body = rawBody === undefined || rawBody === "" ? undefined : JSON.parse(rawBody) as Record<string, unknown>;
      calls.push({ url: parsed.toString(), method, headers, ...(body !== undefined ? { body } : {}) });
      if (parsed.pathname === "/v1/issuer-keys") {
        return new Response(JSON.stringify({issuer: CATALOG, keys: [{kid:"catalog-issuer", state:"ACTIVE", jwk, thumbprint:issuerThumbprint}]}), {status:200,headers:{"content-type":"application/json"}});
      }
      if (parsed.pathname === `/v1/agents/${CATALOG_AGENT}/runtime-binding`) {
        return new Response(JSON.stringify(bindingDocument), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (parsed.pathname === "/v1/listings/publish" && method === "POST") {
        publishCount += 1;
        expect(headers.has("x-kiwi-binding-jws")).toBe(true);
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("idempotency-key")).toMatch(/^kiwi-listing:/);
        expect(body).not.toHaveProperty("owner_token");
        expect(body).not.toHaveProperty("admin_token");
        expect(JSON.stringify(init)).not.toContain(OWNER_TOKEN);
        const jws = headers.get("x-kiwi-binding-jws")!;
        const verified = verifyCompactJws(jws, createPublicKey(identity.publicKeyPem));
        const signed = JSON.parse(verified.payload.toString("utf8")) as Record<string, unknown>;
        expect(signed).toMatchObject({
          method: "POST",
          path: "/v1/listings/publish",
          audience: "kiwi-catalog",
          agent_id: CATALOG_AGENT,
          merchant_id: MERCHANT,
          binding_id: BINDING_ID,
          key_id: identity.keyid,
          idempotency_key: headers.get("idempotency-key"),
        });
        expect(String(signed.listing_digest)).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(String(signed.nonce).length).toBeGreaterThanOrEqual(16);
        return new Response(JSON.stringify({ ok: true, created: true, idempotent: false, listing: { listing_id: `lst_${publishCount}` } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (parsed.pathname === `/v1/agents/${CATALOG_AGENT}/listings` && method === "GET") {
        expect(parsed.searchParams.has("owner_token")).toBe(false);
        expect(headers.get("x-kiwi-binding-jws")).toBeTruthy();
        const signed = JSON.parse(verifyCompactJws(headers.get("x-kiwi-binding-jws")!, createPublicKey(identity.publicKeyPem)).payload.toString("utf8")) as Record<string, unknown>;
        expect(signed).toMatchObject({ method: "GET", audience: "kiwi-catalog", agent_id: CATALOG_AGENT, merchant_id: MERCHANT, binding_id: BINDING_ID });
        expect(signed.query_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        return new Response(JSON.stringify({ ok: true, results: [{ listing_type: "product", owner_agent_id: CATALOG_AGENT, merchant_id: MERCHANT, source_product_ref: "SKU-GONE", listing_id: "lst_gone", publication_state: "ACTIVE" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (parsed.pathname === "/v1/listings/lst_gone/withdraw" && method === "POST") {
        expect(body).toEqual({});
        expect(headers.has("authorization")).toBe(false);
        expect(headers.get("idempotency-key")).toMatch(/^kiwi-withdraw:/);
        expect(headers.get("x-kiwi-binding-jws")).toBeTruthy();
        expect(JSON.stringify(init)).not.toContain(OWNER_TOKEN);
        const signed = JSON.parse(verifyCompactJws(headers.get("x-kiwi-binding-jws")!, createPublicKey(identity.publicKeyPem)).payload.toString("utf8")) as Record<string, unknown>;
        expect(signed).toMatchObject({
          method: "POST",
          path: "/v1/listings/lst_gone/withdraw",
          audience: "kiwi-catalog",
          agent_id: CATALOG_AGENT,
          merchant_id: MERCHANT,
          binding_id: BINDING_ID,
          listing_id: "lst_gone",
          idempotency_key: headers.get("idempotency-key"),
        });
        expect(signed.body_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        return new Response(JSON.stringify({ ok: true, idempotent: false, listing: { listing_id: "lst_gone", publication_state: "WITHDRAWN" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected signed publish request: ${method} ${parsed}`);
    }) as typeof fetch;

    const profile: AgentProfile = testProfile({
      agent_id: "local-shopping-merchant",
      owner_id: "local-owner",
      merchant_public: { public_url: ORIGIN, catalog_url: CATALOG },
    });
    const report = await merchantPublish({
      profile,
      catalogBaseUrl: CATALOG,
      ownerToken: OWNER_TOKEN,
      ownerTokenSecret: "must-not-be-derived-or-forwarded",
      shoppingCliDb: "/tmp/shop.sqlite",
      dataDir,
      runtimeOrigin: ORIGIN,
      fetchImpl,
      spawnImpl: ((_cmd: string, args: string[]) => args.includes("--version")
        ? { status: 0, stdout: "shopping.py 2.0.0\n", stderr: "" }
        : { status: 0, stdout: JSON.stringify({ ok: true, results: [{ listing_type: "product", source_product_ref: "SKU-1", title: "Widget", category: "widgets" }] }), stderr: "" }) as unknown as typeof import("node:child_process").spawnSync,
    });

    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.steps.agent.catalog_agent_id).toBe(CATALOG_AGENT);
    expect(report.steps.listings.authorization_mode).toBe("runtime_binding");
    expect(report.steps.listings.reconcile_complete).toBe(true);
    expect(report.steps.listings.published_refs).toEqual(["SKU-1"]);
    expect(report.steps.listings.withdrawn_refs).toEqual(["SKU-GONE"]);
    expect(publishCount).toBe(1);
    expect(calls.some((call) => call.url.includes("/v1/agent-catalog/agents/register"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/v1/agent-catalog/merchants/"))).toBe(false);
    expect(calls.every((call) => !call.url.includes("owner_token="))).toBe(true);
  });
});
