/**
 * §4.6 Runtime 侧 Catalog 客户端（catalog-client.ts）。
 *
 * 覆盖验收要点（§8 runtime 行）：
 *   - 绑定请求：JWS 覆盖字段完整（agent_id/key_id/key_thumbprint/runtime_origin/
 *     a2a_endpoint/generation/service_epoch）+ 每次请求 nonce 唯一；
 *   - 匿名确认轮询：绝不带任何凭据；未确认 → CONFIRMATION_TIMEOUT（不放行发布）；
 *   - 名片构造：url 与全部 supportedInterfaces[].url 必须在自身 origin 内、
 *     至少一项等于绑定的 a2a_endpoint——**发出前**自查（fetch 不得被调用）；
 *   - 本地产物用 contracts/*.0.1.2 schema 自检（结构与契约锁一致）；
 *   - 目录不可达 → CATALOG_UNREACHABLE（由调用方标 pending_publication）；
 *   - CAS 409 → 匿名重读 + 重试一次；仍 409 → CONFLICT 报人工；
 *   - card_digest = 发布方计算的 JCS sha256。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { generateA2aSigningIdentity, toJwsSigningIdentity } from "../src/a2a/signing-key.js";
import {
  CatalogClient,
  CatalogClientError,
  assertCardWithinOrigin,
  runtimePublicKey,
  type RuntimeSigningIdentity,
} from "../src/cloud/catalog-client.js";
import { validateCloudContract } from "../src/contracts/cloud-contracts.js";
import { canonicalize } from "../src/negotiation/jcs.js";
import { buildBindingClaims, type BindingClaims } from "../src/trust/binding/claims.js";
import { verifyCompactJws } from "../src/trust/identity/jws.js";
import type { AgentCard } from "../src/discovery/agent-card/types.js";

const ORIGIN = "https://merchant-demo.example";
const A2A = `${ORIGIN}/a2a`;
const CATALOG = "https://catalog.example";
const AGENT = "cagt_demo";

function identity(): RuntimeSigningIdentity {
  const a2a = generateA2aSigningIdentity(ORIGIN);
  return { signingIdentity: toJwsSigningIdentity(a2a), keyId: a2a.keyid };
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function mockFetch(
  handler: (call: FetchCall) => { status: number; json?: unknown },
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (
    url: string | URL,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        String(v),
      ]),
    );
    const call: FetchCall = {
      url: String(url),
      method: String(init?.method ?? "GET"),
      headers,
      ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) as unknown } : {}),
    };
    calls.push(call);
    const result = handler(call);
    return new Response(result.json === undefined ? "" : JSON.stringify(result.json), {
      status: result.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function bindingDocument(id: RuntimeSigningIdentity, overrides: Partial<BindingClaims> = {}) {
  const { keyThumbprint } = runtimePublicKey(id);
  const claims = buildBindingClaims({
    bindingId: "binding_demo",
    bindingVersion: 1,
    merchantId: "merchant_demo",
    agentId: AGENT,
    workloadRef: "workload_demo",
    runtimeOrigin: ORIGIN,
    a2aEndpoint: A2A,
    cardUrl: `${CATALOG}/v1/agents/${AGENT}/agent-card.json`,
    keyId: id.keyId,
    keyThumbprint,
    serviceEpoch: 1,
    issuedAt: "2026-09-26T07:00:00Z",
    ttlSeconds: 900,
    issuer: "catalog_demo",
    ...overrides,
  });
  return {
    claims,
    claims_jws: "header.payload.sig",
    issuer_kid: "catalog_demo",
    issuer_thumbprint: `sha256:${"a".repeat(64)}`,
    governance: { publication_state: "ACTIVE" },
    card_revision: 3,
    card_etag: '"etag-3"',
  };
}

function validCard(): AgentCard {
  return {
    name: "Kiwi A2A Merchant",
    description: "Kiwi A2A node",
    provider: { organization: "Kiwi" },
    version: "1.0.0",
    url: ORIGIN,
    supportedInterfaces: [{ url: A2A, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    skills: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };
}

function decodeJwsPayload(jws: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("requestBinding", () => {
  it("body 符合 0.1.2 契约；JWS 覆盖七个字段 + nonce，签名可验", async () => {
    const id = identity();
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, json: { binding_request_id: "breq_1" } }));
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    const result = await client.requestBinding(
      { agentId: AGENT, runtimeOrigin: ORIGIN, a2aEndpoint: A2A, generation: 1, serviceEpoch: 7 },
      id,
    );

    expect(result.bindingRequestId).toBe("breq_1");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${CATALOG}/v1/agents/${AGENT}/runtime-bindings`);

    // 本地产物结构自检（contracts/runtime-binding/0.1.2/binding-request.schema.json）。
    expect(validateCloudContract("runtime-binding-request", call.body)).toEqual([]);
    const binding = (call.body as { binding: Record<string, unknown> }).binding;
    expect(binding["runtime_origin"]).toBe(ORIGIN);
    expect(binding["a2a_endpoint"]).toBe(A2A);
    expect(binding["generation"]).toBe(1);
    expect(binding["service_epoch"]).toBe(7);
    expect(binding["key_id"]).toBe(id.keyId);
    expect((binding["key_jwk"] as { kty: string }).kty).toBe("OKP");

    // JWS 覆盖字段完整 + issued_at（catalog 300s 时钟窗强制）+ 签名真实可验（Ed25519）。
    const jws = call.headers["x-kiwi-binding-jws"]!;
    const { keyJwk, keyThumbprint } = runtimePublicKey(id);
    const verified = verifyCompactJws(jws, keyJwk);
    expect(verified.alg).toBe("EdDSA");
    const payload = JSON.parse(verified.payload.toString("utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      agent_id: AGENT,
      key_id: id.keyId,
      key_thumbprint: keyThumbprint,
      runtime_origin: ORIGIN,
      a2a_endpoint: A2A,
      generation: 1,
      service_epoch: 7,
      nonce: result.nonce,
    });
    expect(typeof payload["issued_at"]).toBe("string");
    expect(Number.isNaN(Date.parse(String(payload["issued_at"])))).toBe(false);
    expect(Object.keys(payload).sort()).toEqual([
      "a2a_endpoint",
      "agent_id",
      "generation",
      "issued_at",
      "key_id",
      "key_thumbprint",
      "nonce",
      "runtime_origin",
      "service_epoch",
    ]);
  });

  it("每次请求生成新 nonce（客户端绝不复用）", async () => {
    const id = identity();
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, json: {} }));
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    for (let i = 0; i < 3; i++) {
      await client.requestBinding(
        { agentId: AGENT, runtimeOrigin: ORIGIN, a2aEndpoint: A2A, generation: 1, serviceEpoch: 1 },
        id,
      );
    }
    const nonces = calls.map((call) => decodeJwsPayload(call.headers["x-kiwi-binding-jws"]!)["nonce"]);
    expect(new Set(nonces).size).toBe(3);
  });

  it("runtime_origin 不从别处推导：非 https / 跨域端点直接拒绝（不发出请求）", async () => {
    const id = identity();
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, json: {} }));
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    await expect(
      client.requestBinding(
        { agentId: AGENT, runtimeOrigin: "http://merchant.example", a2aEndpoint: A2A, generation: 1, serviceEpoch: 1 },
        id,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      client.requestBinding(
        { agentId: AGENT, runtimeOrigin: ORIGIN, a2aEndpoint: "https://other.example/a2a", generation: 1, serviceEpoch: 1 },
        id,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toHaveLength(0);
  });
});

describe("awaitBindingConfirmation（匿名轮询）", () => {
  it("确认后返回绑定；匿名读不带任何凭据", async () => {
    const id = identity();
    const { keyThumbprint } = runtimePublicKey(id);
    let gets = 0;
    const { fetchImpl, calls } = mockFetch(() => {
      gets += 1;
      // 前两次：未确认（404）；第三次：确认后的公开绑定。
      return gets < 3 ? { status: 404 } : { status: 200, json: bindingDocument(id) };
    });
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    const binding = await client.awaitBindingConfirmation({
      agentId: AGENT,
      runtimeOrigin: ORIGIN,
      keyThumbprint,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    expect(binding.bindingId).toBe("binding_demo");
    expect(binding.cardRevision).toBe(3);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.headers["authorization"]).toBeUndefined();
      expect(call.headers["x-kiwi-binding-jws"]).toBeUndefined();
      expect(call.headers["cookie"]).toBeUndefined();
    }
  });

  it("未确认 → CONFIRMATION_TIMEOUT（不是失败，不放行发布）", async () => {
    const id = identity();
    const { keyThumbprint } = runtimePublicKey(id);
    const { fetchImpl } = mockFetch(() => ({ status: 404 }));
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    await expect(
      client.awaitBindingConfirmation({
        agentId: AGENT,
        runtimeOrigin: ORIGIN,
        keyThumbprint,
        pollIntervalMs: 1,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_TIMEOUT" });
  });

  it("公开读到的绑定与本实例不一致 → 继续等，最终超时并带上观测信息", async () => {
    const id = identity();
    const other = identity();
    const { keyThumbprint } = runtimePublicKey(id);
    const { fetchImpl } = mockFetch(() => ({ status: 200, json: bindingDocument(other) }));
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    await expect(
      client.awaitBindingConfirmation({
        agentId: AGENT,
        runtimeOrigin: ORIGIN,
        keyThumbprint,
        pollIntervalMs: 1,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_TIMEOUT" });
  });

  it("403（绑定已存在但文档暂不可读，首发布前窗口）→ 区分于 404，继续等并在超时信息里如实带上", async () => {
    const id = identity();
    const { keyThumbprint } = runtimePublicKey(id);
    const { fetchImpl } = mockFetch(() => ({
      status: 403,
      json: { ok: false, error: "agent is not publishable: no published card for this agent" },
    }));
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    const err = await client
      .awaitBindingConfirmation({
        agentId: AGENT,
        runtimeOrigin: ORIGIN,
        keyThumbprint,
        pollIntervalMs: 1,
        timeoutMs: 20,
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CONFIRMATION_TIMEOUT" });
    expect((err as Error).message).toContain("403");
  });

  it("fetchPublicBinding：403 → BINDING_UNREADABLE（区别于 404 的 null）", async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 403, json: { ok: false, error: "x" } }));
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    await expect(client.fetchPublicBinding(AGENT)).rejects.toMatchObject({
      code: "BINDING_UNREADABLE",
    });
    const notFound = new CatalogClient({
      baseUrl: CATALOG,
      fetchImpl: mockFetch(() => ({ status: 404 })).fetchImpl,
    });
    await expect(notFound.fetchPublicBinding(AGENT)).resolves.toBeNull();
  });
});

describe("publishCard", () => {
  it("body 符合 0.1.2 契约；card_digest 是发布方算的 JCS sha256；JWS 覆盖 binding_id", async () => {
    const id = identity();
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, json: { revision: 4 } }));
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    const card = validCard();
    const result = await client.publishCard(
      {
        agentId: AGENT,
        bindingId: "binding_demo",
        generation: 1,
        expectedRevision: 3,
        agentCard: card,
        a2aEndpoint: A2A,
        runtimeOrigin: ORIGIN,
      },
      id,
    );

    expect(result.revision).toBe(4);
    const expectedDigest = `sha256:${createHash("sha256").update(canonicalize(card), "utf8").digest("hex")}`;
    expect(result.cardDigest).toBe(expectedDigest);

    const call = calls[0]!;
    expect(call.url).toBe(`${CATALOG}/v1/agents/${AGENT}/card-publications`);
    expect(validateCloudContract("card-publication-request", call.body)).toEqual([]);
    const publication = (call.body as { publication: Record<string, unknown> }).publication;
    expect(publication["schema_version"]).toBe("0.1.2");
    expect(publication["wire_profile"]).toBe("a2a-1.0");
    expect(publication["card_digest"]).toBe(expectedDigest);
    expect(publication["expected_revision"]).toBe(3);

    const payload = decodeJwsPayload(call.headers["x-kiwi-binding-jws"]!);
    expect(payload["binding_id"]).toBe("binding_demo");
    expect(payload["card_digest"]).toBe(expectedDigest);
    expect(payload["expected_revision"]).toBe(3);
    expect(typeof payload["nonce"]).toBe("string");
    expect(typeof payload["issued_at"]).toBe("string");
  });

  it("名片接口在自身 origin 之外 → 发出前拒绝（fetch 不被调用）", async () => {
    const id = identity();
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, json: {} }));
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    const badCard: AgentCard = {
      ...validCard(),
      supportedInterfaces: [
        { url: A2A, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        { url: "https://evil.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      ],
    };
    await expect(
      client.publishCard(
        {
          agentId: AGENT,
          bindingId: "binding_demo",
          generation: 1,
          expectedRevision: 0,
          agentCard: badCard,
          a2aEndpoint: A2A,
          runtimeOrigin: ORIGIN,
        },
        id,
      ),
    ).rejects.toMatchObject({ code: "CARD_ORIGIN_VIOLATION" });
    expect(calls).toHaveLength(0);
  });

  it("没有任何接口等于绑定的 a2a_endpoint → 发出前拒绝", async () => {
    expect(() =>
      assertCardWithinOrigin(
        {
          ...validCard(),
          supportedInterfaces: [
            { url: `${ORIGIN}/other`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
          ],
        },
        ORIGIN,
        A2A,
      ),
    ).toThrowError(/a2a_endpoint/);
  });

  it("card.url 不是运行时 origin → 发出前拒绝", async () => {
    expect(() =>
      assertCardWithinOrigin({ ...validCard(), url: "https://catalog.example/card" }, ORIGIN, A2A),
    ).toThrowError(CatalogClientError);
  });

  it("目录不可达 → CATALOG_UNREACHABLE（调用方标 pending_publication，不谎报）", async () => {
    const id = identity();
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as typeof fetch;
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    await expect(
      client.publishCard(
        {
          agentId: AGENT,
          bindingId: "binding_demo",
          generation: 1,
          expectedRevision: 0,
          agentCard: validCard(),
          a2aEndpoint: A2A,
          runtimeOrigin: ORIGIN,
        },
        id,
      ),
    ).rejects.toMatchObject({ code: "CATALOG_UNREACHABLE" });
  });

  it("CAS 409 → 匿名重读最新 revision 后用新 nonce 重试一次，成功", async () => {
    const id = identity();
    let posts = 0;
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.method === "GET") return { status: 200, json: bindingDocument(id) }; // card_revision=3
      posts += 1;
      return posts === 1 ? { status: 409 } : { status: 200, json: { revision: 4 } };
    });
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    const result = await client.publishCard(
      {
        agentId: AGENT,
        bindingId: "binding_demo",
        generation: 1,
        expectedRevision: 1,
        agentCard: validCard(),
        a2aEndpoint: A2A,
        runtimeOrigin: ORIGIN,
      },
      id,
    );
    expect(result.revision).toBe(4);
    const posts2 = calls.filter((call) => call.method === "POST");
    expect(posts2).toHaveLength(2);
    // 重试用了重读到的 revision 与新的 nonce。
    const second = (posts2[1]!.body as { publication: Record<string, unknown> }).publication;
    expect(second["expected_revision"]).toBe(3);
    const nonces = posts2.map((call) => decodeJwsPayload(call.headers["x-kiwi-binding-jws"]!)["nonce"]);
    expect(new Set(nonces).size).toBe(2);
  });

  it("CAS 409 重试一次后仍 409 → CONFLICT 报人工（恰好两次 POST）", async () => {
    const id = identity();
    const { fetchImpl, calls } = mockFetch((call) =>
      call.method === "GET" ? { status: 200, json: bindingDocument(id) } : { status: 409 },
    );
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    await expect(
      client.publishCard(
        {
          agentId: AGENT,
          bindingId: "binding_demo",
          generation: 1,
          expectedRevision: 1,
          agentCard: validCard(),
          a2aEndpoint: A2A,
          runtimeOrigin: ORIGIN,
        },
        id,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });
});

describe("activateCard（kiwi-catalog activate_card_publication 实际契约）", () => {
  it("body 平铺（card_revision/expected_revision/binding_id 顶层），JWS 覆盖四字段 + issued_at + nonce", async () => {
    const id = identity();
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, json: { active_revision: 4, etag: '"e4"' } }));
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    const result = await client.activateCard(
      { agentId: AGENT, bindingId: "binding_demo", cardRevision: 4, expectedRevision: 3 },
      id,
    );
    expect(result.revision).toBe(4);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${CATALOG}/v1/agents/${AGENT}/publish`);
    // body 平铺，不是 publication 嵌套。
    expect(call.body).toEqual({
      agent_id: AGENT,
      binding_id: "binding_demo",
      card_revision: 4,
      expected_revision: 3,
    });
    const payload = decodeJwsPayload(call.headers["x-kiwi-binding-jws"]!);
    expect(payload).toMatchObject({
      agent_id: AGENT,
      binding_id: "binding_demo",
      card_revision: 4,
      expected_revision: 3,
      nonce: result.nonce,
    });
    expect(typeof payload["issued_at"]).toBe("string");
  });

  it("缺 card_revision / binding_id → INVALID_INPUT（不发出请求）", async () => {
    const id = identity();
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, json: {} }));
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    await expect(
      client.activateCard(
        { agentId: AGENT, bindingId: "binding_demo", cardRevision: 0, expectedRevision: 0 },
        id,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      client.activateCard(
        { agentId: AGENT, bindingId: "", cardRevision: 4, expectedRevision: 3 },
        id,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("CAS 激活：409 重读重试一次后成功（重试用重读到的 revision 与新 nonce）", async () => {
    const id = identity();
    let posts = 0;
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.method === "GET") return { status: 200, json: bindingDocument(id) };
      posts += 1;
      return posts === 1 ? { status: 409 } : { status: 200, json: { active_revision: 4 } };
    });
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    const result = await client.activateCard(
      { agentId: AGENT, bindingId: "binding_demo", cardRevision: 4, expectedRevision: 1 },
      id,
    );
    expect(result.revision).toBe(4);
    const postCalls = calls.filter((call) => call.method === "POST");
    expect(postCalls).toHaveLength(2);
    // card_revision（要激活的版本）在重试中不变；expected_revision 用重读到的 3。
    expect((postCalls[1]!.body as Record<string, unknown>)["card_revision"]).toBe(4);
    const payload = decodeJwsPayload(postCalls[1]!.headers["x-kiwi-binding-jws"]!);
    expect(payload["expected_revision"]).toBe(3);
    const nonces = postCalls.map((call) => decodeJwsPayload(call.headers["x-kiwi-binding-jws"]!)["nonce"]);
    expect(new Set(nonces).size).toBe(2);
  });

  it("409 且公开文档不可读（403 窗口）→ 直接 CONFLICT 报人工（无从重读）", async () => {
    const id = identity();
    const { fetchImpl, calls } = mockFetch((call) =>
      call.method === "GET" ? { status: 403, json: { ok: false, error: "agent is not publishable" } } : { status: 409 },
    );
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    await expect(
      client.activateCard(
        { agentId: AGENT, bindingId: "binding_demo", cardRevision: 1, expectedRevision: 0 },
        id,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("4xx（非 409）→ REQUEST_REJECTED（重试不会变好）", async () => {
    const id = identity();
    const { fetchImpl } = mockFetch(() => ({ status: 400, json: { error: "bad" } }));
    const client = new CatalogClient({ baseUrl: CATALOG, fetchImpl });
    await expect(
      client.activateCard(
        { agentId: AGENT, bindingId: "binding_demo", cardRevision: 4, expectedRevision: 0 },
        id,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_REJECTED" });
  });
});
