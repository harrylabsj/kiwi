import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

import { WorkbenchConfirmationStore } from "../src/http/merchant-management/webauthn-confirmation.js";

const NOW = "2026-09-22T02:00:00.000Z";
const EXPIRES = "2026-09-22T02:05:00.000Z";
const MERCHANT = "merchant-concurrent";
const ORIGIN = "https://merchant.example";
const RP_ID = "merchant.example";
const DIGEST = `sha256:${"b".repeat(64)}`;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface RaceEntry {
  challenge: string;
  input: {
    confirmationId: string;
    merchantId: string;
    actorId: string;
    candidateId: string;
    approvalGeneration: number;
    decision: "approve" | "reject";
    actionDigest: string;
    expectedVersion: number;
  };
}

interface WorkerResult {
  results?: Array<{ kind: string; decision: string; operationId: string }>;
  error?: string;
}

function runWorker(workerData: Record<string, unknown>): Promise<WorkerResult> {
  const worker = new Worker(
    new URL("./helpers/workbench-decision-race-worker.mjs", import.meta.url),
    { workerData },
  );
  cleanups.push(() => void worker.terminate());
  return new Promise((resolve, reject) => {
    worker.once("message", (message: WorkerResult) => resolve(message));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`decision race worker exited with code ${code}`));
    });
  });
}

describe("Workbench decision arbitration across SQLite connections", () => {
  it("commits exactly one decision and outbox item in each of 100 concurrent rounds", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-workbench-decision-race-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, "state.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("pragma journal_mode=WAL");
    const store = new WorkbenchConfirmationStore({ db, now: () => NOW });
    const actors = ["owner-a", "operator-b"].map((actorId, index) => {
      const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const credentialId = `race-credential-${index}`;
      store.persistVerifiedCredential({
        registrationVerified: true,
        credentialId,
        merchantId: MERCHANT,
        actorId,
        publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        rpId: RP_ID,
        origin: ORIGIN,
      });
      return {
        actorId,
        credentialId,
        privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        rpId: RP_ID,
        origin: ORIGIN,
        entries: [] as RaceEntry[],
      };
    });

    for (let round = 1; round <= 100; round += 1) {
      const candidateId = `concurrent-candidate-${round}`;
      for (const [index, actor] of actors.entries()) {
        const decision = index === 0 ? "approve" : "reject";
        const confirmation = store.createRequest({
          merchantId: MERCHANT,
          actorId: actor.actorId,
          candidateId,
          approvalGeneration: round,
          decision,
          operationId: `concurrent-operation-${round}-${index}`,
          actionDigest: DIGEST,
          actionSnapshot: { candidate_id: candidateId, decision },
          expectedVersion: round,
          expiresAt: EXPIRES,
        });
        actor.entries.push({
          challenge: confirmation.challenge,
          input: {
            confirmationId: confirmation.confirmationId,
            merchantId: MERCHANT,
            actorId: actor.actorId,
            candidateId,
            approvalGeneration: round,
            decision,
            actionDigest: DIGEST,
            expectedVersion: round,
          },
        });
      }
    }
    db.close();

    const barrierBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const results = await Promise.all(
      actors.map((actor) =>
        runWorker({
          actor: {
            actorId: actor.actorId,
            credentialId: actor.credentialId,
            privateKeyPem: actor.privateKeyPem,
            rpId: actor.rpId,
            origin: actor.origin,
          },
          barrierBuffer,
          dbPath,
          entries: actor.entries,
          now: NOW,
        }),
      ),
    );
    expect(results.map((result) => result.error)).toEqual([undefined, undefined]);
    expect(results[0]?.results).toHaveLength(100);
    expect(results[1]?.results).toHaveLength(100);
    for (let round = 0; round < 100; round += 1) {
      expect(
        [results[0]?.results?.[round]?.kind, results[1]?.results?.[round]?.kind].sort(),
      ).toEqual(["already_decided", "decided"]);
      expect(results[0]?.results?.[round]?.decision).toBe(results[1]?.results?.[round]?.decision);
      expect(results[0]?.results?.[round]?.operationId).toBe(
        results[1]?.results?.[round]?.operationId,
      );
    }

    const verified = new DatabaseSync(dbPath, { readOnly: true });
    for (const table of [
      "workbench_approval_decisions",
      "workbench_approval_operations",
      "workbench_approval_outbox",
    ]) {
      const row = verified.prepare(`SELECT count(*) count FROM ${table}`).get() as {
        count: number;
      };
      expect(row.count).toBe(100);
    }
    verified.close();
  }, 30_000);
});
