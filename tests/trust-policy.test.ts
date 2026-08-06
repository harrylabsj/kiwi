/**
 * TrustPolicy 矩阵 + HttpMessageSignatureVerifier（AuthVerifier 接缝）+ 身份绑定。
 *
 * 覆盖：
 *   - DEFAULT_TRUST_POLICY 矩阵（T0 不强制 / T1+ 强制签名 / T2+ 强制 JWS / T3 强制 nonce）；
 *   - evaluatePolicy 按 level 判定；
 *   - bindIdentity：绑定到幂等主键 sender + Ledger snapshot；宣称冲突 → identity_rejected；
 *   - HttpMessageSignatureVerifier：匿名 T0 放行、强制签名时拒绝未签名、
 *     T1 签名通过、T2 缺卡片 JWS 拒绝、T3 缺 nonce 拒绝、宣称冲突 identity_rejected、
 *     nonce 复用 replay_detected。
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRUST_POLICY,
  HttpMessageSignatureVerifier,
  HttpMessageSigner,
  InMemoryNonceStore,
  bindIdentity,
  evaluatePolicy,
  resolveFromSigningKeys,
} from "../src/trust/identity/index.js";
import type { SigningKey } from "../src/trust/identity/index.js";

const ED25519_SEED = Buffer.from(
  "e90b1a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
  "hex",
);
const PUBLIC_X = "70unY03oy6rp20mv0AvfklFpbVJVy8s_jwN6egnPjQY";
const CREATED = 1723000000;
const HOST = "127.0.0.1:43210";

function key(keyid: string, trustLevel: "T1" | "T2" | "T3", identity: string): SigningKey {
  return {
    keyid,
    algorithm: "ed25519",
    jwk: { kty: "OKP", crv: "Ed25519", x: PUBLIC_X },
    profile: { identity, organization: "Acme", trustLevel },
  };
}

const RESOLVER = resolveFromSigningKeys([
  key("t1-key", "T1", "peer-t1"),
  key("t2-key", "T2", "peer-t2"),
  key("t3-key", "T3", "peer-t3"),
]);

function signedHeaders(keyid: string, overrides: { nonce?: string } = {}): Record<string, string> {
  const signer = new HttpMessageSigner({
    keyid,
    algorithm: "ed25519",
    privateKey: ED25519_SEED,
    created: CREATED,
    nonce: overrides.nonce,
  });
  return signer.sign({ method: "POST", url: "http://127.0.0.1:43210/", body: Buffer.from("{}"), headers: {} });
}

function verifierCtx(extraHeaders: Record<string, string>, body?: Buffer) {
  return {
    method: "POST",
    url: "/",
    scheme: "http" as const,
    remoteAddress: "10.0.0.1",
    authorizationHeader: undefined,
    headers: { host: HOST, ...extraHeaders },
    body: body ?? Buffer.from("{}"),
  };
}

describe("DEFAULT_TRUST_POLICY 矩阵", () => {
  it("T0 不强制任何证据；T1+ 强制 HTTP 签名；T2+ 强制 JWS；T3 强制 nonce", () => {
    const p = DEFAULT_TRUST_POLICY;
    expect([p.requireHttpSignature("T0"), p.requireCardJws("T0"), p.requireNonce("T0")]).toEqual([
      false,
      false,
      false,
    ]);
    expect([p.requireHttpSignature("T1"), p.requireCardJws("T1"), p.requireNonce("T1")]).toEqual([
      true,
      false,
      false,
    ]);
    expect([p.requireHttpSignature("T2"), p.requireCardJws("T2"), p.requireNonce("T2")]).toEqual([
      true,
      true,
      false,
    ]);
    expect([p.requireHttpSignature("T3"), p.requireCardJws("T3"), p.requireNonce("T3")]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("evaluatePolicy：T0 未签名放行，T1+ 未签名拒绝", () => {
    const p = DEFAULT_TRUST_POLICY;
    expect(
      evaluatePolicy(p, { level: "T0", hasHttpSignature: false, hasCardJws: false }).allowed,
    ).toBe(true);
    expect(
      evaluatePolicy(p, { level: "T1", hasHttpSignature: false, hasCardJws: false }),
    ).toMatchObject({ allowed: false, protocolCode: "authentication_required" });
  });

  it("evaluatePolicy：T2 强制有效 JWS", () => {
    const p = DEFAULT_TRUST_POLICY;
    expect(
      evaluatePolicy(p, { level: "T2", hasHttpSignature: true, hasCardJws: false }).allowed,
    ).toBe(false);
    expect(
      evaluatePolicy(p, { level: "T2", hasHttpSignature: true, hasCardJws: true, cardJwsValid: false }),
    ).toMatchObject({ allowed: false, protocolCode: "authorization_failed" });
    expect(
      evaluatePolicy(p, { level: "T2", hasHttpSignature: true, hasCardJws: true, cardJwsValid: true }).allowed,
    ).toBe(true);
  });

  it("evaluatePolicy：T3 强制 nonce", () => {
    const p = DEFAULT_TRUST_POLICY;
    expect(
      evaluatePolicy(p, {
        level: "T3",
        hasHttpSignature: true,
        hasCardJws: true,
        cardJwsValid: true,
        hasNonce: false,
      }).allowed,
    ).toBe(false);
    expect(
      evaluatePolicy(p, {
        level: "T3",
        hasHttpSignature: true,
        hasCardJws: true,
        cardJwsValid: true,
        hasNonce: true,
      }).allowed,
    ).toBe(true);
  });
});

describe("bindIdentity（身份绑定）", () => {
  it("把验证过的身份绑定到幂等主键 sender 与 Ledger snapshot", () => {
    const bound = bindIdentity({
      verified: {
        identity: "peer-t2",
        keyid: "t2-key",
        trustLevel: "T2",
        profile: { identity: "peer-t2", organization: "Acme" },
      },
    });
    expect(bound).toEqual({
      ok: true,
      senderIdentity: "peer-t2",
      snapshot: { sender_identity: "peer-t2", counterparty_identity: "peer-t2" },
    });
  });

  it("宣称 org 与密钥档案冲突 → identity_rejected", () => {
    const bound = bindIdentity({
      verified: {
        identity: "peer-t2",
        keyid: "t2-key",
        trustLevel: "T2",
        profile: { identity: "peer-t2", organization: "Acme" },
      },
      claimed: { organization: "Evil Corp" },
    });
    expect(bound).toMatchObject({ ok: false, protocolCode: "identity_rejected" });
  });

  it("宣称 identity 与密钥档案冲突 → identity_rejected", () => {
    const bound = bindIdentity({
      verified: {
        identity: "peer-t2",
        keyid: "t2-key",
        trustLevel: "T2",
        profile: { identity: "peer-t2" },
      },
      claimed: { identity: "someone-else" },
    });
    expect(bound).toMatchObject({ ok: false, protocolCode: "identity_rejected" });
  });

  it("宣称与档案一致 → ok", () => {
    const bound = bindIdentity({
      verified: {
        identity: "peer-t2",
        keyid: "t2-key",
        trustLevel: "T2",
        profile: { identity: "peer-t2", organization: "Acme" },
      },
      claimed: { identity: "peer-t2", organization: "Acme" },
    });
    expect(bound).toMatchObject({ ok: true, senderIdentity: "peer-t2" });
  });
});

describe("HttpMessageSignatureVerifier（AuthVerifier 接缝）", () => {
  it("未签名 T0 请求以匿名身份放行", () => {
    const verifier = new HttpMessageSignatureVerifier({ resolver: RESOLVER });
    expect(verifier.verify(verifierCtx({}))).toEqual({ authenticated: true, identity: "anonymous" });
  });

  it("anonymousTrustLevel=T1 时未签名请求被拒", () => {
    const verifier = new HttpMessageSignatureVerifier({ resolver: RESOLVER, anonymousTrustLevel: "T1" });
    expect(verifier.verify(verifierCtx({}))).toMatchObject({
      authenticated: false,
      protocolCode: "authentication_required",
    });
  });

  it("T1 密钥签名请求通过（T1 不强制 JWS）", () => {
    const verifier = new HttpMessageSignatureVerifier({ resolver: RESOLVER, now: () => CREATED });
    const ctx = verifierCtx(signedHeaders("t1-key"));
    // 验签通过 → identityVerified=true（驱动入站 Ledger counterparty 身份，§22）。
    expect(verifier.verify(ctx)).toEqual({
      authenticated: true,
      identity: "peer-t1",
      identityVerified: true,
    });
  });

  it("T2 密钥签名但缺卡片 JWS → authentication_required", () => {
    const verifier = new HttpMessageSignatureVerifier({
      resolver: RESOLVER,
      now: () => CREATED,
      verifyCardJws: () => ({ ok: true, organization: "Acme" }),
    });
    const ctx = verifierCtx(signedHeaders("t2-key"));
    expect(verifier.verify(ctx)).toMatchObject({
      authenticated: false,
      protocolCode: "authentication_required",
    });
  });

  it("T2 密钥 + 有效卡片 JWS → 认证通过", () => {
    const verifier = new HttpMessageSignatureVerifier({
      resolver: RESOLVER,
      now: () => CREATED,
      verifyCardJws: () => ({ ok: true, identity: "peer-t2", organization: "Acme" }),
    });
    const ctx = verifierCtx({ "x-agent-card-jws": "valid.jws.value", ...signedHeaders("t2-key") });
    expect(verifier.verify(ctx)).toEqual({
      authenticated: true,
      identity: "peer-t2",
      identityVerified: true,
    });
  });

  it("T2 密钥 + 无效卡片 JWS → authorization_failed", () => {
    const verifier = new HttpMessageSignatureVerifier({
      resolver: RESOLVER,
      now: () => CREATED,
      verifyCardJws: () => ({ ok: false, reason: "signature invalid" }),
    });
    const ctx = verifierCtx({ "x-agent-card-jws": "bad.jws", ...signedHeaders("t2-key") });
    expect(verifier.verify(ctx)).toMatchObject({
      authenticated: false,
      protocolCode: "authorization_failed",
    });
  });

  it("T3 密钥签名但缺 nonce → authorization_failed", () => {
    const verifier = new HttpMessageSignatureVerifier({
      resolver: RESOLVER,
      now: () => CREATED,
      verifyCardJws: () => ({ ok: true, organization: "Acme" }),
    });
    const ctx = verifierCtx({ "x-agent-card-jws": "jws", ...signedHeaders("t3-key") });
    expect(verifier.verify(ctx)).toMatchObject({
      authenticated: false,
      protocolCode: "authorization_failed",
    });
  });

  it("T3 密钥 + nonce + 卡片 JWS → 认证通过", () => {
    const verifier = new HttpMessageSignatureVerifier({
      resolver: RESOLVER,
      now: () => CREATED,
      verifyCardJws: () => ({ ok: true, identity: "peer-t3", organization: "Acme" }),
    });
    const ctx = verifierCtx({
      "x-agent-card-jws": "jws",
      ...signedHeaders("t3-key", { nonce: "n-1" }),
    });
    expect(verifier.verify(ctx)).toEqual({
      authenticated: true,
      identity: "peer-t3",
      identityVerified: true,
    });
  });

  it("宣称 org 与密钥档案冲突 → identity_rejected", () => {
    const verifier = new HttpMessageSignatureVerifier({ resolver: RESOLVER, now: () => CREATED });
    const ctx = verifierCtx({
      "x-kiwi-claimed-identity": JSON.stringify({ organization: "Evil Corp" }),
      ...signedHeaders("t1-key"),
    });
    expect(verifier.verify(ctx)).toMatchObject({
      authenticated: false,
      protocolCode: "identity_rejected",
    });
  });

  it("宣称与档案一致 → 认证通过", () => {
    const verifier = new HttpMessageSignatureVerifier({ resolver: RESOLVER, now: () => CREATED });
    const ctx = verifierCtx({
      "x-kiwi-claimed-identity": JSON.stringify({ identity: "peer-t1", organization: "Acme" }),
      ...signedHeaders("t1-key"),
    });
    expect(verifier.verify(ctx)).toEqual({
      authenticated: true,
      identity: "peer-t1",
      identityVerified: true,
    });
  });

  it("T3 nonce 复用 → replay_detected", () => {
    const verifier = new HttpMessageSignatureVerifier({
      resolver: RESOLVER,
      now: () => CREATED,
      verifyCardJws: () => ({ ok: true, organization: "Acme" }),
      nonceStore: new InMemoryNonceStore(),
    });
    const ctx = verifierCtx({
      "x-agent-card-jws": "jws",
      ...signedHeaders("t3-key", { nonce: "n-replay" }),
    });
    expect(verifier.verify(ctx).authenticated).toBe(true);
    expect(verifier.verify(ctx)).toMatchObject({
      authenticated: false,
      protocolCode: "replay_detected",
    });
  });

  it("未知 keyid 的签名 → authorization_failed", () => {
    const verifier = new HttpMessageSignatureVerifier({ resolver: RESOLVER, now: () => CREATED });
    const ctx = verifierCtx(signedHeaders("unknown-key"));
    expect(verifier.verify(ctx)).toMatchObject({
      authenticated: false,
      protocolCode: "authorization_failed",
    });
  });
});
