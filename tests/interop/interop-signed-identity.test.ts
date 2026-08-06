/**
 * WP4 interop E2E — 场景 4：签名身份（基线 §41 #16 相关传输侧证据，§27 / §31）。
 *
 * T2 档位（AUTHENTICATED）下 Ed25519 HTTP Message Signature 请求往返：
 *   - buyer 侧 A2AClient + HttpMessageSigner（RFC 9421，覆盖 @method/@target-uri/
 *     @authority/content-digest）携带 Agent Card JWS（T2 强制，TrustPolicy
 *     requireCardJws(T2)=true）；
 *   - merchant 侧 HttpMessageSignatureVerifier 验签 + 卡片 JWS 绑定 → 验签身份
 *     进入协议幂等主键与 Ledger identity snapshot；
 *   - 篡改 body → content-digest 不匹配 → 403 authorization_failed（fail-closed）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEnvelope } from "../../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../../src/negotiation/idempotency/index.js";
import { A2AClient } from "../../src/a2a/client/index.js";
import type { A2AMessage } from "../../src/a2a/client/index.js";
import { A2AServer, HttpMessageSignatureVerifier } from "../../src/a2a/server/index.js";
import {
  HttpMessageSigner,
  resolveFromSigningKeys,
  verifyAgentCardJws,
} from "../../src/trust/identity/index.js";
import { parseAgentCard } from "../../src/discovery/agent-card/index.js";
import type { AgentCard } from "../../src/discovery/agent-card/index.js";
import { NEGOTIATION_ID, validEnvelopeFields } from "../negotiation-helpers.js";

const KEYID = "buyer-2026";
const PROFILE_IDENTITY = "peer-buyer";

const started: Array<{ httpServer: import("node:http").Server; dir: string }> = [];

async function listen(server: import("node:http").Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as import("node:net").AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

/** 用私钥签一个 compact JWS（EdDSA）。 */
function makeJws(payload: unknown, privateKey: KeyObject, kid: string): string {
  const header: Record<string, string> = { alg: "EdDSA" };
  if (kid !== undefined) header.kid = kid;
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = Buffer.from(`${h}.${p}`, "utf8");
  const sig = nodeSign(null, signingInput, privateKey);
  return `${h}.${p}.${sig.toString("base64url")}`;
}

