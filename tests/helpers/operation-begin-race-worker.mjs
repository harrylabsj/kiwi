import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import { MerchantManagementOperationStore } from "../../dist/http/merchant-management/operation-store.js";

const db = new DatabaseSync(workerData.dbPath);
const store = new MerchantManagementOperationStore({ db, now: () => workerData.now });
const barrier = new Int32Array(workerData.barrierBuffer);

const arrival = Atomics.add(barrier, 0, 1) + 1;
if (arrival === 2) {
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1);
} else {
  while (Atomics.load(barrier, 1) === 0) Atomics.wait(barrier, 1, 0, 5_000);
}

let message;
try {
  message = { outcome: store.begin(workerData.input) };
} catch (error) {
  message = { error: error instanceof Error ? error.stack : String(error) };
} finally {
  db.close();
}
parentPort.postMessage(message);
