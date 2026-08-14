/**
 * A2A server 双栈 dispatch 测试（issue 07）：
 * - 按 A2A-Version 路由：1.0 → SendMessage/GetTask + 1.0 Part + 大写 TaskState；
 *   0.3/无头 → legacy 帧；
 * - 不支持版本 → fail-closed；
 * - 未知 A2A-Extensions → fail-closed。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { A2AServer } from "../src/a2a/server/index.js";
import { KIWI_NEGOTIATION_EXTENSION_PATH } from "../src/discovery/agent-card/index.js";
import type { NegotiationHandler } from "../src/a2a/server/types.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { validEnvelopeFields } from "./negotiation-helpers.js";

interface Started {
  url: string;
  a2aUrl: string;
  httpServer: http.Server;
  dir: string;
}

/** 接受型安全 handler：产出已知 taskState（completed），供 dispatch 测试。 */
const acceptHandler: NegotiationHandler = {
  name: "accept",
  async handle() {
    return { kind: "accepted", taskState: "completed" };
  },
};

const registry: Array<{ httpServer: http.Server; dir: string }> = [];

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function startServer(): Promise<Started> {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-v1-"));
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
    handler: acceptHandler,
  });
  const httpServer = server.createServer();
  const url = await listen(httpServer);
  holder.baseUrl = url;
  registry.push({ httpServer, dir });
  return { url, a2aUrl: `${url}/`, httpServer, dir };
}

afterEach(async () => {
  for (const entry of registry) {
    entry.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => entry.httpServer.close(() => resolve()));
    rmSync(entry.dir, { recursive: true, force: true });
  }
  registry.length = 0;
});

