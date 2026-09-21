/**
 * T037「目录发现直连」：**用真实 socket 记账**证明询价不经过 Catalog。
 *
 * 架两个真实的本地 HTTP 服务器（真实 socket，但只在 loopback）：
 *   - **Catalog**：只提供公开读地址（名片 + 绑定声明），逐请求记账；
 *   - **Runtime**：真正的 A2A 端点，应答 JSON-RPC `SendMessage`，逐请求记账。
 *
 * Buyer 侧先用 `CloudCardSource` 解析（真实验签），再用仓库**真实的 `A2AClient`**
 * 向解析出的端点发一轮询价，然后断言：
 *   1. 解析阶段：Catalog 恰好收到 2 个请求（名片 + 绑定），Runtime 收到 0 个；
 *   2. 询价阶段：请求只落在 Runtime 的 `/a2a`，Catalog **一个请求都没再收到**；
 *   3. A2A 1.0 的方法名（`SendMessage`）与 KNP 扩展声明按 §13.1 锁定（不混用旧形状）；
 *   4. 凭据作用域分离：抓名片 / 抓绑定这一侧全程无凭据。
 *
 * 两个约束决定了本地集成怎么搭：
 *   - 绑定声明 schema **只允许 https**（正确约束：协议不允许明文 Runtime）；
 *   - 真实 socket 落在 loopback，TLS 用测试自签会有证书信任问题。
 *
 * 因此这里用 `TLS_SHIM` 只在**测试进程内**把 `https://127.0.0.1:<port>` 改写成
 * `http://127.0.0.1:<port>`（唯一的 shim，只降 TLS，不改目标主机与端口）。声明的
 * 密码学、请求记账、路由判定全部是真的——被断言的事实（询价落在哪台服务器）
 * 不受影响。
 *
 * `allowLoopbackTargets` 是**显式的受控本地集成开关**，生产必须保持 false——
 * 那正是 T035 的判定之一。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { A2AClient } from "../src/a2a/client/client.js";
import { CloudCardSource } from "../src/discovery/catalog-source/cloud-card.js";
import { buildBindingClaims } from "../src/trust/binding/claims.js";
import { signCompactJws, type JwsSigningIdentity } from "../src/trust/identity/jws.js";

const NOW = new Date("2026-09-21T08:00:00Z");
const ISSUER_KID = "catalog-issuer-t037";
const AGENT_ID = "cagt_t037";

const issuer = generateKeyPairSync("ed25519");
const issuerIdentity: JwsSigningIdentity = {
  keyid: ISSUER_KID,
  algorithm: "ed25519",
  privateKey: issuer.privateKey,
};

const issuerThumbprint = (() => {
  const jwk = issuer.publicKey.export({ format: "jwk" }) as {
    kty: string;
    crv: string;
    x: string;
  };
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
})();

/** 唯一的测试 shim：只把 https 降成 http，主机与端口原样保留。 */
function tlsShim(realFetch: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: { headers?: Record<string, string> }) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return realFetch(url.replace(/^https:\/\//, "http://"), init as Parameters<typeof fetch>[1]);
  }) as unknown as typeof fetch;
}

const localFetch = tlsShim(globalThis.fetch);

interface RequestLog {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

interface LocalServer {
  server: Server;
  origin: string;
  log: RequestLog[];
}

const opened: Server[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk as Buffer));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function startServer(
  handler: (request: IncomingMessage, body: string, response: ServerResponse) => void,
): Promise<LocalServer> {
  const log: RequestLog[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      log.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key.toLowerCase(),
            Array.isArray(value) ? value.join(",") : String(value ?? ""),
          ]),
        ),
        body,
      });
      handler(request, body, response);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  opened.push(server);
  const { port } = server.address() as AddressInfo;
  // origin 用 https 形式：绑定声明 schema 只允许 https（真实 socket 仍是本地 http，
  // 由 tlsShim 衔接）。断言里比对的就是这个带 https 的 origin。
  return { server, origin: `https://127.0.0.1:${port}`, log };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    ...headers,
  });
  response.end(payload);
}

