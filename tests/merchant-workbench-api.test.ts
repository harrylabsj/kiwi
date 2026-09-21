import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
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
import { createVerifiedActorContext } from "../src/merchant/application/actor.js";
import { MerchantFeedStore } from "../src/merchant/feed-store.js";
import { BROADCAST_TOOLS } from "../src/merchant/feed-executors.js";
import { GRANT_TOOLS } from "../src/merchant/grant-executors.js";
import { PROMOTION_TOOLS } from "../src/merchant/promotion-executors.js";
import { MerchantPromotionStore } from "../src/merchant/promotion-store.js";
import { PromotionBroadcastWorkflowStore } from "../src/merchant/promotion-broadcast-workflow.js";
import {
  MerchantGrantStore,
  type GrantAction,
  type GrantResourceType,
} from "../src/merchant/grant-store.js";

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
const pending: WriteApprovalCandidate[] = [candidate];
const feed = new MerchantFeedStore({
  db,
  cursorKey: randomBytes(32),
  now: () => NOW.toISOString(),
});
const grants = new MerchantGrantStore({ db, now: () => NOW.toISOString() });
const promotions = new MerchantPromotionStore({ db, now: () => NOW.toISOString() });
const promotionWorkflows = new PromotionBroadcastWorkflowStore({
  db,
  now: () => NOW.toISOString(),
});

let server: Server;
let base: string;
let auth: { cookie: string; csrf: string };

function preparedBroadcast(input: {
  broadcast: Record<string, unknown>;
  authorization: Record<string, unknown>;
  workflowId?: string;
}): { candidate: WriteApprovalCandidate } {
  const item: WriteApprovalCandidate = {
    ...candidate,
    candidate_id: `candidate-broadcast-${pending.length}`,
    tool: BROADCAST_TOOLS.publish,
    arguments: {
      broadcast_id: `bct_${randomBytes(16).toString("base64url")}`,
      input: input.broadcast,
      authorization: input.authorization,
      ...(input.workflowId !== undefined ? { workflow_id: input.workflowId } : {}),
    },
    arguments_hash: `sha256:broadcast-${pending.length}`,
  };
  pending.push(item);
  return { candidate: item };
}

function preparedGrant(input: {
  ownerActorId: string;
  subjectId: string;
  action: GrantAction;
  resourceType: GrantResourceType;
  resourceSelector: "merchant" | "all_products" | readonly string[];
  expiresAt: string;
}): { candidate: WriteApprovalCandidate } {
  const item: WriteApprovalCandidate = {
    ...candidate,
    candidate_id: `candidate-grant-${pending.length}`,
    tool: GRANT_TOOLS.create,
    arguments: {
      owner_actor_id: input.ownerActorId,
      subject_id: input.subjectId,
      grant_action: input.action,
      resource_type: input.resourceType,
      resource_selector: input.resourceSelector,
      expires_at: input.expiresAt,
    },
    arguments_hash: `sha256:grant-${pending.length}`,
  };
  pending.push(item);
  return { candidate: item };
}

function preparedPromotion(input: {
  promotionId: string;
  expectedRevision: number;
  workflowId?: string;
  broadcastAuthorization?: Record<string, unknown>;
}): {
  candidate: WriteApprovalCandidate;
} {
  const item: WriteApprovalCandidate = {
    ...candidate,
    candidate_id: `candidate-promotion-${pending.length}`,
    tool: PROMOTION_TOOLS.publish,
    arguments: {
      promotion_id: input.promotionId,
      expected_revision: input.expectedRevision,
      ...(input.workflowId !== undefined ? { workflow_id: input.workflowId } : {}),
      ...(input.broadcastAuthorization !== undefined
        ? { broadcast_authorization: input.broadcastAuthorization }
        : {}),
    },
    arguments_hash: `sha256:promotion-${pending.length}`,
  };
  pending.push(item);
  return { candidate: item };
}

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
      listPending: () => pending,
      mintCandidateConfirmation: () => "legacy-token-not-used",
      executeDecision: async () => {},
      drafts: new MerchantImportDraftStore({ db, now: () => NOW.toISOString() }),
      operations,
      serviceState: new MutableServiceState("OPERATING"),
      readiness: async () => ({ ready: true, checks: {} }),
      workbenchConfirmations: confirmations,
      workbenchFeed: feed,
      workbenchGrants: grants,
      workbenchPromotions: promotions,
      promotionBroadcastWorkflows: promotionWorkflows,
      prepareBroadcastPublish: preparedBroadcast,
      prepareGrantCreate: preparedGrant,
      preparePromotionPublish: preparedPromotion,
      webauthnRegistration: {
        rpName: "Kiwi Merchant",
        rpId: RP_ID,
        origin: ORIGIN,
        // Test injection represents an independent registration channel; production bootstrap
        // intentionally does not configure this callback until a real channel is verified.
        authorize: () => true,
      },
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
  return await postWithAuth(path, body, auth);
}

