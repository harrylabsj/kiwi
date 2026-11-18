/**
 * 本地评测终态测试网关：not_executed 终态后拒绝再次执行；verifier 契约。
 */
import { afterEach, describe, expect, it } from "vitest";
import { contentDigest } from "../src/negotiation/jcs.js";
import { createRecoveryGatewayVerifier } from "../src/merchant-core/learning/recovery-gateway.js";
import { createTestDispatchGateway, type TestDispatchGateway } from "../src/merchant-core/learning/test-dispatch-gateway.js";
import type { EvaluationRecoveryBinding } from "../src/merchant-core/learning/service.js";

const binding: EvaluationRecoveryBinding = {
  merchant_id: "m-1", candidate_id: "cand-1", candidate_revision: 1,
  artifact_hash: "sha256:a", suite_version: "s1", config_digest: "sha256:c",
  scenario_id: "target-1", kind: "target", repetitions: 3,
  variant: "candidate", attempt: 1, dispatch_id: "disp-test",
};

let gateway: TestDispatchGateway | undefined;
afterEach(async () => { await gateway?.close(); gateway = undefined; });

describe("测试终态网关", () => {
  it("not_executed 后 verifier 返回终态，execute 被 409 阻断", async () => {
    gateway = createTestDispatchGateway();
    const port = await gateway.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const digest = contentDigest(binding);
    const mark = await fetch(`${base}/dispatch/disp-test/not-executed`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ binding_digest: digest, terminal_reason: "test_cancel" }),
    });
    expect(mark.status).toBe(200);
    const verify = createRecoveryGatewayVerifier({ base_url: base });
    await expect(verify(binding, "test:1")).resolves.toMatchObject({ status: "not_executed" });
    const replay = await fetch(`${base}/dispatch/disp-test/execute`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ binding_digest: digest }),
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ future_execution_blocked: true });
  });

  it("completed 写入结果；摘要不符返回 unknown", async () => {
    gateway = createTestDispatchGateway();
    const port = await gateway.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const digest = contentDigest(binding);
    await fetch(`${base}/dispatch/disp-test/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ binding_digest: digest, outcome: { passed: true, hard_gate_failures: 0 } }),
    });
    const verify = createRecoveryGatewayVerifier({ base_url: base });
    await expect(verify(binding, "test:2")).resolves.toMatchObject({ status: "completed" });
    const wrong = createRecoveryGatewayVerifier({ base_url: base });
    await expect(
      wrong({ ...binding, scenario_id: "other" }, "test:3"),
    ).resolves.toEqual({ status: "unknown" });
  });
});
