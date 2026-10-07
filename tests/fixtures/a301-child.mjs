import process from "node:process";
import { setTimeout } from "node:timers";
const { fetch } = globalThis;
import { createServer } from "node:http";
import { createMerchantConnectionService } from "../../dist/cloud/connect-service.js";
import { createEnrollmentChallengeResponder } from "../../dist/cloud/binding/enrollment-challenge.js";
import {
  loadOrCreateA2aSigningIdentity,
  toJwsSigningIdentity,
} from "../../dist/a2a/signing-key.js";
const [dir, runtimePort, catalogPort] = process.argv.slice(2);
const origin = "https://runtime.independent.test";
const raw = loadOrCreateA2aSigningIdentity(dir, origin);
const server = createServer(
  createEnrollmentChallengeResponder({ dataDir: dir, signingIdentity: toJwsSigningIdentity(raw) }),
);
let releasePublication;
const barrier = new Promise((resolve) => {
  releasePublication = resolve;
});
const shim = (input, init) =>
  fetch(
    String(input)
      .replace("https://catalog.independent.test", `http://127.0.0.1:${catalogPort}`)
      .replace(origin, `http://127.0.0.1:${runtimePort}`),
    init,
  );
const service = createMerchantConnectionService({
  dataDir: dir,
  catalogUrl: "https://catalog.independent.test",
  publicOrigin: origin,
  serviceEpoch: 9,
  fetchImpl: shim,
  beforePublish: async () => {
    process.send({ event: "beforePublish" });
    await barrier;
  },
});
server.listen(0, "127.0.0.1", () =>
  process.send({ event: "ready", port: server.address().port, pid: process.pid }),
);
process.on("message", (message) => {
  if (message === "publish") releasePublication();
  if (message === "go")
    service.reconcile().then(
      (result) => process.send({ event: "result", result }),
      (error) => process.send({ event: "result", code: error.code ?? error.message }),
    );
  if (message === "stop") {
    releasePublication();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  }
});
setTimeout(() => process.exit(124), 12000).unref();
