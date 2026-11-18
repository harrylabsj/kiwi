/**
 * 评测终态网关契约：completed / not_executed（需证明未来不可执行）/ unknown。
 */
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { contentDigest } from "../src/negotiation/jcs.js";
import type { EvaluationRecoveryBinding } from "../src/merchant-core/learning/service.js";
import { createRecoveryGatewayVerifier } from "../src/merchant-core/learning/recovery-gateway.js";

const binding: EvaluationRecoveryBinding = {
  merchant_id: "m-1",
  candidate_id: "cand-1",
  candidate_revision: 1,
  artifact_hash: "sha256:artifact",
  suite_version: "m5-suite-v1.3",
  config_digest: "sha256:cfg",
  scenario_id: "target-1",
  kind: "target",
  repetitions: 3,
  variant: "candidate",
  attempt: 1,
  dispatch_id: "disp-1",
};

let server: ReturnType<typeof createServer> | undefined;
afterEach(async () => {
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function verifierWith(body: Record<string, unknown>, status = 200) {
  server = createServer((req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ dispatch_id: "disp-1", binding_digest: contentDigest(binding), ...body }));
    req.resume();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return createRecoveryGatewayVerifier({
    base_url: `http://127.0.0.1:${port}`,
    fetchImpl: fetch,
    timeout_ms: 2_000,
  });
}

describe("评测终态网关契约", () => {
  it("completed：回传 outcome 与同一 binding", async () => {
    const verify = await verifierWith({
      status: "completed",
      outcome: { passed: true, hard_gate_failures: 0, improvement_delta: 1 },
    });
    await expect(verify(binding, "gw:1")).resolves.toMatchObject({
      status: "completed",
      binding,
      outcome: { passed: true, hard_gate_failures: 0, improvement_delta: 1 },
    });
  });

  it("not_executed 必须证明 future_execution_blocked 且有终态原因", async () => {
    const blocked = await verifierWith({
      status: "not_executed",
      future_execution_blocked: true,
      terminal_reason: "gateway_dispatch_lease_revoked",
    });
    await expect(blocked(binding, "gw:2")).resolves.toMatchObject({ status: "not_executed" });

    const unproven = await verifierWith({
      status: "not_executed",
      future_execution_blocked: false,
      terminal_reason: "not_found",
    });
    await expect(unproven(binding, "gw:3")).resolves.toEqual({ status: "unknown" });
  });

  it("404 / binding 摘要不符 / outcome 非法 → unknown（保持阻塞）", async () => {
    const notFound = await verifierWith({ status: "completed" }, 404);
    await expect(notFound(binding, "gw:4")).resolves.toEqual({ status: "unknown" });

    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ dispatch_id: "disp-1", binding_digest: "sha256:other", status: "completed" }));
      req.resume();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const mismatch = createRecoveryGatewayVerifier({ base_url: `http://127.0.0.1:${port}` });
    await expect(mismatch(binding, "gw:5")).resolves.toEqual({ status: "unknown" });

    const invalidOutcome = await verifierWith({ status: "completed", outcome: { passed: "yes" } });
    await expect(invalidOutcome(binding, "gw:6")).resolves.toEqual({ status: "unknown" });
  });
});
