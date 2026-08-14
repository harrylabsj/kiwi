/**
 * KIWI_A2A_AUTH=signature（Issue 16 B / RFC 9421 HTTP Message Signature）：
 * - 匿名请求按 T0 放行（设计意图：任何 kiwi buyer 可与任何 kiwi merchant 沟通）；
 * - 签名请求（key 在 resolver 中）通过且身份提升；
 * - 未知 keyid / 篡改签名 → 拒绝（fail-closed）；
 * - 节点签名密钥持久化确定性（重启不换钥）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpMessageSigner, HttpMessageSignatureVerifier } from "../src/trust/identity/index.js";
import { A2ADirectChannel } from "../src/counterparty/index.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import {
  generateA2aSigningIdentity,
  loadA2aTrustedKeys,
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

  it("signed request passes even when ctx.scheme is http (reverse-proxy TLS termination)", async () => {
    // 公网 https 节点经 Caddy 终结 TLS：本地 socket 是 http，但节点声明
    // expectedAuthority=merchant.example + scheme=https。@target-uri 必须用节点
    // 声明的 https 重建（否则 https 签名的请求被按 http 重建 → 验签失败）。
    const verifier = new HttpMessageSignatureVerifier({
      resolver: resolveA2aSignatureResolver(merchant, [
        { keyid: buyer.keyid, algorithm: buyer.algorithm, publicKeyPem: buyer.publicKeyPem, publicKeyRaw: buyer.publicKeyRaw },
      ]),
      scheme: "https",
      expectedAuthority: "merchant.example",
    });
    const signer = new HttpMessageSigner({
      keyid: buyer.keyid,
      algorithm: buyer.algorithm,
      privateKey: buyer.privateKeyPem,
    });
    const body = JSON.stringify({ rfq: true });
    const headers = { host: "merchant.example", "content-type": "application/json" };
    const signed = signer.sign({ method: "POST", url: "https://merchant.example/a2a", body: Buffer.from(body, "utf8"), headers });
    // ctx.scheme = "http"（本地反代 socket），但节点声明 https 身份 → 仍须通过。
    const result = await verifier.verify({
      ...makeRequest(body).context,
      scheme: "http",
      headers: { ...headers, ...signed },
    });
    expect(result.authenticated).toBe(true);
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

  it("trusted-keys file is parsed and invalid file fails closed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-trust-"));
    try {
      const buyer = generateA2aSigningIdentity("buyer.example");
      const file = path.join(dir, "a2a-trusted-keys.json");
      writeFileSync(
        file,
        JSON.stringify([{ keyid: buyer.keyid, algorithm: buyer.algorithm, publicKeyPem: buyer.publicKeyPem }]),
      );
      const keys = loadA2aTrustedKeys(file);
      expect(keys[0]?.keyid).toBe("buyer.example");
      writeFileSync(file, JSON.stringify([{ keyid: "x" }])); // 缺 publicKeyPem
      expect(() => loadA2aTrustedKeys(file)).toThrow(/fail-closed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A2ADirectChannel signs outbound when KIWI_A2A_SIGNING_KEY_FILE is set", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-out-"));
    const prev = process.env.KIWI_A2A_SIGNING_KEY_FILE;
    try {
      const buyer = generateA2aSigningIdentity("buyer.example");
      writeFileSync(
        path.join(dir, "buyer-key.json"),
        JSON.stringify({
          keyid: buyer.keyid,
          algorithm: buyer.algorithm,
          privateKeyPem: buyer.privateKeyPem,
          publicKeyPem: buyer.publicKeyPem,
          publicKeyRaw: buyer.publicKeyRaw.toString("base64"),
        }),
      );
      process.env.KIWI_A2A_SIGNING_KEY_FILE = path.join(dir, "buyer-key.json");
      let captured: Record<string, string> | undefined;
      const channel = new A2ADirectChannel({
        url: "https://merchant.example/",
        allowPrivateRanges: true,
        skipDnsCheck: true,
        fetchImpl: async (_url, init) => {
          captured = init?.headers as Record<string, string>;
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { task: { id: "t", status: { state: "completed" } } } }), { status: 200 });
        },
      });
      const handle = await channel.open({
        negotiation_id: "neg_1",
        sender_identity: "buyer.example",
        identity: "merchant.example",
        remote: {},
      });
      await handle
        .send({
          ref: { negotiation_id: "neg_1" },
          envelope: finalizeEnvelope({
            capability: "com.harrylabsj.kiwi.shopping.negotiation",
            protocol_version: "1.0",
            negotiation_id: "neg_1",
            exchange_id: "ex_1",
            message_id: "msg_1",
            actor: "buyer",
            action: "rfq",
            created_at: "2026-08-14T00:00:00Z",
            payload: { type: "rfq", items: [{ sku: "VQ-003", quantity: { value: 1, unit: "piece" } }] },
          }),
        })
        .catch(() => {});
      expect(captured).toBeDefined();
      expect(captured?.signature).toBeDefined();
      expect(captured?.signatureInput ?? captured?.["signature-input"]).toBeDefined();
      expect(captured?.contentDigest ?? captured?.["content-digest"]).toBeDefined();
    } finally {
      process.env.KIWI_A2A_SIGNING_KEY_FILE = prev ?? "";
      rmSync(dir, { recursive: true, force: true });
    }
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
