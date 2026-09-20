/**
 * M3 / T039–T042：Buyer 侧解析云端托管名片（`CloudCardSource`）。
 *
 * 覆盖设计 v0.1.2 §12.1 的读侧契约：
 *   - 公开读地址 + 绑定声明的**独立凭据范围**：两个读请求都不带任何凭据；
 *   - 声明必须描述"Buyer 实际连的那个商家"：card_url / a2a_endpoint 逐项比对；
 *   - 信任根来自本地预配置：未知 kid 拒绝，且不发出任何"去取信任根"的请求；
 *   - 失败一律 fail-closed（含 Catalog 不可用），不返回"部分可信"的结果；
 *   - 信任缓存按 (来源, agentId, card revision, binding_version, 端点) 索引，
 *     有效期不长于声明自身。
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { CloudBindingTrustCache, CloudCardSource } from "../src/discovery/catalog-source/cloud-card.js";
import type { CloudAgentResolution } from "../src/discovery/catalog-source/cloud-card.js";
import { BindingRejectionError, CatalogSourceError } from "../src/discovery/catalog-source/index.js";
import {
  describeCloudHosting,
  legacyHostingModeForCloudAgent,
} from "../src/discovery/catalog-source/cloud-hosting.js";
import { normalizeHostingMode } from "../src/discovery/catalog-source/types.js";
import { buildBindingClaims } from "../src/trust/binding/claims.js";
import { publicKeyThumbprint, jwkThumbprint } from "../src/trust/binding/thumbprint.js";
import { signCompactJws, type JwsSigningIdentity } from "../src/trust/identity/jws.js";

const NOW = new Date("2026-09-21T08:00:00Z");
const CATALOG = "https://catalog.example";
const ISSUER_KID = "catalog-issuer-2026";
const RUNTIME_ORIGIN = "https://pilot.example.app.workbuddy.host";
const A2A_ENDPOINT = `${RUNTIME_ORIGIN}/a2a`;
const AGENT_ID = "cagt_cloud_001";
const CARD_URL = `${CATALOG}/v1/agents/${AGENT_ID}/agent-card.json`;
const CARD_ETAG = '"card-etag-1"';

const issuer = generateKeyPairSync("ed25519");
const issuerIdentity: JwsSigningIdentity = {
  keyid: ISSUER_KID,
  algorithm: "ed25519",
  privateKey: issuer.privateKey,
};
const ISSUER_THUMBPRINT = publicKeyThumbprint(issuer.publicKey);

/** 本地预配置的信任存储（kid → 公钥）——绝不由网络内容生成。 */
function trust() {
  return {
    resolveIssuerKey: (kid: string) =>
      kid === ISSUER_KID ? issuer.publicKey : undefined,
  };
}

function claims(overrides: Record<string, unknown> = {}) {
  return buildBindingClaims({
    bindingId: "binding-cloud-001",
    bindingVersion: 3,
    merchantId: "merchant-pilot-001",
    agentId: AGENT_ID,
    workloadRef: "wbapp_DAT3jOAJ",
    runtimeOrigin: RUNTIME_ORIGIN,
    a2aEndpoint: A2A_ENDPOINT,
    cardUrl: CARD_URL,
    keyId: RUNTIME_ORIGIN,
    keyThumbprint: `sha256:${"a".repeat(64)}`,
    serviceEpoch: 7,
    issuedAt: NOW.toISOString(),
    ttlSeconds: 900,
    issuer: "catalog.kiwi.example",
    ...overrides,
  });
}

function signClaims(value: object): string {
  return signWith(issuerIdentity, value);
}

function signWith(identity: JwsSigningIdentity, value: object): string {
  return signCompactJws(value as Record<string, unknown>, identity, {
    extraHeader: { typ: "kiwi-runtime-binding-claims" },
  });
}

