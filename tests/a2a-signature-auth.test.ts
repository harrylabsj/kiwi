/**
 * KIWI_A2A_AUTH=signature（Issue 16 B / RFC 9421 HTTP Message Signature）：
 * - 匿名请求按 T0 放行（设计意图：任何 kiwi buyer 可与任何 kiwi merchant 沟通）；
 * - 签名请求（key 在 resolver 中）通过且身份提升；
 * - 未知 keyid / 篡改签名 → 拒绝（fail-closed）；
 * - 节点签名密钥持久化确定性（重启不换钥）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpMessageSigner, HttpMessageSignatureVerifier } from "../src/trust/identity/index.js";
import {
  generateA2aSigningIdentity,
  loadOrCreateA2aSigningIdentity,
  resolveA2aSignatureResolver,
} from "../src/a2a/signing-key.js";

const AUTH = { scheme: "https" as const, expectedAuthority: "merchant.example" };

function makeRequest(body: string, extraHeaders: Record<string, string> = {}) {
  const headers = { host: "merchant.example", "content-type": "application/json", ...extraHeaders };
  return {
    context: {
      method: "POST",
      url: "/a2a",
      headers,
      body: Buffer.from(body, "utf8"),
      scheme: "https" as const,
      remoteAddress: "127.0.0.1",
      authorizationHeader: undefined,
    },
    headers,
  };
}

describe("A2A signing identity", () => {
  it("generates a deterministic, persistable identity", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-key-"));
    try {
      const a = loadOrCreateA2aSigningIdentity(dir, "https://merchant.example");
      const b = loadOrCreateA2aSigningIdentity(dir, "https://merchant.example");
      expect(a.privateKeyPem).toBe(b.privateKeyPem); // 重启不换钥
      expect(a.publicKeyPem).toBe(b.publicKeyPem);
      expect(a.keyid).toBe("https://merchant.example");
      expect(a.publicKeyRaw.length).toBe(32);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("KIWI_A2A_AUTH=signature verifier", () => {
  const merchant = generateA2aSigningIdentity("merchant.example");
  const buyer = generateA2aSigningIdentity("buyer.example");

  it("anonymous request passes at T0（设计意图：不阻塞任何 kiwi buyer）", async () => {
    const verifier = new HttpMessageSignatureVerifier({
      resolver: resolveA2aSignatureResolver(merchant),
      ...AUTH,
    });
    const { context } = makeRequest('{"hello":"world"}');
    const result = await verifier.verify(context);
    expect(result.authenticated).toBe(true);
    expect(result.identity).toBe("anonymous");
  });

  it("signed request from a known key passes", async () => {
    const verifier = new HttpMessageSignatureVerifier({
      resolver: resolveA2aSignatureResolver(merchant, [
        { keyid: buyer.keyid, algorithm: buyer.algorithm, publicKeyPem: buyer.publicKeyPem, publicKeyRaw: buyer.publicKeyRaw },
      ]),
      ...AUTH,
    });
    const signer = new HttpMessageSigner({
      keyid: buyer.keyid,
      algorithm: buyer.algorithm,
      privateKey: buyer.privateKeyPem,
    });
    const body = JSON.stringify({ rfq: true });
    const { context, headers } = makeRequest(body);
    const signed = signer.sign({ method: "POST", url: "https://merchant.example/a2a", body: Buffer.from(body, "utf8"), headers });
    const result = await verifier.verify({ ...context, headers: { ...headers, ...signed } });
    expect(result.authenticated).toBe(true);
    expect(result.identity).not.toBe("anonymous");
  });

  it("signed request from an unknown key is rejected", async () => {
    const verifier = new HttpMessageSignatureVerifier({
      resolver: resolveA2aSignatureResolver(merchant),
      ...AUTH,
    });
    const stranger = generateA2aSigningIdentity("stranger.example");
    const signer = new HttpMessageSigner({
      keyid: stranger.keyid,
      algorithm: stranger.algorithm,
      privateKey: stranger.privateKeyPem,
    });
    const body = JSON.stringify({ rfq: true });
    const { context, headers } = makeRequest(body);
    const signed = signer.sign({ method: "POST", url: "https://merchant.example/a2a", body: Buffer.from(body, "utf8"), headers });
    const result = await verifier.verify({ ...context, headers: { ...headers, ...signed } });
    expect(result.authenticated).toBe(false);
  });

  it("tampered signature is rejected", async () => {
    const verifier = new HttpMessageSignatureVerifier({
      resolver: resolveA2aSignatureResolver(merchant, [
        { keyid: buyer.keyid, algorithm: buyer.algorithm, publicKeyPem: buyer.publicKeyPem, publicKeyRaw: buyer.publicKeyRaw },
      ]),
      ...AUTH,
    });
    const signer = new HttpMessageSigner({
      keyid: buyer.keyid,
      algorithm: buyer.algorithm,
      privateKey: buyer.privateKeyPem,
    });
    const body = '{"rfq":true}';
    const { context, headers } = makeRequest(body);
    const signed = signer.sign({ method: "POST", url: "https://merchant.example/a2a", body: Buffer.from(body, "utf8"), headers });
    const result = await verifier.verify({
      ...context,
      headers: { ...headers, ...signed, "content-digest": "sha-256=:AAAA:" }, // 篡改 body digest
    });
    expect(result.authenticated).toBe(false);
  });
});
