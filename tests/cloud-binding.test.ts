/**
 * M2 绑定链路（T025–T029 / SIG-02 / SIG-05）——本地密码学测试。
 *
 * 覆盖：
 *   1. 挑战应答（`/control/challenge`）：只签发给本实例的受限结构挑战；一次性；
 *      过期/异代次/异指纹/异身份/超速一律拒绝；不成为"任意内容签名服务"。
 *   2. 受控签发（SIG-02）：缺授权、跨商家、异代次、换钥匙、缺持钥/端点证明、
 *      治理非 active、service_epoch 不符、已撤销 → **一律不签发**；成功签发的
 *      JWS 能用发行者公钥验签，且 claims 与输入一致。
 *   3. 审计与撤销（SIG-05）：签发/拒绝留痕且脱敏；撤销集跨"重启"仍生效
 *      （已撤销的绑定/密钥指纹不得重新签发）；篡改后的声明验签失败。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BindingAuditLog, RevocationSet } from "../src/cloud/binding/audit.js";
import { issueBindingClaims } from "../src/cloud/binding/issuance.js";
import {
  BindingChallengeStore,
  createBindingChallenge,
  signBindingChallenge,
  verifyBindingChallengeProof,
  type BindingChallenge,
} from "../src/cloud/binding/proofs.js";
import { createChallengeResponder } from "../src/cloud/binding/runtime-challenge.js";
import { publicKeyThumbprint } from "../src/trust/binding/thumbprint.js";
import { verifyCompactJws, type JwsSigningIdentity } from "../src/trust/identity/jws.js";

const MERCHANT = "merchant-pilot-001";
const AGENT = "merchant-agent-merchant-pilot-001"; // 契约模式不允许冒号（见 claims.toBindingAgentId）
const ORIGIN = "https://pilot.example.app.workbuddy.host";
const A2A_PATH = "/a2a";
const PROFILE_AGENT_ID = "merchant-agent:merchant-pilot-001"; // profile 原文（含冒号）
const GENERATION = 1;
const NOW = new Date("2026-09-21T04:00:00Z");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function identity(keyid: string): JwsSigningIdentity {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { keyid, algorithm: "ed25519", privateKey };
}

/** runtime 的身份：同时用于挑战证明与"本实例指纹"。 */
function makeRuntime(): { runtime: JwsSigningIdentity; thumbprint: string; publicPem: string } {
  const runtime = identity("runtime:test");
  const publicPem = createPublicKey(runtime.privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    runtime,
    thumbprint: publicKeyThumbprint(createPublicKey(runtime.privateKey)),
    publicPem,
  };
}

function challengeFor(
  thumbprint: string,
  overrides: Partial<BindingChallenge> = {},
): BindingChallenge {
  const base = createBindingChallenge({
    purpose: "key-custody",
    agentId: AGENT,
    merchantId: MERCHANT,
    origin: ORIGIN,
    path: A2A_PATH,
    keyThumbprint: thumbprint,
    generation: GENERATION,
    now: () => NOW,
  });
  return { ...base, ...overrides };
}

async function startChallengeServer(options: {
  runtime: JwsSigningIdentity;
  maxPerMinute?: number;
}): Promise<{ base: string; store: BindingChallengeStore }> {
  const store = new BindingChallengeStore();
  const handler = createChallengeResponder({
    signingIdentity: options.runtime,
    expectedMerchantId: MERCHANT,
    expectedAgentId: AGENT,
    currentGeneration: GENERATION,
    store,
    ...(options.maxPerMinute !== undefined ? { maxPerMinute: options.maxPerMinute } : {}),
    now: () => NOW,
  });
  const server: Server = createServer(handler);
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { base: `http://127.0.0.1:${port}`, store };
}