function card(extra: Record<string, unknown> = {}) {
  return {
    name: "Cloud Merchant Agent",
    description: "Merchant commerce negotiation agent",
    provider: { organization: "Cloud Merchant" },
    version: "1.0.0",
    url: RUNTIME_ORIGIN,
    supportedInterfaces: [
      { url: A2A_ENDPOINT, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    ...extra,
  };
}

function bindingDocument(overrides: Record<string, unknown> = {}) {
  const claimSet = (overrides["claims"] as Record<string, unknown>) ?? claims();
  return {
    claims: claimSet,
    claims_jws: (overrides["claims_jws"] as string) ?? signClaims(claimSet),
    issuer_kid: (overrides["issuer_kid"] as string) ?? ISSUER_KID,
    issuer_thumbprint: (overrides["issuer_thumbprint"] as string) ?? ISSUER_THUMBPRINT,
    governance: (overrides["governance"] as unknown) ?? { publication_state: "ACTIVE" },
    card_revision: (overrides["card_revision"] as number | null) ?? 4,
    card_etag: (overrides["card_etag"] as string | null) ?? CARD_ETAG,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) =>
          ![
            "claims",
            "claims_jws",
            "issuer_kid",
            "issuer_thumbprint",
            "governance",
            "card_revision",
            "card_etag",
          ].includes(key),
      ),
    ),
  };
}

interface Served {
  cardBody?: unknown;
  cardStatus?: number;
  cardHeaders?: Record<string, string>;
  bindingBody?: unknown;
  bindingStatus?: number;
}

/** 记录全部出站请求的假 fetch（用于断言"不带凭据""不跟随重定向""不发额外请求"）。 */
function fakeFetch(served: Served = {}): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }> = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: { headers?: Record<string, string>; redirect?: string },
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    calls.push({ url, headers, redirect: init?.redirect });
    const isCard = url.endsWith("/agent-card.json");
    const status = isCard ? (served.cardStatus ?? 200) : (served.bindingStatus ?? 200);
    const body = isCard ? (served.cardBody ?? card()) : (served.bindingBody ?? bindingDocument());
    const extraHeaders = isCard ? (served.cardHeaders ?? { etag: CARD_ETAG }) : {};
    return new Response(status === 304 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...extraHeaders },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function source(served: Served = {}) {
  const { fetchImpl, calls } = fakeFetch(served);
  return {
    calls,
    source: new CloudCardSource({
      baseUrl: CATALOG,
      trust: trust(),
      fetchImpl,
      now: () => NOW,
    }),
  };
}

async function refusalOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof BindingRejectionError) return err.refusalCode;
    if (err instanceof CatalogSourceError) return `catalog:${err.code}`;
    return `other:${String(err)}`;
  }
  return "no-error";
}

