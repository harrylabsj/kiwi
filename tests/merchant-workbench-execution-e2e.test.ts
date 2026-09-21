import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import { FakeMerchantClient, fakeMerchantProduct } from "../src/agent/merchant/fake-merchant-client.js";
import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import { createMerchantManagementApiHandler } from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import {
  WorkbenchReconciliationStore,
  WorkbenchReconciliationWorker,
  type OperationResult,
} from "../src/http/merchant-management/reconciliation-worker.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import { WorkbenchConfirmationStore } from "../src/http/merchant-management/webauthn-confirmation.js";
import { merchantAdminSurface } from "../src/merchant-admin/pending-page.js";
import { MerchantCoreService } from "../src/merchant-core/service.js";
import { testProfile } from "./helpers.js";

const MERCHANT = "merchant-001";
const PRINCIPAL = "merchant-agent:merchant-001";
const HUMAN = "owner:merchant-001";
const ORIGIN = "https://merchant.example";
const RP_ID = "merchant.example";
const NOW = new Date("2026-09-21T12:00:00.000Z");

const db = new DatabaseSync(":memory:");
const sessions = new MerchantAdminSessions({ db: new DatabaseSync(":memory:") });
const confirmations = new WorkbenchConfirmationStore({ db, now: () => NOW.toISOString() });
const reconciliations = new WorkbenchReconciliationStore({ db, now: () => NOW.toISOString(), jitter: () => 0 });
const client = new FakeMerchantClient({ products: [fakeMerchantProduct()] });
const keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const credentialId = "credential-e2e";

let core: MerchantCoreService;
let server: Server;
let base: string;
let auth: { cookie: string; csrf: string };

beforeAll(async () => {
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals
     (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, ?, 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, MERCHANT, NOW.toISOString(), NOW.toISOString());
  const approvals = new WriteApprovalCandidateStore({
    db,
    principalId: PRINCIPAL,
    now: () => NOW.toISOString(),
  });
  core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: client,
    approvals,
    mode: () => "supervised",
    now: () => NOW.toISOString(),
    commandPrincipalId: PRINCIPAL,
  });
  const admin = merchantAdminSurface(core);
  confirmations.persistVerifiedCredential({
    registrationVerified: true,
    credentialId,
    merchantId: MERCHANT,
    actorId: HUMAN,
    publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    rpId: RP_ID,
    origin: ORIGIN,
  });
  const operations = new MerchantManagementOperationStore({ db, now: () => NOW.toISOString() });
  server = createServer(
    createMerchantManagementApiHandler({
      merchantId: MERCHANT,
      generation: () => 1,
      runtimeVersion: "test",
      sessions,
      allowedOrigins: [ORIGIN],
      listPending: () => admin.listPending(),
      mintCandidateConfirmation: () => "legacy-not-used",
      executeDecision: async () => {},
      drafts: new MerchantImportDraftStore({ db, now: () => NOW.toISOString() }),
      operations,
      serviceState: new MutableServiceState("OPERATING"),
      readiness: async () => ({ ready: true, checks: {} }),
      workbenchConfirmations: confirmations,
      now: () => NOW,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  const session = sessions.createSession({ principalId: HUMAN, merchantId: MERCHANT, role: "owner" });
  const sessionResponse = await fetch(`${base}/merchant/api/session`, {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${session.sessionId}` },
  });
  const sessionBody = (await sessionResponse.json()) as { csrf_token: string };
  auth = { cookie: `${ADMIN_SESSION_COOKIE}=${session.sessionId}`, csrf: sessionBody.csrf_token };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function post(path: string, body: unknown): Promise<Response> {
  return await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      cookie: auth.cookie,
      origin: ORIGIN,
      "x-csrf-token": auth.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function makeAssertion(challenge: string): Record<string, string> {
  const clientData = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
  );
  const authenticatorData = Buffer.alloc(37);
  createHash("sha256").update(RP_ID).digest().copy(authenticatorData);
  authenticatorData[32] = 0x05;
  authenticatorData.writeUInt32BE(1, 33);
  const signed = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientData).digest(),
  ]);
  return {
    credential_id: credentialId,
    client_data_json: clientData.toString("base64url"),
    authenticator_data: authenticatorData.toString("base64url"),
    signature: sign("sha256", signed, keyPair.privateKey).toString("base64url"),
  };
}

describe("Workbench WebAuthn → outbox → Merchant Core E2E", () => {
  it("executes exactly the committed candidate and the worker becomes idle", async () => {
    const prepared = await core.prepareInventoryUpdate({ sku: "sku-001", stock: 5 });
    const candidateId = prepared.candidate.candidate_id;
    const created = await post("/merchant/api/v1/confirmations", {
      candidate_id: candidateId,
      decision: "approve",
    });
    const descriptor = (await created.json()) as { confirmation_id: string };
    const optionResponse = await post(
      `/merchant/api/v1/confirmations/${encodeURIComponent(descriptor.confirmation_id)}/assertion-options`,
      {},
    );
    const assertionOptions = (await optionResponse.json()) as { challenge: string };
    const decision = await post(
      `/merchant/api/v1/approvals/${encodeURIComponent(candidateId)}/decisions`,
      {
        confirmation_id: descriptor.confirmation_id,
        decision: "approve",
        expected_version: 1,
        assertion: makeAssertion(assertionOptions.challenge),
      },
    );
    expect(decision.status).toBe(202);

    const admin = merchantAdminSurface(core);
    const worker = new WorkbenchReconciliationWorker(reconciliations, {
      workerId: "test-worker",
      merchantId: MERCHANT,
      execute: async (lease): Promise<OperationResult> => {
        await admin.executeCommittedDecision!(
          {
            operationId: lease.operationId,
            candidateId: lease.candidateId,
            actorId: lease.actorId,
            decision: lease.decision,
          },
          confirmations,
        );
        return { status: "succeeded" };
      },
      query: async () => ({ status: "unknown", error: "not expected" }),
    });
    expect(await worker.runOnce()).toBe("outbox");
    expect((await client.getProduct("sku-001")).stock).toBe(5);
    expect(core.getCommand(candidateId)?.status).toBe("executed");
    expect(await worker.runOnce()).toBe("idle");
  });
});
