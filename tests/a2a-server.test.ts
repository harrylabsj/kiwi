/**
 * A2A Server（入站侧，WP2）端到端测试 —— node:http 起真实 server。
 *
 * 覆盖：
 *   - well-known Agent Card（含 KNP negotiation extension 声明，无 secret）；
 *   - message/send 正例（KNP envelope 入 Data Part）+ Ledger 落账 + 幂等落盘；
 *   - schema 拒绝（缺 Data Part / payload 非法）→ schema_invalid；
 *   - 版本拒绝 → protocol_version_unsupported；
 *   - 幂等重放（同 key 同 digest 返回原结果）与冲突（异 digest → idempotency_conflict）；
 *   - body 大小上限 → 413 payload_too_large；
 *   - 认证接缝：缺 token 401 / 错 token 403 / 对 token 200；AuthVerifier 单测；
 *   - handler 异常不泄漏内部细节（通用 internal error）；
 *   - tasks/get（内存 + Ledger 视图 fallback，模拟重启）；
 *   - JSON-RPC 帧错误（未知 method / 畸形 body / 未知 task）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeEnvelopeDigest, finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import {
  A2AServer,
  echoHandler,
  HttpMessageSignatureVerifier,
  InboundPipeline,
  LoopbackOnlyAuthVerifier,
  NoneAuthVerifier,
  StaticBearerAuthVerifier,
  TaskRegistry,
} from "../src/a2a/server/index.js";
import type { AgentCardConfig, AuthVerifier, NegotiationHandler } from "../src/a2a/server/index.js";
import { HttpMessageSigner, resolveFromSigningKeys } from "../src/trust/identity/index.js";
import { A2AClient } from "../src/a2a/client/index.js";
import type { A2AMessage } from "../src/a2a/client/index.js";
import { NEGOTIATION_ID, validEnvelopeFields } from "./negotiation-helpers.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface StartOptions {
  handler?: NegotiationHandler;
  authVerifier?: AuthVerifier;
  maxPayloadBytes?: number;
  a2aPath?: string;
  cardOverrides?: Partial<AgentCardConfig>;
}

interface Started {
  url: string;
  a2aUrl: string;
  ledger: LedgerStore;
  idempotency: IdempotencyStore;
  server: A2AServer;
  httpServer: http.Server;
  dir: string;
}

const registry: Array<{ httpServer: http.Server; dir: string }> = [];

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function startServer(options: StartOptions = {}, sharedDir?: string): Promise<Started> {
  const dir = sharedDir ?? mkdtempSync(path.join(tmpdir(), "kiwi-a2a-server-"));
  const ledger = new LedgerStore({ dir });
  const idempotency = new IdempotencyStore({ dir });
  const holder = { baseUrl: "http://127.0.0.1:0" };
  const a2aPath = options.a2aPath ?? "/";
  const server = new A2AServer({
    card: () => ({
      name: "Test Kiwi Merchant",
      description: "A2A test merchant agent",
      providerOrganization: "Kiwi Test Org",
      version: "0.5.0",
      baseUrl: holder.baseUrl,
      a2aPath,
      ...options.cardOverrides,
    }),
    ledger,
    idempotency,
    ...(options.handler !== undefined ? { handler: options.handler } : {}),
    ...(options.authVerifier !== undefined ? { authVerifier: options.authVerifier } : {}),
    ...(options.maxPayloadBytes !== undefined ? { maxPayloadBytes: options.maxPayloadBytes } : {}),
  });
  const httpServer = server.createServer();
  const url = await listen(httpServer);
  holder.baseUrl = url;
  registry.push({ httpServer, dir });
  return {
    url,
    a2aUrl: `${url}${a2aPath}`,
    ledger,
    idempotency,
    server,
    httpServer,
    dir,
  };
}

function knpMessage(envelope: NegotiationEnvelope): A2AMessage {
  return {
    role: "agent",
    parts: [
      { kind: "text", text: "We propose 200 units at CNY 835.00 per unit." },
      { kind: "data", data: { knp_envelope: envelope } },
    ],
    messageId: envelope.message_id,
  };
}

/** 原样 JSON-RPC 请求（错误路径检查用）。 */
async function rpc(
  a2aUrl: string,
  method: string,
  params: unknown,
  id = "req-1",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(a2aUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

function rpcError(body: Record<string, unknown>): Record<string, unknown> {
  const error = body["error"];
  return (error === null || typeof error !== "object" ? {} : error) as Record<string, unknown>;
}

function authCtx(
  partial: Partial<{
    remoteAddress: string | undefined;
    authorizationHeader: string | undefined;
  }> = {},
) {
  return {
    remoteAddress: partial.remoteAddress,
    authorizationHeader: partial.authorizationHeader,
    method: "POST",
    url: "/",
  };
}

afterEach(async () => {
  for (const entry of registry) {
    entry.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => entry.httpServer.close(() => resolve()));
    rmSync(entry.dir, { recursive: true, force: true });
  }
  registry.length = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Agent Card / well-known
// ---------------------------------------------------------------------------

describe("A2A Server: Agent Card（well-known）", () => {
  it("serves the Agent Card with a KNP negotiation extension declaration", async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const card = (await res.json()) as Record<string, unknown>;
    expect(card.name).toBe("Test Kiwi Merchant");
    expect(card.description).toBe("A2A test merchant agent");
    expect(card.provider).toEqual({ organization: "Kiwi Test Org" });
    expect(card.supportedInterfaces).toEqual([
      expect.objectContaining({ protocolBinding: "JSONRPC", protocolVersion: "1.0" }),
    ]);
    const capabilities = card.capabilities as Record<string, unknown>;
    const extensions = (capabilities.extensions as { uri: string; required: boolean }[]) ?? [];
    expect(
      extensions.some(
        (e) => e.uri.endsWith("/a2a/extensions/negotiation/1.0") && e.required === false,
      ),
    ).toBe(true);
    // 不变量 24：card 不含静态 secret。
    expect(JSON.stringify(card)).not.toMatch(/(secret|bearer|api[_-]?key|password)/i);
  });

  it("passes through skills and honors a configured negotiation extension URI", async () => {
    const { url } = await startServer({
      cardOverrides: {
        skills: [{ id: "commerce-negotiation", name: "Commerce Negotiation" }],
        negotiationExtensionUri: "https://kiwi.test/a2a/extensions/negotiation/1.0",
      },
    });
    const res = await fetch(`${url}/.well-known/agent-card.json`);
    const card = (await res.json()) as Record<string, unknown>;
    expect((card.skills as { id: string }[])[0]?.id).toBe("commerce-negotiation");
    const capabilities = card.capabilities as Record<string, unknown>;
    const extensions = capabilities.extensions as { uri: string }[];
    expect(extensions[0]?.uri).toBe("https://kiwi.test/a2a/extensions/negotiation/1.0");
  });

  it("rejects non-GET and unknown paths", async () => {
    const { url } = await startServer();
    const post = await fetch(`${url}/.well-known/agent-card.json`, { method: "POST" });
    expect(post.status).toBe(405);
    const missing = await fetch(`${url}/definitely-not-a-path`);
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// message/send 正例
// ---------------------------------------------------------------------------

describe("A2A Server: message/send 正例", () => {
  it("round-trips a KNP envelope in a data part and records ledger + idempotency", async () => {
    const { url, ledger, idempotency } = await startServer();
    const client = new A2AClient({ url: `${url}/` });
    const envelope = finalizeEnvelope(validEnvelopeFields());

    const task = await client.sendMessage(knpMessage(envelope), "ctx_1");

    expect(task.id).toMatch(/^task_/);
    expect(task.status.state).toBe("completed");
    expect(task.contextId).toBe("ctx_1");
    expect(task.status.message?.role).toBe("agent");

    // Ledger：message_received 事件已落账且链完整。
    expect(ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
    expect(ledger.findByMessageId(envelope.message_id)).not.toBeNull();

    // 幂等：以 (loopback 身份, message_id) 记录，digest 一致且携带 ledger 证据。
    const rec = idempotency.get("loopback:127.0.0.1", envelope.message_id);
    expect(rec?.digest).toBe(envelope.digest);
    expect(rec?.ledger_event_id).toBeTruthy();
    expect(rec?.ledger_event_digest).toBeTruthy();
  });

  it("routes through an injected handler that can accept with artifacts", async () => {
    const handler: NegotiationHandler = {
      name: "artifact-handler",
      async handle(ctx) {
        return {
          kind: "accepted",
          taskState: "completed",
          artifactParts: [{ kind: "data", data: { negotiation_id: ctx.envelope.negotiation_id } }],
        };
      },
    };
    const { url } = await startServer({ handler });
    const client = new A2AClient({ url: `${url}/` });
    const task = await client.sendMessage(
      knpMessage(finalizeEnvelope(validEnvelopeFields())),
      "ctx",
    );
    expect(task.status.state).toBe("completed");
    expect(task.artifacts?.[0]?.artifactId).toMatch(/^art_/);
  });

  it("defaults to a fail-closed decline handler when none is injected", async () => {
    const { url } = await startServer();
    const client = new A2AClient({ url: `${url}/` });
    const task = await client.sendMessage(
      knpMessage(finalizeEnvelope(validEnvelopeFields())),
      "ctx",
    );
    // decline 是合法商业结果：任务 completed，消息携带 decline 原因。
    expect(task.status.state).toBe("completed");
    const data = task.status.message?.parts.find((p) => p.kind === "data");
    expect(data && data.kind === "data" ? data.data : null).toMatchObject({ decline: true });
  });
});

// ---------------------------------------------------------------------------
// schema / version 拒绝
// ---------------------------------------------------------------------------

describe("A2A Server: schema / version 拒绝（fail-closed）", () => {
  it("rejects an A2A message without a KNP data part → schema_invalid", async () => {
    const { a2aUrl } = await startServer();
    const client = new A2AClient({ url: a2aUrl });
    await expect(
      client.sendMessage({
        role: "agent",
        parts: [{ kind: "text", text: "hi" }],
        messageId: "msg_x",
      }),
    ).rejects.toMatchObject({
      kind: "jsonrpc_error",
      jsonrpcCode: -32050,
      jsonrpcData: { protocol_code: "schema_invalid" },
    });
  });

  it("rejects a KNP envelope with an invalid payload → schema_invalid", async () => {
    const { a2aUrl } = await startServer();
    const envelope = finalizeEnvelope(validEnvelopeFields());
    // 篡改 payload 使 schema 校验失败（digest 即使有效也会先过 schema）。
    const badEnvelope = { ...envelope, payload: { type: "bogus" } };
    const res = await rpc(a2aUrl, "message/send", {
      message: {
        role: "agent",
        parts: [{ kind: "data", data: { knp_envelope: badEnvelope } }],
        messageId: envelope.message_id,
      },
    });
    expect(res.status).toBe(200);
    expect(rpcError(res.body).code).toBe(-32050);
    expect((rpcError(res.body).data as Record<string, unknown>).protocol_code).toBe(
      "schema_invalid",
    );
  });

  it("rejects a tampered envelope digest → schema_invalid", async () => {
    const { a2aUrl } = await startServer();
    const envelope = finalizeEnvelope(validEnvelopeFields());
    const tampered = { ...envelope, public_message: "changed after signing" }; // digest 不再匹配
    const res = await rpc(a2aUrl, "message/send", {
      message: {
        role: "agent",
        parts: [{ kind: "data", data: { knp_envelope: tampered } }],
        messageId: envelope.message_id,
      },
    });
    expect(rpcError(res.body).code).toBe(-32050);
    expect((rpcError(res.body).data as Record<string, unknown>).protocol_code).toBe(
      "schema_invalid",
    );
  });

  it("rejects an unknown KNP protocol version → protocol_version_unsupported", async () => {
    const { a2aUrl } = await startServer();
    const fields = validEnvelopeFields();
    const envelope = { ...fields, protocol_version: "2.0" };
    const digest = computeEnvelopeDigest(envelope);
    const wire = { ...envelope, digest };
    const res = await rpc(a2aUrl, "message/send", {
      message: {
        role: "agent",
        parts: [{ kind: "data", data: { knp_envelope: wire } }],
        messageId: fields.message_id,
      },
    });
    expect(res.status).toBe(200);
    expect(rpcError(res.body).code).toBe(-32050);
    expect((rpcError(res.body).data as Record<string, unknown>).protocol_code).toBe(
      "protocol_version_unsupported",
    );
  });
});

// ---------------------------------------------------------------------------
// 幂等
// ---------------------------------------------------------------------------

describe("A2A Server: 幂等（§20）", () => {
  it("replays the original result for same key + same digest", async () => {
    const { url, ledger } = await startServer();
    const client = new A2AClient({ url: `${url}/` });
    const envelope = finalizeEnvelope(validEnvelopeFields());
    const message = knpMessage(envelope);

    const first = await client.sendMessage(message, "ctx_1");
    const second = await client.sendMessage(message, "ctx_1");

    expect(second.id).toBe(first.id);
    expect(second.status.state).toBe(first.status.state);
    // 不重复执行业务效果：Ledger 只落一条。
    expect(ledger.events(NEGOTIATION_ID).length).toBe(1);
  });

  it("returns idempotency_conflict for same key + different digest", async () => {
    const { url } = await startServer();
    const client = new A2AClient({ url: `${url}/` });
    const first = finalizeEnvelope(validEnvelopeFields());
    await client.sendMessage(knpMessage(first), "ctx_1");

    const second = finalizeEnvelope({
      ...validEnvelopeFields(),
      public_message: "different content",
    });
    expect(second.message_id).toBe(first.message_id);
    expect(second.digest).not.toBe(first.digest);

    await expect(client.sendMessage(knpMessage(second), "ctx_1")).rejects.toMatchObject({
      kind: "jsonrpc_error",
      jsonrpcCode: -32050,
      jsonrpcData: { protocol_code: "idempotency_conflict" },
    });
  });

  it("scopes the idempotency key by the auth identity (sender isolation)", async () => {
    // 同一数据目录、两个 server，分别以 peer-1 / peer-2 身份处理同 message_id。
    const first = await startServer({
      authVerifier: new StaticBearerAuthVerifier("tok", { identity: "peer-1" }),
    });
    const second = await startServer(
      {
        authVerifier: new StaticBearerAuthVerifier("tok", { identity: "peer-2" }),
      },
      first.dir,
    );
    const envelope = finalizeEnvelope(validEnvelopeFields());
    const message = knpMessage(envelope);
    const headers = { "content-type": "application/json", authorization: "Bearer tok" };

    const r1 = await fetch(first.a2aUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "message/send",
        params: { message },
      }),
    });
    expect(r1.status).toBe(200);

    // 不同 sender → 不冲突，作为新消息处理（幂等主键 (sender_identity, message_id)）。
    const r2 = await fetch(second.a2aUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "message/send",
        params: { message },
      }),
    });
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as Record<string, unknown>;
    const task2 = (body2["result"] as Record<string, unknown>)["task"] as Record<string, unknown>;
    // 新任务 id ≠ peer-1 的任务 id。
    const body1 = (await r1.json()) as Record<string, unknown>;
    const task1 = (body1["result"] as Record<string, unknown>)["task"] as Record<string, unknown>;
    expect(task2["id"]).not.toBe(task1["id"]);
    // Ledger 记录了两条（同一 negotiation 链，peer 不同则证据不同）。
    expect(first.ledger.events(NEGOTIATION_ID).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 大小上限 / 认证
// ---------------------------------------------------------------------------

describe("A2A Server: body 大小上限（fail-closed）", () => {
  it("rejects a request body larger than maxPayloadBytes with 413", async () => {
    const { a2aUrl } = await startServer({ maxPayloadBytes: 1024 });
    const huge = "x".repeat(8192);
    const res = await fetch(a2aUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "r",
        method: "message/send",
        params: { message: huge },
      }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    const error = rpcError(body);
    expect(error.code).toBe(-32052);
    expect((error.data as Record<string, unknown>).protocol_code).toBe("payload_too_large");
  });
});

describe("A2A Server: 认证接缝", () => {
  it("rejects missing token with 401, wrong token with 403, accepts the right token", async () => {
    const { a2aUrl } = await startServer({
      authVerifier: new StaticBearerAuthVerifier("s3cret", { identity: "peer-1" }),
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "tasks/get",
      params: { id: "task_x" },
    });

    const noToken = await fetch(a2aUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(noToken.status).toBe(401);
    expect(
      (rpcError((await noToken.json()) as Record<string, unknown>).data as Record<string, unknown>)
        .protocol_code,
    ).toBe("authentication_required");

    const wrongToken = await fetch(a2aUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body,
    });
    expect(wrongToken.status).toBe(403);
    expect(
      (
        rpcError((await wrongToken.json()) as Record<string, unknown>).data as Record<
          string,
          unknown
        >
      ).protocol_code,
    ).toBe("authorization_failed");

    const rightToken = await fetch(a2aUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3cret" },
      body,
    });
    expect(rightToken.status).toBe(200);
  });

  it("applies the default loopback-only verifier when none is configured", () => {
    const v = new LoopbackOnlyAuthVerifier();
    expect(v.verify(authCtx({ remoteAddress: "127.0.0.1" })).authenticated).toBe(true);
    expect(v.verify(authCtx({ remoteAddress: "::1" })).authenticated).toBe(true);
    expect(v.verify(authCtx({ remoteAddress: "::ffff:127.0.0.1" })).authenticated).toBe(true);
    expect(v.verify(authCtx({ remoteAddress: "10.0.0.1" })).authenticated).toBe(false);
    expect(v.verify(authCtx({})).authenticated).toBe(false); // 无对端地址 → 拒绝
  });

  it("provides none and static-bearer reference verifiers", () => {
    const none = new NoneAuthVerifier();
    expect(none.verify(authCtx()).authenticated).toBe(true);
    expect(none.verify(authCtx({ remoteAddress: "10.0.0.1" })).authenticated).toBe(true);

    const bearer = new StaticBearerAuthVerifier("tok", { identity: "peer" });
    expect(bearer.verify(authCtx({ authorizationHeader: "Bearer tok" }))).toEqual({
      authenticated: true,
      identity: "peer",
    });
    expect(bearer.verify(authCtx({ authorizationHeader: "Bearer nope" })).protocolCode).toBe(
      "authorization_failed",
    );
    expect(bearer.verify(authCtx({ authorizationHeader: undefined })).protocolCode).toBe(
      "authentication_required",
    );
  });

  // 审查 P2-D：token 比较走常量时间路径（长度恒等预检 + timingSafeEqual）——
  // 长度不同（预检短路）与同长度异值（timingSafeEqual 拒绝）都必须正确拒绝，
  // 正确 token（含多字节字符）仍放行。
  it("static-bearer token comparison accepts only the exact token (P2-D)", () => {
    const bearer = new StaticBearerAuthVerifier("t0ken-值", { identity: "peer" });
    expect(bearer.verify(authCtx({ authorizationHeader: "Bearer t0ken-值" })).authenticated).toBe(true);
    // 长度不同（长度恒等预检分支）
    expect(bearer.verify(authCtx({ authorizationHeader: "Bearer t0ken" })).authenticated).toBe(false);
    expect(
      bearer.verify(authCtx({ authorizationHeader: "Bearer t0ken-值-extra" })).authenticated,
    ).toBe(false);
    // 同长度异值（timingSafeEqual 分支）
    expect(bearer.verify(authCtx({ authorizationHeader: "Bearer t0ken-値" })).authenticated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handler 异常不泄漏
// ---------------------------------------------------------------------------

describe("A2A Server: handler 异常不泄漏内部细节", () => {
  it("returns a generic internal error and never echoes the handler exception", async () => {
    const secret = "INTERNAL_SECRET_DB_PASSWORD=sup3r";
    const handler: NegotiationHandler = {
      name: "explode",
      async handle() {
        throw new Error(secret);
      },
    };
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { a2aUrl } = await startServer({ handler });

    const res = await rpc(a2aUrl, "message/send", {
      message: knpMessage(finalizeEnvelope(validEnvelopeFields())),
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(rpcError(res.body).code).toBe(-32603);
    expect((rpcError(res.body).data as Record<string, unknown>).protocol_code).toBe(
      "temporarily_unavailable",
    );
    // 细节只进服务端日志。
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(secret));
  });
});

// ---------------------------------------------------------------------------
// tasks/get
// ---------------------------------------------------------------------------

describe("A2A Server: tasks/get", () => {
  it("returns the task created by message/send", async () => {
    const { url, a2aUrl } = await startServer();
    const client = new A2AClient({ url: `${url}/` });
    const task = await client.sendMessage(
      knpMessage(finalizeEnvelope(validEnvelopeFields())),
      "ctx",
    );

    const res = await rpc(a2aUrl, "tasks/get", { id: task.id });
    expect(res.status).toBe(200);
    const result = res.body["result"] as Record<string, unknown>;
    const fetched = result["task"] as Record<string, unknown>;
    expect(fetched["id"]).toBe(task.id);
    expect((fetched["status"] as Record<string, unknown>)["state"]).toBe("completed");
  });

  it("maps tasks/get to the Ledger view after a server restart", async () => {
    const first = await startServer();
    const client = new A2AClient({ url: `${first.url}/` });
    const task = await client.sendMessage(
      knpMessage(finalizeEnvelope(validEnvelopeFields())),
      "ctx",
    );

    // 模拟重启：同一数据目录起新 server，内存 TaskRegistry 已空。
    const second = await startServer({}, first.dir);
    const res = await rpc(second.a2aUrl, "tasks/get", { id: task.id });
    expect(res.status).toBe(200);
    const result = res.body["result"] as Record<string, unknown>;
    const fetched = result["task"] as Record<string, unknown>;
    expect(fetched["id"]).toBe(task.id);
    expect((fetched["status"] as Record<string, unknown>)["state"]).toBe("completed");
  });

  it("returns TaskNotFound (-32004) for an unknown task id", async () => {
    const { a2aUrl } = await startServer();
    const res = await rpc(a2aUrl, "tasks/get", { id: "task_nope" });
    expect(res.status).toBe(200);
    expect(rpcError(res.body).code).toBe(-32004);
  });
});

// ---------------------------------------------------------------------------
// JSON-RPC 帧错误
// ---------------------------------------------------------------------------

describe("A2A Server: JSON-RPC 帧错误", () => {
  it("returns -32601 for an unknown method", async () => {
    const { a2aUrl } = await startServer();
    const res = await rpc(a2aUrl, "bogus/method", {});
    expect(res.status).toBe(200);
    expect(rpcError(res.body).code).toBe(-32601);
  });

  it("returns -32602 for missing params.message", async () => {
    const { a2aUrl } = await startServer();
    const res = await rpc(a2aUrl, "message/send", {});
    expect(res.status).toBe(200);
    expect(rpcError(res.body).code).toBe(-32602);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const { a2aUrl } = await startServer();
    const res = await fetch(a2aUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not valid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(rpcError(body).code).toBe(-32700);
  });

  it("returns 400 for a non-JSON-RPC frame", async () => {
    const { a2aUrl } = await startServer();
    const res = await fetch(a2aUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ foo: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 405 for a GET on the JSON-RPC endpoint", async () => {
    const { url } = await startServer();
    const res = await fetch(url);
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// 入站 identity snapshot counterparty 侧（基线 §22，问题三）
// ---------------------------------------------------------------------------

describe("A2A Server: 入站 identity snapshot counterparty 侧", () => {
  it("验签身份优先写入 counterparty_identity；无验签身份才回退 remoteAddress", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-pipeline-identity-"));
    try {
      const ledger = new LedgerStore({ dir, now: () => "2026-08-06T10:00:00.000Z" });
      const idempotency = new IdempotencyStore({ dir, now: () => "2026-08-06T10:00:00.000Z" });
      const pipeline = new InboundPipeline({
        handler: echoHandler(),
        idempotency,
        ledger,
        tasks: new TaskRegistry(),
        now: () => "2026-08-06T10:00:00.000Z",
        logError: () => {},
      });

      // 1. AuthVerifier 给出验签身份（identityVerified=true）→ counterparty 用验签身份，
      //    而不是 socket 地址。
      const signedEnvelope = finalizeEnvelope(validEnvelopeFields());
      await pipeline.sendMessage(
        { message: knpMessage(signedEnvelope) },
        {
          senderIdentity: "peer-verified",
          remoteAddress: "::ffff:127.0.0.1",
          identityVerified: true,
        },
      );
      const first = ledger.events(NEGOTIATION_ID)[0];
      expect(first?.identity.sender_identity).toBe("peer-verified");
      expect(first?.identity.counterparty_identity).toBe("peer-verified");
      expect(first?.identity.counterparty_identity).not.toBe("::ffff:127.0.0.1");

      // 2. 无验签身份（匿名/loopback 档）→ 回退 remoteAddress。
      const anonymousEnvelope = finalizeEnvelope({
        ...validEnvelopeFields(),
        message_id: "msg_pipeline_identity_2",
      });
      await pipeline.sendMessage(
        { message: knpMessage(anonymousEnvelope) },
        { senderIdentity: "anonymous", remoteAddress: "127.0.0.1:43123" },
      );
      const second = ledger.events(NEGOTIATION_ID)[1];
      expect(second?.identity.sender_identity).toBe("anonymous");
      expect(second?.identity.counterparty_identity).toBe("127.0.0.1:43123");

      expect(ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("HttpMessageSignatureVerifier 验签成功时返回 identityVerified=true（驱动 counterparty 身份）", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pubJwk = publicKey.export({ format: "jwk" });
    const resolver = resolveFromSigningKeys([
      {
        keyid: "buyer-2026",
        algorithm: "ed25519" as const,
        jwk: pubJwk,
        // T1（DISCOVERED）：强制 HTTP Message Signature 但不强制 Agent Card JWS，
        // 单测聚焦验签身份的 identityVerified 信号（完整 T2 卡片 JWS 往返由
        // interop-signed-identity 覆盖）。
        profile: { identity: "peer-verified", trustLevel: "T1" as const },
      },
    ]);
    const verifier = new HttpMessageSignatureVerifier({ resolver, anonymousTrustLevel: "T1" });
    const signer = new HttpMessageSigner({
      keyid: "buyer-2026",
      algorithm: "ed25519",
      privateKey: privatePem,
    });
    const headers = signer.sign({
      method: "POST",
      url: "http://merchant/a2a",
      body: Buffer.from("{}"),
      headers: { host: "merchant" },
    });
    const result = verifier.verify({
      remoteAddress: "::ffff:127.0.0.1",
      authorizationHeader: undefined,
      method: "POST",
      url: "/a2a",
      scheme: "http",
      headers: { ...headers, host: "merchant" },
      body: Buffer.from("{}"),
    });
    expect(result.authenticated).toBe(true);
    expect(result.identity).toBe("peer-verified");
    expect(result.identityVerified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 入站幂等 commit 失败后至多一次（审查 P1-05，2026-08-10）
// ---------------------------------------------------------------------------

describe("A2A Server: commit 失败后 handler 至多一次（P1-05）", () => {
  it("commit 失败 → ledger 恢复返回稳定响应；重试幂等短接，handler 不重复执行", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-p105-"));
    const ledger = new LedgerStore({ dir, now: () => "2026-08-06T10:00:00.000Z" });
    const idempotency = new IdempotencyStore({ dir, now: () => "2026-08-06T10:00:00.000Z" });
    let handlerCalls = 0;
    const inner = echoHandler();
    const counting: NegotiationHandler = {
      name: "counting-echo",
      async handle(ctx) {
        handlerCalls += 1;
        return inner.handle(ctx);
      },
    };
    const pipeline = new InboundPipeline({
      handler: counting,
      idempotency,
      ledger,
      tasks: new TaskRegistry(),
      now: () => "2026-08-06T10:00:00.000Z",
      logError: () => {},
    });
    const envelope = finalizeEnvelope({
      ...validEnvelopeFields(),
      message_id: "msg_p105_commit_fail",
    });
    const message = knpMessage(envelope);
    const caller = { senderIdentity: "peer-p105", remoteAddress: "127.0.0.1:9" };

    // run 1：ledger.append 成功、幂等 commit 抛错（模拟 commit 失败窗口）——
    // P1-05 前此窗口抛 internalServerError，客户端重试会重复执行 handler。
    const commitSpy = vi.spyOn(idempotency, "commit").mockImplementationOnce(() => {
      throw new Error("simulated commit failure");
    });
    const run1 = await pipeline.sendMessage({ message }, caller);
    commitSpy.mockRestore();
    expect(run1.task.id).toBeTruthy();
    expect(run1.task.status.state).toBe("completed");

    // run 2：同消息重试 → 幂等已补 commit → 直接短接（不重复执行 handler）
    const run2 = await pipeline.sendMessage({ message }, caller);
    expect(run2.task.id).toBe(run1.task.id);

    // handler 全程只执行一次（至多一次：双份 agreement 不可能）
    expect(handlerCalls).toBe(1);
    // Ledger 只落一条 message_received
    expect(
      ledger.events(NEGOTIATION_ID).filter((e) => e.event_kind === "message_received"),
    ).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("补 commit 也失败（持久）→ 重试走 ledger 守卫恢复，handler 仍不重复执行", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-p105b-"));
    const ledger = new LedgerStore({ dir, now: () => "2026-08-06T10:00:00.000Z" });
    const idempotency = new IdempotencyStore({ dir, now: () => "2026-08-06T10:00:00.000Z" });
    let handlerCalls = 0;
    const inner = echoHandler();
    const counting: NegotiationHandler = {
      name: "counting-echo",
      async handle(ctx) {
        handlerCalls += 1;
        return inner.handle(ctx);
      },
    };
    const pipeline = new InboundPipeline({
      handler: counting,
      idempotency,
      ledger,
      tasks: new TaskRegistry(),
      now: () => "2026-08-06T10:00:00.000Z",
      logError: () => {},
    });
    const envelope = finalizeEnvelope({
      ...validEnvelopeFields(),
      message_id: "msg_p105_persistent_commit_fail",
    });
    const message = knpMessage(envelope);
    const caller = { senderIdentity: "peer-p105b", remoteAddress: "127.0.0.1:9" };

    // commit 永远失败：run 1 的 ledger 恢复补 commit 也失败 → 幂等索引保持为空。
    // 重试必须命中 ledger 守卫（findByMessageId 持久事实）恢复，不重跑 handler。
    const commitSpy = vi.spyOn(idempotency, "commit").mockImplementation(() => {
      throw new Error("persistent commit failure");
    });
    try {
      const run1 = await pipeline.sendMessage({ message }, caller);
      expect(run1.task.status.state).toBe("completed");
      const run2 = await pipeline.sendMessage({ message }, caller);
      expect(run2.task.id).toBe(run1.task.id);
      expect(run2.task.status.state).toBe("completed");
    } finally {
      commitSpy.mockRestore();
    }

    // handler 全程只执行一次：run 2 命中 ledger 守卫，未重跑 handler
    expect(handlerCalls).toBe(1);
    expect(
      ledger.events(NEGOTIATION_ID).filter((e) => e.event_kind === "message_received"),
    ).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("同 message_id 异 digest 重放（幂等索引空、Ledger 有证据）→ idempotency_conflict fail-closed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-p105c-"));
    const ledger = new LedgerStore({ dir, now: () => "2026-08-06T10:00:00.000Z" });
    const idempotency = new IdempotencyStore({ dir, now: () => "2026-08-06T10:00:00.000Z" });
    let handlerCalls = 0;
    const inner = echoHandler();
    const counting: NegotiationHandler = {
      name: "counting-echo",
      async handle(ctx) {
        handlerCalls += 1;
        return inner.handle(ctx);
      },
    };
    const pipeline = new InboundPipeline({
      handler: counting,
      idempotency,
      ledger,
      tasks: new TaskRegistry(),
      now: () => "2026-08-06T10:00:00.000Z",
      logError: () => {},
    });
    const msgId = "msg_p105_conflict";
    const first = finalizeEnvelope({ ...validEnvelopeFields(), message_id: msgId });
    const caller = { senderIdentity: "peer-p105c", remoteAddress: "127.0.0.1:9" };

    // commit 永远失败 → 幂等索引保持为空；Ledger 落证据（wire_digest=first.digest）
    const commitSpy = vi.spyOn(idempotency, "commit").mockImplementation(() => {
      throw new Error("persistent commit failure");
    });
    try {
      await pipeline.sendMessage({ message: knpMessage(first) }, caller);

      // 恶意重放：同 message_id 但内容不同（digest 不同）→ ledger 守卫 digest
      // 校验 fail-closed → idempotency_conflict，handler 不重复执行。
      const replay = finalizeEnvelope({
        ...validEnvelopeFields(),
        message_id: msgId,
        public_message: "tampered content",
      });
      expect(replay.digest).not.toBe(first.digest);
      // pipeline 直接调用抛原始 ServerProtocolError（A2AClient 才归一化成 jsonrpc_error）
      await expect(pipeline.sendMessage({ message: knpMessage(replay) }, caller)).rejects.toMatchObject({
        name: "ServerProtocolError",
        body: { data: { protocol_code: "idempotency_conflict" } },
      });
    } finally {
      commitSpy.mockRestore();
    }

    expect(handlerCalls).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("append 与 commit 之间崩溃（全新实例、幂等为空）：ledger 守卫恢复，handler 零重跑", async () => {
    // 独立故障注入：直接构造"run 1 崩溃后"的持久状态——handler 已执行完毕、
    // message_received 已落账（携带 run 1 的随机 taskId），进程在幂等 commit
    // 之前崩溃（幂等索引为空、内存 task registry 丢失）。重试方是全新实例
    // （重启语义），内部会生成新的随机 taskId——修复前此场景 handler 必重跑。
    const NOW = "2026-08-06T10:00:00.000Z";
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-p105-crash-"));
    const crashedTaskId = "task_crashed_run_1";
    const envelope = finalizeEnvelope({
      ...validEnvelopeFields(),
      message_id: "msg_p105_crash_window",
    });
    const caller = { senderIdentity: "peer-p105-crash", remoteAddress: "127.0.0.1:9" };

    // run 1 崩溃现场：事件内容与 pipeline 落账路径一致（wire_digest 与链上
    // 证据一致，否则恢复路径按恶意重放 fail-closed）。
    const crashedLedger = new LedgerStore({ dir, now: () => NOW });
    crashedLedger.append({
      event_kind: "message_received",
      negotiation_id: envelope.negotiation_id,
      exchange_id: envelope.exchange_id,
      message_id: envelope.message_id,
      in_reply_to: envelope.in_reply_to,
      remote_task_id: crashedTaskId,
      identity: {
        sender_identity: caller.senderIdentity,
        counterparty_identity: caller.remoteAddress,
        actor: envelope.actor,
      },
      capability: { capability: envelope.capability, protocol_version: envelope.protocol_version },
      wire_digest: envelope.digest,
      wire_payload: envelope as unknown as Record<string, unknown>,
      outcome: { kind: "ok", result: { task_id: crashedTaskId, task_state: "completed" } },
      occurred_at: envelope.created_at,
    });

    // “重启”：全新 LedgerStore / IdempotencyStore / TaskRegistry / Pipeline（同 dir）。
    const ledger = new LedgerStore({ dir, now: () => NOW });
    const idempotency = new IdempotencyStore({ dir, now: () => NOW });
    let handlerCalls = 0;
    const inner = echoHandler();
    const counting: NegotiationHandler = {
      name: "counting-echo",
      async handle(ctx) {
        handlerCalls += 1;
        return inner.handle(ctx);
      },
    };
    const pipeline = new InboundPipeline({
      handler: counting,
      idempotency,
      ledger,
      tasks: new TaskRegistry(),
      now: () => NOW,
      logError: () => {},
    });

    // 重试 1（同逻辑消息、同 digest；pipeline 内部生成的新随机 taskId 不得被使用）：
    // ledger 守卫恢复崩溃运行的结果，handler 一次都不跑。
    const retry1 = await pipeline.sendMessage({ message: knpMessage(envelope) }, caller);
    expect(handlerCalls).toBe(0);
    expect(retry1.task.id).toBe(crashedTaskId);
    expect(retry1.task.status.state).toBe("completed");

    // 恢复已补 commit：重试 2 命中幂等短接（同 key 同 digest → 原结果）。
    const retry2 = await pipeline.sendMessage({ message: knpMessage(envelope) }, caller);
    expect(retry2.task.id).toBe(crashedTaskId);
    expect(handlerCalls).toBe(0);

    // 全程只有崩溃 run 落的那一条 message_received，链完整。
    expect(
      ledger.events(NEGOTIATION_ID).filter((e) => e.event_kind === "message_received"),
    ).toHaveLength(1);
    expect(ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("commit 永久失败后整体重启（全新 store/pipeline 实例）→ 重试仍至多一次执行", async () => {
    // 与上一用例互补：run 1 由真实 pipeline 执行（handler 跑完、ledger 落账、
    // commit 被注入永久失败），随后连同 store 一起换成全新实例重放同消息。
    const NOW = "2026-08-06T10:00:00.000Z";
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-p105-restart-"));
    const envelope = finalizeEnvelope({
      ...validEnvelopeFields(),
      message_id: "msg_p105_restart",
    });
    const caller = { senderIdentity: "peer-p105-restart", remoteAddress: "127.0.0.1:9" };
    let handlerCalls = 0;
    const inner = echoHandler();
    const counting: NegotiationHandler = {
      name: "counting-echo",
      async handle(ctx) {
        handlerCalls += 1;
        return inner.handle(ctx);
      },
    };
    const makePipeline = () =>
      new InboundPipeline({
        handler: counting,
        idempotency: new IdempotencyStore({ dir, now: () => NOW }),
        ledger: new LedgerStore({ dir, now: () => NOW }),
        tasks: new TaskRegistry(),
        now: () => NOW,
        logError: () => {},
      });

    // run 1（实例 A）：commit 永久失败——message_received 落账、幂等索引为空。
    const pipelineA = makePipeline();
    const commitSpy = vi
      .spyOn(IdempotencyStore.prototype, "commit")
      .mockImplementation(() => {
        throw new Error("persistent commit failure");
      });
    const run1 = await pipelineA.sendMessage({ message: knpMessage(envelope) }, caller);
    commitSpy.mockRestore();
    expect(run1.task.status.state).toBe("completed");
    expect(handlerCalls).toBe(1);

    // “重启”（实例 B：全新 store/pipeline/task registry，同 dir）重放同一逻辑消息：
    // 幂等索引为空 → 必须命中 ledger 守卫恢复，不得重跑 handler。
    const pipelineB = makePipeline();
    const run2 = await pipelineB.sendMessage({ message: knpMessage(envelope) }, caller);
    expect(run2.task.id).toBe(run1.task.id);
    expect(handlerCalls).toBe(1);

    // 实例 B 已补 commit：重试 3 命中幂等短接。
    const run3 = await pipelineB.sendMessage({ message: knpMessage(envelope) }, caller);
    expect(run3.task.id).toBe(run1.task.id);
    expect(handlerCalls).toBe(1);

    const ledger = new LedgerStore({ dir, now: () => NOW });
    expect(
      ledger.events(NEGOTIATION_ID).filter((e) => e.event_kind === "message_received"),
    ).toHaveLength(1);
    expect(ledger.verifyChain(NEGOTIATION_ID).valid).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