describe("云端名片解析（公开读 + 声明验签）", () => {
  it("正常路径：返回名片 + 已验签声明 + 端点 + 信任缓存键", async () => {
    const { source: cloud } = source();
    const resolved = await cloud.resolveCloudAgent(AGENT_ID);

    expect(resolved.card.name).toBe("Cloud Merchant Agent");
    expect(resolved.claims.binding_version).toBe(3);
    expect(resolved.issuerKid).toBe(ISSUER_KID);
    expect(resolved.issuerThumbprint).toBe(ISSUER_THUMBPRINT);
    expect(resolved.cardRevision).toBe(4);
    expect(resolved.cardEtag).toBe(CARD_ETAG);
    // 端点由**声明背书**（而不是"名片里随便挑一个"）
    expect(resolved.endpoint).toBe(A2A_ENDPOINT);
    expect(resolved.publicationState).toBe("ACTIVE");
    expect(resolved.trustKey).toContain(AGENT_ID);
    expect(resolved.trustKey).toContain("3");
    expect(resolved.trustKey).toContain(A2A_ENDPOINT);
  });

  it("两个读请求都不带任何凭据（独立凭据范围）", async () => {
    const { source: cloud, calls } = source();
    await cloud.resolveCloudAgent(AGENT_ID);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.redirect).toBe("manual");
      expect(call.headers["authorization"]).toBeUndefined();
      expect(call.headers["x-buyer-id"]).toBeUndefined();
      expect(call.headers["cookie"]).toBeUndefined();
    }
    expect(calls.map((c) => c.url).sort()).toEqual(
      [`${CATALOG}/v1/agents/${AGENT_ID}/agent-card.json`, `${CATALOG}/v1/agents/${AGENT_ID}/runtime-binding`].sort(),
    );
  });

  it("签名被篡改 → BAD_SIGNATURE（不发第三请求去「补救」）", async () => {
    const { source: cloud, calls } = source({
      bindingBody: bindingDocument({ claims_jws: `${signClaims(claims()).slice(0, -4)}AAAA` }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("BAD_SIGNATURE");
    expect(calls).toHaveLength(2);
  });

  it("claims.card_url 指向别处 → CARD_URL_MISMATCH", async () => {
    const { source: cloud } = source({
      bindingBody: bindingDocument({ claims: claims({ cardUrl: "https://evil.example/card.json" }) }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("CARD_URL_MISMATCH");
  });

  it("声明背书的端点不在名片接口里 → ENDPOINT_MISMATCH", async () => {
    const { source: cloud } = source({
      bindingBody: bindingDocument({
        claims: claims({ a2aEndpoint: "https://evil.example/a2a" }),
      }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("ENDPOINT_MISMATCH");
  });

  it("名片声明多个 JSONRPC 接口时，声明指向其中任一个都成立", async () => {
    const second = `${RUNTIME_ORIGIN}/a2a-v2`;
    const { source: cloud } = source({
      cardBody: card({
        supportedInterfaces: [
          { url: A2A_ENDPOINT, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
          { url: second, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        ],
      }),
      bindingBody: bindingDocument({ claims: claims({ a2aEndpoint: second }) }),
    });
    await expect(cloud.resolveCloudAgent(AGENT_ID)).resolves.toMatchObject({ endpoint: second });
  });

  it("未知发行者 kid → UNKNOWN_ISSUER（不是「去下载信任根」的理由）", async () => {
    // 声明由一把**本地并不信任**的钥匙签发（kid 不在信任存储里）
    const rogue = generateKeyPairSync("ed25519");
    const rogueKid = "catalog-issuer-rogue";
    const signed = claims();
    const { source: cloud, calls } = source({
      bindingBody: bindingDocument({
        claims: signed,
        claims_jws: signWith(
          { keyid: rogueKid, algorithm: "ed25519", privateKey: rogue.privateKey },
          signed,
        ),
        issuer_kid: rogueKid,
        issuer_thumbprint: publicKeyThumbprint(rogue.publicKey),
      }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("UNKNOWN_ISSUER");
    // 只读了那两个公开地址——没有任何「取信任根」的请求
    expect(calls).toHaveLength(2);
  });

  it("外壳 issuer_kid 与已验签 JWS 头的 kid 不一致 → RESPONSE_INVALID", async () => {
    const { source: cloud } = source({
      bindingBody: bindingDocument({ issuer_kid: "catalog-issuer-other" }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("RESPONSE_INVALID");
  });

  it("Catalog 报告的发行者指纹与本地可信钥匙不符 → ISSUER_MISMATCH", async () => {
    const { source: cloud } = source({
      bindingBody: bindingDocument({ issuer_thumbprint: `sha256:${"b".repeat(64)}` }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("ISSUER_MISMATCH");
  });

  it("声明已过期 → EXPIRED", async () => {
    const expired = claims({ issuedAt: "2026-09-21T06:00:00Z", ttlSeconds: 900 });
    const { source: cloud } = source({ bindingBody: bindingDocument({ claims: expired }) });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("EXPIRED");
  });

  it("外壳 claims 与已验签负载不一致 → RESPONSE_INVALID（响应被拼装）", async () => {
    const signed = claims();
    const { source: cloud } = source({
      bindingBody: bindingDocument({
        claims: { ...signed, merchant_id: "merchant-evil" },
        claims_jws: signClaims(signed),
      }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("RESPONSE_INVALID");
  });

  it("治理状态 WITHDRAWN → REVOKED（有效期内也不得使用）", async () => {
    const { source: cloud } = source({
      bindingBody: bindingDocument({ governance: { publication_state: "WITHDRAWN" } }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("REVOKED");
  });

  it("名片声明没有 JSONRPC 接口 → 契约违规（不猜端点）", async () => {
    const { source: cloud } = source({
      cardBody: card({
        supportedInterfaces: [
          { url: A2A_ENDPOINT, protocolBinding: "GRPC", protocolVersion: "1.0" },
        ],
      }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("catalog:contract_violation");
  });

  it.each([
    ["私网 IPv4", "https://10.0.0.5/a2a"],
    ["loopback", "https://127.0.0.1/a2a"],
    ["cloud metadata", "https://169.254.169.254/latest/meta-data"],
    ["IPv6 loopback", "https://[::1]/a2a"],
    ["保留主机名", "https://metadata.google.internal/a2a"],
  ])("T035：声明背书危险目标（%s）→ UNSAFE_TARGET", async (_label, endpoint) => {
    // 声明侧也危险：注意 claims schema 本身只放行 https、无 userinfo，所以
    // http / 内嵌凭据这两种形态只能在**名片**侧表达（见下一个用例）。
    const { source: cloud } = source({
      cardBody: card({
        supportedInterfaces: [
          { url: endpoint, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        ],
      }),
      bindingBody: bindingDocument({ claims: claims({ a2aEndpoint: endpoint }) }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("UNSAFE_TARGET");
  });

  it("T035：名片声明的非 https 接口 → UNSAFE_TARGET（即使声明没指向它）", async () => {
    const { source: cloud } = source({
      cardBody: card({
        supportedInterfaces: [
          { url: A2A_ENDPOINT, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
          { url: "http://merchant.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        ],
      }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("UNSAFE_TARGET");
  });

  it("T035：名片声明的内嵌凭据接口 → 更早一层就被拒（名片结构校验，纵深防御）", async () => {
    const { source: cloud } = source({
      cardBody: card({
        supportedInterfaces: [
          { url: A2A_ENDPOINT, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
          {
            url: "https://user:pass@merchant.example/a2a",
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
          },
        ],
      }),
    });
    // 名片结构校验本身就拒绝 userinfo；即使它能过，下面的 URL 策略也会拦。
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toContain("AgentCardError");
  });

  it("T035：运行时 origin 指向私网也要拒（不能只在端点上设防）", async () => {
    const { source: cloud } = source({
      bindingBody: bindingDocument({
        claims: claims({
          runtimeOrigin: "https://192.168.1.10",
          a2aEndpoint: A2A_ENDPOINT,
        }),
      }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("UNSAFE_TARGET");
  });

  it("T035：名片里另有 metadata 接口（声明未指向它）也要拒——整张名片必须干净", async () => {
    const { source: cloud } = source({
      cardBody: card({
        supportedInterfaces: [
          { url: A2A_ENDPOINT, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
          {
            url: "https://169.254.169.254/a2a",
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
          },
        ],
      }),
    });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("UNSAFE_TARGET");
  });

  it("对端试图重定向 → 拒绝跟随（不把凭据/请求转发给第三方）", async () => {
    const { source: cloud } = source({ cardStatus: 302, cardBody: {} });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("catalog:request_failed");
  });

  it("Catalog 不可用（5xx）→ 直接失败，绝不降级为「用缓存/用旧名片继续」", async () => {
    const { source: cloud } = source({ cardStatus: 503, bindingStatus: 503, cardBody: {} });
    expect(await refusalOf(() => cloud.resolveCloudAgent(AGENT_ID))).toBe("catalog:request_failed");
  });
});

describe("条件请求与信任缓存（§12.1）", () => {
  it("带 If-None-Match 且命中 → notModified（沿用缓存名片）", async () => {
    const { source: cloud, calls } = source({ cardStatus: 304 });
    const read = await cloud.fetchPublishedCard(AGENT_ID, { ifNoneMatch: CARD_ETAG });
    expect(read).toEqual({ notModified: true, etag: CARD_ETAG });
    expect(calls[0]?.headers["if-none-match"]).toBe(CARD_ETAG);
  });

  it("304 但没给 ETag → 视为响应非法（无法确认缓存对应的表示）", async () => {
    const { source: cloud } = source({ cardStatus: 304, cardHeaders: {} });
    expect(
      await refusalOf(() => cloud.fetchPublishedCard(AGENT_ID, { ifNoneMatch: CARD_ETAG })),
    ).toBe("catalog:response_invalid");
  });

  it("信任缓存按 (来源, agentId, revision, binding_version, 端点) 索引且有有效期", async () => {
    const { source: cloud } = source();
    const resolved = await cloud.resolveCloudAgent(AGENT_ID);
    const cache = new CloudBindingTrustCache();
    cache.set(resolved);

    expect(cache.get(resolved.trustKey, NOW)).toBe(resolved);
    // 键含商家身份：换一个 agentId 不会命中别人的条目
    expect(cache.get(`${resolved.trustKey}x`, NOW)).toBeUndefined();
    // 有效期不长于声明自身：过期即失效（并顺带清理）
    const afterExpiry = new Date(Date.parse(resolved.claims.expires_at) + 1);
    expect(cache.get(resolved.trustKey, afterExpiry)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("binding_version 变化会产生新的缓存键（旧绑定不回放）", async () => {
    const { source: cloud } = source();
    const first = await cloud.resolveCloudAgent(AGENT_ID);
    const { source: bumped } = source({
      bindingBody: bindingDocument({ claims: claims({ bindingVersion: 4 }) }),
    });
    const second = await bumped.resolveCloudAgent(AGENT_ID);
    expect(first.trustKey).not.toBe(second.trustKey);
  });
});

describe("输入校验", () => {
  it("空 agentId / 含路径分隔符 → invalid_input（不拼出不安全的 URL）", async () => {
    const { source: cloud } = source();
    await expect(cloud.resolveCloudAgent("  ")).rejects.toBeInstanceOf(CatalogSourceError);
    await expect(cloud.resolveCloudAgent("../../etc/passwd")).rejects.toBeInstanceOf(
      CatalogSourceError,
    );
  });

  it.each([
    ["not a url", "非法 URL"],
    ["ftp://catalog.example", "非 http(s)"],
    ["https://user:pass@catalog.example", "内嵌凭据"],
  ])("baseUrl 非法（%s）→ invalid_input", (baseUrl) => {
    expect(
      () =>
        new CloudCardSource({
          baseUrl,
          trust: trust(),
        }),
    ).toThrow(CatalogSourceError);
  });
});

describe("指纹工具的口径一致", () => {
  it("KeyObject 形态算出的发行者指纹与 JWK 口径一致", () => {
    const jwk = issuer.publicKey.export({ format: "jwk" }) as {
      kty: string;
      crv: string;
      x: string;
    };
    expect(jwkThumbprint(jwk)).toBe(ISSUER_THUMBPRINT);
  });
});

describe("T041：三个互不替代的托管轴 + 旧通道不破坏", () => {
  it("已校验的云端解析结果 → card_hosting=catalog / a2a-direct；runtime_hosting 由调用方给", async () => {
    const { source: cloud } = source();
    const resolved = await cloud.resolveCloudAgent(AGENT_ID);
    const axes = describeCloudHosting(resolved, { runtimeHosting: "workbuddy_cloud" });
    expect(axes).toEqual({
      card_hosting: "catalog",
      runtime_hosting: "workbuddy_cloud",
      communication_mode: "a2a-direct",
    });
  });

  it("runtime_hosting 是部署事实：不给就报错，绝不替调用方猜", async () => {
    const { source: cloud } = source();
    const resolved = await cloud.resolveCloudAgent(AGENT_ID);
    expect(() => describeCloudHosting(resolved, { runtimeHosting: "   " })).toThrow(
      /runtimeHosting/,
    );
  });

  it("只接受端点由声明背书的解析结果（拒绝伪造的中间对象）", () => {
    expect(() =>
      describeCloudHosting(
        { endpoint: "https://evil.example/a2a", claims: { a2a_endpoint: A2A_ENDPOINT } },
        { runtimeHosting: "workbuddy_cloud" },
      ),
    ).toThrow(/已校验/);
  });

  it("云端商家在旧 hosting.mode 下记为 direct_only——绝不是 hosted_only", () => {
    expect(legacyHostingModeForCloudAgent()).toBe("direct_only");
    // 旧枚举语义本身不动：legacy hosted 记录仍然归一化为 hosted_only
    expect(normalizeHostingMode("hosted")).toBe("hosted_only");
    expect(normalizeHostingMode("direct")).toBe("direct_only");
    // 云端商家不会被写成 hosted_only（hosted_only 意味着"询价走 Catalog 通道"）
    expect(legacyHostingModeForCloudAgent()).not.toBe(normalizeHostingMode("hosted"));
  });
});

describe("CloudAgentResolution 类型面", () => {
  it("解析结果携带 Buyer 连接所需的最小信息（端点 + 声明 + 缓存键）", async () => {
    const { source: cloud } = source();
    const resolved: CloudAgentResolution = await cloud.resolveCloudAgent(AGENT_ID);
    expect(Object.keys(resolved).sort()).toEqual(
      [
        "agentId",
        "card",
        "cardEtag",
        "cardRevision",
        "claims",
        "endpoint",
        "issuerKid",
        "issuerThumbprint",
        "publicationState",
        "trustKey",
      ].sort(),
    );
  });
});
