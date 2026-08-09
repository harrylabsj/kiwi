/**
 * AgentDiscovery.resolve 测试（基线 §33）。
 *
 * 覆盖：
 *   - agentCardUrl：fetch → parseAgentCard（结构 + secret 扫描）→ capability
 *     intersection → CounterpartyProfile + channel candidates；
 *   - domain：well-known Agent Card 路径（`https://<domain>/.well-known/agent-card.json`）；
 *   - capability intersection：A2A 可用 → direct 候选；不兼容但配置了 hosted → hosted；
 *   - 无可用候选 → DiscoveryError（fail-closed，§4.6）；
 *   - Agent Card 含静态 secret → card_has_secret（不变量 24）；
 *   - fetch 失败 / 非法输入 → fail-closed。
 */
import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AgentDiscovery } from "../src/discovery/index.js";
import { selectChannelCandidate } from "../src/counterparty/index.js";

const servers: http.Server[] = [];

function agentCardJson(baseUrl: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Acme Merchant",
    description: "test merchant",
    provider: { organization: "Acme", url: "https://acme.example" },
    version: "1.0",
    url: baseUrl,
    supportedInterfaces: [
      { url: `${baseUrl}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    capabilities: {
      extendedAgentCard: true,
      extensions: [
        { uri: "https://kiwi.harrylabsj.com/a2a/extensions/negotiation/1.0", required: false },
      ],
    },
    ...overrides,
  };
}

async function serveCard(body: unknown): Promise<string> {
  const payload = JSON.stringify(body);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  servers.push(server);
  return `http://127.0.0.1:${addr.port}`;
}

describe("AgentDiscovery.resolve: agentCardUrl", () => {
  it("拉取并校验 Agent Card，产出 profile + direct 候选", async () => {
    const base = await serveCard(agentCardJson("http://127.0.0.1:1"));
    const discovery = new AgentDiscovery();
    const profile = await discovery.resolve({ agentCardUrl: `${base}/card.json` });

    expect(profile.identity).toBe("Acme");
    expect(profile.source).toBe(`card:${base}/card.json`);
    expect(profile.agent_card.name).toBe("Acme Merchant");
    expect(profile.intersection.compatible).toBe(true);
    expect(profile.intersection.selected?.url).toBe("http://127.0.0.1:1/a2a");
    expect(profile.channel_candidates).toContainEqual({
      kind: "a2a-direct",
      url: "http://127.0.0.1:1/a2a",
    });
    expect(selectChannelCandidate(profile)?.kind).toBe("a2a-direct");
  });

  it("A2A 不兼容但配置了 hosted → hosted 候选被选中", async () => {
    const base = await serveCard(
      agentCardJson("http://127.0.0.1:1", {
        supportedInterfaces: [
          { url: "http://127.0.0.1:1/a2a", protocolBinding: "GRPC", protocolVersion: "1.0" },
        ],
      }),
    );
    const discovery = new AgentDiscovery({ hosted: { configured: true, config_id: "local" } });
    const profile = await discovery.resolve({ agentCardUrl: `${base}/card.json` });

    expect(profile.intersection.compatible).toBe(false);
    expect(profile.channel_candidates).toContainEqual({ kind: "shopping-cli-hosted", config_id: "local" });
    expect(selectChannelCandidate(profile)?.kind).toBe("shopping-cli-hosted");
  });

  it("A2A 可用且 hosted 已配置 → direct 优先（候选顺序 direct → hosted）", async () => {
    const base = await serveCard(agentCardJson("http://127.0.0.1:1"));
    const discovery = new AgentDiscovery({ hosted: { configured: true, config_id: "local" } });
    const profile = await discovery.resolve({ agentCardUrl: `${base}/card.json` });

    expect(profile.channel_candidates.map((c) => c.kind)).toEqual(["a2a-direct", "shopping-cli-hosted"]);
    expect(selectChannelCandidate(profile)?.kind).toBe("a2a-direct");
  });

  it("无兼容 A2A 且未配置 hosted/platform → fail-closed（no_channel_candidate）", async () => {
    const base = await serveCard(
      agentCardJson("http://127.0.0.1:1", {
        supportedInterfaces: [
          { url: "http://127.0.0.1:1/a2a", protocolBinding: "GRPC", protocolVersion: "1.0" },
        ],
      }),
    );
    const discovery = new AgentDiscovery();
    await expect(discovery.resolve({ agentCardUrl: `${base}/card.json` })).rejects.toMatchObject({
      code: "no_channel_candidate",
    });
  });

  it("Agent Card 含静态 secret → card_has_secret（不变量 24）", async () => {
    const base = await serveCard(
      agentCardJson("http://127.0.0.1:1", { api_key: "sk_live_1234567890abcdef" }),
    );
    const discovery = new AgentDiscovery();
    await expect(discovery.resolve({ agentCardUrl: `${base}/card.json` })).rejects.toMatchObject({
      code: "card_has_secret",
    });
  });

  it("fetch 失败 → card_fetch_failed（fail-closed）", async () => {
    const discovery = new AgentDiscovery();
    await expect(
      discovery.resolve({ agentCardUrl: "http://127.0.0.1:1/nope.json" }),
    ).rejects.toMatchObject({ code: "card_fetch_failed" });
  });

  it("远程 Agent Card 不得把 direct 候选指向 loopback（SSRF）", async () => {
    const card = agentCardJson("http://127.0.0.1:8765");
    const discovery = new AgentDiscovery({
      skipDnsCheck: true,
      fetchImpl: async () => new globalThis.Response(JSON.stringify(card), { status: 200 }),
    });
    await expect(
      discovery.resolve({ agentCardUrl: "https://remote.example/.well-known/agent-card.json" }),
    ).rejects.toMatchObject({ code: "no_channel_candidate" });
  });

  it("非法输入：domain 与 agentCardUrl 同时提供 → invalid_input", async () => {
    const discovery = new AgentDiscovery();
    await expect(
      discovery.resolve({ domain: "acme.example", agentCardUrl: "http://127.0.0.1:1/card.json" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("非法输入：两者都缺 → invalid_input", async () => {
    const discovery = new AgentDiscovery();
    await expect(discovery.resolve({})).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("AgentDiscovery.resolve: domain", () => {
  it("domain → UCP 优先，失败回退 well-known Agent Card（双发现入口，WP3）", async () => {
    const captured: string[] = [];
    const card = agentCardJson("https://merchant.example/a2a");
    const discovery = new AgentDiscovery({
      fetchImpl: async (url, _init) => {
        captured.push(String(url));
        return new globalThis.Response(JSON.stringify(card), { status: 200 });
      },
      // skipDnsCheck 让 UCP 尝试确定性到达注入的 fetchImpl（返回的 Response 无
      // Cache-Control 头 → profile_cache_control → 回退，同时验证 discovery 路径
      // 上 UCP Cache-Control 强制生效）。
      ucp: { resolver: { skipDnsCheck: true } },
      // fetchCard 的 SSRF DNS 复查同样跳过（注入的 fetchImpl 是测试替身，
      // merchant.example 在测试环境 DNS 解析到保留网段，非真实目标）。
      skipDnsCheck: true,
    });
    const profile = await discovery.resolve({ domain: "merchant.example" });

    expect(captured).toEqual([
      "https://merchant.example/.well-known/ucp",
      "https://merchant.example/.well-known/agent-card.json",
    ]);
    expect(profile.source).toBe("domain:merchant.example");
    expect(profile.ucp_fallback_reason).toContain("ucp:profile_cache_control");
    expect(selectChannelCandidate(profile)?.kind).toBe("a2a-direct");
  });

  it("ucp.disabled: true → 保持 v0.5 行为（直接 well-known Agent Card）", async () => {
    const captured: string[] = [];
    const card = agentCardJson("https://merchant.example/a2a");
    const discovery = new AgentDiscovery({
      fetchImpl: async (url, _init) => {
        captured.push(String(url));
        return new globalThis.Response(JSON.stringify(card), { status: 200 });
      },
      ucp: { disabled: true },
      skipDnsCheck: true, // 同上：注入的 fetchImpl 测试替身
    });
    const profile = await discovery.resolve({ domain: "merchant.example" });

    expect(captured).toEqual(["https://merchant.example/.well-known/agent-card.json"]);
    expect(profile.ucp_fallback_reason).toBeUndefined();
    expect(profile.ucp_profile).toBeUndefined();
    expect(profile.ucp_intersection).toBeUndefined();
  });
});

afterAll(async () => {
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
