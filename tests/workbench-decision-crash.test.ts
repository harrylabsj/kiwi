import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  WorkbenchConfirmationStore,
  type ConfirmationRequest,
  type WebAuthnAssertionInput,
} from "../src/http/merchant-management/webauthn-confirmation.js";

const NOW = "2026-09-22T02:10:00.000Z";
const EXPIRES = "2026-09-22T02:15:00.000Z";
const MERCHANT = "merchant-crash";
const ACTOR = "owner-crash";
const CANDIDATE = "candidate-crash";
const OPERATION = "operation-crash";
const CREDENTIAL = "credential-crash";
const ORIGIN = "https://merchant.example";
const RP_ID = "merchant.example";
const DIGEST = `sha256:${"c".repeat(64)}`;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function assertion(
  confirmation: ConfirmationRequest,
  privateKey: KeyObject,
): WebAuthnAssertionInput {
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: confirmation.challenge,
      origin: ORIGIN,
      crossOrigin: false,
    }),
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
    credentialId: CREDENTIAL,
    clientDataJSON: clientData.toString("base64url"),
    authenticatorData: authenticatorData.toString("base64url"),
    signature: sign("sha256", signed, privateKey).toString("base64url"),
  };
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count;
}

describe("Workbench decision crash atomicity", () => {
  it("rolls back a SIGKILL between decision and operation inserts and safely retries", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-workbench-decision-crash-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, "state.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("pragma journal_mode=WAL");
    const store = new WorkbenchConfirmationStore({ db, now: () => NOW });
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    store.persistVerifiedCredential({
      registrationVerified: true,
      credentialId: CREDENTIAL,
      merchantId: MERCHANT,
      actorId: ACTOR,
      publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const confirmation = store.createRequest({
      merchantId: MERCHANT,
      actorId: ACTOR,
      candidateId: CANDIDATE,
      approvalGeneration: 1,
      decision: "approve",
      operationId: OPERATION,
      actionDigest: DIGEST,
      actionSnapshot: { candidate_id: CANDIDATE },
      expectedVersion: 1,
      expiresAt: EXPIRES,
    });
    const input = {
      confirmationId: confirmation.confirmationId,
      merchantId: MERCHANT,
      actorId: ACTOR,
      candidateId: CANDIDATE,
      approvalGeneration: 1,
      decision: "approve" as const,
      actionDigest: DIGEST,
      expectedVersion: 1,
      assertion: assertion(confirmation, pair.privateKey),
    };
    db.close();

    const payloadPath = path.join(dir, "payload.json");
    writeFileSync(payloadPath, JSON.stringify({ dbPath, now: NOW, input }));
    const child = spawn(
      process.execPath,
      [
        new URL("./helpers/workbench-decision-crash-worker.mjs", import.meta.url).pathname,
        payloadPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    cleanups.push(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const exit = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("decision crash worker did not exit within 10 seconds"));
        }, 10_000);
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );
    expect(exit, stderr).toEqual({ code: null, signal: "SIGKILL" });

    const recovered = new DatabaseSync(dbPath);
    const recoveredStore = new WorkbenchConfirmationStore({ db: recovered, now: () => NOW });
    expect(count(recovered, "workbench_approval_decisions")).toBe(0);
    expect(count(recovered, "workbench_approval_operations")).toBe(0);
    expect(count(recovered, "workbench_approval_outbox")).toBe(0);
    expect(
      recovered
        .prepare("SELECT consumed_at FROM workbench_confirmation_requests WHERE confirmation_id=?")
        .get(confirmation.confirmationId),
    ).toMatchObject({ consumed_at: null });
    expect(
      recovered
        .prepare("SELECT sign_count FROM workbench_webauthn_credentials WHERE credential_id=?")
        .get(CREDENTIAL),
    ).toMatchObject({ sign_count: 0 });

    expect(recoveredStore.finalizeDecision(input)).toEqual({
      kind: "decided",
      decision: "approve",
      operationId: OPERATION,
    });
    expect(count(recovered, "workbench_approval_decisions")).toBe(1);
    expect(count(recovered, "workbench_approval_operations")).toBe(1);
    expect(count(recovered, "workbench_approval_outbox")).toBe(1);
    recovered.close();
  }, 20_000);
});
