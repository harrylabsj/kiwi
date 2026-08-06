/**
 * UCP Profile 服务化 + UCP-Agent 宣告（WP3）端到端测试。
 *
 * 覆盖（基线 §25 / §25.1 / §8.3 / §43）：
 *   - GET /.well-known/ucp：200 + Cache-Control: public, max-age>=60（UCP 规范强制）、
 *     内容过 validateUcpProfile 自洽、含 a2a transport 与 vendor capability；
 *   - 未配置发布 → 404；非 GET → 405；
 *   - UCP-Agent 出站注入（A2AClient）→ 入站解析 → handler 可见（往返）；
 *   - 缺省（无 UCP-Agent 头）→ handler 收到 undefined，请求照常处理（不强制）；
 *   - RFC 8941 Dictionary 序列化/解析单测。
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import {
  A2AServer,
  buildUcpProfile,
  parseUcpAgentHeader,
  serializeUcpAgentHeader,
  UCP_AGENT_HEADER,
  WELL_KNOWN_UCP_PATH,
} from "../src/a2a/server/index.js";
import type { NegotiationHandler } from "../src/a2a/server/index.js";
import { A2AClient } from "../src/a2a/client/index.js";
import type { A2AMessage } from "../src/a2a/client/index.js";
import { validateUcpProfile } from "../src/discovery/ucp/index.js";
import { validEnvelopeFields } from "./negotiation-helpers.js";

const registry: Array<{ httpServer: http.Server; dir: string }> = [];

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function startServer(options: {
  ucp?: boolean | Record<string, unknown>;
  handler?: NegotiationHandler;
} = {}): Promise<{ url: string; server: A2AServer; httpServer: http.Server; dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-ucp-server-"));
  const ledger = new LedgerStore({ dir });
  const idempotency = new IdempotencyStore({ dir });
  // UCP profile 的 a2a endpoint 必须是 https（UCP 规范）→ 用逻辑 https baseUrl；
  // 实际 HTTP server 仍监听 127.0.0.1，client 往返打到真实地址。
  const server = new A2AServer({
    card: () => ({
      name: "Test Kiwi Merchant",
      description: "A2A test merchant agent",
      providerOrganization: "Kiwi Test Org",
      version: "0.5.0",
      baseUrl: "https://kiwi.test",
    }),
    ledger,
    idempotency,
    ...(options.handler !== undefined ? { handler: options.handler } : {}),
    ...(options.ucp !== undefined ? { ucp: options.ucp } : {}),
  });
  const httpServer = server.createServer();
  const url = await listen(httpServer);
  registry.push({ httpServer, dir });
  return { url, server, httpServer, dir };
}

function knpMessage(envelope: NegotiationEnvelope): A2AMessage {
  return {
    role: "agent",
    parts: [{ kind: "text", text: "test message" }, { kind: "data", data: { knp_envelope: envelope } }],
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

describe("A2A Server: GET /.well-known/ucp（UCP profile 服务化）", () => {
  it("发布 UCP profile：200 + Cache-Control public max-age>=60 + validate 自洽", async () => {
    const { url } = await startServer({ ucp: true });
    const res = await fetch(`${url}${WELL_KNOWN_UCP_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    // UCP 规范强制：Cache-Control 含 public 且 max-age>=60。
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl.toLowerCase()).toContain("public");
    const maxAge = /max-age\s*=\s*(\d+)/i.exec(cacheControl)?.[1];
    expect(Number(maxAge)).toBeGreaterThanOrEqual(60);

    // 内容过 validate 自洽（无条目被拒）。
    const body = (await res.json()) as Record<string, unknown>;
    const validation = validateUcpProfile(body);
    expect(validation.rejected).toEqual([]);
    expect(validation.profile.ucp.version).toBe("2026-04-08");

    // a2a transport → endpoint 指向本 server 的 Agent Card URL。
    const services = validation.profile.ucp.services as Record<string, unknown[]>;
    const a2a = (services?.["example.kiwi.shopping"] ?? [])[0] as Record<string, unknown>;
    expect(a2a.transport).toBe("a2a");
    expect(a2a.endpoint).toBe("https://kiwi.test/.well-known/agent-card.json");

    // 不声明任何 dev.ucp.* 官方 capability（该 namespace 由 UCP 治理机构保留）；
    // profile 只携带 Kiwi vendor capability example.kiwi.shopping.negotiation。
    const caps = validation.profile.ucp.capabilities as Record<string, unknown[]>;
    expect(caps).toEqual({ "example.kiwi.shopping.negotiation": expect.any(Array) });
    expect(Object.keys(caps).some((name) => name.startsWith("dev.ucp."))).toBe(false);
  });

  it("未配置发布 → 404；非 GET → 405", async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}${WELL_KNOWN_UCP_PATH}`);
    expect(res.status).toBe(404);

    const withUcp = await startServer({ ucp: true });
    const post = await fetch(`${withUcp.url}${WELL_KNOWN_UCP_PATH}`, { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("对象配置可覆盖 max-age（仍 >= 60）", async () => {
    const { url } = await startServer({ ucp: { maxAgeSeconds: 120 } });
    const res = await fetch(`${url}${WELL_KNOWN_UCP_PATH}`);
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl.toLowerCase()).toContain("public");
    expect(Number(/max-age\s*=\s*(\d+)/i.exec(cacheControl)?.[1])).toBe(120);
  });

  it("buildUcpProfile 拒绝 max-age < 60（fail-closed，不发坏 profile）", () => {
    expect(() =>
      buildUcpProfile(
        {
          name: "x",
          description: "x",
          providerOrganization: "x",
          version: "1.0",
          baseUrl: "https://kiwi.test",
        },
        { maxAgeSeconds: 30 },
      ),
    ).toThrow(/max-age/);
  });
});

describe("UCP-Agent 宣告（§25.1）—— 出站注入 + 入站解析往返", () => {
  it("client 配置 ucpAgentProfile → 出站带 RFC 8941 Dictionary 头 → server handler 可见", async () => {
    let seen: string | undefined;
    const { url } = await startServer({
      handler: {
        name: "ucp-agent-capture",
        async handle(ctx) {
          seen = ctx.ucpAgentProfile;
          return { kind: "accepted", taskState: "completed" };
        },
      },
    });
    const client = new A2AClient({
      url: `${url}/`,
      ucpAgentProfile: "https://buyer.example/.well-known/ucp",
    });
    await client.sendMessage(knpMessage(finalizeEnvelope(validEnvelopeFields())), "ctx");

    expect(seen).toBe("https://buyer.example/.well-known/ucp");
  });

  it("缺省（无 UCP-Agent 头）→ handler 收到 undefined，请求照常处理（不强制）", async () => {
    let seen: string | undefined = "unset";
    const { url } = await startServer({
      handler: {
        name: "no-ucp-agent",
        async handle(ctx) {
          seen = ctx.ucpAgentProfile;
          return { kind: "accepted", taskState: "completed" };
        },
      },
    });
    const client = new A2AClient({ url: `${url}/` });
    await client.sendMessage(knpMessage(finalizeEnvelope(validEnvelopeFields())), "ctx");

    expect(seen).toBeUndefined();
  });

  it("畸形 UCP-Agent 头 → 解析为 undefined，不拒绝请求", async () => {
    let seen: string | undefined = "unset";
    const { url } = await startServer({
      handler: {
        name: "malformed-ucp-agent",
        async handle(ctx) {
          seen = ctx.ucpAgentProfile;
          return { kind: "accepted", taskState: "completed" };
        },
      },
    });
    const res = await fetch(`${url}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [UCP_AGENT_HEADER]: "not-a-dictionary",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "message/send",
        params: { message: knpMessage(finalizeEnvelope(validEnvelopeFields())) },
      }),
    });
    expect(res.status).toBe(200);
    expect(seen).toBeUndefined();
  });
});

describe("UCP-Agent 头（RFC 8941）纯函数", () => {
  it("serializeUcpAgentHeader 产出 Dictionary 语法", () => {
    expect(serializeUcpAgentHeader("https://buyer.example/.well-known/ucp")).toBe(
      'profile="https://buyer.example/.well-known/ucp"',
    );
  });

  it("parseUcpAgentHeader 提取 profile 成员，忽略其他成员与参数", () => {
    expect(parseUcpAgentHeader('profile="https://buyer.example/.well-known/ucp"')).toBe(
      "https://buyer.example/.well-known/ucp",
    );
    expect(
      parseUcpAgentHeader('other=1, profile="https://x.example/.well-known/ucp";foo=bar'),
    ).toBe("https://x.example/.well-known/ucp");
    expect(parseUcpAgentHeader(undefined)).toBeUndefined();
    expect(parseUcpAgentHeader("")).toBeUndefined();
    expect(parseUcpAgentHeader("foo=1")).toBeUndefined();
  });

  it("serialize → parse 往返一致（含需要转义的 URI）", () => {
    const header = serializeUcpAgentHeader('https://buyer.example/.well-known/ucp?tag="a"');
    expect(parseUcpAgentHeader(header)).toBe('https://buyer.example/.well-known/ucp?tag="a"');
  });
});