async function post(
  a2aUrl: string,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
  id = "req-1",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(a2aUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

function resultOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  return body["result"] === null || typeof body["result"] !== "object" ? undefined : (body["result"] as Record<string, unknown>);
}

describe("A2A server 双栈 dispatch（issue 07）", () => {
  it("1.0 SendMessage：1.0 Part + 大写 TaskState 往返", async () => {
    const { a2aUrl, url } = await startServer();
    const knpUri = `${url}${KIWI_NEGOTIATION_EXTENSION_PATH}`;
    const envelope = finalizeEnvelope(validEnvelopeFields());
    const message = {
      role: "agent",
      parts: [
        { text: "hi" },
        { data: { knp_envelope: envelope }, mediaType: "application/json" },
      ],
      messageId: envelope.message_id,
    };
    const { status, body } = await post(a2aUrl, "SendMessage", { message }, {
      "A2A-Version": "1.0",
      "A2A-Extensions": knpUri,
    });
    expect(status).toBe(200);
    const task = resultOf(body)?.["task"] as { status?: { state?: string } } | undefined;
    expect(task?.status?.state).toBe("TASK_STATE_COMPLETED"); // 1.0 wire 状态
  });

  it("1.0 KNP response maps legacy carrier parts to unified Parts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-a2a-v1-response-"));
    const ledger = new LedgerStore({ dir });
    const idempotency = new IdempotencyStore({ dir });
    const holder = { baseUrl: "http://127.0.0.1:0" };
    const server = new A2AServer({
      card: () => ({
        name: "Response shape merchant",
        description: "A2A response shape test",
        providerOrganization: "Kiwi Test Org",
        version: "1.0.0",
        baseUrl: holder.baseUrl,
        a2aPath: "/",
      }),
      ledger,
      idempotency,
      handler: {
        name: "response-shape",
        async handle() {
          return {
            kind: "accepted" as const,
            taskState: "completed" as const,
            message: { role: "agent" as const, parts: [{ kind: "text" as const, text: "done" }], messageId: "msg-response" },
            artifactParts: [{ kind: "data" as const, data: { agreement: { agreement_id: "agr_test" } } }],
          };
        },
      },
    });
    const httpServer = server.createServer();
    const responseUrl = await listen(httpServer);
    holder.baseUrl = responseUrl;
    registry.push({ httpServer, dir });
    const envelope = finalizeEnvelope(validEnvelopeFields());
    const { body } = await post(`${responseUrl}/`, "SendMessage", {
      message: {
        role: "ROLE_USER",
        parts: [{ data: { knp_envelope: envelope }, mediaType: "application/json" }],
        messageId: envelope.message_id,
      },
    }, { "A2A-Version": "1.0", "A2A-Extensions": `${responseUrl}${KIWI_NEGOTIATION_EXTENSION_PATH}` });
    const task = resultOf(body)?.["task"] as {
      status?: { message?: { role?: string; parts?: unknown[] } };
      artifacts?: Array<{ parts?: unknown[] }>;
    } | undefined;
    expect(task?.status?.message?.role).toBe("ROLE_AGENT");
    expect(task?.status?.message?.parts?.[0]).toEqual({ text: "done" });
    expect(task?.artifacts?.[0]?.parts?.[0]).toEqual({
      data: { agreement: { agreement_id: "agr_test" } },
      mediaType: "application/json",
    });
  });

  it.each([
    [null, "null"],
    ["bad", "primitive"],
    [{ data: null }, "null data"],
    [{ kind: "data", data: {} }, "legacy kind"],
  ])("1.0 malformed Part (%s) is rejected as invalid request", async (part, _label) => {
    const { a2aUrl } = await startServer();
    const { body } = await post(a2aUrl, "SendMessage", {
      message: { role: "ROLE_USER", parts: [part], messageId: `malformed-${String(part)}` },
    }, { "A2A-Version": "1.0" });
    expect(rpcError(body).code).toBe(-32600);
    expect(rpcError(body).message).not.toContain("internal error");
  });

  it("0.3 / 无版本头走 legacy（message/send 可用）", async () => {
    const { a2aUrl } = await startServer();
    const { status } = await post(a2aUrl, "message/send", {
      message: { role: "agent", parts: [{ kind: "text", text: "hi" }], messageId: "m1" },
    });
    expect(status).toBe(200);
  });

  it("不支持版本 → fail-closed", async () => {
    const { a2aUrl } = await startServer();
    const { body } = await post(a2aUrl, "SendMessage", { message: {} }, {
      "A2A-Version": "9.9",
    });
    expect(rpcError(body).message).toContain("unsupported A2A version");
  });

  it("未知 A2A-Extensions → fail-closed", async () => {
    const { a2aUrl } = await startServer();
    const { body } = await post(a2aUrl, "SendMessage", { message: {} }, {
      "A2A-Version": "1.0",
      "A2A-Extensions": "https://evil.example/ext",
    });
    expect(rpcError(body).message).toContain("unsupported A2A extension");
  });

  it("1.0 错误体：error.data 是 ErrorInfo 数组（domain a2a-protocol.org）", async () => {
    const { a2aUrl } = await startServer();
    const { body } = await post(a2aUrl, "SendMessage", { message: {} }, {
      "A2A-Version": "1.0",
      "A2A-Extensions": "https://evil.example/ext",
    });
    const data = rpcError(body)["data"] as
      | Array<{ "@type"?: string; domain?: string; reason?: string }>
      | undefined;
    expect(Array.isArray(data)).toBe(true);
    expect(data?.[0]?.["@type"]).toBe("type.googleapis.com/google.rpc.ErrorInfo");
    expect(data?.[0]?.domain).toBe("a2a-protocol.org");
  });

  it("0.3 错误体保持 legacy 形状（无 google.rpc.Status 升级）", async () => {
    const { a2aUrl } = await startServer();
    const { body } = await post(a2aUrl, "message/send", { message: {} });
    const data = rpcError(body)["data"] as { "@type"?: string } | undefined;
    expect(data?.["@type"]).not.toBe("google.rpc.Status"); // 0.3 不升级
  });
});

