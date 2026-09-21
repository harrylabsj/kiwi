/**
 * M3 / C2「Buyer 发现流程接入」：search → canonical Card URL → 取原始 Card
 * （**独立凭据作用域**）→ 验绑定 → 比对元组 → 直连 A2A。
 *
 * 覆盖两条纪律：
 *   1. 候选的 `agent_card_url` 指向 Catalog 稳定读地址时，**必须**经
 *      `CloudCardSource` 验签才能升级为可信档案；未配置 cloud 来源时该候选被
 *      **跳过**（fail-closed），绝不把"目录里读到的名片"当成已验证身份；
 *   2. 抓这类公开读地址**不带任何凭据**——即便 `deps.headers` 配了商家出站令牌
 *      （设计 §12.2：抓 Card / 抓绑定 / 访问 Runtime 的凭据作用域分离）。
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AgentDiscovery } from "../src/discovery/resolve.js";
import { isCatalogHostedCardUrl } from "../src/discovery/resolve.js";
import { CloudCardSource } from "../src/discovery/catalog-source/cloud-card.js";
import { buildBindingClaims } from "../src/trust/binding/claims.js";
import { signCompactJws, type JwsSigningIdentity } from "../src/trust/identity/jws.js";
import type { CandidateAgent } from "../src/discovery/catalog-source/index.js";

const NOW = new Date("2026-09-21T08:00:00Z");
const CATALOG = "https://catalog.example";
const ISSUER_KID = "catalog-issuer-c2";
const RUNTIME = "https://pilot.example.app.workbuddy.host";
const A2A_ENDPOINT = `${RUNTIME}/a2a`;
const AGENT_ID = "cagt_cloud_c2";
const CARD_URL = `${CATALOG}/v1/agents/${AGENT_ID}/agent-card.json`;

const issuer = generateKeyPairSync("ed25519");
const issuerIdentity: JwsSigningIdentity = {
  keyid: ISSUER_KID,
  algorithm: "ed25519",
  privateKey: issuer.privateKey,
};

const claims = buildBindingClaims({
  bindingId: "binding-c2",
  bindingVersion: 1,
  merchantId: "merchant-c2",
  agentId: AGENT_ID,
  workloadRef: "wbapp_c2",
  runtimeOrigin: RUNTIME,
  a2aEndpoint: A2A_ENDPOINT,
  cardUrl: CARD_URL,
  keyId: RUNTIME,
  keyThumbprint: `sha256:${"a".repeat(64)}`,
  serviceEpoch: 1,
  issuedAt: NOW.toISOString(),
  ttlSeconds: 900,
  issuer: "catalog.kiwi.c2",
});

const CARD = {
  name: "C2 Cloud Merchant Agent",
  description: "Merchant commerce negotiation agent",
  provider: { organization: "C2 Merchant" },
  version: "1.0.0",
  url: RUNTIME,
  supportedInterfaces: [
    { url: A2A_ENDPOINT, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
};

function candidate(agentCardUrl: string): CandidateAgent {
  return {
    catalog_agent_id: AGENT_ID,
    verification: { status: "discovered" },
    hosting: { mode: "direct_only" },
    contract: { name: "candidate-agent", version: "1.0" },
    merchant: { id: "merchant-c2", name: "C2 Merchant" },
    discovery: { agent_card_url: agentCardUrl },
  } as unknown as CandidateAgent;
}

interface Capture {
  calls: Array<{ url: string; headers: Record<string, string> }>;
}

function catalogFetch(capture: Capture): typeof fetch {
  return (async (input: string | URL | Request, init?: { headers?: Record<string, string> }) => {
    const url = typeof input === "string" ? input : input.toString();
    capture.calls.push({
      url,
      headers: Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
    });
    if (url === CARD_URL) {
      return new Response(JSON.stringify(CARD), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"c2-etag"' },
      });
    }
    if (url === `${CATALOG}/v1/agents/${AGENT_ID}/runtime-binding`) {
      return new Response(
        JSON.stringify({
          claims,
          claims_jws: signCompactJws(claims as unknown as Record<string, unknown>, issuerIdentity, {
            extraHeader: { typ: "kiwi-runtime-binding-claims" },
          }),
          issuer_kid: ISSUER_KID,
          issuer_thumbprint: "",
          governance: { publication_state: "ACTIVE" },
          card_revision: 1,
          card_etag: '"c2-etag"',
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404 });
  }) as unknown as typeof fetch;
}

function discoveryWith(capture: Capture, withCloud: boolean): AgentDiscovery {
  const cloud = new CloudCardSource({
    baseUrl: CATALOG,
    trust: {
      resolveIssuerKey: (kid: string) => (kid === ISSUER_KID ? issuer.publicKey : undefined),
    },
    fetchImpl: catalogFetch(capture),
    now: () => NOW,
  });
  return new AgentDiscovery({
    fetchImpl: catalogFetch(capture),
    // 商家出站凭据：**绝不能**出现在 Catalog 公开读地址的请求里
    headers: { authorization: "Bearer merchant-outbound-token" },
    skipDnsCheck: true,
    catalog: {
      source: {
        searchCandidates: async () => [candidate(CARD_URL)],
        getCandidate: async () => candidate(CARD_URL),
      },
      ...(withCloud ? { cloud } : {}),
    },
  });
}

describe("C2：目录发现接入云端名片（验签 + 独立凭据作用域）", () => {
  it("云端候选经绑定验签后升级为档案，端点由声明背书", async () => {
    const capture: Capture = { calls: [] };
    const results = await discoveryWith(capture, true).resolveViaCatalog();
    expect(results).toHaveLength(1);
    const profile = results[0]?.profile;
    expect(profile?.agent_card.name).toBe("C2 Cloud Merchant Agent");
    expect(profile?.source).toBe(`catalog-card:${CARD_URL}`);
    // 直连候选指向 Runtime 端点，而不是 Catalog
    expect(profile?.channel_candidates.some((c) => c.kind === "a2a-direct")).toBe(true);
  });

  it("抓公开读地址**不带任何凭据**（即便配了商家出站令牌）", async () => {
    const capture: Capture = { calls: [] };
    await discoveryWith(capture, true).resolveViaCatalog();
    expect(capture.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of capture.calls) {
      expect(call.headers["authorization"]).toBeUndefined();
    }
    // 反向确认测试有效：同一 discovery 的**非 Catalog** 路径仍会带令牌
    const otherCapture: Capture = { calls: [] };
    const plain = new AgentDiscovery({
      fetchImpl: (async (input: string | URL | Request, init?: { headers?: Record<string, string> }) => {
        const url = typeof input === "string" ? input : input.toString();
        otherCapture.calls.push({
          url,
          headers: Object.fromEntries(
            Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
          ),
        });
        return new Response(JSON.stringify(CARD), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
      headers: { authorization: "Bearer merchant-outbound-token" },
      skipDnsCheck: true,
    });
    await plain.resolve({ agentCardUrl: `${RUNTIME}/.well-known/agent-card.json` });
    expect(otherCapture.calls[0]?.headers["authorization"]).toBe(
      "Bearer merchant-outbound-token",
    );
  });

  it("未配置 cloud 来源 → 云端候选被跳过（fail-closed，不当作已验证）", async () => {
    const capture: Capture = { calls: [] };
    const results = await discoveryWith(capture, false).resolveViaCatalog();
    expect(results).toEqual([]);
    // 跳过意味着连抓都不抓——绝不"先抓下来再说"
    expect(capture.calls).toEqual([]);
  });

  it("候选的 card URL 落在别的 origin → 拒绝（不跟着候选换信任根）", async () => {
    const capture: Capture = { calls: [] };
    const discovery = new AgentDiscovery({
      fetchImpl: catalogFetch(capture),
      skipDnsCheck: true,
      catalog: {
        source: {
          searchCandidates: async () => [candidate(`https://evil.example/v1/agents/${AGENT_ID}/agent-card.json`)],
          getCandidate: async () => candidate(CARD_URL),
        },
        cloud: new CloudCardSource({
          baseUrl: CATALOG,
          trust: { resolveIssuerKey: () => issuer.publicKey },
          fetchImpl: catalogFetch(capture),
          now: () => NOW,
        }),
      },
    });
    await expect(discovery.resolveViaCatalog()).rejects.toThrow(/configured catalog origin/);
    expect(capture.calls).toEqual([]);
  });

  it("稳定读地址的识别是路径形状（不靠端口/主机名硬编码）", () => {
    expect(isCatalogHostedCardUrl(`${CATALOG}/v1/agents/cagt_x/agent-card.json`)).toBe(true);
    expect(isCatalogHostedCardUrl("https://other.example/v1/agents/cagt_x/agent-card.json")).toBe(true);
    expect(isCatalogHostedCardUrl(`${RUNTIME}/.well-known/agent-card.json`)).toBe(false);
    expect(isCatalogHostedCardUrl(`${CATALOG}/v1/agents/cagt_x/ucp`)).toBe(false);
    expect(isCatalogHostedCardUrl("not a url")).toBe(false);
  });
});
