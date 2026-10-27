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
 * M-05/M-06：受保护操作的业务身份策略（G0 §1.3）。
 *
 * | 操作 | 策略 |
 * |---|---|
 * | 公开 Agent Card GET | 匿名允许 |
 * | `message/send` | 保留匿名 T0 |
 * | `tasks/get` / `ListTasks` / `CancelTask` | 需要已验证身份 |
 * | `GetExtendedAgentCard` | 需要已验证身份；匿名 authentication_required |
 *
 * 安全边界（M-06）：签名模式下**绝不**把平台注入或伪造的 `Authorization`
 * 当业务身份——它既不能让匿名调用者通过受保护操作，也不能覆盖签名身份。
 */

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { A2AServer } from "../src/a2a/server/index.js";
import type { AuthVerifier } from "../src/a2a/server/index.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import { HttpMessageSigner, HttpMessageSignatureVerifier } from "../src/trust/identity/index.js";
import {
  generateA2aSigningIdentity,
  resolveA2aSignatureResolver,
} from "../src/a2a/signing-key.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { validEnvelopeFields } from "./negotiation-helpers.js";

const AUTHORITY = "merchant.example";
const registry: Array<{ server: http.Server; dir: string }> = [];
afterEach(() => {
  while (registry.length > 0) {
    const entry = registry.pop()!;
    entry.server.closeAllConnections();
    entry.server.close();
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

async function start(authVerifier: AuthVerifier): Promise<{ base: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-protected-ops-"));
  const holder = { baseUrl: "http://127.0.0.1:0" };
  const server = new A2AServer({
    card: () => ({
      name: "Protected Ops Merchant",
      description: "M-05 policy test",
      providerOrganization: "Kiwi Test Org",
      version: "0.5.0",
      baseUrl: holder.baseUrl,
    }),
    ledger: new LedgerStore({ dir }),
    idempotency: new IdempotencyStore({ dir }),
    authVerifier,
  });
  const httpServer = server.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  holder.baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  registry.push({ server: httpServer, dir });
  return { base: holder.baseUrl };
}

async function rpc(
  base: string,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/`, {
    method: "POST",
    headers: { "content-type": "application/json", "a2a-version": "1.0", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: "req-1", method, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * A2A 1.0 错误体把 `data` 换成 ErrorInfo 数组（不再带 `protocol_code`），
 * 所以两种形态都要认：0.3 的 `data.protocol_code` 或 1.0 的 message 语义。
 */
function authRejected(body: Record<string, unknown>): boolean {
  const error = body["error"] as Record<string, unknown> | undefined;
  if (error === undefined) return false;
  const data = error["data"];
  const protocol =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? String((data as Record<string, unknown>)["protocol_code"] ?? "")
      : "";
  return (
    protocol === "authentication_required" ||
    /requires an authenticated identity|requires a verified identity/.test(String(error["message"] ?? ""))
  );
}

function protocolCode(body: Record<string, unknown>): string {
  const error = body["error"] as Record<string, unknown> | undefined;
  const data = error?.["data"];
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const code = (data as Record<string, unknown>)["protocol_code"];
    if (code !== undefined) return String(code);
  }
  return String(error?.["message"] ?? "");
}

function knpSendParams(): unknown {
  const envelope = finalizeEnvelope({ ...validEnvelopeFields(), message_id: "msg_protected_ops" });
  return {
    message: {
      role: "agent",
      parts: [{ kind: "data", data: { knp_envelope: envelope } }],
      messageId: envelope.message_id,
    },
  };
}

describe("受保护操作策略（匿名 T0）", () => {
  it("keeps anonymous RFQ open, requires identity for task reads and the extended card", async () => {
    const { base } = await start(new (await import("../src/a2a/server/index.js")).NoneAuthVerifier());

    // 公开名片：匿名可读。
    const card = await fetch(`${base}/.well-known/agent-card.json`);
    expect(card.status).toBe(200);

    // message/send：保留匿名 T0 询价。
    const send = await rpc(base, "message/send", knpSendParams());
    expect(protocolCode(send.body)).not.toBe("authentication_required");

    for (const [method, params] of [
      ["GetTask", { id: "task_does_not_exist" }],
      ["ListTasks", {}],
      ["CancelTask", { id: "task_does_not_exist" }],
      ["GetExtendedAgentCard", {}],
    ] as const) {
      const result = await rpc(base, method, params);
      expect(authRejected(result.body), `${method}: ${JSON.stringify(result.body)}`).toBe(true);
    }
  });
});

describe("签名模式：身份来自 HTTP Message Signature，不来自 Authorization", () => {
  const merchant = generateA2aSigningIdentity(AUTHORITY);
  const buyer = generateA2aSigningIdentity("buyer.example");

  function verifier(): HttpMessageSignatureVerifier {
    return new HttpMessageSignatureVerifier({
      resolver: resolveA2aSignatureResolver(merchant, [
        {
          keyid: buyer.keyid,
          algorithm: buyer.algorithm,
          publicKeyPem: buyer.publicKeyPem,
          publicKeyRaw: buyer.publicKeyRaw,
        },
      ]),
      scheme: "https",
      expectedAuthority: AUTHORITY,
      authoritySource: "declared",
    });
  }

  function sign(body: string, headers: Record<string, string>): Record<string, string> {
    const signer = new HttpMessageSigner({
      keyid: buyer.keyid,
      algorithm: buyer.algorithm,
      privateKey: buyer.privateKeyPem,
    });
    return signer.sign({
      method: "POST",
      url: `https://${AUTHORITY}/`,
      body: Buffer.from(body, "utf8"),
      headers,
    });
  }

  it("does not treat an injected Authorization header as a business identity", async () => {
    const { base } = await start(verifier());
    const result = await rpc(base, "GetTask", { id: "task_1" }, {
      authorization: "Bearer platform-injected-token",
    });
    expect(authRejected(result.body)).toBe(true);
  });

  it("accepts a request signed with a trusted key for protected operations", async () => {
    const { base } = await start(verifier());
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-signed",
      method: "GetTask",
      params: { id: "task_unknown" },
    });
    const headers = { host: AUTHORITY, "content-type": "application/json", "a2a-version": "1.0" };
    const signed = sign(body, headers);
    const res = await fetch(`${base}/`, {
      method: "POST",
      headers: { ...headers, ...signed },
      body,
    });
    const payload = (await res.json()) as Record<string, unknown>;
    // 通过身份门后是"任务不存在"，而不是认证失败。
    expect(authRejected(payload)).toBe(false);
    expect(payload["error"]).toBeDefined();
  });

  it("returns the extended card only to a verified identity", async () => {
    const { base } = await start(verifier());

    const anonymous = await rpc(base, "GetExtendedAgentCard", {});
    expect(authRejected(anonymous.body)).toBe(true);

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-card",
      method: "GetExtendedAgentCard",
      params: {},
    });
    const headers = { host: AUTHORITY, "content-type": "application/json", "a2a-version": "1.0" };
    const signed = sign(body, headers);
    const res = await fetch(`${base}/`, {
      method: "POST",
      headers: { ...headers, ...signed },
      body,
    });
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload["error"]).toBeUndefined();
    expect((payload["result"] as Record<string, unknown>)["name"]).toBe("Protected Ops Merchant");
  });

  it("rejects a request whose signature was made for a different body", async () => {
    const { base } = await start(verifier());
    const signedBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-a",
      method: "GetTask",
      params: { id: "task_a" },
    });
    const headers = { host: AUTHORITY, "content-type": "application/json", "a2a-version": "1.0" };
    const signed = sign(signedBody, headers);
    const tamperedBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-b",
      method: "GetTask",
      params: { id: "task_b" },
    });
    const res = await fetch(`${base}/`, {
      method: "POST",
      headers: { ...headers, ...signed },
      body: tamperedBody,
    });
    const payload = (await res.json()) as Record<string, unknown>;
    expect([401, 403]).toContain(res.status);
    expect(protocolCode(payload)).toMatch(/authentication_required|authorization_failed/);
  });
});
