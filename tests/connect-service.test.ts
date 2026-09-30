/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * A2 连接服务内核（connect-service）独立测试。
 *
 * 全部走本地 stub（loopback 真实 socket）：
 *   - Runtime stub：只提供 /.well-known/agent-card.json（冻结预览来源）；
 *   - Catalog stub：device enrollment / token 轮询 / issuer-keys / 绑定 / 发布 /
 *     激活 / 公开绑定读，逐请求记账，行为可编程（第 N 次 poll 才 authorized、
 *     撤回开关等）。
 *
 * 覆盖任务书要求：begin 幂等、pending 短轮询与节流、绑定验真后才调
 * beforePublish、钩子失败不发布、重启续办、错 origin/key/catalog 拒绝、
 * 过期显式重开、撤销不自动恢复、summary 不含凭据、authorized 轮询结果
 * 不足以盖戳商品（merchant_id 只能来自验真 claim）、CLI 行为兼容。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalize } from "../src/negotiation/jcs.js";
import { validateAgentCard } from "../src/discovery/agent-card/validate.js";
import { buildBindingClaims } from "../src/trust/binding/claims.js";
import { signCompactJws, type JwsSigningIdentity } from "../src/trust/identity/jws.js";
import { readEnrollmentStore } from "../src/cloud/binding/enrollment-challenge.js";
import { createMerchantConnectionService, type VerifiedBinding } from "../src/cloud/connect-service.js";
import { connectMerchant } from "../src/cloud/merchant-connect.js";
import type { AgentProfile } from "../src/config/profile.js";

const RUNTIME_ORIGIN = "https://runtime.test";
const CATALOG_ORIGIN = "https://catalog.test";
const A2A_ENDPOINT = `${RUNTIME_ORIGIN}/a2a`;
const AGENT_ID = "cagt_server_assigned";
const BINDING_ID = "bnd_stub";
const MERCHANT_CLAIM = "merchant-claim-1";

/**
 * 唯一的 TLS shim：只把 https://runtime.test / https://catalog.test 降成各自的
 * loopback http 端口（测试进程内；声明里的 URL 保持 https，契约/schema 全走原样）。
 */
function tlsShim(realFetch: typeof fetch, ports: { runtime: number; catalog: number }): typeof fetch {
  return ((input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const rewritten = url
      .replace(/^https:\/\/runtime\.test/, `http://127.0.0.1:${ports.runtime}`)
      .replace(/^https:\/\/catalog\.test/, `http://127.0.0.1:${ports.catalog}`);
    return realFetch(rewritten, init);
  }) as unknown as typeof fetch;
}

/** 冻结预览卡（Runtime stub 的 well-known 与 Catalog 批准的 digest 都用它）。 */
const CARD = {
  name: "Stub Merchant",
  description: "Merchant commerce negotiation agent",
  provider: { organization: "Stub Merchant" },
  version: "1.0.0",
  url: RUNTIME_ORIGIN,
  supportedInterfaces: [
    { url: A2A_ENDPOINT, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
  ],
};

const APPROVED_DIGEST = (() => {
  const card = validateAgentCard(CARD);
  return `sha256:${createHash("sha256").update(canonicalize(card as unknown as Record<string, unknown>), "utf8").digest("hex")}`;
})();

const issuer = generateKeyPairSync("ed25519");
const ISSUER_KID = "catalog-issuer-stub";
const issuerIdentity: JwsSigningIdentity = {
  keyid: ISSUER_KID,
  algorithm: "ed25519",
  privateKey: issuer.privateKey,
};
const issuerJwk = issuer.publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
const issuerThumbprint = `sha256:${createHash("sha256")
  .update(JSON.stringify({ crv: issuerJwk.crv, kty: issuerJwk.kty, x: issuerJwk.x }), "utf8")
  .digest("hex")}`;

function futureIso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

function jwsPayload(jws: string): Record<string, unknown> {
  const segment = jws.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk as Buffer));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
  response.end(payload);
}

interface CatalogStubOptions {
  /** 第几次 poll 起返回 authorized（默认 0 = 第一次就 authorized）。 */
  pollsBeforeAuthorized?: number;
  /** 非空时：bind 端点固定返回该 403 错误码（模拟 grant 过期等确定性拒绝）。 */
  failBindWith?: { status: 403; code: string };
  /** 重签声明用的时钟（缺省真实时钟）；与注入服务的 now 共享即可模拟时间推进。 */
  claimsNow?: () => Date;
}

interface CatalogStub {
  /** 对外 https origin（契约面）。 */
  origin: string;
  /** loopback 实际端口（TLS shim 目标）。 */
  port: number;
  close: () => Promise<void>;
  counts: { deviceCreates: number; polls: number; binds: number; publications: number; activations: number };
  /** token 端点实际收到的全部 device_code（用于断言外码不外泄）。 */
  seenDeviceCodes: string[];
  /** 打开后：公开绑定读 404（模拟 Catalog 侧撤回/暂停）。 */
  withdrawn: boolean;
  /** 非空时：每次公开读对**重签后**的声明做篡改（模拟 Catalog 侧被换绑/错签）。 */
  corruptClaims: ((claims: Record<string, unknown>) => Record<string, unknown>) | null;
  lastBindingClaims: Record<string, unknown> | null;
}