describe("1.0 通用（非 KNP）消息路径（issue 10 / TCK）", () => {
  it("普通消息 → 完成任务 + 生成 contextId + 回显 artifact（缺省响应器）", async () => {
    const { a2aUrl } = await startServer();
    const message = {
      role: "ROLE_USER",
      parts: [{ text: "hello generic" }],
      messageId: "msg-generic-1",
    };
    const { status, body } = await post(a2aUrl, "SendMessage", { message }, { "A2A-Version": "1.0" });
    expect(status).toBe(200);
    const task = resultOf(body)?.["task"] as
      | { id?: string; status?: { state?: string }; contextId?: string; artifacts?: unknown[] }
      | undefined;
    expect(task?.id).toBeTruthy();
    expect(task?.status?.state).toBe("TASK_STATE_COMPLETED");
    expect(task?.contextId).toBeTruthy();
    expect(Array.isArray(task?.artifacts)).toBe(true);
  });

  it("CORE-MULTI-004：消息携带不存在的 taskId → TaskNotFound (-32001)", async () => {
    const { a2aUrl } = await startServer();
    const message = {
      role: "ROLE_USER",
      parts: [{ text: "to missing task" }],
      messageId: "msg-multi-004",
      taskId: "task_nonexistent",
    };
    const { status, body } = await post(a2aUrl, "SendMessage", { message }, { "A2A-Version": "1.0" });
    expect(status).toBe(200);
    expect(rpcError(body).code).toBe(-32001);
  });

  it("CORE-SEND-002：向终态任务发消息 → UnsupportedOperation (-32004)", async () => {
    const { a2aUrl } = await startServer();
    // 先创建任务（缺省响应器立即完成任务）。
    const first = {
      role: "ROLE_USER",
      parts: [{ text: "first" }],
      messageId: "msg-terminal-1",
    };
    const firstRes = await post(a2aUrl, "SendMessage", { message: first }, { "A2A-Version": "1.0" });
    const taskId = (resultOf(firstRes.body)?.["task"] as { id?: string } | undefined)?.id;
    expect(taskId).toBeTruthy();
    // 对终态任务再发消息 → -32004。
    const follow = {
      role: "ROLE_USER",
      parts: [{ text: "follow-up" }],
      messageId: "msg-terminal-2",
      taskId,
    };
    const { status, body } = await post(a2aUrl, "SendMessage", { message: follow }, { "A2A-Version": "1.0" });
    expect(status).toBe(200);
    expect(rpcError(body).code).toBe(-32004);
  });

  it("CORE-MULTI-006：taskId + 不匹配 contextId → 拒绝", async () => {
    const { a2aUrl } = await startServer();
    const first = {
      role: "ROLE_USER",
      parts: [{ text: "first" }],
      messageId: "msg-mismatch-1",
    };
    const firstRes = await post(a2aUrl, "SendMessage", { message: first }, { "A2A-Version": "1.0" });
    const task = resultOf(firstRes.body)?.["task"] as
      | { id?: string; contextId?: string }
      | undefined;
    expect(task?.id).toBeTruthy();
    expect(task?.contextId).toBeTruthy();
    const wrong = {
      role: "ROLE_USER",
      parts: [{ text: "wrong ctx" }],
      messageId: "msg-mismatch-2",
      taskId: task?.id,
      contextId: "ctx-wrong",
    };
    const { status, body } = await post(a2aUrl, "SendMessage", { message: wrong }, { "A2A-Version": "1.0" });
    expect(status).toBe(200);
    expect(rpcError(body).code).not.toBeUndefined();
  });

  it("HTTP 层：非 application/json Content-Type → 415 text body（不进 JSON-RPC 解析）", async () => {
    const { a2aUrl } = await startServer();
    const res = await fetch(a2aUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });
    expect(res.status).toBe(415);
    expect((await res.text()).startsWith("{")).toBe(false);
  });
});

function rpcError(body: Record<string, unknown>): Record<string, unknown> {
  const error = body["error"];
  return (error === null || typeof error !== "object" ? {} : error) as Record<string, unknown>;
}
