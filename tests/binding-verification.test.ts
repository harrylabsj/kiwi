/**
 * SIG-03 / T039：Buyer 侧对 Catalog 签发绑定声明的**真实密码学验证**。
 *
 * 覆盖设计要求（§11.4）：验证签名、发行者、scope、时间、端点、身份与绑定版本；
 * 拒绝篡改、未知发行者、算法回退、过期/未生效、旧绑定回放、已撤销状态；
 * 未知 kid **不得**触发到任意 URL 下载信任根（可信存储只由调用方本地提供）。
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signCompactJws, type JwsSigningIdentity } from "../src/trust/identity/jws.js";
import { buildBindingClaims } from "../src/trust/binding/claims.js";
import { verifyBindingClaims, trustCacheKey } from "../src/trust/binding/verify.js";
import { generateA2aSigningIdentity } from "../src/a2a/signing-key.js";

const NOW = new Date("2026-09-21T08:00:00Z");
const ISSUER_KID = "catalog-issuer-2026";
const RUNTIME_KID = "https://pilot.example.app.workbuddy.host";

function issuerIdentity(): JwsSigningIdentity {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { keyid: ISSUER_KID, algorithm: "ed25519", privateKey };
}

/** 一个"Runtime"身份（用仓库真实实现，保证与 Runtime 侧口径一致）。 */
function runtimeIdentity() {
  return generateA2aSigningIdentity(RUNTIME_KID);
}

function claimsFor(runtimeThumbprint: string, overrides: Record<string, unknown> = {}) {
  return buildBindingClaims({
    bindingId: "binding-m3-001",
    bindingVersion: 3,
    merchantId: "merchant-pilot-001",
    agentId: "merchant-agent-merchant-pilot-001",
    workloadRef: "wbapp_DAT3jOAJ",
    runtimeOrigin: "https://pilot.example.app.workbuddy.host",
    a2aEndpoint: "https://pilot.example.app.workbuddy.host/a2a",
    cardUrl: "https://catalog.example/v1/agents/cagt_001/agent-card.json",
    keyId: RUNTIME_KID,
    keyThumbprint: runtimeThumbprint,
    serviceEpoch: 7,
    issuedAt: NOW.toISOString(),
    ttlSeconds: 900,
    issuer: "catalog.kiwi.example",
    ...overrides,
  });
}

function harness(overrides: Record<string, unknown> = {}) {
  const issuer = issuerIdentity();
  const runtime = runtimeIdentity();
  const claims = claimsFor(`sha256:${"a".repeat(64)}`, overrides);
  const jws = signCompactJws(claims as unknown as Record<string, unknown>, issuer, {
    extraHeader: { typ: "kiwi-runtime-binding-claims" },
  });
  const trust = {
    resolveIssuerKey: (kid: string) => (kid === ISSUER_KID ? issuer.privateKey : undefined),
  };
  return { issuer, runtime, claims, jws, trust };
}

const EXPECTED = {
  agentId: "merchant-agent-merchant-pilot-001",
  cardUrl: "https://catalog.example/v1/agents/cagt_001/agent-card.json",
  a2aEndpoint: "https://pilot.example.app.workbuddy.host/a2a",
  runtimeOrigin: "https://pilot.example.app.workbuddy.host",
  merchantId: "merchant-pilot-001",
  serviceEpoch: 7,
  bindingId: "binding-m3-001",
  minBindingVersion: 3,
};