async function startRuntimeStub(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    sendJson(res, 200, CARD);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startCatalogStub(options: CatalogStubOptions = {}): Promise<CatalogStub> {
  const counts = { deviceCreates: 0, polls: 0, binds: 0, publications: 0, activations: 0 };
  const seenDeviceCodes: string[] = [];
  let enrollmentId = "enr_none";
  let withdrawn = false;
  let lastBindingClaims: Record<string, unknown> | null = null;
  const pollsBeforeAuthorized = options.pollsBeforeAuthorized ?? 0;
  const failBindWith = options.failBindWith ?? null;
  const claimsNow = options.claimsNow ?? (() => new Date());
  /** 首签声明的基线（bind 时生成）；每次公开读在此基础上重签 expires_at。 */
  let boundClaims: Record<string, unknown> | null = null;
  let corruptClaims: ((claims: Record<string, unknown>) => Record<string, unknown>) | null = null;
  // 对外 origin 是 https 面（由 TLS shim 落到本 socket）；契约里的
  // verification_uri / card_url 都必须能过 https 校验。
  const publicOrigin = CATALOG_ORIGIN;

  const server: Server = createServer((request, response) => {
    void (async () => {
      // 消费请求体，避免连接挂起；内容只解析 device_code 用于防串用断言。
      const rawBody = await readBody(request);
      const url = request.url ?? "";
      const jwsHeader = String(request.headers["x-kiwi-binding-jws"] ?? "");
      if (request.method === "POST" && url === "/v1/enrollments/device") {
        counts.deviceCreates += 1;
        enrollmentId = `enr_${counts.deviceCreates}`;
        sendJson(response, 200, {
          enrollment_id: enrollmentId,
          device_code: `device-code-${counts.deviceCreates}-${"x".repeat(40)}`,
          user_code: `WDJB-00${counts.deviceCreates}`,
          verification_uri: `${publicOrigin}/activate`,
          expires_at: futureIso(600_000),
          interval: 5,
        });
        return;
      }
      if (request.method === "POST" && url === "/v1/enrollments/device/token") {
        counts.polls += 1;
        const tokenBody = JSON.parse(rawBody) as { device_code?: string };
        if (typeof tokenBody.device_code === "string") seenDeviceCodes.push(tokenBody.device_code);
        if (counts.polls <= pollsBeforeAuthorized) {
          sendJson(response, 200, { status: "authorization_pending", interval: 5 });
          return;
        }
        sendJson(response, 200, {
          status: "authorized",
          enrollment_id: enrollmentId,
          grant: "grant-stub",
          catalog_agent_id: AGENT_ID,
          merchant_id: MERCHANT_CLAIM,
          runtime_origin: RUNTIME_ORIGIN,
          a2a_endpoint: A2A_ENDPOINT,
          expires_at: futureIso(600_000),
          authorization_epoch: 1,
          approved_card_digest: APPROVED_DIGEST,
          scopes: ["runtime:bind", "card:publish", "heartbeat"],
        });
        return;
      }
      if (request.method === "GET" && url === "/v1/issuer-keys") {
        sendJson(response, 200, {
          issuer: "catalog.stub",
          keys: [{ kid: ISSUER_KID, state: "ACTIVE", jwk: issuerJwk, thumbprint: issuerThumbprint }],
        });
        return;
      }
      if (request.method === "POST" && url === `/v1/agents/${AGENT_ID}/runtime-bindings`) {
        counts.binds += 1;
        if (failBindWith !== null) {
          sendJson(response, failBindWith.status, { error: failBindWith.code });
          return;
        }
        const payload = jwsPayload(jwsHeader);
        const claims = buildBindingClaims({
          bindingId: BINDING_ID,
          bindingVersion: 1,
          merchantId: MERCHANT_CLAIM,
          agentId: AGENT_ID,
          workloadRef: "wbapp_stub",
          runtimeOrigin: RUNTIME_ORIGIN,
          a2aEndpoint: A2A_ENDPOINT,
          cardUrl: `${publicOrigin}/v1/agents/${AGENT_ID}/agent-card.json`,
          keyId: String(payload["key_id"]),
          keyThumbprint: String(payload["key_thumbprint"]),
          serviceEpoch: 1,
          issuedAt: new Date().toISOString(),
          ttlSeconds: 900, // BINDING_CLAIMS_MAX_TTL_SECONDS 上限
          issuer: "catalog.stub",
        });
        boundClaims = claims as unknown as Record<string, unknown>;
        lastBindingClaims = boundClaims;
        sendJson(response, 200, {
          binding_id: BINDING_ID,
          binding_version: 1,
          key_thumbprint: String(payload["key_thumbprint"]),
          binding_claim: {
            // 线格式：信封里既有验签用的 claims_jws，也有明文 claims 摘要
            // （Runtime 据此取 merchant_id/expires_at；二者已由客户端验签把关）。
            claims: { merchant_id: claims.merchant_id, expires_at: claims.expires_at },
            claims_jws: signCompactJws(claims as unknown as Record<string, unknown>, issuerIdentity, {
              extraHeader: { typ: "kiwi-runtime-binding-claims" },
            }),
            issuer_kid: ISSUER_KID,
            issuer_thumbprint: issuerThumbprint,
            card_revision: null,
          },
        });
        return;
      }
      if (request.method === "POST" && url === `/v1/agents/${AGENT_ID}/card-publications`) {
        counts.publications += 1;
        sendJson(response, 200, { revision: 1 });
        return;
      }
      if (request.method === "POST" && url === `/v1/agents/${AGENT_ID}/publish`) {
        counts.activations += 1;
        sendJson(response, 200, { active_revision: 1 });
        return;
      }
      if (request.method === "GET" && url === `/v1/agents/${AGENT_ID}/runtime-binding`) {
        if (withdrawn || boundClaims === null) {
          sendJson(response, 404, { ok: false, error: "not found" });
          return;
        }
        // 与真实 Catalog（kiwi_catalog/a2a/binding_claims.py::read_runtime_binding）
        // 一致：每次公开读都**重新签发** issued_at/expires_at（expires_at=时钟
        // +900s 的短期绑定声明）；本地首签 TTL 过期绝不意味着长期绑定终止。
        const stamp = claimsNow();
        const fresh: Record<string, unknown> = {
          ...boundClaims,
          issued_at: stamp.toISOString(),
          expires_at: new Date(stamp.getTime() + 900_000).toISOString(),
        };
        const issued = corruptClaims === null ? fresh : corruptClaims({ ...fresh });
        lastBindingClaims = issued;
        sendJson(response, 200, {
          claims: issued,
          claims_jws: signCompactJws(issued, issuerIdentity, {
            extraHeader: { typ: "kiwi-runtime-binding-claims" },
          }),
          issuer_kid: ISSUER_KID,
          issuer_thumbprint: issuerThumbprint,
          governance: { publication_state: "ACTIVE" },
          card_revision: 1,
          card_etag: '"stub"',
        });
        return;
      }
      sendJson(response, 404, { ok: false, error: "not found" });
    })().catch((err: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { ok: false, error: `stub failure: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = (server.address() as AddressInfo).port;
  return {
    origin: publicOrigin,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    counts,
    seenDeviceCodes,
    get withdrawn() {
      return withdrawn;
    },
    set withdrawn(value: boolean) {
      withdrawn = value;
    },
    get corruptClaims() {
      return corruptClaims;
    },
    set corruptClaims(value: ((claims: Record<string, unknown>) => Record<string, unknown>) | null) {
      corruptClaims = value;
    },
    get lastBindingClaims() {
      return lastBindingClaims;
    },
  };
}

// ── 测试夹具 ─────────────────────────────────────────────────────────

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-connect-service-"));
  tempDirs.push(dir);
  return dir;
}

interface Harness {
  dataDir: string;
  catalog: CatalogStub;
  serviceOptions: {
    dataDir: string;
    catalogUrl: string;
    publicOrigin: string;
    generation: number;
    serviceEpoch: number;
    fetchImpl: typeof fetch;
  };
}

async function makeHarness(catalogOptions: CatalogStubOptions = {}): Promise<Harness> {
  const runtime = await startRuntimeStub();
  servers.push(runtime);
  const catalog = await startCatalogStub(catalogOptions);
  servers.push(catalog);
  const dataDir = makeDataDir();
  return {
    dataDir,
    catalog,
    serviceOptions: {
      dataDir,
      catalogUrl: CATALOG_ORIGIN,
      publicOrigin: RUNTIME_ORIGIN,
      generation: 1,
      serviceEpoch: 1,
      fetchImpl: tlsShim(globalThis.fetch, { runtime: runtime.port, catalog: catalog.port }),
    },
  };
}

function sessionRecord(dataDir: string): Record<string, unknown> {
  const sessions = readEnrollmentStore(dataDir).sessions as unknown as Array<Record<string, unknown>>;
  const selected = sessions.find((session) => session["runtime_origin"] === RUNTIME_ORIGIN);
  if (selected === undefined) throw new Error("测试夹具：找不到本会话");
  return selected;
}

function rewriteSessions(dataDir: string, mutate: (session: Record<string, unknown>) => Record<string, unknown>): void {
  const store = JSON.parse(readFileSync(path.join(dataDir, "merchant-enrollments.json"), "utf8")) as {
    sessions: Array<Record<string, unknown>>;
  };
  store.sessions = store.sessions.map((session) =>
    session["runtime_origin"] === RUNTIME_ORIGIN ? mutate(session) : session);
  writeFileSync(path.join(dataDir, "merchant-enrollments.json"), `${JSON.stringify(store)}\n`);
}

const PROFILE = {
  role: "merchant",
  agent_id: "agent_stub",
  owner_id: "owner_stub",
  name: "Stub 商家",
} as unknown as AgentProfile;

const CREDENTIAL_MARKERS = ["user_code", "device_code", "grant", "verification_uri", "device-code-", "WDJB-", "grant-stub"];

function expectNoCredentials(serialized: string): void {
  for (const marker of CREDENTIAL_MARKERS) {
    expect(serialized).not.toContain(marker);
  }
}

// ── 用例 ─────────────────────────────────────────────────────────────

describe("connect-service 内核", () => {
  it("begin 幂等：同 origin/key/卡重复 begin 只创建一个 enrollment", async () => {
    const harness = await makeHarness();
    const service = createMerchantConnectionService(harness.serviceOptions);
    const first = await service.begin();
    expect(first.status).toBe("awaiting_confirmation");
    const second = await service.begin();
    expect(second.status).toBe("awaiting_confirmation");
    expect(harness.catalog.counts.deviceCreates).toBe(1);

    const pairing = service.getPairing();
    expect(pairing).not.toBeNull();
    expect(pairing?.userCode).toBe("WDJB-001");
    expect(Object.keys(pairing ?? {}).sort()).toEqual(["expiresAt", "userCode", "verificationUri"]);
  });

  it("summary 与 pairing 分层：summary 永不含凭据", async () => {
    const harness = await makeHarness();
    const service = createMerchantConnectionService(harness.serviceOptions);
    await service.begin();
    const summary = await service.getSummary();
    expectNoCredentials(JSON.stringify(summary));
    expect(summary.status).toBe("awaiting_confirmation");
    expect(summary.published).toBe(false);
  });

  it("pending 短轮询：尊重 interval 节流，slow_down 不轰炸 Catalog", async () => {
    const harness = await makeHarness({ pollsBeforeAuthorized: 2 });
    let nowMs = Date.now();
    const service = createMerchantConnectionService({
      ...harness.serviceOptions,
      now: () => new Date(nowMs),
    });
    await service.begin();
    await service.reconcile();
    expect(harness.catalog.counts.polls).toBe(1);
    // 间隔内再次 reconcile：不发起新 poll。
    await service.reconcile();
    expect(harness.catalog.counts.polls).toBe(1);
    // 推进 6s（超过 interval=5s）：允许下一次 poll，本次 poll 返回 authorized，
    // 级联走完 bind → publish → activate。
    nowMs += 6_000;
    await service.reconcile();
    expect(harness.catalog.counts.polls).toBe(2);
    nowMs += 6_000;
    const summary = await service.reconcile();
    expect(harness.catalog.counts.polls).toBe(3);
    expect(summary.status).toBe("published");
    expect(harness.catalog.counts.binds).toBe(1);
  });

  it("authorized 轮询结果不足以盖戳：merchant_id 只在验真 claim 后写入", async () => {
    const harness = await makeHarness({ pollsBeforeAuthorized: 1 });
    let nowMs = Date.now();
    const service = createMerchantConnectionService({
      ...harness.serviceOptions,
      now: () => new Date(nowMs),
    });
    await service.begin();
    expect(await service.getVerifiedBinding()).toBeNull();
    await service.reconcile(); // 仍 pending
    expect(await service.getVerifiedBinding()).toBeNull();
    // preparing 阶段连未验真断言都没有；权威 merchant_id 尚未写入。
    expect(sessionRecord(harness.dataDir)["merchant_id"]).toBeUndefined();
    nowMs += 6_000; // 越过 interval 节流
    const done = await service.reconcile(); // authorized → bind（claim 验真）→ 发布
    expect(done.status).toBe("published");
    const record = sessionRecord(harness.dataDir);
    expect(record["offered_merchant_id"]).toBe(MERCHANT_CLAIM);
    expect(record["merchant_id"]).toBe(MERCHANT_CLAIM);
    expect((await service.getVerifiedBinding())?.merchantId).toBe(MERCHANT_CLAIM);
  });

  it("验证绑定后才调 beforePublish，且拿到的是 claim 里的 merchant_id", async () => {
    const harness = await makeHarness({ pollsBeforeAuthorized: 1 });
    let nowMs = Date.now();
    const hookCalls: VerifiedBinding[] = [];
    const service = createMerchantConnectionService({
      ...harness.serviceOptions,
      now: () => new Date(nowMs),
      beforePublish: async (binding) => {
        hookCalls.push(binding);
      },
    });
    await service.begin();
    await service.reconcile(); // 仍 pending：未碰钩子
    expect(hookCalls).toHaveLength(0);
    nowMs += 6_000; // 越过 interval 节流
    const summary = await service.reconcile(); // authorized→bind（验真）→钩子→publish→activate
    expect(summary.status).toBe("published");
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]?.merchantId).toBe(MERCHANT_CLAIM);
    expect(hookCalls[0]?.agentId).toBe(AGENT_ID);
    expect(hookCalls[0]?.bindingId).toBe(BINDING_ID);
  });

  it("钩子失败：保留 bound，不发布；修复后同一会话续办", async () => {
    const harness = await makeHarness();
    let fail = true;
    const service = createMerchantConnectionService({
      ...harness.serviceOptions,
      beforePublish: async () => {
        if (fail) throw new Error("商品表暂不可写");
      },
    });
    await service.begin();
    await expect(service.reconcile()).rejects.toThrow("商品表暂不可写");
    expect(harness.catalog.counts.publications).toBe(0);
    const failing = createMerchantConnectionService({
      ...harness.serviceOptions,
      beforePublish: async () => {
        if (fail) throw new Error("商品表暂不可写");
      },
    });
    expect((await failing.getSummary()).status).toBe("bound");
    fail = false;
    const summary = await service.reconcile();
    expect(summary.status).toBe("published");
    expect(harness.catalog.counts.publications).toBe(1);
  });

  it("重启续办：bound 状态跨实例续办且重新验证冻结卡，不重复 bind", async () => {
    const harness = await makeHarness();
    let fail = true;
    const service = createMerchantConnectionService({
      ...harness.serviceOptions,
      beforePublish: async () => {
        if (fail) throw new Error("先不发布");
      },
    });
    await service.begin();
    await expect(service.reconcile()).rejects.toThrow("先不发布");
    expect(harness.catalog.counts.binds).toBe(1);
    expect(harness.catalog.counts.polls).toBe(1);
    fail = false;
    // 全新实例（模拟进程重启）：只应走 publish/activate，不再 bind/poll。
    const restarted = createMerchantConnectionService({
      ...harness.serviceOptions,
      beforePublish: async () => undefined,
    });
    expect((await restarted.getSummary()).status).toBe("bound");
    const summary = await restarted.reconcile();
    expect(summary.status).toBe("published");
    expect(harness.catalog.counts.binds).toBe(1);
    expect(harness.catalog.counts.polls).toBe(1);
    expect(sessionRecord(harness.dataDir)["merchant_id"]).toBe(MERCHANT_CLAIM);
    expect(harness.catalog.counts.publications).toBe(1);
    expect(harness.catalog.counts.activations).toBe(1);
  });

  it("错 catalog 拒绝复用；错 origin/key 不被选中且不删除旧会话", async () => {
    const harness = await makeHarness();
    const service = createMerchantConnectionService(harness.serviceOptions);
    await service.begin();
    expect(harness.catalog.counts.deviceCreates).toBe(1);

    // ① 换一个 Catalog（同 dataDir/origin/key）：许可不串用，明确拒绝。
    const foreign = createMerchantConnectionService({
      ...harness.serviceOptions,
      catalogUrl: "http://127.0.0.1:9",
    });
    await expect(foreign.begin()).rejects.toMatchObject({ code: "CATALOG_MISMATCH" });

    // ② 会话 runtime_origin 被改写（地址迁移）：不再被选中，begin 显式新建。
    rewriteSessions(harness.dataDir, (session) => ({ ...session, runtime_origin: "https://other.test" }));
    const migrated = createMerchantConnectionService(harness.serviceOptions);
    expect((await migrated.getSummary()).status).toBe("idle");
    expect((await migrated.reconcile()).status).toBe("idle");
    const reopened = await migrated.begin();
    expect(reopened.status).toBe("awaiting_confirmation");
    expect(harness.catalog.counts.deviceCreates).toBe(2);
    const store = readEnrollmentStore(harness.dataDir);
    expect(store.sessions).toHaveLength(2);

    // ③ 换密钥（删除签名密钥文件 = 新身份）：旧会话不选中、保留。
    const keyFile = path.join(harness.dataDir, "a2a-signing-key.json");
    const storeFile = path.join(harness.dataDir, "merchant-enrollments.json");
    const savedStore = readFileSync(storeFile, "utf8");
    rmSync(keyFile);
    writeFileSync(storeFile, savedStore); // rewriteSessions 后的存根恢复为新会话两份
    const rekeyed = createMerchantConnectionService(harness.serviceOptions);
    expect((await rekeyed.getSummary()).status).toBe("idle");
    await rekeyed.begin();
    expect(harness.catalog.counts.deviceCreates).toBe(3);
    expect(readEnrollmentStore(harness.dataDir).sessions.length).toBe(3);
  });

  it("授权过期：不再轮询、显式标记，下一次 begin 显式重开", async () => {
    const harness = await makeHarness();
    let nowMs = Date.now();
    const service = createMerchantConnectionService({
      ...harness.serviceOptions,
      now: () => new Date(nowMs),
    });
    await service.begin();
    nowMs += 601_000; // 越过 stub 的 600s 授权窗口
    const expired = await service.reconcile();
    expect(expired.status).toBe("expired");
    expect(harness.catalog.counts.polls).toBe(0);
    expect(service.getPairing()).toBeNull();
    const reopened = await service.begin();
    expect(reopened.status).toBe("awaiting_confirmation");
    expect(harness.catalog.counts.deviceCreates).toBe(2);
    expect(readEnrollmentStore(harness.dataDir).sessions).toHaveLength(2);
  });

  it("撤销不自动恢复：published 核对 Catalog 当前绑定，撤回 fail-closed 报 paused、零写请求", async () => {
    const harness = await makeHarness();
    const service = createMerchantConnectionService(harness.serviceOptions);
    await service.begin();
    const published = await service.reconcile();
    expect(published.status).toBe("published");
    expect(published.published).toBe(true);
    expect(published.code).toBeNull();
    expect(await service.getVerifiedBinding()).not.toBeNull();

    harness.catalog.withdrawn = true;
    const revoked = await service.reconcile();
    // fail-closed：撤回后绝不上报 published=true；状态可区分（paused/error/unknown）。
    expect(revoked.status).toBe("paused");
    expect(revoked.published).toBe(false);
    expect(revoked.code).toBe("PUBLICATION_NOT_ACTIVE");
    expect(revoked.detail).toContain("不会自动恢复营业");
    const revokedSummary = await service.getSummary();
    expect(revokedSummary.status).toBe("paused");
    expect(revokedSummary.published).toBe(false);
    expect(await service.getVerifiedBinding()).toBeNull();
    const writesAfterRevoke = harness.catalog.counts.publications + harness.catalog.counts.activations + harness.catalog.counts.binds;
    await service.reconcile();
    expect(harness.catalog.counts.publications + harness.catalog.counts.activations + harness.catalog.counts.binds)
      .toBe(writesAfterRevoke);
  });

  it("重启后未验证：新实例不把本地 published 历史当当前发布回执（unknown），reconcile 核对后才 published", async () => {
    const harness = await makeHarness();
    const service = createMerchantConnectionService(harness.serviceOptions);
    await service.begin();
    expect((await service.reconcile()).status).toBe("published");

    // 模拟进程重启：全新实例从未核对过 Catalog。
    const restarted = createMerchantConnectionService(harness.serviceOptions);
    const unverified = await restarted.getSummary();
    expect(unverified.status).toBe("unknown");
    expect(unverified.published).toBe(false);
    expect(unverified.code).toBeNull();
    expect(unverified.agentId).not.toBeNull();
    // 纯读：未核对前零出站（getSummary 不发任何 Catalog 请求）。
    const verified = await restarted.reconcile();
    expect(verified.status).toBe("published");
    expect(verified.published).toBe(true);
    expect((await restarted.getSummary()).status).toBe("published");
  });

  it("多会话不遮挡：第一条错 Catalog 的会话被跳过，选中后面正确 Catalog 的会话且外码不外泄", async () => {
    const harness = await makeHarness();
    const service = createMerchantConnectionService(harness.serviceOptions);
    await service.begin(); // 真实会话 enr_1（当前 Catalog）
    const real = sessionRecord(harness.dataDir);
    // 在数组头部插入一条同 origin+key、但属于其他 Catalog 的克隆会话。
    const store = readEnrollmentStore(harness.dataDir);
    const foreign = {
      ...real,
      enrollment_id: "enr_foreign",
      catalog_origin: "https://foreign-catalog.test",
      device_code: "device-code-foreign-yyyy",
      user_code: "WDJB-999",
    };
    writeFileSync(path.join(harness.dataDir, "merchant-enrollments.json"),
      `${JSON.stringify({ ...store, sessions: [foreign, ...store.sessions] })}\n`, { mode: 0o600 });

    // 不返回错 Catalog 会话的配对码，选中正确会话的。
    const pairing = service.getPairing();
    expect(pairing?.userCode).toBe("WDJB-001");
    expect(JSON.stringify(pairing)).not.toContain("WDJB-999");
    // reconcile 用正确会话走完流程；foreign 的 device_code 从未发往当前 Catalog。
    const summary = await service.reconcile();
    expect(summary.status).toBe("published");
    expect(harness.catalog.seenDeviceCodes).not.toContain("device-code-foreign-yyyy");
    expect(harness.catalog.seenDeviceCodes.length).toBeGreaterThan(0);
    // 错 Catalog 会话原样保留（preparing），不被删除/改写。
    const foreignAfter = readEnrollmentStore(harness.dataDir).sessions
      .find((session) => session.enrollment_id === "enr_foreign") as unknown as Record<string, unknown>;
    expect(foreignAfter["status"]).toBe("preparing");
    expect(foreignAfter["catalog_origin"]).toBe("https://foreign-catalog.test");
  });

  it("错 Catalog 无可用会话：reconcile/getPairing/getVerifiedBinding 零出站、不返回配对", async () => {
    const harness = await makeHarness();
    const service = createMerchantConnectionService(harness.serviceOptions);
    await service.begin();

    // 只存在错 Catalog 的会话（指向不可达端口，任何出站都会抛错）。
    const foreign = createMerchantConnectionService({
      ...harness.serviceOptions,
      catalogUrl: "http://127.0.0.1:9",
    });
    expect(foreign.getPairing()).toBeNull();
    expect(await foreign.getVerifiedBinding()).toBeNull();
    expect((await foreign.getSummary()).status).toBe("idle");
    expect((await foreign.reconcile()).status).toBe("idle");
    // begin 显式拒绝（CATALOG_MISMATCH），也不发任何出站请求。
    await expect(foreign.begin()).rejects.toMatchObject({ code: "CATALOG_MISMATCH" });
  });

  it("claim TTL 语义：bound 看本地已验真声明；published 越过首签 TTL 后凭 Catalog 重签声明续验", async () => {
    let nowMs = Date.now();
    // stub 重签声明的时钟与服务的注入时钟共享，模拟真实环境两边同钟。
    const harness = await makeHarness({ claimsNow: () => new Date(nowMs) });
    const service = createMerchantConnectionService({
      ...harness.serviceOptions,
      now: () => new Date(nowMs),
      beforePublish: async () => undefined,
    });
    await service.begin();
    expect((await service.reconcile()).status).toBe("published");
    expect(harness.catalog.counts.deviceCreates).toBe(1);
    const initialClaimExpiry = Date.parse(String(sessionRecord(harness.dataDir)["binding_expires_at"]));
    // bind 用真实时钟签发，容差 5s。
    expect(initialClaimExpiry).toBeLessThanOrEqual(nowMs + 900_000 + 5_000);
    expect(initialClaimExpiry).toBeGreaterThan(nowMs + 900_000 - 60_000);

    // 推进 1200s，远超首签声明的 900s TTL：本地 binding_expires_at 早已过期，
    // 但 Catalog 每次公开读都重签新声明——只读续验不得被历史 TTL 阻断。
    nowMs += 1_200_000;
    const binding = await service.getVerifiedBinding();
    expect(binding).not.toBeNull();
    expect(binding?.merchantId).toBe(MERCHANT_CLAIM);
    expect(binding?.bindingId).toBe(BINDING_ID);
    // 投影期限必须是当次重签的新鲜声明，不是历史 claim 的过期时间。
    expect(Date.parse(binding?.expiresAt ?? "")).toBeGreaterThan(nowMs);
    expect(Date.parse(binding?.expiresAt ?? "")).toBeLessThanOrEqual(nowMs + 900_000);
    const summary = await service.reconcile();
    expect(summary.status).toBe("published");
    expect(summary.published).toBe(true);
    // 全程零写、零新建会话：声明过期绝不触发重建 enrollment 或重新授权。
    expect(harness.catalog.counts.deviceCreates).toBe(1);
    expect(harness.catalog.counts.binds).toBe(1);
    expect(harness.catalog.counts.publications).toBe(1);
    expect(harness.catalog.counts.activations).toBe(1);
  });

  it("bound（未发布）签名 claim 已过期：hook 与 publish 不得执行，显式重开", async () => {
    const harness = await makeHarness();
    let nowMs = Date.now();
    let hookCalls = 0;
    const service = createMerchantConnectionService({
      ...harness.serviceOptions,
      now: () => new Date(nowMs),
      beforePublish: async () => {
        hookCalls += 1;
        throw new Error("先导入商品，暂不发布");
      },
    });
    await service.begin();
    await expect(service.reconcile()).rejects.toThrow("先导入商品");
    expect(hookCalls).toBe(1);
    expect((await service.getSummary()).status).toBe("bound");
    expect(harness.catalog.counts.publications).toBe(0);

    // 推进 901s，越过首签声明 TTL：未发布的 bound 必须拒绝续用旧凭据。
    nowMs += 901_000;
    expect((await service.reconcile()).status).toBe("idle");
    expect(hookCalls).toBe(1); // 钩子不得执行
    expect(harness.catalog.counts.publications).toBe(0); // publish 不得执行
    expect(harness.catalog.counts.activations).toBe(0);
    expect(await service.getVerifiedBinding()).toBeNull();
    // 显式重开：创建全新 enrollment，不做隐式续期。
    const reopened = await service.begin();
    expect(reopened.status).toBe("awaiting_confirmation");
    expect(harness.catalog.counts.deviceCreates).toBe(2);
  });

  it("bound 恢复按 binding_expires_at：grant 过期不碍续办（无需用户重新授权）", async () => {
    const harness = await makeHarness();
    let nowMs = Date.now();
    let hookCalls = 0;
    const service = createMerchantConnectionService({
      ...harness.serviceOptions,
      now: () => new Date(nowMs),
      beforePublish: async () => {
        hookCalls += 1;
        if (hookCalls === 1) throw new Error("先导入商品，暂不发布");
      },
    });
    await service.begin();
    await expect(service.reconcile()).rejects.toThrow("先导入商品");
    expect(harness.catalog.counts.binds).toBe(1);
    expect((await service.getSummary()).status).toBe("bound");

    // 推进 601s：授权 grant（窗口 600s）已过期，但验真绑定（首签 TTL 900s）仍
    // 有效——不应要求用户重新授权，应直接续办发布。
    nowMs += 601_000;
    const resumed = await service.reconcile();
    expect(resumed.status).toBe("published");
    expect(resumed.published).toBe(true);
    expect(hookCalls).toBe(2);
    expect(harness.catalog.counts.binds).toBe(1); // 未重复 bind
    expect(harness.catalog.counts.polls).toBe(1);
    expect(harness.catalog.counts.publications).toBe(1);
  });

  it("Catalog 重签声明与本地绑定不一致：错 merchant/origin/key/binding id/version 一律 fail-closed", async () => {
    const harness = await makeHarness();
    let nowMs = Date.now();
    const service = createMerchantConnectionService({
      ...harness.serviceOptions,
      now: () => new Date(nowMs),
    });
    await service.begin();
    expect((await service.reconcile()).status).toBe("published");
    nowMs += 30_000; // 声明自然重签窗口内

    // 错 merchant_id：BINDING_MERCHANT_MISMATCH → error/published=false。
    harness.catalog.corruptClaims = (claims) => ({ ...claims, merchant_id: "mkt_evil" });
    expect(await service.getVerifiedBinding()).toBeNull();
    expect((await service.getSummary()).published).toBe(false);
    expect((await service.getSummary()).code).toBe("BINDING_MERCHANT_MISMATCH");
    const wrongMerchant = await service.reconcile();
    expect(wrongMerchant.published).toBe(false);
    expect(wrongMerchant.code).toBe("BINDING_MERCHANT_MISMATCH");

    // 错 binding_id / origin / key / version：PUBLICATION_NOT_ACTIVE → paused。
    const cases: Array<(claims: Record<string, unknown>) => Record<string, unknown>> = [
      (claims) => ({ ...claims, binding_id: "binding_evildoer" }),
      (claims) => ({ ...claims, runtime_origin: "https://evil.test" }),
      (claims) => ({ ...claims, key_thumbprint: `sha256:${"e".repeat(64)}` }),
      (claims) => ({ ...claims, binding_version: 99 }),
    ];
    for (const corrupt of cases) {
      harness.catalog.corruptClaims = corrupt;
      expect(await service.getVerifiedBinding()).toBeNull();
      expect((await service.getSummary()).published).toBe(false);
      const summary = await service.reconcile();
      expect(summary.published).toBe(false);
      expect(summary.code).toBe("PUBLICATION_NOT_ACTIVE");
      expect(["paused", "error"]).toContain(summary.status);
    }

    // 解除篡改后下一趟重读即自愈，无需任何写/重建。
    harness.catalog.corruptClaims = null;
    expect(await service.getVerifiedBinding()).not.toBeNull();
    expect((await service.getSummary()).published).toBe(true);
    expect((await service.reconcile()).published).toBe(true);
    expect(await service.getVerifiedBinding()).not.toBeNull();
    expect(harness.catalog.counts.deviceCreates).toBe(1);
  });

  it("私网/本地 host 边界不放宽：服务构造器与 CLI 同一白名单口径", () => {
    for (const publicOrigin of ["https://localhost", "https://127.0.0.1", "https://192.168.1.1", "https://foo.local"]) {
      expect(() => createMerchantConnectionService({
        dataDir: makeDataDir(),
        catalogUrl: "https://catalog.test",
        publicOrigin,
      })).toThrowError(expect.objectContaining({ code: "PUBLIC_ORIGIN_INVALID" }));
    }
    // 公网 host 正常构造（loadPublicCard 缺省，构造不触网）。
    expect(() => createMerchantConnectionService({
      dataDir: makeDataDir(),
      catalogUrl: "https://catalog.test",
      publicOrigin: "https://shop.example",
    })).not.toThrow();
  });
});

describe("CLI 适配层（connectMerchant 行为兼容）", () => {
  it("完整直连：pending 后 authorized → bind → publish → activate，采用服务端分配的身份", async () => {
    const harness = await makeHarness({ pollsBeforeAuthorized: 1 });
    let nowMs = Date.now();
    const lines: string[] = [];
    const opened: string[] = [];
    const result = await connectMerchant({
      profile: PROFILE,
      dataDir: harness.dataDir,
      catalogUrl: harness.catalog.origin,
      publicOrigin: RUNTIME_ORIGIN,
      output: (line) => lines.push(line),
      openBrowser: (url) => opened.push(url),
      now: () => {
        nowMs += 5_000;
        return new Date(nowMs);
      },
      sleep: () => Promise.resolve(),
      fetchImpl: harness.serviceOptions.fetchImpl,
    });
    expect(result).toEqual({ agentId: AGENT_ID, bindingId: BINDING_ID, cardRevision: 1 });
    expect(lines.some((line) => line.includes("配对码 WDJB-001"))).toBe(true);
    expect(opened).toEqual([`${harness.catalog.origin}/activate`]);
    expect(harness.catalog.counts.binds).toBe(1);
    expect(harness.catalog.counts.publications).toBe(1);
    expect(harness.catalog.counts.activations).toBe(1);
  });

  it("缺少公网入口/非 https：沿用原错误码", async () => {
    await expect(connectMerchant({
      profile: PROFILE,
      dataDir: makeDataDir(),
      catalogUrl: "http://127.0.0.1:9",
    })).rejects.toMatchObject({ code: "PUBLIC_ORIGIN_MISSING" });
    await expect(connectMerchant({
      profile: PROFILE,
      dataDir: makeDataDir(),
      catalogUrl: "http://127.0.0.1:9",
      publicOrigin: "http://runtime.test",
    })).rejects.toMatchObject({ code: "PUBLIC_ORIGIN_INVALID" });
  });

  it("授权超时：抛 AUTHORIZATION_PENDING 且会话保留，重跑可续办", async () => {
    const harness = await makeHarness({ pollsBeforeAuthorized: 999 });
    let nowMs = Date.now();
    const advancingNow = (): Date => {
      nowMs += 5_000;
      return new Date(nowMs);
    };
    await expect(connectMerchant({
      profile: PROFILE,
      dataDir: harness.dataDir,
      catalogUrl: harness.catalog.origin,
      publicOrigin: RUNTIME_ORIGIN,
      now: advancingNow,
      sleep: () => Promise.resolve(),
      timeoutMs: 30_000,
      fetchImpl: harness.serviceOptions.fetchImpl,
    })).rejects.toMatchObject({ code: "AUTHORIZATION_PENDING" });
    // 会话保留在 preparing，重跑命令可以继续等待同一授权。
    expect(sessionRecord(harness.dataDir)["status"]).toBe("preparing");
  });

  it("授权窗口（grant）过期：不再尝试 bind，会话显式转 expired（A13 生产停滞回归）", async () => {
    const harness = await makeHarness();
    const service = createMerchantConnectionService(harness.serviceOptions);
    await service.begin();
    const done = await service.reconcile();
    expect(done.status).toBe("published");
    // 构造生产事故形态：会话停在 authorized 且授权窗口（=Catalog grant 窗口）已过。
    harness.catalog.counts.binds = 0;
    rewriteSessions(harness.dataDir, (session) => ({
      ...session,
      status: "authorized",
      binding_id: undefined,
      binding_version: undefined,
      binding_expires_at: undefined,
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    }));
    const summary = await service.reconcile();
    expect(summary.status).toBe("expired");
    expect(harness.catalog.counts.binds).toBe(0); // 绝不拿过期 grant 出站 bind
  });

  it("bind 阶段失败：自有稳定码进摘要 code/detail，状态保持 authorized 可重试；远端原文不反射", async () => {
    const harness = await makeHarness({
      pollsBeforeAuthorized: 1,
      failBindWith: { status: 403, code: "permission_denied" },
    });
    let nowMs = Date.now();
    const service = createMerchantConnectionService({
      ...harness.serviceOptions,
      now: () => new Date(nowMs),
    });
    await service.begin();
    await service.reconcile(); // 第一次 poll：authorization_pending（节流生效）
    nowMs += 6_000; // 越过节流：poll 返回 authorized → bind 403
    await expect(service.reconcile()).rejects.toThrow(); // 步骤失败上抛（tick 侧记录）
    const summary = await service.getSummary();
    expect(summary.status).toBe("authorized");
    expect(summary.code).toBe("REQUEST_REJECTED");
    expect(summary.detail).toBe("");
    expect(JSON.stringify(summary)).not.toContain("permission_denied");
  });
});
