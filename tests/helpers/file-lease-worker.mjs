import process from "node:process";
import { writeFileSync } from "node:fs";
import { workerData, parentPort } from "node:worker_threads";

import { FileLeaseStore } from "../../dist/negotiation/lease/store.js";

if (workerData !== null) {
  const barrier = new Int32Array(workerData.barrierBuffer);
  const store = new FileLeaseStore(workerData.dir, { nowMs: () => workerData.now });
  const arrival = Atomics.add(barrier, 0, 1) + 1;
  if (arrival === 2) {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1);
  } else {
    while (Atomics.load(barrier, 1) === 0) Atomics.wait(barrier, 1, 0, 5_000);
  }
  parentPort.postMessage(store.acquire(workerData.key, workerData.owner, workerData.ttlMs));
} else if (process.argv[2] === "crash") {
  const [, , , dir, handleFile, key, owner, ttl, now] = process.argv;
  const store = new FileLeaseStore(dir, { nowMs: () => Number(now) });
  const handle = store.acquire(key, owner, Number(ttl));
  if (handle === undefined) process.exit(2);
  writeFileSync(handleFile, JSON.stringify(handle));
  process.kill(process.pid, "SIGKILL");
}