async function postChallenge(base: string, challenge: unknown) {
  const res = await fetch(`${base}/control/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("契约冲突：agent_id 归一（显式、可追溯）", () => {
  it("profile 的 agent_id 含冒号（契约不允许）→ 显式归一，非法值不静默通过", async () => {
    const { toBindingAgentId } = await import("../src/trust/binding/claims.js");
    expect(toBindingAgentId(PROFILE_AGENT_ID)).toBe(AGENT);
    // 归一后仍不合模式 → 抛错（绝不签发"看起来合法"的错身份）
    expect(() => toBindingAgentId(":")).toThrow();
  });
});

describe("挑战应答（/control/challenge）", () => {
  it("属于本实例的挑战 → 返回受限结构签名证明，可用本实例公钥验签", async () => {
    const { runtime, thumbprint } = makeRuntime();
    const { base } = await startChallengeServer({ runtime });
    const challenge = challengeFor(thumbprint);
    const res = await postChallenge(base, challenge);
    expect(res.status).toBe(200);
    const proof = String(res.body["proof_jws"]);
    const verified = verifyCompactJws(proof, createPublicKey(runtime.privateKey));
    // 签名内容 = 挑战主体（受限结构），不是调用方给的自由文本。
    expect(verified.payload.toString("utf8")).toContain(challenge.nonce);
    expect(verified.payload.toString("utf8")).toContain(AGENT);
    expect(res.body["key_thumbprint"]).toBe(thumbprint);
  });

  it("挑战属于别的实例（指纹不符）→ 403，不签名", async () => {
    const { runtime } = makeRuntime();
    const other = makeRuntime();
    const { base } = await startChallengeServer({ runtime });
    const res = await postChallenge(base, challengeFor(other.thumbprint));
    expect(res.status).toBe(403);
    expect(res.body["proof_jws"]).toBeUndefined();
  });

  it("重复提交同一挑战 → 409（一次性）；过期 → 403", async () => {
    const { runtime, thumbprint } = makeRuntime();
    const { base } = await startChallengeServer({ runtime });
    const challenge = challengeFor(thumbprint);
    expect((await postChallenge(base, challenge)).status).toBe(200);
    expect((await postChallenge(base, challenge)).status).toBe(409);

    const expired = challengeFor(thumbprint, {
      challenge_id: randomUUID(),
      expires_at: new Date(NOW.getTime() - 1000).toISOString(),
    });
    expect((await postChallenge(base, expired)).status).toBe(403);
  });

  it("异代次 → 409；结构不完整 → 400；GET → 405；超速 → 429", async () => {
    const { runtime, thumbprint } = makeRuntime();
    const { base } = await startChallengeServer({ runtime, maxPerMinute: 3 });

    const wrongGen = challengeFor(thumbprint, { challenge_id: randomUUID(), generation: 2 });
    expect((await postChallenge(base, wrongGen)).status).toBe(409);
    expect((await postChallenge(base, { challenge_id: "x" })).status).toBe(400);
    const get = await fetch(`${base}/control/challenge`);
    expect(get.status).toBe(405);

    // 速率上限：继续打满（前三次已用掉两次成功/失败都计数）
    let sawRateLimit = false;
    for (let i = 0; i < 6; i += 1) {
      const res = await postChallenge(base, challengeFor(thumbprint, { challenge_id: randomUUID() }));
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});

describe("持钥证明的验收方语义（verifyBindingChallengeProof）", () => {
  it("正确证明通过；负载被替换 / 过期 / 重放 / 指纹不符 一律拒绝", async () => {
    const { runtime, thumbprint } = makeRuntime();
    const store = new BindingChallengeStore();
    const challenge = challengeFor(thumbprint);
    const good = signBindingChallenge(challenge, runtime);

    const verified = verifyBindingChallengeProof({
      challenge,
      proofJws: good,
      publicKey: createPublicKey(runtime.privateKey),
      store,
      options: { now: () => NOW },
    });
    expect(verified.key_thumbprint).toBe(thumbprint);
    expect(verified.generation).toBe(GENERATION);

    // 重放
    expect(() =>
      verifyBindingChallengeProof({
        challenge,
        proofJws: good,
        publicKey: createPublicKey(runtime.privateKey),
        store,
        options: { now: () => NOW },
      }),
    ).toThrowError(/重放|已被消费/);

    // 过期
    const stale = challengeFor(thumbprint, {
      challenge_id: randomUUID(),
      expires_at: new Date(NOW.getTime() - 1).toISOString(),
    });
    expect(() =>
      verifyBindingChallengeProof({
        challenge: stale,
        proofJws: signBindingChallenge(stale, runtime),
        publicKey: createPublicKey(runtime.privateKey),
        store,
        options: { now: () => NOW },
      }),
    ).toThrowError(/过期/);

    // 指纹不符（用另一个实例的公钥来验）
    const other = makeRuntime();
    expect(() =>
      verifyBindingChallengeProof({
        challenge: challengeFor(thumbprint, { challenge_id: randomUUID() }),
        proofJws: good,
        publicKey: createPublicKey(other.runtime.privateKey),
        store,
        options: { now: () => NOW },
      }),
    ).toThrowError(/指纹/);
  });
});

describe("受控签发（SIG-02）与审计/撤销（SIG-05）", () => {
  function harness() {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-binding-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const issuer = identity("catalog-issuer:test");
    const runtime = makeRuntime();
    const audit = new BindingAuditLog({ file: path.join(dir, "audit.jsonl"), now: () => NOW });
    const revocations = new RevocationSet({ file: path.join(dir, "revocations.json") });
    const store = new BindingChallengeStore();
    const custodyChallenge = challengeFor(runtime.thumbprint);
    const endpointChallenge = challengeFor(runtime.thumbprint, {
      challenge_id: randomUUID(),
      purpose: "endpoint",
      origin: ORIGIN,
      path: A2A_PATH,
    });
    const custody = verifyBindingChallengeProof({
      challenge: custodyChallenge,
      proofJws: signBindingChallenge(custodyChallenge, runtime.runtime),
      publicKey: createPublicKey(runtime.runtime.privateKey),
      store,
      options: { now: () => NOW },
    });
    const endpoint = verifyBindingChallengeProof({
      challenge: endpointChallenge,
      proofJws: signBindingChallenge(endpointChallenge, runtime.runtime),
      publicKey: createPublicKey(runtime.runtime.privateKey),
      store,
      options: { now: () => NOW },
    });
    const authorization = {
      merchant_id: MERCHANT,
      intent_id: "intent-001",
      generation: GENERATION,
      method: "portal_session" as const,
      authorized_at: NOW.toISOString(),
      key_thumbprint: runtime.thumbprint,
    };
    const claimsInput = {
      bindingId: "binding-001",
      bindingVersion: 1,
      merchantId: MERCHANT,
      agentId: AGENT,
      workloadRef: "wbapp_test",
      runtimeOrigin: ORIGIN,
      a2aEndpoint: `${ORIGIN}${A2A_PATH}`,
      cardUrl: `${ORIGIN}/.well-known/agent-card.json`,
      keyId: runtime.runtime.keyid,
      keyThumbprint: runtime.thumbprint,
      serviceEpoch: 7,
      issuedAt: NOW.toISOString(),
      ttlSeconds: 900,
    };
    return {
      dir,
      issuer,
      runtime,
      audit,
      revocations,
      authorization,
      claimsInput,
      custody,
      endpoint,
      issue: (overrides: Partial<Parameters<typeof issueBindingClaims>[0]> = {}) =>
        issueBindingClaims(
          {
            claims: claimsInput,
            authorization,
            keyCustody: custody,
            endpointChallenge: endpoint,
            currentGeneration: GENERATION,
            governance: { status: "active", service_epoch: 7 },
            ...overrides,
          },
          { signer: issuer, issuerId: "catalog.kiwi.example", audit, revocations, now: () => NOW },
        ),
    };
  }

  it("授权+持钥+端点证明齐备且治理 active → 签发成功，发行者公钥可验签", () => {
    const h = harness();
    const result = h.issue();
    if (!result.ok) console.log("DEBUG_ISSUE", result.code, result.reason);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.issuer).toBe("catalog.kiwi.example");
    expect(result.claims.scope).toBe("a2a-runtime");
    expect(result.claims.key_thumbprint).toBe(h.runtime.thumbprint);

    // 用发行者公钥验签（真实密码学，不是结构样例）
    const verified = verifyCompactJws(result.jws, createPublicKey(h.issuer.privateKey));
    const claims = JSON.parse(verified.payload.toString("utf8")) as Record<string, unknown>;
    expect(claims["binding_id"]).toBe("binding-001");
    expect(claims["merchant_id"]).toBe(MERCHANT);

    // 篡改负载 → 验签失败
    const parts = result.jws.split(".");
    const tampered = `${parts[0]}.${Buffer.from('{"binding_id":"evil"}', "utf8").toString("base64url")}.${parts[2]}`;
    expect(() => verifyCompactJws(tampered, createPublicKey(h.issuer.privateKey))).toThrow();

    // 审计留痕（签发一条）
    const events = h.audit.read();
    expect(events.some((e) => e.event === "issued" && e.binding_id === "binding-001")).toBe(true);
  });

  it("缺授权 / 跨商家 / 异代次 / 换钥匙 → 拒绝签发", () => {
    const h = harness();
    expect(h.issue({ authorization: undefined })).toMatchObject({ ok: false, code: "MISSING_AUTHORIZATION" });
    expect(
      h.issue({ authorization: { ...h.authorization, merchant_id: "merchant-other" } }),
    ).toMatchObject({ ok: false, code: "AUTHORIZATION_MERCHANT_MISMATCH" });
    expect(
      h.issue({ authorization: { ...h.authorization, generation: 2 } }),
    ).toMatchObject({ ok: false, code: "AUTHORIZATION_GENERATION_MISMATCH" });
    expect(
      h.issue({ authorization: { ...h.authorization, key_thumbprint: "sha256:" + "0".repeat(64) } }),
    ).toMatchObject({ ok: false, code: "AUTHORIZATION_THUMBPRINT_MISMATCH" });
  });

  it("缺持钥/端点证明、证明与声明不符、治理非 active、epoch 不符 → 拒绝签发", () => {
    const h = harness();
    expect(h.issue({ keyCustody: undefined })).toMatchObject({ ok: false, code: "MISSING_KEY_CUSTODY" });
    expect(h.issue({ endpointChallenge: undefined })).toMatchObject({ ok: false, code: "MISSING_ENDPOINT_CHALLENGE" });
    expect(
      h.issue({ governance: { status: "paused", service_epoch: 7 } }),
    ).toMatchObject({ ok: false, code: "GOVERNANCE_NOT_ACTIVE" });
    expect(
      h.issue({ governance: { status: "active", service_epoch: 8 } }),
    ).toMatchObject({ ok: false, code: "SERVICE_EPOCH_MISMATCH" });
    // 用 key-custody 的证明冒充端点挑战
    expect(h.issue({ endpointChallenge: h.custody })).toMatchObject({
      ok: false,
      code: "MISSING_ENDPOINT_CHALLENGE",
    });
  });

  it("service_epoch 写成字符串 / TTL 超上限 → claims 校验拒绝", () => {
    const h = harness();
    // 类型错（字符串 epoch）同样必须拒绝——拒绝码是稳定码之一，不追求唯一。
    const badEpoch = h.issue({ claims: { ...h.claimsInput, serviceEpoch: "7" as unknown as number } });
    expect(badEpoch.ok).toBe(false);
    const tooLong = h.issue({ claims: { ...h.claimsInput, ttlSeconds: 3600 } });
    expect(tooLong).toEqual(expect.objectContaining({ ok: false, code: "CLAIMS_INVALID" }));
  });

  it("撤销后不得重新签发（SIG-05：恢复不复活）；审计与撤销集跨重启仍生效", () => {
    const h = harness();
    h.revocations.revoke({
      binding_id: "binding-001",
      reason: "key compromise",
      revoked_at: NOW.toISOString(),
    });
    expect(h.issue()).toMatchObject({ ok: false, code: "BINDING_REVOKED" });

    // 重新打开"进程"（同文件新实例）→ 撤销仍生效
    const reopened = new RevocationSet({ file: path.join(h.dir, "revocations.json") });
    expect(reopened.byBinding("binding-001")).toBeDefined();

    // 审计文件同样可读回，且拒绝事件留痕
    const events = h.audit.read();
    expect(events.some((e) => e.event === "refused" && e.code === "BINDING_REVOKED")).toBe(true);
    // 脱敏：审计里不出现私钥/JWS 片段
    const raw = readFileSync(path.join(h.dir, "audit.jsonl"), "utf8");
    expect(raw).not.toMatch(/PRIVATE KEY|eyJ[A-Za-z0-9_-]{10,}\./);
  });
});
