/**
 * Compact JWS（EdDSA / ES256）与 Agent Card JWS 绑定验证测试。
 *
 * 覆盖：
 *   - EdDSA / ES256 正例（验签通过）与反例（篡改 payload / 错密钥 → invalid_signature）；
 *   - 畸形 JWS（段数不对 / header 非 JSON / 未知 alg）拒绝；
 *   - verifyAgentCardJws：卡片 JWS 与 card 一致 → ok；篡改卡片 / 错密钥 → fail。
 *
 * 是否强制 JWS 由 TrustPolicy 决定（§31），本文件只测验签能力。
 */

import { describe, expect, it } from "vitest";
import {
  createPrivateKey,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from "node:crypto";
import {
  JwsError,
  verifyAgentCardJws,
  verifyCompactJws,
  resolveFromSigningKeys,
} from "../src/trust/identity/index.js";
import type { SigningKey } from "../src/trust/identity/index.js";
import { parseAgentCard } from "../src/discovery/agent-card/index.js";
import type { AgentCard } from "../src/discovery/agent-card/index.js";

const ED25519_SEED = Buffer.from(
  "e90b1a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
  "hex",
);
const ED25519_PUBLIC_X = "70unY03oy6rp20mv0AvfklFpbVJVy8s_jwN6egnPjQY";

function makeJws(
  payload: unknown,
  privateKey: KeyObject,
  alg: "EdDSA" | "ES256",
  kid?: string,
): string {
  const header: Record<string, string> = { alg };
  if (kid !== undefined) header.kid = kid;
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = Buffer.from(`${h}.${p}`, "utf8");
  const sig =
    alg === "EdDSA"
      ? nodeSign(null, signingInput, privateKey)
      : nodeSign("sha256", signingInput, { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${sig.toString("base64url")}`;
}

/** 确定性 Ed25519 私钥（PKCS8 DER，固定 seed）。 */
function deterministicEd25519Private(): KeyObject {
  const DER_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({
    key: Buffer.concat([DER_PREFIX, ED25519_SEED]),
    format: "der",
    type: "pkcs8",
  });
}

function ed25519Key(keyid: string): SigningKey {
  return { keyid, algorithm: "ed25519", jwk: { kty: "OKP", crv: "Ed25519", x: ED25519_PUBLIC_X } };
}

function validCard(): AgentCard {
  return parseAgentCard({
    name: "Test Merchant",
    description: "A2A test merchant agent",
    provider: { organization: "Kiwi Test Org", url: "https://merchant.example" },
    version: "1.0.0",
    url: "https://merchant.example/agent-card.json",
    supportedInterfaces: [
      { url: "https://merchant.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    capabilities: { extendedAgentCard: true },
  });
}

describe("verifyCompactJws", () => {
  it("verifies an EdDSA compact JWS", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jws = makeJws({ hello: "world" }, privateKey, "EdDSA");
    const verified = verifyCompactJws(jws, publicKey);
    expect(verified.alg).toBe("EdDSA");
    expect(JSON.parse(verified.payload.toString("utf8"))).toEqual({ hello: "world" });
  });

  it("verifies an ES256 compact JWS", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jws = makeJws({ n: 1 }, privateKey, "ES256");
    const verified = verifyCompactJws(jws, publicKey);
    expect(verified.alg).toBe("ES256");
    expect(JSON.parse(verified.payload.toString("utf8"))).toEqual({ n: 1 });
  });

  it("rejects a tampered payload (signature no longer valid)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jws = makeJws({ hello: "world" }, privateKey, "EdDSA");
    const [header, , signature] = jws.split(".");
    const tampered = `${header}.${Buffer.from(JSON.stringify({ hello: "EVIL" })).toString("base64url")}.${signature}`;
    try {
      verifyCompactJws(tampered, publicKey);
      expect.unreachable("tampered JWS should not verify");
    } catch (err) {
      expect((err as JwsError).code).toBe("invalid_signature");
    }
  });

  it("rejects a signature made by the wrong key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const { publicKey: otherPublic } = generateKeyPairSync("ed25519");
    const jws = makeJws({ hello: "world" }, privateKey, "EdDSA");
    expect(() => verifyCompactJws(jws, otherPublic)).toThrow(JwsError);
  });

  it("rejects malformed JWS (wrong segment count / non-JSON header / unknown alg)", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    expect(() => verifyCompactJws("only-two.segments", publicKey)).toThrow(JwsError);
    expect(() => verifyCompactJws(`${Buffer.from("not json").toString("base64url")}.e30.e30`, publicKey)).toThrow(
      JwsError,
    );
    const h = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const p = Buffer.from(JSON.stringify({})).toString("base64url");
    const sig = nodeSign(null, Buffer.from(`${h}.${p}`, "utf8"), privateKey);
    expect(() => verifyCompactJws(`${h}.${p}.${sig.toString("base64url")}`, publicKey)).toThrow(JwsError);
  });

  it("verifies a deterministic Ed25519 JWS with the fixed key", () => {
    const jws = makeJws({ org: "Kiwi Test Org" }, deterministicEd25519Private(), "EdDSA", "test-ed25519");
    const verified = verifyCompactJws(jws, ed25519Key("test-ed25519"));
    expect(verified.keyid).toBe("test-ed25519");
    expect(JSON.parse(verified.payload.toString("utf8"))).toEqual({ org: "Kiwi Test Org" });
  });
});

describe("verifyAgentCardJws（卡片 JWS 绑定）", () => {
  it("accepts a card whose JWS payload matches (EdDSA)", () => {
    const card = validCard();
    const jws = makeJws(card, deterministicEd25519Private(), "EdDSA", "test-ed25519");
    const result = verifyAgentCardJws(
      card,
      jws,
      resolveFromSigningKeys([ed25519Key("test-ed25519")]),
    );
    expect(result).toEqual({ ok: true, keyid: "test-ed25519" });
  });

  it("rejects when the presented card differs from the JWS payload", () => {
    const card = validCard();
    const jws = makeJws(card, deterministicEd25519Private(), "EdDSA", "test-ed25519");
    const tamperedCard = { ...card, description: "someone else's description" };
    const result = verifyAgentCardJws(
      tamperedCard,
      jws,
      resolveFromSigningKeys([ed25519Key("test-ed25519")]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects when the key is not bound (unknown kid)", () => {
    const card = validCard();
    const jws = makeJws(card, deterministicEd25519Private(), "EdDSA", "test-ed25519");
    const result = verifyAgentCardJws(card, jws, resolveFromSigningKeys([]));
    expect(result.ok).toBe(false);
  });

  it("rejects a JWS signed by the wrong key (kid mismatch)", () => {
    const card = validCard();
    const jws = makeJws(card, deterministicEd25519Private(), "EdDSA", "attacker");
    const result = verifyAgentCardJws(
      card,
      jws,
      resolveFromSigningKeys([ed25519Key("test-ed25519")]),
    );
    expect(result.ok).toBe(false);
  });
});