async function postWithAuth(
  path: string,
  body: unknown,
  credentials: { cookie: string; csrf: string },
): Promise<Response> {
  return await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      cookie: credentials.cookie,
      origin: ORIGIN,
      "x-csrf-token": credentials.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function createAuth(
  principalId: string,
  role: "owner" | "operator" | "viewer",
): Promise<{ cookie: string; csrf: string }> {
  const session = sessions.createSession({ principalId, merchantId: MERCHANT, role });
  const cookie = `${ADMIN_SESSION_COOKIE}=${session.sessionId}`;
  const response = await fetch(`${base}/merchant/api/session`, { headers: { cookie } });
  const body = (await response.json()) as { csrf_token: string };
  return { cookie, csrf: body.csrf_token };
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
  it("returns a source-backed overview and marks unavailable metrics unobservable", async () => {
    const response = await fetch(`${base}/merchant/api/v1/overview`, {
      headers: { cookie: auth.cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runtime: { service_state: "OPERATING" },
      approvals: { observable: true, pending: expect.any(Number) },
      broadcasts: {
        observable: true,
        value: { total: expect.any(Number), published: expect.any(Number) },
      },
      promotions: {
        observable: true,
        value: { total: expect.any(Number), active: expect.any(Number) },
      },
      followers: {
        observable: false,
        value: null,
        reason: "verified_buyer_identity_resolver_unavailable",
      },
      negotiations: {
        observable: false,
        value: null,
      },
    });
  });

  it("issues registration options only through the independent authorization callback", async () => {
    const response = await post("/merchant/api/v1/webauthn/registrations/options", {});
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      registration_id: string;
      options: { challenge: string; rp: { id: string }; authenticatorSelection: object };
    };
    expect(body).toMatchObject({
      registration_id: expect.stringMatching(/^wrg_/),
      options: {
        challenge: expect.any(String),
        rp: { id: RP_ID },
        authenticatorSelection: { userVerification: "required" },
      },
    });
    const forged = await post(
      `/merchant/api/v1/webauthn/registrations/${encodeURIComponent(body.registration_id)}/verify`,
      {
        id: "forged",
        rawId: "forged",
        response: { clientDataJSON: "forged", attestationObject: "forged" },
        clientExtensionResults: {},
        type: "public-key",
      },
    );
    expect(forged.status).toBe(403);
    expect(await forged.json()).toMatchObject({ code: "CONFIRMATION_INVALID" });
  });

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

  it("creates broadcast candidates only, and exposes no direct Feed write route", async () => {
    const drafted = await post("/merchant/api/v1/broadcasts/drafts", {
      action: "publish",
      broadcast: {
        kind: "service_notice",
        title: "Candidate only",
        body: "No direct Feed mutation",
        audience: "public",
      },
    });
    expect(drafted.status).toBe(201);
    const body = (await drafted.json()) as { candidate: WriteApprovalCandidate };
    const broadcastId = String(body.candidate.arguments.broadcast_id);
    expect(feed.getBroadcast(MERCHANT, broadcastId)).toBeUndefined();

    const direct = await post("/merchant/api/v1/broadcasts", {
      title: "must not write",
    });
    expect(direct.status).toBe(404);
  });

  it("requires distinct Operator draft/decide grants and invalidates confirmation after revoke", async () => {
    const operatorId = "operator:merchant-wb-api";
    const operatorAuth = await createAuth(operatorId, "operator");
    confirmations.persistVerifiedCredential({
      registrationVerified: true,
      credentialId: "credential-operator-workbench-api",
      merchantId: MERCHANT,
      actorId: operatorId,
      publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const owner = createVerifiedActorContext({
      actorId: ACTOR,
      merchantId: MERCHANT,
      role: "owner",
      authMethod: "admin-session",
      generation: 1,
      requestId: "test-owner-grants",
      expiresAt: "2027-09-21T12:00:00.000Z",
    });
    const withoutDraftGrant = await postWithAuth(
      "/merchant/api/v1/broadcasts/drafts",
      {
        action: "publish",
        broadcast: {
          kind: "service_notice",
          title: "Denied operator candidate",
          body: "No grant",
          audience: "public",
        },
      },
      operatorAuth,
    );
    expect(withoutDraftGrant.status).toBe(403);
    grants.createGrant(owner, {
      subjectId: operatorId,
      action: "broadcast.draft",
      resourceType: "merchant",
      resourceSelector: "merchant",
      expiresAt: "2027-09-21T12:00:00.000Z",
    });
    const drafted = await postWithAuth(
      "/merchant/api/v1/broadcasts/drafts",
      {
        action: "publish",
        broadcast: {
          kind: "service_notice",
          title: "Operator candidate",
          body: "Grant separation",
          audience: "public",
        },
      },
      operatorAuth,
    );
    expect(drafted.status).toBe(201);
    const draftedBody = (await drafted.json()) as { candidate: WriteApprovalCandidate };

    const noDecideGrant = await postWithAuth(
      "/merchant/api/v1/confirmations",
      { candidate_id: draftedBody.candidate.candidate_id, decision: "approve" },
      operatorAuth,
    );
    expect(noDecideGrant.status).toBe(403);

    const decideGrant = grants.createGrant(owner, {
      subjectId: operatorId,
      action: "broadcast.decide",
      resourceType: "merchant",
      resourceSelector: "merchant",
      expiresAt: "2027-09-21T12:00:00.000Z",
    });
    const created = await postWithAuth(
      "/merchant/api/v1/confirmations",
      { candidate_id: draftedBody.candidate.candidate_id, decision: "approve" },
      operatorAuth,
    );
    expect(created.status).toBe(201);
    const descriptor = (await created.json()) as { confirmation_id: string };
    const optionsResponse = await postWithAuth(
      `/merchant/api/v1/confirmations/${descriptor.confirmation_id}/assertion-options`,
      {},
      operatorAuth,
    );
    const assertionOptions = (await optionsResponse.json()) as { challenge: string };
    grants.revokeGrant(owner, decideGrant.grant_id);
    const revoked = await postWithAuth(
      `/merchant/api/v1/approvals/${draftedBody.candidate.candidate_id}/decisions`,
      {
        confirmation_id: descriptor.confirmation_id,
        decision: "approve",
        expected_version: 1,
        assertion: assertion(assertionOptions.challenge),
      },
      operatorAuth,
    );
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({ code: "PERMISSION_REVOKED" });
  });

  it("makes Owner grant changes candidates and exposes no direct grant mutation route", async () => {
    const before = grants.listGrants(MERCHANT).items.length;
    const drafted = await post("/merchant/api/v1/operator-grant-drafts", {
      action: "create",
      subject_id: "operator:new",
      grant_action: "broadcast.draft",
      resource_type: "merchant",
      resource_selector: "merchant",
      expires_at: "2027-09-21T12:00:00.000Z",
    });
    expect(drafted.status).toBe(201);
    const body = (await drafted.json()) as { candidate: WriteApprovalCandidate };
    expect(body.candidate.tool).toBe(GRANT_TOOLS.create);
    expect(grants.listGrants(MERCHANT).items).toHaveLength(before);

    const direct = await post("/merchant/api/v1/operator-grants", {
      subject_id: "operator:new",
    });
    expect(direct.status).toBe(404);

    const created = await post("/merchant/api/v1/confirmations", {
      candidate_id: body.candidate.candidate_id,
      decision: "approve",
    });
    expect(created.status).toBe(201);
    const descriptor = (await created.json()) as { confirmation_id: string };
    const projection = await fetch(
      `${base}/merchant/api/v1/confirmations/${descriptor.confirmation_id}`,
      { headers: { cookie: auth.cookie } },
    );
    expect(await projection.json()).toMatchObject({
      snapshot: {
        decision_authorization: {
          actor_id: ACTOR,
          actor_role: "owner",
          action: "grants.manage",
        },
      },
    });
  });

  it("stores promotion drafts but requires a candidate and product-scoped decision to publish", async () => {
    const privateAudience = await post("/merchant/api/v1/promotions/drafts", {
      sku_refs: ["sku-1"],
      rule: {
        kind: "limited_price",
        unit_price: { currency: "CNY", amount_minor: "9999" },
      },
      audience: "followers",
      starts: "2026-09-21T12:00:00Z",
      ends: "2026-09-22T12:00:00Z",
      timezone: "UTC",
    });
    expect(privateAudience.status).toBe(422);

    const draft = await post("/merchant/api/v1/promotions/drafts", {
      sku_refs: ["sku-1"],
      rule: {
        kind: "limited_price",
        unit_price: { currency: "CNY", amount_minor: "9999" },
      },
      audience: "public",
      starts: "2026-09-21T12:00:00Z",
      ends: "2026-09-22T12:00:00Z",
      timezone: "UTC",
    });
    expect(draft.status).toBe(201);
    const created = (await draft.json()) as { promotion_id: string; revision: number };
    expect(promotions.getPromotion(MERCHANT, created.promotion_id)?.status).toBe("draft");

    const publishDraft = await post(
      `/merchant/api/v1/promotions/${created.promotion_id}/publish-drafts`,
      {
        expected_revision: created.revision,
        broadcast: {
          kind: "promotion_notice",
          title: "Promotion prepared",
          body: "The promotion will be announced after it is published.",
          audience: "public",
        },
      },
    );
    expect(publishDraft.status).toBe(201);
    const prepared = (await publishDraft.json()) as {
      candidate: WriteApprovalCandidate;
      workflow_id: string;
    };
    expect(prepared.candidate.tool).toBe(PROMOTION_TOOLS.publish);
    expect(prepared.candidate.arguments).toMatchObject({
      workflow_id: prepared.workflow_id,
      broadcast_authorization: {
        actor_id: ACTOR,
        actor_role: "owner",
        action: "broadcast.draft",
      },
    });
    const workflowResponse = await fetch(
      `${base}/merchant/api/v1/promotion-workflows/${prepared.workflow_id}`,
      { headers: { cookie: auth.cookie } },
    );
    expect(await workflowResponse.json()).toMatchObject({
      promotion_id: created.promotion_id,
      promotion_candidate_id: prepared.candidate.candidate_id,
      broadcast_requested: true,
      status: "promotion_pending",
    });
    expect(promotions.getPromotion(MERCHANT, created.promotion_id)?.status).toBe("draft");

    const confirmation = await post("/merchant/api/v1/confirmations", {
      candidate_id: prepared.candidate.candidate_id,
      decision: "approve",
    });
    expect(confirmation.status).toBe(201);
    const descriptor = (await confirmation.json()) as { confirmation_id: string };
    const projection = await fetch(
      `${base}/merchant/api/v1/confirmations/${descriptor.confirmation_id}`,
      { headers: { cookie: auth.cookie } },
    );
    expect(await projection.json()).toMatchObject({
      snapshot: {
        decision_authorization: {
          action: "product.decide",
          resource_type: "product",
          resource_ids: ["sku-1"],
        },
      },
    });
  });

  it("requires complete SKU coverage and separate product draft/decide grants", async () => {
    const operatorId = "operator:promotion-api";
    const operatorAuth = await createAuth(operatorId, "operator");
    confirmations.persistVerifiedCredential({
      registrationVerified: true,
      credentialId: "credential-promotion-operator-api",
      merchantId: MERCHANT,
      actorId: operatorId,
      publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const owner = createVerifiedActorContext({
      actorId: ACTOR,
      merchantId: MERCHANT,
      role: "owner",
      authMethod: "admin-session",
      generation: 1,
      requestId: "test-promotion-owner",
      expiresAt: "2027-09-21T12:00:00.000Z",
    });
    const promotionBody = (skuRefs: string[]) => ({
      sku_refs: skuRefs,
      rule: {
        kind: "limited_price",
        unit_price: { currency: "CNY", amount_minor: "8888" },
      },
      audience: "public",
      starts: "2026-09-21T12:00:00Z",
      ends: "2026-09-22T12:00:00Z",
      timezone: "UTC",
    });
    expect(
      (
        await postWithAuth(
          "/merchant/api/v1/promotions/drafts",
          promotionBody(["sku-granted"]),
          operatorAuth,
        )
      ).status,
    ).toBe(403);
    grants.createGrant(owner, {
      subjectId: operatorId,
      action: "product.draft",
      resourceType: "product",
      resourceSelector: ["sku-granted"],
      expiresAt: "2027-09-21T12:00:00.000Z",
    });
    expect(
      (
        await postWithAuth(
          "/merchant/api/v1/promotions/drafts",
          promotionBody(["sku-granted", "sku-denied"]),
          operatorAuth,
        )
      ).status,
    ).toBe(403);
    const draft = await postWithAuth(
      "/merchant/api/v1/promotions/drafts",
      promotionBody(["sku-granted"]),
      operatorAuth,
    );
    expect(draft.status).toBe(201);
    const created = (await draft.json()) as { promotion_id: string; revision: number };
    const preparedResponse = await postWithAuth(
      `/merchant/api/v1/promotions/${created.promotion_id}/publish-drafts`,
      { expected_revision: created.revision },
      operatorAuth,
    );
    expect(preparedResponse.status).toBe(201);
    const prepared = (await preparedResponse.json()) as { candidate: WriteApprovalCandidate };
    expect(
      (
        await postWithAuth(
          "/merchant/api/v1/confirmations",
          { candidate_id: prepared.candidate.candidate_id, decision: "approve" },
          operatorAuth,
        )
      ).status,
    ).toBe(403);
    grants.createGrant(owner, {
      subjectId: operatorId,
      action: "product.decide",
      resourceType: "product",
      resourceSelector: ["sku-granted"],
      expiresAt: "2027-09-21T12:00:00.000Z",
    });
    expect(
      (
        await postWithAuth(
          "/merchant/api/v1/confirmations",
          { candidate_id: prepared.candidate.candidate_id, decision: "approve" },
          operatorAuth,
        )
      ).status,
    ).toBe(201);
  });

  it("retries only the broadcast side of a partial promotion workflow", async () => {
    const promotion = promotions.createDraft(MERCHANT, {
      skuRefs: ["sku-retry"],
      rule: {
        kind: "limited_price",
        unit_price: { currency: "CNY", amount_minor: "7777" },
      },
      audience: "public",
      starts: "2026-09-21T12:00:00Z",
      ends: "2026-09-22T12:00:00Z",
      timezone: "UTC",
    });
    promotions.publish(MERCHANT, promotion.promotion_id, 1, {
      publishedBy: ACTOR,
      approvalRef: "operation-published",
    });
    const workflow = promotionWorkflows.create({
      merchantId: MERCHANT,
      promotionId: promotion.promotion_id,
      broadcast: {
        kind: "promotion_notice",
        title: "Retry announcement",
        body: "Only this broadcast candidate should be retried.",
        audience: "public",
      },
    });
    promotionWorkflows.markPromotionPublished(MERCHANT, workflow.workflow_id, 2);
    promotionWorkflows.markPartial(MERCHANT, workflow.workflow_id, "candidate store unavailable");

    const retried = await post(
      `/merchant/api/v1/promotion-workflows/${workflow.workflow_id}/retry-broadcast`,
      {},
    );
    expect(retried.status).toBe(201);
    const body = (await retried.json()) as {
      candidate: WriteApprovalCandidate;
      workflow: { status: string; broadcast_candidate_id: string };
    };
    expect(body.candidate.tool).toBe(BROADCAST_TOOLS.publish);
    expect(body.workflow).toMatchObject({
      status: "broadcast_pending",
      broadcast_candidate_id: body.candidate.candidate_id,
    });
    expect(promotions.getPromotion(MERCHANT, promotion.promotion_id)?.revision).toBe(2);
  });
});
