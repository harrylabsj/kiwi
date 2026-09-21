import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { WriteApprovalCandidate } from "../src/agent/merchant/action-candidate.js";
import { ADMIN_SESSION_COOKIE, MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import { createMerchantManagementApiHandler } from "../src/http/merchant-management/api.js";
import { MerchantImportDraftStore } from "../src/http/merchant-management/draft-store.js";
import { MerchantManagementOperationStore } from "../src/http/merchant-management/operation-store.js";
import { MutableServiceState } from "../src/http/merchant-management/service-state.js";
import { WorkbenchConfirmationStore } from "../src/http/merchant-management/webauthn-confirmation.js";

const MERCHANT = "merchant-wb-api";
const ACTOR = "owner:merchant-wb-api";
const ORIGIN = "https://merchant.example";
const RP_ID = "merchant.example";
const NOW = new Date("2026-09-21T12:00:00.000Z");
const db = new DatabaseSync(":memory:");
const sessions = new MerchantAdminSessions({ db: new DatabaseSync(":memory:") });
const confirmations = new WorkbenchConfirmationStore({ db, now: () => NOW.toISOString() });
const keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const credentialId = "credential-workbench-api";
const candidate: WriteApprovalCandidate = {
  candidate_id: "candidate-workbench-api",
  principal_id: "merchant-agent:merchant-wb-api",
  tool: "kiwi_merchant_prepare_inventory_update",
  arguments: { sku: "sku-1", stock: 5 },
  arguments_hash: "sha256:args",
  preconditions: { stock: 10, revision: 1 },
  preconditions_hash: "sha256:pre",
  risk: "write_catalog",
  status: "pending_approval",
  expires_at: "2026-09-21T13:00:00.000Z",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

let server: Server;
let base: string;
let auth: { cookie: string; csrf: string };

beforeAll(async () => {
  confirmations.persistVerifiedCredential({
    registrationVerified: true,
    credentialId,
    merchantId: MERCHANT,
    actorId: ACTOR,
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
      listPending: () => [candidate],
      mintCandidateConfirmation: () => "legacy-token-not-used",
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
  const session = sessions.createSession({
    principalId: ACTOR,
    merchantId: MERCHANT,
    role: "owner",
  });
  const response = await fetch(`${base}/merchant/api/session`, {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${session.sessionId}` },
  });
  const body = (await response.json()) as { csrf_token: string };
  auth = { cookie: `${ADMIN_SESSION_COOKIE}=${session.sessionId}`, csrf: body.csrf_token };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

function assertion(challenge: string): {
  credential_id: string;
  client_data_json: string;
  authenticator_data: string;
  signature: string;
} {
  const clientData = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
    "utf8",
  );
  const authenticatorData = Buffer.alloc(37);
  createHash("sha256").update(RP_ID).digest().copy(authenticatorData, 0);
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

describe("Workbench v1 trusted confirmation API", () => {
  it("freezes a server snapshot, returns assertion options and atomically accepts the decision", async () => {
    const created = await post("/merchant/api/v1/confirmations", {
      candidate_id: candidate.candidate_id,
      decision: "approve",
    });
    expect(created.status).toBe(201);
    const descriptor = (await created.json()) as { confirmation_id: string; request_ref: string };
    expect(descriptor.request_ref).toMatch(/^wcr_/);

    const projection = await fetch(
      `${base}/merchant/api/v1/confirmations/${encodeURIComponent(descriptor.confirmation_id)}`,
      { headers: { cookie: auth.cookie } },
    );
    expect(await projection.json()).toMatchObject({
      candidate_id: candidate.candidate_id,
      decision: "approve",
      snapshot: {
        merchant_id: MERCHANT,
        tool: candidate.tool,
        arguments: candidate.arguments,
      },
    });

    const optionResponse = await post(
      `/merchant/api/v1/confirmations/${encodeURIComponent(descriptor.confirmation_id)}/assertion-options`,
      {},
    );
    expect(optionResponse.status).toBe(200);
    const options = (await optionResponse.json()) as { challenge: string; rp_id: string };
    expect(options.rp_id).toBe(RP_ID);

    const decided = await post(
      `/merchant/api/v1/approvals/${encodeURIComponent(candidate.candidate_id)}/decisions`,
      {
        confirmation_id: descriptor.confirmation_id,
        decision: "approve",
        expected_version: 1,
        assertion: assertion(options.challenge),
      },
    );
    expect(decided.status).toBe(202);
    const result = (await decided.json()) as { operation_id: string; status: string };
    expect(result).toMatchObject({ status: "accepted" });
  });

  it("rejects missing CSRF before creating a confirmation", async () => {
    const noCsrf = await fetch(`${base}/merchant/api/v1/confirmations`, {
      method: "POST",
      headers: { cookie: auth.cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ candidate_id: candidate.candidate_id, decision: "reject" }),
    });
    expect(noCsrf.status).toBe(403);
  });
});