describe("T037：目录发现直连（真实 socket 记账）", () => {
  it("询价不经过 Catalog：解析后所有 A2A 流量只落在 Runtime 端点", async () => {
    // ── Runtime：真正的 A2A 端点 ───────────────────────────────────
    const runtime = await startServer((_request, body, response) => {
      const rpc = JSON.parse(body || "{}") as { id?: unknown; method?: string };
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: rpc.id,
        // A2A 1.0 形状：result.task，状态用 1.0 wire 常量
        result: {
          task: {
            id: "task-t037",
            contextId: "ctx-t037",
            status: { state: "TASK_STATE_COMPLETED" },
            artifacts: [
              { artifactId: "a1", parts: [{ kind: "text", text: "quote: 11565" }] },
            ],
            metadata: { a2a_method: rpc.method },
          },
        },
      });
    });

    // ── Catalog：只有公开读地址，且响应里的 claims 由真钥匙签发 ──────
    let catalog!: LocalServer;
    const claims = buildBindingClaims({
      bindingId: "binding-t037",
      bindingVersion: 1,
      merchantId: "merchant-t037",
      agentId: AGENT_ID,
      workloadRef: "wbapp_t037",
      runtimeOrigin: runtime.origin,
      a2aEndpoint: `${runtime.origin}/a2a`,
      cardUrl: "https://catalog.example/v1/agents/cagt_t037/agent-card.json", // 下面按真实端口改写
      keyId: "runtime-key",
      keyThumbprint: `sha256:${"a".repeat(64)}`,
      serviceEpoch: 1,
      issuedAt: NOW.toISOString(),
      ttlSeconds: 900,
      issuer: "catalog.kiwi.t037",
    });
    const cardUrl = (origin: string): string =>
      `${origin}/v1/agents/${AGENT_ID}/agent-card.json`;

    catalog = await startServer((_request, _body, response) => {
      const path = _request.url ?? "";
      if (path === `/v1/agents/${AGENT_ID}/agent-card.json`) {
        sendJson(
          response,
          200,
          {
            name: "T037 Merchant Agent",
            description: "Merchant commerce negotiation agent",
            provider: { organization: "T037 Merchant" },
            version: "1.0.0",
            url: runtime.origin,
            supportedInterfaces: [
              { url: `${runtime.origin}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
            ],
          },
          { etag: '"t037-etag"' },
        );
        return;
      }
      if (path === `/v1/agents/${AGENT_ID}/runtime-binding`) {
        const bound = { ...claims, card_url: cardUrl(catalog.origin) };
        sendJson(response, 200, {
          claims: bound,
          claims_jws: signCompactJws(bound as unknown as Record<string, unknown>, issuerIdentity, {
            extraHeader: { typ: "kiwi-runtime-binding-claims" },
          }),
          issuer_kid: ISSUER_KID,
          issuer_thumbprint: issuerThumbprint,
          governance: { publication_state: "ACTIVE" },
          card_revision: 1,
          card_etag: '"t037-etag"',
        });
        return;
      }
      sendJson(response, 404, { ok: false, error: "not found" });
    });

    const source = new CloudCardSource({
      baseUrl: catalog.origin,
      trust: {
        resolveIssuerKey: (kid: string) => (kid === ISSUER_KID ? issuer.publicKey : undefined),
      },
      fetchImpl: localFetch,
      now: () => NOW,
      // 受控本地集成：真实 socket 但只在 loopback（生产必须保持 false）
      allowLoopbackTargets: true,
    });

    // ── 1) 解析阶段 ───────────────────────────────────────────────
    const resolved = await source.resolveCloudAgent(AGENT_ID);
    expect(resolved.endpoint).toBe(`${runtime.origin}/a2a`);
    expect(resolved.cardEtag).toBe('"t037-etag"');
    expect(catalog.log).toHaveLength(2);
    expect(runtime.log).toHaveLength(0);
    expect(catalog.log.map((entry) => entry.path).sort()).toEqual(
      [`/v1/agents/${AGENT_ID}/agent-card.json`, `/v1/agents/${AGENT_ID}/runtime-binding`].sort(),
    );

    const catalogRequestsAfterResolve = catalog.log.length;

    // ── 2) 询价阶段：真实 A2A client 直连解析出的端点 ──────────────
    const client = new A2AClient({
      url: resolved.endpoint,
      allowPrivateRanges: true,
      skipDnsCheck: true,
      fetchImpl: localFetch,
    });
    const task = await client.sendMessage({
      role: "user",
      messageId: "msg-t037",
      parts: [{ kind: "text", text: "请问 50 件多少钱？" }],
    });
    expect(task.id).toBe("task-t037");

    // 询价只落在 Runtime
    expect(runtime.log).toHaveLength(1);
    expect(runtime.log[0]?.path).toBe("/a2a");

    // A2A 1.0 形状（§13.1）：方法名与版本头、KNP 扩展声明
    const rpc = JSON.parse(runtime.log[0]?.body ?? "{}") as { method?: string };
    expect(rpc.method).toBe("SendMessage");
    expect(runtime.log[0]?.headers["a2a-version"]).toBe("1.0");
    expect(runtime.log[0]?.headers["a2a-extensions"]).toContain(
      "/a2a/extensions/negotiation/1.0",
    );

    // 解析完成后 Catalog 一个请求都没再收到——这就是"询价不经过 Catalog"
    expect(catalog.log).toHaveLength(catalogRequestsAfterResolve);

    // 凭据作用域分离：抓名片/抓绑定这一侧全程无凭据
    for (const entry of catalog.log) {
      expect(entry.headers["authorization"]).toBeUndefined();
      expect(entry.headers["cookie"]).toBeUndefined();
      expect(entry.headers["x-buyer-id"]).toBeUndefined();
    }
  });
});
