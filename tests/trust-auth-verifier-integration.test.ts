/**
 * WP5 集成：HttpMessageSigner（出站）+ HttpMessageSignatureVerifier（入站）+
 * A2AServer / A2AClient 全链路。
 *
 * 验证身份绑定不变量：验签通过的身份 MUST 成为协议幂等主键的 sender 侧，且
 * Ledger identity snapshot 的 sender_identity 与之一致。另验证 fail-closed：
 * anonymousTrustLevel=T1 时未签名请求被拒（authentication_required）。
 */

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import { A2AServer, HttpMessageSignatureVerifier } from "../src/a2a/server/index.js";
import { A2AClient } from "../src/a2a/client/index.js";
import type { A2AMessage } from "../src/a2a/client/index.js";
import { HttpMessageSigner, resolveFromSigningKeys } from "../src/trust/identity/index.js";
import { NEGOTIATION_ID, validEnvelopeFields } from "./negotiation-helpers.js";

const ED25519_SEED = Buffer.from(
  "e90b1a2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
  "hex",
);
const PUBLIC_X = "70unY03oy6rp20mv0AvfklFpbVJVy8s_jwN6egnPjQY";

/** T1 信任锚：签名密钥绑定到 Acme 的 peer-t1 身份（T1 不强制 JWS）。 */
const RESOLVER = resolveFromSigningKeys([
  {
    keyid: "acme-2026",
    algorithm: "ed25519" as const,
    jwk: { kty: "OKP", crv: "Ed25519", x: PUBLIC_X },
    profile: { identity: "peer-t1", organization: "Acme", trustLevel: "T1" as const },
  },
]);

interface Started {
  url: string;
  a2aUrl: string;
  ledger: LedgerStore;
  idempotency: IdempotencyStore;
  httpServer: http.Server;
  dir: string;
}

const registry: Array<{ httpServer: http.Server; dir: string }> = [];

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function startSignedServer(): Promise<Started> {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-trust-integration-"));
  const ledger = new LedgerStore({ dir });
  const idempotency = new IdempotencyStore({ dir });
  const holder = { baseUrl: "http://127.0.0.1:0" };
  const server = new A2AServer({
    card: () => ({
      name: "Test Kiwi Merchant",
      description: "A2A test merchant agent",
      providerOrganization: "Kiwi Test Org",
      version: "0.5.0",
      baseUrl: holder.baseUrl,
      a2aPath: "/",
    }),
    ledger,
    idempotency,
    // fail-closed：T1 以下（含匿名）未签名请求拒绝；签名请求按密钥档案评级。
    authVerifier: new HttpMessageSignatureVerifier({ resolver: RESOLVER, anonymousTrustLevel: "T1" }),
  });
  const httpServer = server.createServer();
  const url = await listen(httpServer);
  holder.baseUrl = url;
  registry.push({ httpServer, dir });
  return { url, a2aUrl: `${url}/`, ledger, idempotency, httpServer, dir };
}

function knpMessage(envelope: ReturnType<typeof finalizeEnvelope>): A2AMessage {
  return {
    role: "agent",
    parts: [{ kind: "data", data: { knp_envelope: envelope } }],
    messageId: envelope.message_id,
  };
}

afterEach(async () => {
  for (const entry of registry) {
    entry.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => entry.httpServer.close(() => resolve()));
    rmSync(entry.dir, { recursive: true, force: true });
  }
  registry.length = 0;
});

describe("WP5 身份层集成（A2AServer + 签名 client）", () => {
  it("签名 message/send 通过，且身份绑定到幂等主键与 Ledger snapshot", async () => {
    const { a2aUrl, ledger, idempotency } = await startSignedServer();
    const client = new A2AClient({
      url: a2aUrl,
      signer: new HttpMessageSigner({ keyid: "acme-2026", algorithm: "ed25519", privateKey: ED25519_SEED }),
    });
    const envelope = finalizeEnvelope(validEnvelopeFields());

    const task = await client.sendMessage(knpMessage(envelope), "ctx_signed");

    expect(task.id).toMatch(/^task_/);
    expect(task.status.state).toBe("completed");

    // 身份绑定：幂等记录以验证过的身份（peer-t1）为 sender 主键。
    const rec = idempotency.get("peer-t1", envelope.message_id);
    expect(rec?.digest).toBe(envelope.digest);

    // 身份绑定：Ledger identity snapshot 的 sender_identity = 验证过的身份。
    const ledgerEvents = ledger.events(NEGOTIATION_ID);
    expect(ledgerEvents.length).toBe(1);
    expect(ledgerEvents[0]?.identity.sender_identity).toBe("peer-t1");
    expect(ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
  });

  it("未签名请求被拒（anonymousTrustLevel=T1，fail-closed）", async () => {
    const { a2aUrl } = await startSignedServer();
    const res = await fetch(a2aUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-unsigned",
        method: "tasks/get",
        params: { id: "task_x" },
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { data?: { protocol_code?: string } } };
    expect(body.error?.data?.protocol_code).toBe("authentication_required");
  });

  it("篡改请求体后验签失败 → 403（content-digest 覆盖 body）", async () => {
    const { a2aUrl } = await startSignedServer();
    const envelope = finalizeEnvelope(validEnvelopeFields());
    const message = knpMessage(envelope);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-signed",
      method: "message/send",
      params: { message, contextId: "ctx_signed" },
    });
    const signer = new HttpMessageSigner({
      keyid: "acme-2026",
      algorithm: "ed25519",
      privateKey: ED25519_SEED,
    });
    const headers = signer.sign({ method: "POST", url: a2aUrl, body: Buffer.from(body), headers: {} });

    // 发送前篡改 body → content-digest 与 body 不一致 → 验签失败。
    const tampered = body.replace('"counter_offer"', '"inquiry"');
    const res = await fetch(a2aUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: tampered,
    });
    expect(res.status).toBe(403);
    const resBody = (await res.json()) as { error?: { data?: { protocol_code?: string } } };
    expect(resBody.error?.data?.protocol_code).toBe("authorization_failed");
  });
});
