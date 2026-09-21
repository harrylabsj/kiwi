import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  WorkbenchConfirmationError,
  WorkbenchConfirmationStore,
  type ConfirmationRequest,
  type WebAuthnAssertionInput,
} from "../src/http/merchant-management/webauthn-confirmation.js";

const NOW = "2026-09-21T11:00:00.000Z";
const EXPIRES = "2026-09-21T11:05:00.000Z";
const MERCHANT = "merchant-wb-1";
const RP_ID = "merchant.example";
const ORIGIN = "https://merchant.example";
const DIGEST = `sha256:${"a".repeat(64)}`;

function fixture() {
  const db = new DatabaseSync(":memory:");
  const store = new WorkbenchConfirmationStore({ db, now: () => NOW });
  const actors = ["owner-a", "operator-b"].map((actorId, index) => {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const credentialId = `cred-${index + 1}`;
    store.persistVerifiedCredential({
      registrationVerified: true,
      credentialId,
      merchantId: MERCHANT,
      actorId,
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      rpId: RP_ID,
      origin: ORIGIN,
    });
    return { actorId, credentialId, privateKey: pair.privateKey };
  });
  return { db, store, actors };
}

function request(
  store: WorkbenchConfirmationStore,
  actorId: string,
  input: Partial<{
    candidateId: string;
    generation: number;
    decision: "approve" | "reject";
    operationId: string;
    digest: string;
    version: number;
  }> = {},
): ConfirmationRequest {
  return store.createRequest({
    merchantId: MERCHANT,
    actorId,
    candidateId: input.candidateId ?? "candidate-1",
    approvalGeneration: input.generation ?? 1,
    decision: input.decision ?? "approve",
    operationId: input.operationId ?? `operation-${actorId}`,
    actionDigest: input.digest ?? DIGEST,
    actionSnapshot: { merchant: MERCHANT, candidate: input.candidateId ?? "candidate-1" },
    expectedVersion: input.version ?? 7,
    expiresAt: EXPIRES,
  });
}

function assertion(
  confirmation: ConfirmationRequest,
  actor: ReturnType<typeof fixture>["actors"][number],
  input: Partial<{
    challenge: string;
    origin: string;
    rpId: string;
    flags: number;
    signCount: number;
    crossOrigin: boolean;
  }> = {},
): WebAuthnAssertionInput {
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: input.challenge ?? confirmation.challenge,
      origin: input.origin ?? ORIGIN,
      crossOrigin: input.crossOrigin ?? false,
    }),
    "utf8",
  );
  const authenticatorData = Buffer.alloc(37);
  createHash("sha256")
    .update(input.rpId ?? RP_ID)
    .digest()
    .copy(authenticatorData, 0);
  authenticatorData[32] = input.flags ?? 0x05; // UP + UV
  authenticatorData.writeUInt32BE(input.signCount ?? 1, 33);
  const signed = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientData).digest(),
  ]);
  return {
    credentialId: actor.credentialId,
    clientDataJSON: clientData.toString("base64url"),
    authenticatorData: authenticatorData.toString("base64url"),
    signature: sign("sha256", signed, actor.privateKey).toString("base64url"),
  };
}

function decisionInput(
  confirmation: ConfirmationRequest,
  actor: ReturnType<typeof fixture>["actors"][number],
  overrides: Partial<{
    candidateId: string;
    generation: number;
    decision: "approve" | "reject";
    digest: string;
    version: number;
    assertion: WebAuthnAssertionInput;
  }> = {},
) {
  return {
    confirmationId: confirmation.confirmationId,
    merchantId: MERCHANT,
    actorId: actor.actorId,
    candidateId: overrides.candidateId ?? "candidate-1",
    approvalGeneration: overrides.generation ?? 1,
    decision: overrides.decision ?? "approve",
    actionDigest: overrides.digest ?? DIGEST,
    expectedVersion: overrides.version ?? 7,
    assertion: overrides.assertion ?? assertion(confirmation, actor),
  };
}

