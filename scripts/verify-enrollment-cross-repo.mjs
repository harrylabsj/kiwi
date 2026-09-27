/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 跨仓接入验证：先 npm run build，再运行本脚本。
 * 使用临时账号/密钥/数据库，ASGI 桥接代替网络；生产签名、验证、挑战应答和发布代码均真实执行。
 * 环境：相邻 kiwi-catalog/.venv，或指定 KIWI_CATALOG_REPO / KIWI_CATALOG_PYTHON。
 * 不部署、不访问公网，失败保留临时目录便于诊断。
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { CatalogClient, runtimePublicKey } from "../dist/cloud/catalog-client.js";
import { generateA2aSigningIdentity, toJwsSigningIdentity } from "../dist/a2a/signing-key.js";
import { buildAgentCard } from "../dist/a2a/server/card.js";
import { startEnrollmentHeartbeat } from "../dist/cloud/binding/enrollment-heartbeat.js";
import {
  canonicalizeCatalogListing,
  signedListingDigest,
} from "../dist/cloud/listing-publisher.js";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const catalogRoot = path.resolve(
  process.env.KIWI_CATALOG_REPO ?? path.join(repoRoot, "../kiwi-catalog"),
);
const python = process.env.KIWI_CATALOG_PYTHON ?? path.join(catalogRoot, ".venv/bin/python");
const root = mkdtempSync(path.join(os.tmpdir(), "kiwi-enrollment-cross-"));
const origin = "https://runtime.example";
const catalog = "https://catalog.example";
const raw = generateA2aSigningIdentity(`${origin}/#key`);
const identity = { signingIdentity: toJwsSigningIdentity(raw), keyId: raw.keyid };
const config = {
  runtimeRepo: repoRoot,
  responder: fileURLToPath(new URL("./fixtures/enrollment-responder.mjs", import.meta.url)),
  db: `${root}/catalog.sqlite`,
  dataDir: `${root}/runtime`,
  issuer: `${root}/issuer.pem`,
  runtimeKey: `${root}/runtime.pem`,
  keyId: raw.keyid,
};
mkdirSync(config.dataDir, { mode: 0o700 });
writeFileSync(config.runtimeKey, raw.privateKeyPem, { mode: 0o600 });
writeFileSync(
  config.issuer,
  generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
  { mode: 0o600 },
);
const configPath = `${root}/config.json`;
writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
const calls = [];
function dispatch(method, path, body, headers = {}) {
  const r = spawnSync(
    python,
    [fileURLToPath(new URL("./fixtures/enrollment-bridge.py", import.meta.url)), configPath],
    {
      cwd: catalogRoot,
      env: { ...process.env, PYTHONPATH: catalogRoot },
      input: JSON.stringify({
        method,
        path,
        ...(body === undefined ? {} : { body }),
        headers: { "content-type": "application/json", ...headers },
      }),
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (r.status !== 0) throw new Error(`Python bridge failed: ${r.stderr}\n${r.stdout}`);
  const result = JSON.parse(r.stdout.trim().split("\n").at(-1));
  calls.push({ method, path, status: result.status });
  if (result.status >= 400)
    console.error(JSON.stringify({ method, path, status: result.status, response: result.text }));
  return result;
}
const fetchImpl = async (url, init = {}) => {
  const response = dispatch(
    init.method ?? "GET",
    `${new URL(url).pathname}${new URL(url).search}`,
    init.body === undefined ? undefined : JSON.parse(init.body),
    Object.fromEntries(new Headers(init.headers)),
  );
  return new Response(response.text, { status: response.status, headers: response.headers });
};
const client = new CatalogClient({ baseUrl: catalog, fetchImpl });
const card = buildAgentCard({
  name: "跨语言测试商家",
  description: "临时测试公开资料",
  providerOrganization: "测试",
  version: "1.0.0",
  baseUrl: origin,
  a2aPath: "/a2a",
  securityScheme: {
    name: "kiwi-signature",
    type: "kiwi-http-message-signature",
    keyid: raw.keyid,
    publicKeyPem: raw.publicKeyPem,
    algorithm: "ed25519",
  },
});
const session = await client.createDeviceEnrollment(
  {
    runtimeOrigin: origin,
    a2aEndpoint: `${origin}/a2a`,
    generation: 1,
    serviceEpoch: 1,
    publicPreview: card,
    publicProfileRevision: 1,
  },
  identity,
);
console.log("PASS TS signed device creation -> Python API");
let r = dispatch("POST", "/v1/accounts/register", {
  merchant_name: "跨语言测试商家",
  password: "cross-test-strong-password",
  phone: "+86 138 0000 0000",
  email: "cross-test@example.com",
});
assert.equal(r.status, 200, r.text);
const registered = JSON.parse(r.text);
r = dispatch("POST", "/v1/accounts/verify-email", {
  email: "cross-test@example.com",
  code: registered.verification_code,
});
assert.equal(r.status, 200, r.text);
const cookie = r.headers["set-cookie"].split(";")[0];
r = dispatch("GET", `/v1/accounts/enrollments/${session.enrollmentId}`, undefined, { cookie });
assert.equal(r.status, 200, r.text);
r = dispatch("POST", "/v1/accounts/token-request", {}, { cookie });
assert.equal(r.status, 200, r.text);
const tokenApplicationId = JSON.parse(r.text).application_id;
r = dispatch(
  "POST",
  `/v1/merchants/applications/${tokenApplicationId}/approve`,
  {},
  { authorization: "Bearer cross-test-only-admin" },
);
assert.equal(r.status, 200, "admin listing approval failed: " + JSON.parse(r.text).error);
console.log("PASS admin Listings approval gate (owner token remains server-side)");
r = dispatch(
  "POST",
  `/v1/accounts/enrollments/${session.enrollmentId}/authorize`,
  { user_code: session.userCode },
  { cookie, origin: catalog },
);
assert.equal(r.status, 200, r.text);
console.log("PASS authenticated merchant preview/authorize");
const grant = await client.pollDeviceEnrollment(session.deviceCode, identity);
assert.equal(grant.status, "authorized");
console.log("PASS TS signed grant polling -> Python API");
const { keyThumbprint } = runtimePublicKey(identity);
writeFileSync(
  `${config.dataDir}/merchant-enrollments.json`,
  JSON.stringify({
    version: 1,
    sessions: [
      {
        enrollment_id: session.enrollmentId,
        runtime_origin: origin,
        key_thumbprint: keyThumbprint,
        expires_at: grant.expiresAt,
        status: "authorized",
      },
    ],
    consumed: [],
  }),
  { mode: 0o600 },
);
let binding;
try {
  binding = await client.bindEnrollment(
    {
      enrollmentId: session.enrollmentId,
      grant: grant.grant,
      catalogAgentId: grant.catalogAgentId,
      runtimeOrigin: origin,
      a2aEndpoint: `${origin}/a2a`,
      generation: 1,
      serviceEpoch: 1,
      authorizationEpoch: grant.authorizationEpoch,
      merchantId: grant.merchantId,
    },
    identity,
  );
} catch (error) {
  const debug = dispatch("GET", `/v1/agents/${grant.catalogAgentId}/runtime-binding`);
  let claims = {};
  try {
    const jws = JSON.parse(debug.text).claims_jws;
    claims = JSON.parse(Buffer.from(String(jws).split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    /* Keep diagnostics metadata-only. */
  }
  const fields = [
    "binding_id",
    "binding_version",
    "merchant_id",
    "agent_id",
    "runtime_origin",
    "a2a_endpoint",
    "card_url",
    "key_id",
    "key_thumbprint",
    "service_epoch",
    "issuer",
    "status",
  ];
  console.error(
    JSON.stringify(
      {
        bindingVerificationError: error instanceof Error ? error.message : String(error),
        actual: Object.fromEntries(fields.map((key) => [key, claims[key]])),
        expected: {
          catalogAgentId: grant.catalogAgentId,
          merchantId: grant.merchantId,
          origin,
          endpoint: `${origin}/a2a`,
          keyId: identity.keyId,
          keyThumbprint: runtimePublicKey(identity).keyThumbprint,
          issuerExpectedFromJWKS: config.expectedIssuer ?? "catalog.kiwi",
        },
      },
      null,
      2,
    ),
  );
  throw error;
}
console.log("PASS grant + TS Runtime challenge responder -> Python automatic binding");
const published = await client.publishCard(
  {
    agentId: grant.catalogAgentId,
    bindingId: binding.bindingId,
    generation: 1,
    expectedRevision: 0,
    agentCard: card,
    a2aEndpoint: `${origin}/a2a`,
    runtimeOrigin: origin,
    casRetry: false,
  },
  identity,
);
assert.ok(published.revision);
await client.activateCard(
  {
    agentId: grant.catalogAgentId,
    bindingId: binding.bindingId,
    cardRevision: published.revision,
    expectedRevision: 0,
    casRetry: false,
  },
  identity,
);
r = dispatch("GET", `/v1/agents/${grant.catalogAgentId}/agent-card.json`);
assert.equal(r.status, 200, r.text);
r = dispatch("GET", `/v1/agents/${grant.catalogAgentId}`);
assert.equal(r.status, 200, r.text);
assert.ok(r.text.includes(`/v1/agents/${grant.catalogAgentId}/agent-card.json`), r.text);
r = dispatch("GET", "/v1/agents/search?verification_level=commerce_verified");
assert.equal(r.status, 200, r.text);
assert.ok(
  r.text.includes(grant.catalogAgentId),
  "published merchant missing from verified catalog search: " + r.text,
);
const listingContext = {
  catalogAgentId: grant.catalogAgentId,
  merchantId: grant.merchantId,
  bindingId: binding.bindingId,
  keyId: identity.keyId,
};
const listing = canonicalizeCatalogListing(
  {
    listing_type: "product",
    source_product_ref: "SKU-CROSS-1",
    title: "临时验收商品",
    category: "test-products",
    attributes: { size: "1" },
    regions: ["CN"],
  },
  listingContext.catalogAgentId,
  listingContext.merchantId,
);
const listingDigest = signedListingDigest(listing);
const listingResult = await client.publishSignedListing(
  {
    catalogAgentId: listingContext.catalogAgentId,
    merchantId: listingContext.merchantId,
    bindingId: listingContext.bindingId,
    idempotencyKey: `cross-listing-${listingDigest.slice(-16)}`,
    listingDigest,
    listing,
  },
  identity,
);
assert.ok(listingResult.listingId);
const selfListings = await client.listSignedListings(listingContext, identity, { limit: 100 });
assert.ok(selfListings.results.some((item) => item["listing_id"] === listingResult.listingId));
await client.withdrawSignedListing(listingContext, identity, {
  listingId: listingResult.listingId,
  idempotencyKey: `cross-withdraw-${listingResult.listingId}`,
});
console.log(
  "PASS approved Runtime publishes, reads and withdraws listings without sending an owner token",
);
writeFileSync(
  `${config.dataDir}/merchant-enrollments.json`,
  JSON.stringify({
    version: 1,
    sessions: [
      {
        enrollment_id: session.enrollmentId,
        runtime_origin: origin,
        key_thumbprint: keyThumbprint,
        expires_at: grant.expiresAt,
        status: "published",
        catalog_origin: catalog,
        catalog_agent_id: grant.catalogAgentId,
        binding_id: binding.bindingId,
      },
    ],
    consumed: [],
  }),
  { mode: 0o600 },
);
const heartbeat = startEnrollmentHeartbeat({
  dataDir: config.dataDir,
  signingIdentity: identity.signingIdentity,
  fetchImpl,
});
try {
  await heartbeat.tick();
} finally {
  heartbeat.stop();
}
console.log("PASS long-running Runtime heartbeat uses the active binding signature");
await assert.rejects(() =>
  client.publishCard(
    {
      agentId: grant.catalogAgentId,
      bindingId: binding.bindingId,
      generation: 1,
      expectedRevision: published.revision,
      agentCard: { ...card, description: "未经批准的内容" },
      a2aEndpoint: `${origin}/a2a`,
      runtimeOrigin: origin,
      casRetry: false,
    },
    identity,
  ),
);
console.log("PASS merchant-approved card cannot be replaced by a differently signed card");
r = dispatch(
  "POST",
  `/v1/agents/${grant.catalogAgentId}/runtime-bindings`,
  {
    enrollment_id: session.enrollmentId,
    grant: grant.grant,
    binding: {
      runtime_origin: origin,
      a2a_endpoint: `${origin}/a2a`,
      key_jwk: runtimePublicKey(identity).keyJwk,
      key_id: identity.keyId,
      generation: 1,
      service_epoch: 1,
    },
  },
  { "x-kiwi-binding-jws": "fake.signature.value" },
);
assert.ok(r.status >= 400, "forged signature accepted");
r = dispatch(
  "POST",
  `/v1/accounts/agents/${grant.catalogAgentId}/card/pause`,
  { expected_revision: published.revision },
  { cookie, origin: catalog },
);
assert.equal(r.status, 200, r.text);
await assert.rejects(() =>
  client.activateCard(
    {
      agentId: grant.catalogAgentId,
      bindingId: binding.bindingId,
      cardRevision: published.revision,
      expectedRevision: published.revision,
      casRetry: false,
    },
    identity,
  ),
);
console.log("PASS paused card cannot be reactivated by automatic Runtime publication");
assert.ok(calls.some((call) => call.path === "/v1/issuer-keys" && call.status === 200));
assert.ok(calls.some((call) => call.path.endsWith("/heartbeat") && call.status === 200));
console.log(
  JSON.stringify({
    result: "PASS",
    steps: [
      "signed device request",
      "authenticated authorization",
      "signed grant poll",
      "real TS challenge response",
      "automatic binding",
      "Catalog issuer signature verification",
      "signed card publication",
      "activation",
      "public card and discovery",
      "signed heartbeat",
      "tamper and paused publication rejection",
      "approved, tokenless signed Listings publish/self-list/withdraw",
    ],
    requests: calls.length,
    temporaryRoot: root,
  }),
);
