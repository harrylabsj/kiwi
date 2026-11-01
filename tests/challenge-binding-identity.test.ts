/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * `/control/challenge` 应答者的**身份来源**契约（runtime-challenge + connect-service
 * getChallengeIdentity 的 direct 连接接线）。
 *
 * 边界（a422 已覆盖结构/限流/重放/窗口，本文件钉住身份语义）：
 *   - direct 模式下 merchant/agent 只认「当前已验证的绑定会话」，静态旧口径被覆盖；
 *   - 未绑定 → 503 catalog_binding_missing，不签任何证明；他人实例的挑战拒绝；
 *   - 旧 onboarding 路径（无 expectedBindingIdentity）行为不变；
 *   - 同一 challenge_id 只应答一次。
 */
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, createPublicKey, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createChallengeResponder, type ChallengeResponderOptions } from "../src/cloud/binding/runtime-challenge.js";
import { createBindingChallenge, challengeSubject, type BindingChallenge } from "../src/cloud/binding/proofs.js";
import { publicKeyThumbprint } from "../src/trust/binding/thumbprint.js";
import { verifyCompactJws, type JwsSigningIdentity } from "../src/trust/identity/jws.js";

const ORIGIN = "https://shop.example";
const PATH = "/a2a";
const NOW = () => new Date("2026-11-01T10:00:00Z");

interface Fixture {
  server: Server;
  post: (challenge: BindingChallenge) => Promise<{ status: number; body: Record<string, unknown> }>;
  publicKey: ReturnType<typeof createPublicKey>;
  thumbprint: string;
  close: () => Promise<void>;
}

type ResponderOverrides = Omit<ChallengeResponderOptions, "signingIdentity" | "now" | "store">;

