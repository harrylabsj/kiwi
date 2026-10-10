#!/usr/bin/env node
/** Actual installed/staged imports + signed committed proof/receipt/guarded SDK root; synthetic only, no model input. */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const dir = path.resolve(process.argv[2] ?? "build/cloud-package");
const app = path.join(dir, process.argv[3] ?? "app");
const resolverDir = mkdtempSync(path.join(dir, ".shipping-resolver-"));
const resolverFile = path.join(resolverDir, "resolve.mjs");
writeFileSync(resolverFile, "export const resolve = spec => import.meta.resolve(spec);\n");
const { resolve: resolveEsm } = await import(pathToFileURL(resolverFile).href);
const load = (p) => import(pathToFileURL(path.join(app, p)).href);
let requests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  requests++;
  throw new Error("SHIPPING_SYNTHETIC_NETWORK_FORBIDDEN");
};
const temp = mkdtempSync(path.join(tmpdir(), "shipping-runtime-"));
const db = new DatabaseSync(":memory:");
try {
  for (const spec of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-durable",
    "@earendil-works/pi-coding-agent",
    "@simplewebauthn/server",
  ])
    await import(resolveEsm(spec));
  await load("cloud/main.js");
  const owner = await load("merchant/ai-runtime/owner-session.js");
  assert.deepEqual(owner.readOwnerSessionSwitches({}), {
    ownerEnabled: false,
    aiRuntimeEnabled: false,
  });
  const { WorkbenchConfirmationStore } = await load(
    "http/merchant-management/webauthn-confirmation.js",
  );
  const { migrateMemorySchema } = await load("agent/memory/schema.js");
  migrateMemorySchema(db);
  const { WriteApprovalCandidateStore, contentHash } = await load(
    "agent/merchant/action-candidate.js",
  );
  const { OwnerCommittedProofAuthority } = await load(
    "merchant/ai-runtime/owner-committed-proof.js",
  );
  const { OwnerOperationReader } = await load("merchant/ai-runtime/owner-operation-reader.js");
  const { EXACT_PRODUCT_TOOLS } = await load("merchant/exact-product-executors.js");
  const { WORKBENCH_CURRENCY_TABLE_VERSION: table } = await load("merchant/application/money.js");
  const now = new Date().toISOString(),
    expiry = new Date(Date.now() + 240000).toISOString();
  const merchant = "synthetic-shipping-merchant",
    principal = "synthetic-shipping-principal",
    actor = "synthetic-shipping-actor",
    upstream = "synthetic-upstream";
  db.prepare(
    "INSERT INTO principals (principal_id,owner_id,role,created_at,updated_at) VALUES (?,?,'merchant',?,?)",
  ).run(principal, merchant, now, now);
  const candidates = new WriteApprovalCandidateStore({
    db,
    principalId: principal,
    ownerMerchantId: merchant,
    now: () => now,
  });
  const confirmations = new WorkbenchConfirmationStore({ db, now: () => now });
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  confirmations.persistVerifiedCredential({
    registrationVerified: true,
    credentialId: "synthetic-credential",
    merchantId: merchant,
    actorId: actor,
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    rpId: "synthetic.invalid",
    origin: "https://synthetic.invalid",
  });
  const args = {
    sku: "synthetic-sku",
    expected_authority_version: 7,
    money: { currency: "CNY", amount_minor: "18000", currency_table_version: table },
  };
  const preconditions = {
    sku: args.sku,
    currency: "CNY",
    price_minor: "18900",
    currency_table_version: table,
    authority_version: 7,
    merchant_id: merchant,
    principal,
    business_key: owner.businessKey(EXACT_PRODUCT_TOOLS.updateMoney, args),
  };
  const candidate = candidates.create({
    tool: EXACT_PRODUCT_TOOLS.updateMoney,
    arguments: args,
    preconditions,
    risk: "write_catalog",
    expires_at: expiry,
  });
  const binding = {
    operationId: "synthetic-shipping-op",
    merchantId: merchant,
    principal,
    actorId: actor,
    upstreamMerchantId: upstream,
    authoritySource: "synthetic-authority",
    subjectSource: "synthetic-subject",
    candidateId: candidate.candidate_id,
    actionDigest: contentHash({ arguments: args, preconditions }),
    sku: args.sku,
    expectedMoneyAuthorityVersion: 7,
    approvalGeneration: 1,
    expiresAt: expiry,
    kind: EXACT_PRODUCT_TOOLS.updateMoney,
    currency: "CNY",
    amountMinor: "18000",
    currencyTableVersion: table,
    arguments: args,
    preconditions,
  };
  const request = confirmations.createRequest({
    merchantId: merchant,
    actorId: actor,
    candidateId: candidate.candidate_id,
    approvalGeneration: 1,
    decision: "approve",
    operationId: binding.operationId,
    actionDigest: binding.actionDigest,
    actionSnapshot: { decision_authorization: binding },
    expectedVersion: 7,
    expiresAt: expiry,
  });
  const data = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: request.challenge,
      origin: "https://synthetic.invalid",
      crossOrigin: false,
    }),
  );
  const auth = Buffer.alloc(37);
  createHash("sha256").update("synthetic.invalid").digest().copy(auth);
  auth[32] = 5;
  auth.writeUInt32BE(1, 33);
  confirmations.finalizeDecision({
    confirmationId: request.confirmationId,
    merchantId: merchant,
    actorId: actor,
    candidateId: candidate.candidate_id,
    approvalGeneration: 1,
    decision: "approve",
    actionDigest: binding.actionDigest,
    expectedVersion: 7,
    assertion: {
      credentialId: "synthetic-credential",
      clientDataJSON: data.toString("base64url"),
      authenticatorData: auth.toString("base64url"),
      signature: sign(
        "sha256",
        Buffer.concat([auth, createHash("sha256").update(data).digest()]),
        pair.privateKey,
      ).toString("base64url"),
    },
  });
  const authority = new OwnerCommittedProofAuthority({
    confirmations,
    confirmationDb: db,
    candidates,
    merchantId: merchant,
    principal,
    authoritySource: binding.authoritySource,
    now: () => now,
    subject: {
      source: binding.subjectSource,
      resolve: () => ({
        principal,
        upstreamMerchantId: upstream,
        generation: 1,
        expiresAt: expiry,
        revoked: false,
      }),
    },
  });
  const permit = authority.issue(binding.operationId);
  assert.equal(authority.inspect(permit).operationId, binding.operationId);
  assert.throws(() => authority.inspect({}));
  const receipt = {
    operation_id: binding.operationId,
    merchant_id: upstream,
    operation_kind: "exact_product_money_update",
    sku: args.sku,
    status: "succeeded",
    result: {
      expected_authority_version: 7,
      product: {
        merchant_id: upstream,
        sku: args.sku,
        currency: "CNY",
        price_minor: "18000",
        currency_table_version: table,
        authority_version: 8,
      },
    },
  };
  const reader = new OwnerOperationReader({
    source: binding.authoritySource,
    upstreamMerchantId: upstream,
    timeoutMs: 100,
    client: { getProductOperation: async () => receipt },
  });
  assert.equal((await reader.read(binding)).status, "applied");
  receipt.result.product.price_minor = "17999";
  assert.equal((await reader.read(binding)).status, "unknown");
  const { Harness, createRegistry } = await import(resolveEsm("@earendil-works/pi-durable"));
  const { createModels } = await import(resolveEsm("@earendil-works/pi-ai/models"));
  const { openNodeSqliteStorage } = await import(
    resolveEsm("@earendil-works/pi-durable/storage/sqlite/node")
  );
  const { BACKGROUND_CONTEXT } = await import(resolveEsm("@earendil-works/chord/context"));
  const storage = await load("merchant/ai-runtime/owner-storage-admission.js");
  const storageBinding = { storageRoot: temp, merchantId: merchant, principal };
  const cap = storage.prepareNewOwnerStorage(storageBinding);
  const harness = await Harness.open(
    storage.guardOwnerStorage(
      await openNodeSqliteStorage(
        path.join(owner.merchantStorageDir(temp, merchant), "session.sqlite"),
      ),
      cap,
    ),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: "openai", modelId: "gpt-4o" } },
    });
    storage.assertOwnerStorageReady(cap);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
  assert.equal(requests, 0);
  console.log(
    JSON.stringify({
      installed_package: dir,
      default_owner_dual_off: true,
      full_pi_imports: true,
      actual_signed_committed_permit: true,
      actual_receipt_positive_and_negative: true,
      actual_guarded_sdk_root: true,
      model_submissions: 0,
      provider_requests: requests,
    }),
  );
} finally {
  db.close();
  globalThis.fetch = originalFetch;
  rmSync(temp, { recursive: true, force: true });
  rmSync(resolverDir, { recursive: true, force: true });
}
