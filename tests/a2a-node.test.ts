/**
 * A2A node 启动接线测试（评审项 H2：裸 kiwi 自动启动的节点生命周期此前
 * 零覆盖——端口抢占、merchant 自动注册进 kiwi-catalog 的编排无回归网；
 * 其依赖的原始能力 registerCatalogAgent 由 catalog-register.test.ts 覆盖）。
 *
 * 真实 node:http：mock catalog 注册端点 + 真实 A2AServer 监听。
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startA2aNode } from "../src/a2a/node.js";
import { NoneAuthVerifier } from "../src/a2a/server/index.js";
import { testProfile } from "./helpers.js";

interface MockCatalog {
  server: http.Server;
  url: string;
  registrations: Array<{ method: string; path: string; body: Record<string, unknown> }>;
}

const servers: http.Server[] = [];

function startCatalog(): Promise<MockCatalog> {
  const registrations: MockCatalog["registrations"] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      if (req.method === "POST" && req.url?.includes("/agents/register")) {
        registrations.push({ method: req.method, path: req.url, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            catalog_agent: { catalog_agent_id: "agent-1", status: "discovered" },
            verification_enqueued: true,
            idempotent: false,
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no route" }));
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, registrations });
    });
  });
}

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.length = 0;
});

describe("startA2aNode（启动接线）", () => {
  it("merchant 节点启动 → 自动注册进 catalog → agent-card 可 fetch → stop 清理", async () => {
    const catalog = await startCatalog();
    const node = await startA2aNode({
      profile: testProfile(),
      catalog: catalog.url,
      preferredPort: 0, // 随机端口（真实节点监听 127.0.0.1）
    });
    try {
      expect(node.role).toBe("merchant");
      expect(node.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // 自动注册：mock catalog 收到注册请求并返回 catalog_agent_id
      expect(node.catalogAgentId).toBe("agent-1");
      expect(catalog.registrations).toHaveLength(1);
      const reg = catalog.registrations[0];
      expect(reg?.method).toBe("POST");
      expect(reg?.body.agent_card_url).toBe(node.agentCardUrl);
      // Agent Card well-known 端点真实可 fetch
      const card = await fetch(node.agentCardUrl);
      expect(card.ok).toBe(true);
      const cardJson = (await card.json()) as { name?: string };
      expect(cardJson.name).toBeDefined();
      // 节点可服务 A2A message/send（merchant handler 响应 decline）
      const send = await fetch(node.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1", // A2A 协议：id 必须是字符串
          method: "message/send",
          params: { message: { role: "agent", parts: [{ kind: "text", text: "hi" }], messageId: "m1" } },
        }),
      });
      expect(send.ok).toBe(true);
      const body = (await send.json()) as { error?: { code?: number } };
      expect(body.error?.code).toBeDefined(); // 无 KNP envelope → 协议错误（fail-closed，不崩溃）
    } finally {
      await node.stop();
    }
  });

  it("buyer 节点不注册 catalog；无 catalog 的 merchant 节点正常启动且不注册", async () => {
    const catalog = await startCatalog();
    const buyer = await startA2aNode({
      profile: testProfile({ role: "buyer" }),
      catalog: catalog.url,
      preferredPort: 0,
    });
    expect(buyer.catalogAgentId).toBeUndefined();
    expect(catalog.registrations).toHaveLength(0);
    await buyer.stop();

    const merchant = await startA2aNode({ profile: testProfile(), preferredPort: 0 });
    expect(merchant.catalogAgentId).toBeUndefined();
    await merchant.stop();
  });

  it("publicBaseUrl 覆盖：节点仍监听回环，但 card/注册/ucp 广告公网地址", async () => {
    const savedDomain = process.env.KIWI_CATALOG_DOMAIN;
    delete process.env.KIWI_CATALOG_DOMAIN;
    const catalog = await startCatalog();
    const publicUrl = "https://veyquo.example";
    const node = await startA2aNode({
      profile: testProfile(),
      catalog: catalog.url,
      preferredPort: 0,
      publicBaseUrl: publicUrl,
      // 审查 BUG-02：公网广告形态必须显式认证（本测试验证广告 URL 接线，
      // 不是认证门——认证门见 a2a-node-guard.test.ts）
      authVerifier: new NoneAuthVerifier(),
    });
    try {
      // 对外广告地址与 agent card URL 用公网地址；实际监听仍是回环。
      expect(node.advertisedUrl).toBe(publicUrl);
      expect(node.agentCardUrl).toBe(`${publicUrl}/.well-known/agent-card.json`);
      expect(node.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // 注册体广告公网 card/ucp；域名派生自 publicBaseUrl 的 hostname。
      expect(catalog.registrations).toHaveLength(1);
      const reg = catalog.registrations[0];
      expect(reg?.body.agent_card_url).toBe(`${publicUrl}/.well-known/agent-card.json`);
      expect(reg?.body.ucp_profile_url).toBe(`${publicUrl}/.well-known/ucp`);
      expect(reg?.body.domain).toBe("veyquo.example");
      // card 内容广告公网 baseUrl（buyer 拿到 card 后据此发 A2A）。
      const card = await fetch(`${node.url}/.well-known/agent-card.json`);
      expect(card.ok).toBe(true);
      const cardJson = (await card.json()) as { url?: string };
      expect(cardJson.url).toBe(publicUrl);
      // UCP Profile 端点真实可拉（注册广告了 ucp_profile_url，端点必须存在，
      // 否则 catalog 验证 profile 阶段拉 UCP 404 → freshness=unreachable）。
      // 形状为标准 UCP（specificationVersion，对齐 kiwi-catalog 验证器）。
      const ucp = await fetch(`${node.url}/.well-known/ucp`);
      expect(ucp.ok).toBe(true);
      // 审查 P1-03：UCP profile 为 canonical 形状（ucp:{version,services,capabilities}），
      // 不再有规范外顶层 specificationVersion 字段。
      const ucpJson = (await ucp.json()) as { ucp?: { version?: string } };
      expect(ucpJson.ucp?.version).toBe("2026-04-08");
      // 本地回环 A2A 端点仍服务。
      const send = await fetch(node.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "message/send",
          params: {
            message: { role: "agent", parts: [{ kind: "text", text: "hi" }], messageId: "m1" },
          },
        }),
      });
      expect(send.ok).toBe(true);
      const body = (await send.json()) as { error?: { code?: number } };
      expect(body.error?.code).toBeDefined();
    } finally {
      if (savedDomain === undefined) delete process.env.KIWI_CATALOG_DOMAIN;
      else process.env.KIWI_CATALOG_DOMAIN = savedDomain;
      await node.stop();
    }
  });

  // ── 审查 P1-08：publicBaseUrl 只接受 HTTPS origin ─────────────────────────
  it("publicBaseUrl 拒绝远程 http（仅 HTTPS origin）", async () => {
    await expect(
      startA2aNode({
        profile: testProfile(),
        preferredPort: 0,
        publicBaseUrl: "http://veyquo.example",
        authVerifier: new NoneAuthVerifier(),
      }),
    ).rejects.toThrow(/必须是 https/);
  });

  it("publicBaseUrl 拒绝 userinfo / path / query / fragment", async () => {
    await expect(
      startA2aNode({
        profile: testProfile(),
        preferredPort: 0,
        publicBaseUrl: "https://user:pass@veyquo.example",
        authVerifier: new NoneAuthVerifier(),
      }),
    ).rejects.toThrow(/不得内嵌凭据/);
    await expect(
      startA2aNode({
        profile: testProfile(),
        preferredPort: 0,
        publicBaseUrl: "https://veyquo.example/shop",
        authVerifier: new NoneAuthVerifier(),
      }),
    ).rejects.toThrow(/不得包含路径/);
    await expect(
      startA2aNode({
        profile: testProfile(),
        preferredPort: 0,
        publicBaseUrl: "https://veyquo.example?x=1",
        authVerifier: new NoneAuthVerifier(),
      }),
    ).rejects.toThrow(/query\/fragment/);
    await expect(
      startA2aNode({
        profile: testProfile(),
        preferredPort: 0,
        publicBaseUrl: "https://veyquo.example#top",
        authVerifier: new NoneAuthVerifier(),
      }),
    ).rejects.toThrow(/query\/fragment/);
  });

  it("publicBaseUrl 拒绝裸 hostname（无 scheme）", async () => {
    await expect(
      startA2aNode({
        profile: testProfile(),
        preferredPort: 0,
        publicBaseUrl: "veyquo.example",
        authVerifier: new NoneAuthVerifier(),
      }),
    ).rejects.toThrow(/不是合法 URL/);
  });

  it("无显式 publicBaseUrl → 回环自动 URL 保持 http（本地形态）", async () => {
    const savedPublic = process.env.KIWI_A2A_PUBLIC_URL;
    delete process.env.KIWI_A2A_PUBLIC_URL;
    try {
      const node = await startA2aNode({ profile: testProfile(), preferredPort: 0 });
      try {
        expect(node.advertisedUrl.startsWith("http://127.0.0.1:")).toBe(true);
        expect(node.advertisedUrl).toBe(node.url);
      } finally {
        await node.stop();
      }
    } finally {
      if (savedPublic === undefined) delete process.env.KIWI_A2A_PUBLIC_URL;
      else process.env.KIWI_A2A_PUBLIC_URL = savedPublic;
    }
  });
});
