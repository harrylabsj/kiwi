import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import { WorkbenchConfirmationStore } from "../../dist/http/merchant-management/webauthn-confirmation.js";

const { actor, barrierBuffer, dbPath, entries, now } = workerData;
const barrier = new Int32Array(barrierBuffer);
const db = new DatabaseSync(dbPath);
const store = new WorkbenchConfirmationStore({ db, now: () => now });
const privateKey = createPrivateKey(actor.privateKeyPem);
const results = [];
let message;

try {
  for (let index = 0; index < entries.length; index += 1) {
    const round = index + 1;
    const arrival = Atomics.add(barrier, 0, 1) + 1;
    if (arrival === round * 2) {
      Atomics.store(barrier, 1, round);
      Atomics.notify(barrier, 1);
    } else {
      while (Atomics.load(barrier, 1) < round) {
        Atomics.wait(barrier, 1, round - 1, 5_000);
      }
    }

    const entry = entries[index];
    const clientData = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: entry.challenge,
        origin: actor.origin,
        crossOrigin: false,
      }),
      "utf8",
    );
    const authenticatorData = Buffer.alloc(37);
    createHash("sha256").update(actor.rpId).digest().copy(authenticatorData, 0);
    authenticatorData[32] = 0x05;
    authenticatorData.writeUInt32BE(round, 33);
    const signed = Buffer.concat([
      authenticatorData,
      createHash("sha256").update(clientData).digest(),
    ]);
    const assertion = {
      credentialId: actor.credentialId,
      clientDataJSON: clientData.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: sign("sha256", signed, privateKey).toString("base64url"),
    };
    results.push(store.finalizeDecision({ ...entry.input, assertion }));
  }
  message = { results };
} catch (error) {
  message = { error: error instanceof Error ? error.stack : String(error) };
} finally {
  db.close();
}
parentPort.postMessage(message);
