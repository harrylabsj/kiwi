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
    expect(task?.status?.state).toBe("COMPLETED"); // 1.0 大写状态
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

  it("1.0 错误体升级为 google.rpc.Status + ErrorInfo（domain a2a-protocol.org）", async () => {
    const { a2aUrl } = await startServer();
    const { body } = await post(a2aUrl, "SendMessage", { message: {} }, {
      "A2A-Version": "1.0",
      "A2A-Extensions": "https://evil.example/ext",
    });
    const data = rpcError(body)["data"] as {
      "@type"?: string;
      code?: number;
      details?: Array<{ "@type"?: string; domain?: string }>;
    };
    expect(data?.["@type"]).toBe("google.rpc.Status");
    expect(typeof data?.code).toBe("number");
    expect(data?.details?.[0]?.["@type"]).toBe("type.googleapis.com/google.rpc.ErrorInfo");
    expect(data?.details?.[0]?.domain).toBe("a2a-protocol.org");
  });

  it("0.3 错误体保持 legacy 形状（无 google.rpc.Status 升级）", async () => {
    const { a2aUrl } = await startServer();
    const { body } = await post(a2aUrl, "message/send", { message: {} });
    const data = rpcError(body)["data"] as { "@type"?: string } | undefined;
    expect(data?.["@type"]).not.toBe("google.rpc.Status"); // 0.3 不升级
  });
});

function rpcError(body: Record<string, unknown>): Record<string, unknown> {
  const error = body["error"];
  return (error === null || typeof error !== "object" ? {} : error) as Record<string, unknown>;
}