describe("SIG-03：绑定声明验证（真实签名）", () => {
  it("验签通过且与观测事实一致 → ok，返回完整 claims 与发行者 kid", () => {
    const { jws, trust } = harness();
    const result = verifyBindingClaims(jws, { trust, expected: EXPECTED, now: () => NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.binding_id).toBe("binding-m3-001");
      expect(result.claims.binding_version).toBe(3);
      expect(result.issuer_kid).toBe(ISSUER_KID);
    }
  });

  it("篡改负载（改 merchant）→ 验签失败", () => {
    const { jws, trust } = harness();
    const [h, , s] = jws.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...claimsFor(`sha256:${"a".repeat(64)}`), merchant_id: "merchant-evil" }),
      "utf8",
    ).toString("base64url");
    const result = verifyBindingClaims(`${h}.${tamperedPayload}.${s}`, { trust, now: () => NOW });
    expect(result).toMatchObject({ ok: false, code: "BAD_SIGNATURE" });
  });

  it("未知发行者 kid → UNKNOWN_ISSUER（不得据此下载信任根）", () => {
    const { jws } = harness();
    const emptyTrust = { resolveIssuerKey: () => undefined };
    expect(verifyBindingClaims(jws, { trust: emptyTrust, now: () => NOW })).toMatchObject({
      ok: false,
      code: "UNKNOWN_ISSUER",
    });
  });

  it("用另一把钥匙签名（换发行者）→ 验签失败", () => {
    const { claims, trust } = harness();
    const other = issuerIdentity();
    const wrongJws = signCompactJws(claims as unknown as Record<string, unknown>, other);
    // trust 只认 ISSUER_KID 那把公钥；kid 相同但密钥不同 → 验签必须失败
    expect(verifyBindingClaims(wrongJws, { trust, now: () => NOW })).toMatchObject({
      ok: false,
      code: "BAD_SIGNATURE",
    });
  });

  it("过期 / 未生效 → EXPIRED / NOT_YET_VALID", () => {
    const expired = harness({ issuedAt: "2026-09-21T06:00:00Z", ttlSeconds: 60 });
    expect(verifyBindingClaims(expired.jws, { trust: expired.trust, now: () => NOW })).toMatchObject({
      ok: false,
      code: "EXPIRED",
    });
    const future = harness({ issuedAt: "2026-09-21T09:00:00Z" });
    expect(verifyBindingClaims(future.jws, { trust: future.trust, now: () => NOW })).toMatchObject({
      ok: false,
      code: "NOT_YET_VALID",
    });
  });

  it("端点/商家/绑代次 不相符 → 逐项拒绝（不串商家）", () => {
    const { jws, trust } = harness();
    const opts = (expected: Record<string, unknown>) => ({ trust, expected, now: () => NOW });
    expect(
      verifyBindingClaims(jws, opts({ ...EXPECTED, a2aEndpoint: "https://other.example/a2a" })),
    ).toMatchObject({ ok: false, code: "ENDPOINT_MISMATCH" });
    expect(
      verifyBindingClaims(jws, opts({ ...EXPECTED, merchantId: "merchant-other" })),
    ).toMatchObject({ ok: false, code: "MERCHANT_MISMATCH" });
    expect(verifyBindingClaims(jws, opts({ ...EXPECTED, serviceEpoch: 8 }))).toMatchObject({
      ok: false,
      code: "SERVICE_EPOCH_MISMATCH",
    });
    expect(
      verifyBindingClaims(jws, opts({ ...EXPECTED, cardUrl: "https://evil.example/card.json" })),
    ).toMatchObject({ ok: false, code: "CARD_URL_MISMATCH" });
  });

  it("旧绑定回放（binding_version 低于下限）→ BINDING_VERSION_TOO_OLD", () => {
    const old = harness({ bindingVersion: 1 });
    expect(
      verifyBindingClaims(old.jws, { trust: old.trust, expected: { minBindingVersion: 3 }, now: () => NOW }),
    ).toMatchObject({ ok: false, code: "BINDING_VERSION_TOO_OLD" });
  });

  it("已撤销状态 → REVOKED（治理撤回后旧声明不再被接受）", () => {
    const revoked = harness({ status: "revoked" });
    expect(verifyBindingClaims(revoked.jws, { trust: revoked.trust, now: () => NOW })).toMatchObject({
      ok: false,
      code: "REVOKED",
    });
  });

  it("非 EdDSA 算法（伪造 alg=none）→ 拒绝，不做算法回退", () => {
    const { claims, trust } = harness();
    const header = Buffer.from(JSON.stringify({ alg: "none", kid: ISSUER_KID }), "utf8").toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const forged = `${header}.${payload}.`;
    const result = verifyBindingClaims(forged, { trust, now: () => NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["MALFORMED", "ALGORITHM_NOT_ALLOWED", "BAD_SIGNATURE"]).toContain(result.code);
    }
  });

  it("信任缓存键按 (来源, agent, card revision, binding_version, 端点) 联合索引——不按 Catalog hostname 归并商家", () => {
    const a = trustCacheKey({
      source: "catalog-a", agentId: "cagt_1", cardRevision: 2, bindingVersion: 3, endpoint: "https://m1.example/a2a",
    });
    const b = trustCacheKey({
      source: "catalog-a", agentId: "cagt_2", cardRevision: 2, bindingVersion: 3, endpoint: "https://m2.example/a2a",
    });
    expect(a).not.toBe(b);
    expect(
      trustCacheKey({ source: "catalog-a", agentId: "cagt_1", cardRevision: 2, bindingVersion: 3, endpoint: "https://m1.example/a2a" }),
    ).toBe(a);
    // 同一 agent 但换绑定版本 → 新条目（旧绑定不得复用信任）
    expect(
      trustCacheKey({ source: "catalog-a", agentId: "cagt_1", cardRevision: 2, bindingVersion: 4, endpoint: "https://m1.example/a2a" }),
    ).not.toBe(a);
  });
});