function buyerCard(): AgentCard {
  return parseAgentCard({
    name: "Kiwi Interop Buyer",
    description: "interop E2E buyer agent",
    provider: { organization: "Acme" },
    version: "1.0",
    url: "https://buyer.example/agent-card.json",
    supportedInterfaces: [
      { url: "https://buyer.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
  });
}

function knpMessage(envelope: ReturnType<typeof finalizeEnvelope>): A2AMessage {
  return {
    role: "agent",
    parts: [{ kind: "data", data: { knp_envelope: envelope } }],
    messageId: envelope.message_id,
  };
}

afterEach(async () => {
  for (const entry of started.splice(0)) {
    entry.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => entry.httpServer.close(() => resolve()));
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

describe("场景 4：T2 签名身份往返 + 篡改拒绝", () => {
  it("Ed25519 签名请求通过，验签身份进入双侧 Ledger identity snapshot", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pubJwk = publicKey.export({ format: "jwk" });

    const card = buyerCard();
    const cardJws = makeJws(card, privateKey, KEYID);
    const resolver = resolveFromSigningKeys([
      {
        keyid: KEYID,
        algorithm: "ed25519" as const,
        jwk: pubJwk,
        profile: {
          identity: PROFILE_IDENTITY,
          organization: "Acme",
          role: "buyer" as const,
          trustLevel: "T2" as const,
        },
      },
    ]);

    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-interop-signed-"));
    const ledger = new LedgerStore({ dir });
    const idempotency = new IdempotencyStore({ dir });
    const holder = { baseUrl: "http://127.0.0.1:0" };
    const server = new A2AServer({
      card: () => ({
        name: "Signed Merchant",
        description: "interop signed merchant",
        providerOrganization: "Kiwi Test Org",
        version: "0.7.0",
        baseUrl: holder.baseUrl,
        a2aPath: "/",
      }),
      ledger,
      idempotency,
      authVerifier: new HttpMessageSignatureVerifier({
        resolver,
        // T2 强制卡片 JWS：验证 presented JWS 是对已知 buyer card 的签名。
        verifyCardJws: (jws) => {
          const result = verifyAgentCardJws(card, jws, resolver);
          if (!result.ok) return { ok: false, reason: result.reason };
          return { ok: true, identity: PROFILE_IDENTITY, organization: "Acme", role: "buyer" };
        },
        anonymousTrustLevel: "T1",
      }),
    });
    const httpServer = server.createServer();
    const url = await listen(httpServer);
    holder.baseUrl = url;
    started.push({ httpServer, dir });

    const client = new A2AClient({
      url: `${url}/`,
      signer: new HttpMessageSigner({ keyid: KEYID, algorithm: "ed25519", privateKey: privatePem }),
      headers: { "x-agent-card-jws": cardJws },
    });

    const envelope = finalizeEnvelope(validEnvelopeFields());
    const task = await client.sendMessage(knpMessage(envelope), "ctx_signed");

    expect(task.id).toMatch(/^task_/);
    expect(task.status.state).toBe("completed");

    // 验签身份进入协议幂等主键（sender 侧）。
    const rec = idempotency.get(PROFILE_IDENTITY, envelope.message_id);
    expect(rec?.digest).toBe(envelope.digest);

    // 验签身份进入 Ledger identity snapshot 的 sender 侧（§22：验签通过的身份
    // MUST 成为协议幂等主键的 sender 侧并进入 identity snapshot）。
    const events = ledger.events(NEGOTIATION_ID);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.identity.sender_identity).toBe(PROFILE_IDENTITY);
    // counterparty 侧同样优先用验签身份（而非 socket 地址）——与 buyer 侧记录
    // 对称（基线 §22；问题三回归）。
    expect(events[0]?.identity.counterparty_identity).toBe(PROFILE_IDENTITY);
    expect(events[0]?.identity.actor).toBe("buyer");
    expect(ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
  });

  it("篡改 body 后验签失败 → 403 authorization_failed（content-digest 绑定）", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pubJwk = publicKey.export({ format: "jwk" });
    const card = buyerCard();
    const cardJws = makeJws(card, privateKey, KEYID);
    const resolver = resolveFromSigningKeys([
      {
        keyid: KEYID,
        algorithm: "ed25519" as const,
        jwk: pubJwk,
        profile: { identity: PROFILE_IDENTITY, trustLevel: "T2" as const },
      },
    ]);

    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-interop-signed-"));
    const ledger = new LedgerStore({ dir });
    const idempotency = new IdempotencyStore({ dir });
    const holder = { baseUrl: "http://127.0.0.1:0" };
    const server = new A2AServer({
      card: () => ({
        name: "Signed Merchant",
        description: "interop signed merchant",
        providerOrganization: "Kiwi Test Org",
        version: "0.7.0",
        baseUrl: holder.baseUrl,
        a2aPath: "/",
      }),
      ledger,
      idempotency,
      authVerifier: new HttpMessageSignatureVerifier({
        resolver,
        verifyCardJws: (jws) => {
          const result = verifyAgentCardJws(card, jws, resolver);
          return result.ok
            ? { ok: true, identity: PROFILE_IDENTITY, role: "buyer" as const }
            : { ok: false, reason: result.reason };
        },
      }),
    });
    const httpServer = server.createServer();
    const url = await listen(httpServer);
    holder.baseUrl = url;
    started.push({ httpServer, dir });

    const envelope = finalizeEnvelope(validEnvelopeFields());
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-signed-tampered",
      method: "message/send",
      params: { message: knpMessage(envelope), contextId: "ctx_signed" },
    });
    const signer = new HttpMessageSigner({ keyid: KEYID, algorithm: "ed25519", privateKey: privatePem });
    const headers = signer.sign({ method: "POST", url: `${url}/`, body: Buffer.from(body), headers: {} });

    // 签名后篡改 body：content-digest 与 body 不一致 → 验签失败。
    const tampered = body.replace('"counter_offer"', '"inquiry"');
    const res = await fetch(`${url}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-card-jws": cardJws, ...headers },
      body: tampered,
    });
    expect(res.status).toBe(403);
    const resBody = (await res.json()) as { error?: { data?: { protocol_code?: string } } };
    expect(resBody.error?.data?.protocol_code).toBe("authorization_failed");
  });
});