describe("Workbench WebAuthn trusted confirmation", () => {
  it("validates the assertion and atomically creates decision, operation and outbox", () => {
    const { db, store, actors } = fixture();
    const actor = actors[0]!;
    const confirmation = request(store, actor.actorId);
    expect(
      store.requestProjection({
        confirmationId: confirmation.confirmationId,
        merchantId: MERCHANT,
        actorId: actor.actorId,
      }),
    ).toMatchObject({
      candidate_id: "candidate-1",
      decision: "approve",
      snapshot: { merchant: MERCHANT, candidate: "candidate-1" },
    });
    expect(
      store.assertionOptions({
        confirmationId: confirmation.confirmationId,
        merchantId: MERCHANT,
        actorId: actor.actorId,
      }),
    ).toMatchObject({
      challenge: confirmation.challenge,
      rp_id: RP_ID,
      user_verification: "required",
      allow_credentials: [{ id: actor.credentialId, type: "public-key" }],
    });
    expect(store.finalizeDecision(decisionInput(confirmation, actor))).toEqual({
      kind: "decided",
      decision: "approve",
      operationId: "operation-owner-a",
    });
    expect(
      store.verifyCommittedDecision({
        operationId: "operation-owner-a",
        candidateId: "candidate-1",
        actorId: actor.actorId,
        decision: "approve",
        actionDigest: DIGEST,
      }),
    ).toBe(true);
    expect(
      store.verifyCommittedDecision({
        operationId: "forged",
        candidateId: "candidate-1",
        actorId: actor.actorId,
        decision: "approve",
        actionDigest: DIGEST,
      }),
    ).toBe(false);
    for (const table of [
      "workbench_approval_decisions",
      "workbench_approval_operations",
      "workbench_approval_outbox",
    ]) {
      expect((db.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count).toBe(1);
    }
    expect(() => store.finalizeDecision(decisionInput(confirmation, actor))).toThrowError(
      WorkbenchConfirmationError,
    );
  });

  it("rejects changed action snapshots, wrong origin/RP, missing UV and cross-actor credentials", () => {
    const { store, actors } = fixture();
    const actor = actors[0]!;
    const other = actors[1]!;

    const changed = request(store, actor.actorId, { candidateId: "changed" });
    expect(() =>
      store.finalizeDecision(decisionInput(changed, actor, { candidateId: "other" })),
    ).toThrow(/does not match/);

    const wrongOrigin = request(store, actor.actorId, {
      candidateId: "origin",
      operationId: "op-origin",
    });
    expect(() =>
      store.finalizeDecision(
        decisionInput(wrongOrigin, actor, {
          candidateId: "origin",
          assertion: assertion(wrongOrigin, actor, { origin: "https://evil.example" }),
        }),
      ),
    ).toThrow(WorkbenchConfirmationError);

    const wrongRp = request(store, actor.actorId, { candidateId: "rp", operationId: "op-rp" });
    expect(() =>
      store.finalizeDecision(
        decisionInput(wrongRp, actor, {
          candidateId: "rp",
          assertion: assertion(wrongRp, actor, { rpId: "evil.example" }),
        }),
      ),
    ).toThrow(WorkbenchConfirmationError);

    const missingUv = request(store, actor.actorId, { candidateId: "uv", operationId: "op-uv" });
    expect(() =>
      store.finalizeDecision(
        decisionInput(missingUv, actor, {
          candidateId: "uv",
          assertion: assertion(missingUv, actor, { flags: 0x01 }),
        }),
      ),
    ).toThrow(WorkbenchConfirmationError);

    const cross = request(store, actor.actorId, { candidateId: "cross", operationId: "op-cross" });
    expect(() =>
      store.finalizeDecision(
        decisionInput(cross, actor, { candidateId: "cross", assertion: assertion(cross, other) }),
      ),
    ).toThrow(/belongs to another actor/);
  });

  it("revoked credentials and replayed sign counters fail closed", () => {
    const { store, actors } = fixture();
    const actor = actors[0]!;
    const first = request(store, actor.actorId, { candidateId: "first", operationId: "op-first" });
    store.finalizeDecision(
      decisionInput(first, actor, {
        candidateId: "first",
        assertion: assertion(first, actor, { signCount: 5 }),
      }),
    );
    const replay = request(store, actor.actorId, { candidateId: "replay", operationId: "op-replay" });
    expect(() =>
      store.finalizeDecision(
        decisionInput(replay, actor, {
          candidateId: "replay",
          assertion: assertion(replay, actor, { signCount: 5 }),
        }),
      ),
    ).toThrow(/counter did not advance/);
    expect(store.revokeCredential(actor.credentialId, MERCHANT, actor.actorId)).toBe(true);
    const revoked = request(store, actor.actorId, { candidateId: "revoked", operationId: "op-revoked" });
    expect(() =>
      store.finalizeDecision(decisionInput(revoked, actor, { candidateId: "revoked" })),
    ).toThrow(/revoked/);
  });

  it("arbitrates two actors for 100 candidate generations with exactly one winner", () => {
    const { db, store, actors } = fixture();
    const first = actors[0]!;
    const second = actors[1]!;
    for (let round = 1; round <= 100; round += 1) {
      const candidateId = `race-${round}`;
      const firstRequest = request(store, first.actorId, {
        candidateId,
        generation: round,
        operationId: `op-a-${round}`,
      });
      const secondRequest = request(store, second.actorId, {
        candidateId,
        generation: round,
        decision: "reject",
        operationId: `op-b-${round}`,
      });
      const winner = round % 2 === 0 ? second : first;
      const loser = round % 2 === 0 ? first : second;
      const winnerRequest = round % 2 === 0 ? secondRequest : firstRequest;
      const loserRequest = round % 2 === 0 ? firstRequest : secondRequest;
      const winnerDecision = round % 2 === 0 ? "reject" : "approve";
      const loserDecision = round % 2 === 0 ? "approve" : "reject";
      expect(
        store.finalizeDecision(
          decisionInput(winnerRequest, winner, {
            candidateId,
            generation: round,
            decision: winnerDecision,
            assertion: assertion(winnerRequest, winner, { signCount: round }),
          }),
        ).kind,
      ).toBe("decided");
      expect(
        store.finalizeDecision(
          decisionInput(loserRequest, loser, {
            candidateId,
            generation: round,
            decision: loserDecision,
            assertion: assertion(loserRequest, loser, { signCount: round }),
          }),
        ),
      ).toMatchObject({ kind: "already_decided", decision: winnerDecision });
    }
    expect(
      (db.prepare("SELECT count(*) count FROM workbench_approval_decisions").get() as { count: number })
        .count,
    ).toBe(100);
    expect(
      (db.prepare("SELECT count(*) count FROM workbench_approval_outbox").get() as { count: number }).count,
    ).toBe(100);
  });
});
