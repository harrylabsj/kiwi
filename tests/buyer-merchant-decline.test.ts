/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 商家结构化拒绝（`data: {decline:true, reason_code}`）必须**立刻**成为终态。
 *
 * 此前它没有 KNP 信封，恢复路径会一直轮询到超时，最后对外报「结果未知，
 * 可能已执行」——商家明明已经明确拒绝，买家却以为要重试。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BuyerProtocolRecovery, MerchantDeclined } from "../src/buyer-core/protocol-recovery.js";
import { buildRfqEnvelope } from "../src/buyer-core/a2a-knp.js";
import type { A2ATask } from "../src/a2a/client/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CREATED_AT = "2026-10-28T12:00:00.000Z";

function declineTask(): A2ATask {
  return {
    id: "task_remote_declined",
    status: {
      state: "completed",
      timestamp: CREATED_AT,
      message: {
        role: "agent",
        messageId: "msg_decline_1",
        parts: [{ kind: "data", data: { decline: true, reason_code: "field_unsupported" } }],
      },
    },
  } as unknown as A2ATask;
}

describe("merchant structured decline", () => {
  it("surfaces as MerchantDeclined instead of polling to the timeout", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-decline-"));
    dirs.push(dir);
    const recovery = new BuyerProtocolRecovery(dir, "buyer-agent:test", () => CREATED_AT);
    const started = Date.now();
    await expect(
      recovery.exchange({
        context: {
          taskId: "task-local-1",
          createdAt: CREATED_AT,
          intentBindingDigest: "sha256:intent-binding",
        },
        stage: "rfq",
        round: 0,
        merchantId: "mkt_test",
        endpoint: "https://merchant.example/a2a",
        binding: { intent: "probe" },
        build: (negotiationId) =>
          buildRfqEnvelope({
            negotiationId,
            sku: "SKU-1",
            quantity: { value: 5, unit: "piece" },
            now: () => CREATED_AT,
          }),
        send: async () => declineTask(),
        get: async () => declineTask(),
        timeoutMs: 5_000,
        pollIntervalMs: 50,
      }),
    ).rejects.toBeInstanceOf(MerchantDeclined);
    // 终态应当立刻返回，而不是等满超时预算。
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps the reason code for the caller to project", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-decline-"));
    dirs.push(dir);
    const recovery = new BuyerProtocolRecovery(dir, "buyer-agent:test", () => CREATED_AT);
    await recovery
      .exchange({
        context: { taskId: "task-local-2", createdAt: CREATED_AT, intentBindingDigest: "sha256:intent-binding" },
        stage: "rfq",
        round: 0,
        merchantId: "mkt_test",
        endpoint: "https://merchant.example/a2a",
        binding: { intent: "probe" },
        build: (negotiationId) =>
          buildRfqEnvelope({ negotiationId, sku: "SKU-1", quantity: { value: 5, unit: "piece" }, now: () => CREATED_AT }),
        send: async () => declineTask(),
        get: async () => declineTask(),
        timeoutMs: 2_000,
        pollIntervalMs: 50,
      })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(MerchantDeclined);
        expect((error as MerchantDeclined).reasonCode).toBe("field_unsupported");
      });
  });
});