function startResponder(options: ResponderOverrides): Promise<Fixture> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const signingIdentity: JwsSigningIdentity = { keyid: "runtime-under-test", algorithm: "ed25519", privateKey };
  const thumbprint = publicKeyThumbprint(createPublicKey(privateKey).export({ type: "spki", format: "pem" }) as string);
  const handler = createChallengeResponder({ signingIdentity, now: NOW, ...options });
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const post = async (challenge: BindingChallenge) => {
        const response = await fetch(`http://127.0.0.1:${port}/control/challenge`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ challenge }),
        });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };
      resolve({
        server, post, publicKey: createPublicKey(privateKey), thumbprint,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const mkChallenge = (thumbprint: string, over: Partial<Record<string, unknown>> = {}): BindingChallenge =>
  createBindingChallenge({
    purpose: "endpoint", agentId: "cagt-1", merchantId: "m-verified",
    origin: ORIGIN, path: PATH, keyThumbprint: thumbprint, generation: 1, now: NOW,
    ...over,
  } as Parameters<typeof createBindingChallenge>[0]);
const digestOf = (challenge: BindingChallenge): string =>
  `sha256:${createHash("sha256").update(challengeSubject(challenge), "utf8").digest("hex")}`;

describe("challenge responder binding identity (direct connection)", () => {
  it("合法绑定身份：应答成功、证明可验、subject_digest 与挑战主体一致", async () => {
    const fx = await startResponder({
      expectedMerchantId: "stale-product-merchant", expectedAgentId: "stale-product-agent",
      expectedBindingIdentity: () => ({ merchantId: "m-verified", agentId: "cagt-1" }),
      currentGeneration: 1, expectedOrigin: ORIGIN, expectedPath: PATH,
    });
    try {
      const challenge = mkChallenge(fx.thumbprint);
      const ok = await fx.post(challenge);
      expect(ok.status).toBe(200);
      expect(typeof ok.body.proof_jws).toBe("string");
      const payload = JSON.parse(verifyCompactJws(String(ok.body.proof_jws), fx.publicKey).payload.toString("utf8")) as Record<string, unknown>;
      expect(payload["merchant_id"]).toBe("m-verified");
      expect(payload["agent_id"]).toBe("cagt-1");
      expect(ok.body.subject_digest).toBe(digestOf(challenge));
      expect(ok.body.key_id).toBe("runtime-under-test");
      expect(ok.body.key_thumbprint).toBe(fx.thumbprint);
    } finally { await fx.close(); }
  });

  it("身份错配拒绝（merchant/agent/双错），旧 static 口径被 direct 身份覆盖", async () => {
    const fx = await startResponder({
      expectedMerchantId: "stale-product-merchant", expectedAgentId: "stale-product-agent",
      expectedBindingIdentity: () => ({ merchantId: "m-verified", agentId: "cagt-1" }),
      currentGeneration: 1, expectedOrigin: ORIGIN, expectedPath: PATH,
    });
    try {
      for (const over of [
        { merchantId: "m-other" },
        { agentId: "cagt-other" },
        { merchantId: "x", agentId: "y" },
        // 旧的静态口径身份：direct 模式下不再被采信。
        { merchantId: "stale-product-merchant", agentId: "stale-product-agent" },
      ]) {
        const rejected = await fx.post(mkChallenge(fx.thumbprint, over));
        expect(rejected.status).toBe(403);
        expect(rejected.body.error).toBe("identity_mismatch");
      }
    } finally { await fx.close(); }
  });

  it("未绑定 → 503 catalog_binding_missing（不签证明）；他人实例挑战 → 403 指纹不符", async () => {
    const unbound = await startResponder({
      expectedMerchantId: "stale-product-merchant", expectedAgentId: "stale-product-agent",
      expectedBindingIdentity: () => undefined,
      currentGeneration: 1, expectedOrigin: ORIGIN, expectedPath: PATH,
    });
    try {
      const missing = await unbound.post(mkChallenge(unbound.thumbprint));
      expect(missing.status).toBe(503);
      expect(missing.body.error).toBe("catalog_binding_missing");
      expect(missing.body.proof_jws).toBeUndefined();
    } finally { await unbound.close(); }

    const fx = await startResponder({
      expectedMerchantId: "stale-product-merchant", expectedAgentId: "stale-product-agent",
      expectedBindingIdentity: () => ({ merchantId: "m-verified", agentId: "cagt-1" }),
      currentGeneration: 1, expectedOrigin: ORIGIN, expectedPath: PATH,
    });
    try {
      const { privateKey: otherKey } = generateKeyPairSync("ed25519");
      const otherThumbprint = publicKeyThumbprint(createPublicKey(otherKey).export({ type: "spki", format: "pem" }) as string);
      const foreign = await fx.post(mkChallenge(otherThumbprint));
      expect(foreign.status).toBe(403);
      expect(foreign.body.error).toBe("thumbprint_mismatch");
    } finally { await fx.close(); }
  });

  it("旧 onboarding 路径不回归：静态/函数式身份、代次、一次性重放", async () => {
    const legacy = await startResponder({
      expectedMerchantId: "merchant-synthetic", expectedAgentId: "merchant-agent-synthetic",
      currentGeneration: 1, expectedOrigin: ORIGIN, expectedPath: PATH,
    });
    const notReady = await startResponder({
      expectedMerchantId: () => undefined, expectedAgentId: "merchant-agent-synthetic",
      currentGeneration: 1, expectedOrigin: ORIGIN, expectedPath: PATH,
    });
    try {
      const ok = await legacy.post(mkChallenge(legacy.thumbprint,
        { merchantId: "merchant-synthetic", agentId: "merchant-agent-synthetic" }));
      expect(ok.status).toBe(200);
      expect(typeof ok.body.proof_jws).toBe("string");
      const mismatch = await legacy.post(mkChallenge(legacy.thumbprint,
        { merchantId: "someone-else", agentId: "merchant-agent-synthetic" }));
      expect(mismatch.status).toBe(403);
      expect(mismatch.body.error).toBe("identity_mismatch");
      const staleProfile = await notReady.post(mkChallenge(notReady.thumbprint,
        { merchantId: "merchant-synthetic", agentId: "merchant-agent-synthetic" }));
      expect(staleProfile.status).toBe(503);
      expect(staleProfile.body.error).toBe("catalog_binding_missing");
      const wrongGeneration = await legacy.post(mkChallenge(legacy.thumbprint,
        { merchantId: "merchant-synthetic", agentId: "merchant-agent-synthetic", generation: 2 }));
      expect(wrongGeneration.status).toBe(409);
      expect(wrongGeneration.body.error).toBe("generation_mismatch");
      const challenge = mkChallenge(legacy.thumbprint,
        { merchantId: "merchant-synthetic", agentId: "merchant-agent-synthetic" });
      expect((await legacy.post(challenge)).status).toBe(200);
      const replayed = await legacy.post(challenge);
      expect(replayed.status).toBe(409);
      expect(replayed.body.error).toBe("challenge_replayed");
    } finally {
      await legacy.close();
      await notReady.close();
    }
  });
});
