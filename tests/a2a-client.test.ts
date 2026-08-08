/**
 * A2A JSONRPC 出站 client 测试：
 *  - mock server（node:http 本地 127.0.0.1）往返：message/send（Text Part +
 *    Data Part 携带 KNP envelope）、tasks/get；
 *  - fail-closed 错误路径：timeout / 非 2xx / JSON-RPC error / 畸形响应 /
 *    id 不匹配 / schema 校验失败 / network；
 *  - SSRF 防护：http(s) only、拒绝私网/保留段、loopback 放行、DNS 复查。
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import {
  A2AClient,
  A2AClientError,
  assertResolvableTargetUrl,
  assertSafeTargetUrl,
  isReservedIpv4,
  isReservedIpv6,
} from "../src/a2a/client/index.js";
import { NEGOTIATION_ID, validEnvelopeFields } from "./negotiation-helpers.js";
import type { A2AMessage } from "../src/a2a/client/index.js";

interface MockServer {
  server: http.Server;
  url: string;
  lastRequest: () => Record<string, unknown> | null;
}

const servers: http.Server[] = [];

function startServer(
  handler: (body: Record<string, unknown> | null, res: http.ServerResponse) => void,
): Promise<MockServer> {
  let lastRequest: Record<string, unknown> | null = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      lastRequest = body;
      handler(body, res);
    });
  });
  server.on("clientError", () => {
    // ignore malformed client traffic (aborted sockets during timeout tests)
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        lastRequest: () => lastRequest,
      });
    });
  });
}

function jsonResponse(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function requestId(body: Record<string, unknown> | null): string {
  return typeof body?.id === "string" ? body.id : "unknown";
}

function knpMessage(taskId = "task_01"): A2AMessage {
  const envelope = finalizeEnvelope(validEnvelopeFields());
  return {
    role: "agent",
    parts: [
      { kind: "text", text: "We propose 200 units at CNY 835.00 per unit." },
      { kind: "data", data: { knp_envelope: envelope } },
    ],
    messageId: envelope.message_id,
    taskId,
  };
}

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.length = 0;
});

describe("A2A client 往返（mock server）", () => {
  it("sendMessage round-trips a Text Part + Data Part carrying the KNP envelope", async () => {
    const mock = await startServer((body, res) => {
      jsonResponse(res, {
        jsonrpc: "2.0",
        id: requestId(body),
        result: {
          task: {
            id: "task_01",
            status: { state: "working" },
            contextId: "ctx_1",
          },
        },
      });
    });

    const client = new A2AClient({ url: mock.url });
    const message = knpMessage();
    const task = await client.sendMessage(message, "ctx_1");

    expect(task.id).toBe("task_01");
    expect(task.status.state).toBe("working");
    expect(task.contextId).toBe("ctx_1");

    const received = mock.lastRequest();
    expect(received?.method).toBe("message/send");
    expect((received?.params as Record<string, unknown>).contextId).toBe("ctx_1");
    const msg = (received?.params as Record<string, unknown>).message as Record<string, unknown>;
    expect(msg.messageId).toBe(message.messageId);
    const parts = msg.parts as { kind: string; [k: string]: unknown }[];
    expect(parts.map((p) => p.kind).sort()).toEqual(["data", "text"]);
    const dataPart = parts.find((p) => p.kind === "data");
    const knp = (dataPart?.data as Record<string, unknown>).knp_envelope as Record<string, unknown>;
    expect(knp.negotiation_id).toBe(NEGOTIATION_ID);
    expect(typeof knp.digest).toBe("string");
  });

  it("sendMessage parses a completed task with artifacts", async () => {
    const mock = await startServer((body, res) => {
      jsonResponse(res, {
        jsonrpc: "2.0",
        id: requestId(body),
        result: {
          task: {
            id: "task_09",
            status: { state: "completed", timestamp: "2026-08-06T10:00:00Z" },
            artifacts: [
              {
                artifactId: "art_1",
                parts: [{ kind: "data", data: { agreement_id: "agr_1" } }],
              },
            ],
          },
        },
      });
    });

    const task = await new A2AClient({ url: mock.url }).sendMessage(knpMessage("task_09"));
    expect(task.status.state).toBe("completed");
    expect(task.artifacts?.[0]?.artifactId).toBe("art_1");
  });

  it("getTask round-trips the requested task id", async () => {
    const mock = await startServer((body, res) => {
      expect((body?.params as Record<string, unknown>).id).toBe("task_42");
      jsonResponse(res, {
        jsonrpc: "2.0",
        id: requestId(body),
        result: { task: { id: "task_42", status: { state: "completed" } } },
      });
    });

    const task = await new A2AClient({ url: mock.url }).getTask("task_42");
    expect(task.id).toBe("task_42");
    expect(task.status.state).toBe("completed");
  });
});

describe("A2A client 错误路径（fail-closed）", () => {
  it("times out when the server never responds", async () => {
    const mock = await startServer(() => {
      // never respond
    });
    const client = new A2AClient({ url: mock.url, timeoutMs: 50 });
    await expect(client.sendMessage(knpMessage())).rejects.toMatchObject({ kind: "timeout" });
  });

  it("refuses to follow a redirect (SSRF: redirect target is not re-checked)", async () => {
    const redirectedTo = await startServer((_body, res) => {
      jsonResponse(res, { jsonrpc: "2.0", id: "x", result: { task: {} } });
    });
    const mock = await startServer((_body, res) => {
      res.writeHead(302, { location: redirectedTo.url });
      res.end();
    });
    const client = new A2AClient({ url: mock.url });
    await expect(client.sendMessage(knpMessage())).rejects.toMatchObject({
      kind: "http_status",
    });
    // 目标服务器从未收到请求（此前 fetch 默认跟随，请求体会被投递过去）。
    expect(redirectedTo.lastRequest()).toBeNull();
  });

  it("times out while reading a stalled response body (slow-body hang)", async () => {
    const mock = await startServer((_body, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"jsonrpc":"2.0","id":1,"result":');
      // 不再 end：body 停滞——此前超时只覆盖头阶段，此场景会永久挂起。
    });
    const client = new A2AClient({ url: mock.url, timeoutMs: 200 });
    await expect(client.sendMessage(knpMessage())).rejects.toMatchObject({ kind: "timeout" });
  });

  it("rejects an oversized response before reading it (content-length precheck)", async () => {
    const client = new A2AClient({
      url: "http://127.0.0.1:1/a2a",
      skipDnsCheck: true,
      fetchImpl: async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(1024 * 1024 * 1024),
          },
        }),
    });
    await expect(client.sendMessage(knpMessage())).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("fails with http_status on a non-2xx response", async () => {
    const mock = await startServer((_body, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    const client = new A2AClient({ url: mock.url });
    await expect(client.sendMessage(knpMessage())).rejects.toMatchObject({ kind: "http_status" });
  });

  it("fails with jsonrpc_error on a JSON-RPC error response", async () => {
    const mock = await startServer((body, res) => {
      jsonResponse(res, {
        jsonrpc: "2.0",
        id: requestId(body),
        error: { code: -32003, message: "Message rejected" },
      });
    });
    const client = new A2AClient({ url: mock.url });
    await expect(client.sendMessage(knpMessage())).rejects.toMatchObject({
      kind: "jsonrpc_error",
      jsonrpcCode: -32003,
    });
  });

  it("fails with invalid_response on a malformed body", async () => {
    const mock = await startServer((_body, res) => {
      jsonResponse(res, { foo: 1 });
    });
    const client = new A2AClient({ url: mock.url });
    await expect(client.sendMessage(knpMessage())).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("fails with invalid_response when the response id does not match", async () => {
    const mock = await startServer((_body, res) => {
      jsonResponse(res, {
        jsonrpc: "2.0",
        id: "different-id",
        result: { task: { id: "t", status: { state: "working" } } },
      });
    });
    const client = new A2AClient({ url: mock.url });
    await expect(client.sendMessage(knpMessage())).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("fails with schema_invalid when the task state is unknown", async () => {
    const mock = await startServer((body, res) => {
      jsonResponse(res, {
        jsonrpc: "2.0",
        id: requestId(body),
        result: { task: { id: "t", status: { state: "bogus" } } },
      });
    });
    const client = new A2AClient({ url: mock.url });
    await expect(client.sendMessage(knpMessage())).rejects.toMatchObject({
      kind: "schema_invalid",
    });
  });

  it("fails with network on a fetch-level failure", async () => {
    const client = new A2AClient({
      url: "http://127.0.0.1:1",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(client.sendMessage(knpMessage())).rejects.toMatchObject({ kind: "network" });
  });

  it("fails with invalid_response when the task part kind is unsupported", async () => {
    const mock = await startServer((body, res) => {
      jsonResponse(res, {
        jsonrpc: "2.0",
        id: requestId(body),
        result: {
          task: {
            id: "t",
            status: {
              state: "completed",
              message: { role: "agent", parts: [{ kind: "file", file: "x.pdf" }], messageId: "m1" },
            },
          },
        },
      });
    });
    const client = new A2AClient({ url: mock.url });
    await expect(client.getTask("t")).rejects.toMatchObject({ kind: "schema_invalid" });
  });
});

describe("A2A client URL 安全（SSRF 防护）", () => {
  function targetErrorKind(value: string): string | undefined {
    try {
      assertSafeTargetUrl(value);
      return undefined;
    } catch (err) {
      return err instanceof A2AClientError ? err.kind : "other";
    }
  }

  it("rejects non-http(s) schemes", () => {
    expect(targetErrorKind("ftp://example.com/a2a")).toBe("unsafe_target");
    expect(targetErrorKind("file:///etc/passwd")).toBe("unsafe_target");
  });

  it("rejects userinfo in the URL", () => {
    expect(targetErrorKind("https://user:pass@example.com/a2a")).toBe("unsafe_target");
  });

  it("rejects cleartext HTTP to non-loopback hosts", () => {
    expect(targetErrorKind("http://example.com/a2a")).toBe("unsafe_target");
    expect(targetErrorKind("http://10.0.0.1/a2a")).toBe("unsafe_target");
  });

  it("allows loopback hosts over HTTP", () => {
    expect(targetErrorKind("http://127.0.0.1:8765/a2a")).toBeUndefined();
    expect(targetErrorKind("http://localhost:8765/a2a")).toBeUndefined();
    expect(targetErrorKind("http://[::1]:8765/a2a")).toBeUndefined();
    expect(targetErrorKind("https://127.0.0.1:8765/a2a")).toBeUndefined();
  });

  it("rejects private/reserved IP ranges over HTTPS", () => {
    expect(targetErrorKind("https://10.0.0.1/a2a")).toBe("unsafe_target");
    expect(targetErrorKind("https://192.168.1.1/a2a")).toBe("unsafe_target");
    expect(targetErrorKind("https://172.16.0.1/a2a")).toBe("unsafe_target");
    expect(targetErrorKind("https://169.254.169.254/latest/meta-data")).toBe("unsafe_target");
    expect(targetErrorKind("https://0.0.0.0/a2a")).toBe("unsafe_target");
  });

  it("rejects reserved metadata hostnames", () => {
    expect(targetErrorKind("https://metadata.google.internal/")).toBe("unsafe_target");
    expect(targetErrorKind("https://instance-data.ec2.internal/")).toBe("unsafe_target");
  });

  it("allows public HTTPS hosts", () => {
    expect(targetErrorKind("https://example.com/a2a")).toBeUndefined();
    expect(targetErrorKind("https://8.8.8.8/a2a")).toBeUndefined();
  });

  it("honors allowPrivateRanges as an explicit escape hatch", () => {
    expect(() =>
      assertSafeTargetUrl("https://10.0.0.1/a2a", { allowPrivateRanges: true }),
    ).not.toThrow();
    expect(() => new A2AClient({ url: "https://10.0.0.1/a2a" })).toThrowError(A2AClientError);
    expect(
      () => new A2AClient({ url: "https://10.0.0.1/a2a", allowPrivateRanges: true }),
    ).not.toThrow();
  });

  it("re-checks DNS-resolved addresses before connecting", async () => {
    const url = assertSafeTargetUrl("https://api.example.com/a2a");
    await expect(
      assertResolvableTargetUrl(url, { resolveIp: async () => ["93.184.216.34"] }),
    ).resolves.toBeUndefined();
    await expect(
      assertResolvableTargetUrl(url, { resolveIp: async () => ["10.0.0.5"] }),
    ).rejects.toMatchObject({ kind: "unsafe_target" });
    await expect(
      assertResolvableTargetUrl(url, { resolveIp: async () => ["192.168.1.10", "93.184.216.34"] }),
    ).rejects.toMatchObject({ kind: "unsafe_target" });
    await expect(
      assertResolvableTargetUrl(url, { resolveIp: async () => ["127.0.0.1"] }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the hostname cannot be resolved", async () => {
    const url = assertSafeTargetUrl("https://api.example.com/a2a");
    await expect(
      assertResolvableTargetUrl(url, {
        resolveIp: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toMatchObject({ kind: "unsafe_target" });
  });

  it("classifies IPv4/IPv6 reserved ranges", () => {
    expect(isReservedIpv4("10.0.0.1").reserved).toBe(true);
    expect(isReservedIpv4("192.168.1.1").reserved).toBe(true);
    expect(isReservedIpv4("172.16.5.5").reserved).toBe(true);
    expect(isReservedIpv4("100.64.0.1").reserved).toBe(true);
    expect(isReservedIpv4("8.8.8.8").reserved).toBe(false);
    expect(isReservedIpv6("::1").reserved).toBe(true);
    expect(isReservedIpv6("fe80::1").reserved).toBe(true);
    expect(isReservedIpv6("2001:db8::1").reserved).toBe(true);
    expect(isReservedIpv6("fc00::1").reserved).toBe(true);
    expect(isReservedIpv6("2606:4700::1111").reserved).toBe(false);
    // fe80::/10 全段（此前只覆盖 fe80-fe8f，fe90-febf 漏判）+ 废弃 site-local
    expect(isReservedIpv6("fe90::1").reserved).toBe(true);
    expect(isReservedIpv6("febf::1").reserved).toBe(true);
    expect(isReservedIpv6("fec0::1").reserved).toBe(true);
    expect(isReservedIpv6("feff::1").reserved).toBe(true);
    expect(isReservedIpv6("fe7f::1").reserved).toBe(false);
  });
});
