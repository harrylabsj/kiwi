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
import { afterEach, expect, it } from "vitest";

import { canonicalize } from "../src/negotiation/jcs.js";
import { validateAgentCard } from "../src/discovery/agent-card/validate.js";
import { buildBindingClaims } from "../src/trust/binding/claims.js";
import { signCompactJws, type JwsSigningIdentity } from "../src/trust/identity/jws.js";
import { readEnrollmentStore } from "../src/cloud/binding/enrollment-challenge.js";
import {
  createMerchantConnectionService,
} from "../src/cloud/connect-service.js";
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
function tlsShim(
  realFetch: typeof fetch,
  ports: { runtime: number; catalog: number },
): typeof fetch {
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
  supportedInterfaces: [{ url: A2A_ENDPOINT, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
};

const APPROVED_DIGEST = (() => {
  const card = validateAgentCard(CARD);
  return `sha256:${createHash("sha256")
    .update(canonicalize(card as unknown as Record<string, unknown>), "utf8")
    .digest("hex")}`;
})();

const issuer = generateKeyPairSync("ed25519");
const ISSUER_KID = "catalog-issuer-stub";
const issuerIdentity: JwsSigningIdentity = {
  keyid: ISSUER_KID,
  algorithm: "ed25519",
  privateKey: issuer.privateKey,
};
const issuerJwk = issuer.publicKey.export({ format: "jwk" }) as {
  kty: string;
  crv: string;
  x: string;
};
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
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
  });
  response.end(payload);
}

interface CatalogStubOptions {
  /** 第几次 poll 起返回 authorized（默认 0 = 第一次就 authorized）。 */
  slowDown?: boolean;
  pollsBeforeAuthorized?: number;
  /** 非空时：对 bind 签发声明做篡改（模拟 card_url/merchant 等验真失配）。 */
  tamperBindClaims?: (claims: Record<string, unknown>) => Record<string, unknown>;
  /** 非空时：bind 端点固定返回该 403 错误码（模拟 grant 过期等确定性拒绝）。 */
  failBindWith?: { status: 403; code: string };
  /** 非空时：publish 端点固定返回该 HTTP 状态（模拟发布阶段拒绝）。 */
  failPublishWith?: { status: 403; code: string };
  /** publish 返回缺 revision 的回执（模拟回执不完整）。 */
  publishReceiptInvalid?: boolean;
  /** 重签声明用的时钟（缺省真实时钟）；与注入服务的 now 共享即可模拟时间推进。 */
  claimsNow?: () => Date;
}

interface CatalogStub {
  /** 对外 https origin（契约面）。 */
  origin: string;
  /** loopback 实际端口（TLS shim 目标）。 */
  port: number;
  close: () => Promise<void>;
  counts: {
    deviceCreates: number;
    polls: number;
    binds: number;
    publications: number;
    activations: number;
  };
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
  const failPublishWith = options.failPublishWith ?? null;
  const publishReceiptInvalid = options.publishReceiptInvalid ?? false;
  const tamperBindClaims = options.tamperBindClaims ?? null;
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
          keys: [
            { kid: ISSUER_KID, state: "ACTIVE", jwk: issuerJwk, thumbprint: issuerThumbprint },
          ],
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
        let claims = buildBindingClaims({
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
        if (tamperBindClaims !== null) {
          claims = tamperBindClaims(
            claims as unknown as Record<string, unknown>,
          ) as unknown as typeof claims;
        }
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
            claims_jws: signCompactJws(
              claims as unknown as Record<string, unknown>,
              issuerIdentity,
              {
                extraHeader: { typ: "kiwi-runtime-binding-claims" },
              },
            ),
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
        if (failPublishWith !== null) {
          sendJson(response, failPublishWith.status, { error: failPublishWith.code });
          return;
        }
        // 缺 revision 的回执 → 客户端 PUBLICATION_RECEIPT_INVALID（阶段码
        // CARD_PUBLISH_INVALID 归类路径）。
        sendJson(response, 200, publishReceiptInvalid ? { active_revision: 1 } : { revision: 1 });
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
        sendJson(response, 500, {
          ok: false,
          error: `stub failure: ${err instanceof Error ? err.message : String(err)}`,
        });
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
    set corruptClaims(
      value: ((claims: Record<string, unknown>) => Record<string, unknown>) | null,
    ) {
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
  runtimePort: number;
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
    runtimePort: runtime.port,
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
  const sessions = readEnrollmentStore(dataDir).sessions as unknown as Array<
    Record<string, unknown>
  >;
  const selected = sessions.find((session) => session["runtime_origin"] === RUNTIME_ORIGIN);
  if (selected === undefined) throw new Error("测试夹具：找不到本会话");
  return selected;
}

function _rewriteSessions(
  dataDir: string,
  mutate: (session: Record<string, unknown>) => Record<string, unknown>,
): void {
  const store = JSON.parse(
    readFileSync(path.join(dataDir, "merchant-enrollments.json"), "utf8"),
  ) as {
    sessions: Array<Record<string, unknown>>;
  };
  store.sessions = store.sessions.map((session) =>
    session["runtime_origin"] === RUNTIME_ORIGIN ? mutate(session) : session,
  );
  writeFileSync(path.join(dataDir, "merchant-enrollments.json"), `${JSON.stringify(store)}\n`);
}

const _PROFILE = {
  role: "merchant",
  agent_id: "agent_stub",
  owner_id: "owner_stub",
  name: "Stub 商家",
} as unknown as AgentProfile;

const CREDENTIAL_MARKERS = [
  "user_code",
  "device_code",
  "grant",
  "verification_uri",
  "device-code-",
  "WDJB-",
  "grant-stub",
];

function _expectNoCredentials(serialized: string): void {
  for (const marker of CREDENTIAL_MARKERS) {
    expect(serialized).not.toContain(marker);
  }
}

// ── 用例 ─────────────────────────────────────────────────────────────

import {
  MerchantConnectError,
  CONNECTION_PAIRING_SAFE_CODES,
} from "../src/cloud/connect-service.js";
import { withEnrollmentStoreLock } from "../src/cloud/binding/store-lock.js";
it("actual public JWS bad signature/plaintext mismatch cannot backfill a legacy merchant", async () => {
  const h = await makeHarness(),
    svc = createMerchantConnectionService(h.serviceOptions);
  await svc.begin();
  await svc.reconcile();
  const file = path.join(h.dataDir, "merchant-enrollments.json");
  const store = JSON.parse(readFileSync(file, "utf8"));
  delete store.sessions[0].merchant_id;
  writeFileSync(file, JSON.stringify(store));
  const before = readFileSync(file, "utf8");
  for (const mode of ["signature", "plaintext", "kid", "thumbprint"]) {
    const base = h.serviceOptions.fetchImpl;
    const fetchImpl = (async (input, init) => {
      const response = await base(input, init);
      if (String(input).endsWith("/runtime-binding")) {
        const parsed: unknown = await response.json();
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("fixture envelope is not an object");
        const json = parsed as Record<string, unknown>;
        if (typeof json["claims_jws"] !== "string") throw new Error("fixture signature missing");
        const signature = json["claims_jws"];
        const plain = json["claims"];
        if (plain === null || typeof plain !== "object" || Array.isArray(plain))
          throw new Error("fixture plaintext claims missing");
        const claims = plain as Record<string, unknown>;
        if (mode === "signature") {
          const pieces = signature.split(".");
          if (pieces[2] === undefined) throw new Error("fixture compact signature invalid");
          pieces[2] =
            pieces[2].slice(0, 10) + (pieces[2][10] === "A" ? "B" : "A") + pieces[2].slice(11);
          json.claims_jws = pieces.join(".");
        }
        if (mode === "plaintext") claims["merchant_id"] = "merchant-forged";
        if (mode === "kid") json.issuer_kid = "unknown";
        if (mode === "thumbprint") json.issuer_thumbprint = "sha256:" + "0".repeat(64);
        return new Response(JSON.stringify(json));
      }
      return response;
    }) as typeof fetch;
    const revived = createMerchantConnectionService({ ...h.serviceOptions, fetchImpl });
    expect(await revived.getVerifiedBinding()).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(before);
  }
  const valid = createMerchantConnectionService(h.serviceOptions);
  expect((await valid.getVerifiedBinding())?.merchantId).toBe(MERCHANT_CLAIM);
  expect(sessionRecord(h.dataDir).merchant_id).toBe(MERCHANT_CLAIM);
});
it("two instances block duplicate poll, stale pending CAS cannot overwrite advanced published", async () => {
  const h = await makeHarness({ pollsBeforeAuthorized: 10 });
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (arrived = r));
  const base = h.serviceOptions.fetchImpl;
  const held = (async (input, init) => {
    const response = await base(input, init);
    if (String(input).endsWith("/device/token")) {
      arrived();
      await gate;
    }
    return response;
  }) as typeof fetch;
  const a = createMerchantConnectionService({ ...h.serviceOptions, fetchImpl: held }),
    b = createMerchantConnectionService(h.serviceOptions);
  await a.begin();
  const running = a.reconcile();
  await seen;
  await expect(b.reconcile()).rejects.toMatchObject({ code: "CONNECTION_OPERATION_PENDING" });
  expect(h.catalog.counts.polls).toBe(1);
  withEnrollmentStoreLock(h.dataDir, () => {
    const file = path.join(h.dataDir, "merchant-enrollments.json"),
      s = JSON.parse(readFileSync(file, "utf8"));
    s.sessions[0].status = "published";
    // Legacy competing writer does not know store_revision; snapshot/status CAS must still reject.
    writeFileSync(file, JSON.stringify(s));
  });
  release();
  await expect(running).rejects.toMatchObject({ code: "STATE_CAS_CONFLICT" });
  expect(sessionRecord(h.dataDir).status).toBe("published");
});
it("readiness fixed code resumes same bound session; slow_down actual response increases polling interval", async () => {
  const h = await makeHarness();
  let ready = false;
  const svc = createMerchantConnectionService({
    ...h.serviceOptions,
    beforePublish: async () => {
      if (!ready)
        throw new MerchantConnectError("CATALOG_RUNTIME_NOT_READY", "unsafe detail never summary");
    },
  });
  await svc.begin();
  await expect(svc.reconcile()).rejects.toMatchObject({ code: "CATALOG_RUNTIME_NOT_READY" });
  expect((await svc.getSummary()).code).toBe("CATALOG_RUNTIME_NOT_READY");
  expect(sessionRecord(h.dataDir).status).toBe("bound");
  ready = true;
  expect((await svc.reconcile()).status).toBe("published");
  expect(h.catalog.counts.binds).toBe(1);
  for (const code of ["RUNTIME_UNREACHABLE", "RUNTIME_NOT_READY", "RUNTIME_IDENTITY_MISMATCH"])
    expect(CONNECTION_PAIRING_SAFE_CODES.has(code)).toBe(true);
  const h2 = await makeHarness();
  let now = Date.now(),
    polls = 0;
  const base = h2.serviceOptions.fetchImpl;
  const slow = (async (input, init) => {
    if (String(input).endsWith("/device/token")) {
      polls++;
      return new Response(JSON.stringify({ status: "slow_down", interval: 11 }));
    }
    return base(input, init);
  }) as typeof fetch;
  const s = createMerchantConnectionService({
    ...h2.serviceOptions,
    fetchImpl: slow,
    now: () => new Date(now),
  });
  await s.begin();
  await s.reconcile();
  now += 10000;
  await s.reconcile();
  expect(polls).toBe(1);
  now += 1001;
  await s.reconcile();
  expect(polls).toBe(2);
});

import { fork, type ChildProcess } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { loadOrCreateA2aSigningIdentity } from "../src/a2a/signing-key.js";
import { publicKeyThumbprint } from "../src/trust/binding/thumbprint.js";
function message(
  child: ChildProcess,
  predicate: (m: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", on);
      reject(new Error("child_message_timeout"));
    }, 5000);
    function on(m: Record<string, unknown>) {
      if (predicate(m)) {
        clearTimeout(timer);
        child.off("message", on);
        resolve(m);
      }
    }
    child.on("message", on);
  });
}
async function stopChild(child: ChildProcess) {
  const done = new Promise<void>((r) => child.once("exit", () => r()));
  child.send("stop");
  await Promise.race([
    done,
    new Promise<void>((_, j) =>
      setTimeout(() => {
        child.kill("SIGTERM");
        j(new Error("child_stop_timeout"));
      }, 3000),
    ),
  ]);
}
it("two real processes consume one challenge and publish once; callback RMW does not deadlock", async () => {
  const h = await makeHarness(),
    parent = createMerchantConnectionService({
      ...h.serviceOptions,
      beforePublish: async () => {
        throw new MerchantConnectError("CATALOG_RUNTIME_NOT_READY", "fixture waits");
      },
    });
  await parent.begin();
  await expect(parent.reconcile()).rejects.toMatchObject({ code: "CATALOG_RUNTIME_NOT_READY" });
  const script = path.resolve("tests/fixtures/a297-child.mjs"),
    children: ChildProcess[] = [];
  try {
    const responders = [0, 1].map(() => {
      const c = fork(script, ["challenge", h.dataDir], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      children.push(c);
      return c;
    });
    const ready = await Promise.all(responders.map((c) => message(c, (m) => m.ready === true)));
    const raw = loadOrCreateA2aSigningIdentity(h.dataDir, RUNTIME_ORIGIN),
      now = Date.now(),
      body = {
        audience: "kiwi-catalog",
        challenge: "A".repeat(43),
        enrollment_id: sessionRecord(h.dataDir).enrollment_id,
        expires_at: new Date(now + 60000).toISOString(),
        issued_at: new Date(now).toISOString(),
        key_thumbprint: publicKeyThumbprint(createPublicKey(raw.publicKeyPem)),
        origin: RUNTIME_ORIGIN,
      };
    const results = await Promise.all(
      ready.map((r) =>
        fetch(`http://127.0.0.1:${r.port}/.well-known/kiwi-binding-challenge`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(readEnrollmentStore(h.dataDir).consumed.length).toBe(1);
    await Promise.all(responders.map(stopChild));
    children.splice(0);
    const workers = [0, 1].map(() => {
      const c = fork(
        script,
        ["publish", h.dataDir, String(h.catalog.port), String(h.runtimePort)],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      children.push(c);
      return c;
    });
    await Promise.all(workers.map((c) => message(c, (m) => m.ready === true)));
    const outcomes = workers.map((c) =>
      message(c, (m) => m.result !== undefined || m.error !== undefined),
    );
    workers.forEach((c) => c.send("go"));
    const done = await Promise.all(outcomes);
    expect(done.filter((m) => m.error === "CONNECTION_OPERATION_PENDING").length).toBe(1);
    expect(done.filter((m) => m.result !== undefined).length).toBe(1);
    expect(h.catalog.counts.binds).toBe(1);
    expect(h.catalog.counts.publications).toBe(1);
    expect(h.catalog.counts.activations).toBe(1);
    expect(sessionRecord(h.dataDir).status).toBe("published");
    expect(readEnrollmentStore(h.dataDir).consumed.length).toBe(2);
  } finally {
    await Promise.all(children.map(stopChild));
  }
});
it("lost effect reply and expired claim cannot rebind or start another enrollment automatically", async () => {
  const h = await makeHarness(),
    base = h.serviceOptions.fetchImpl;
  const lost = (async (input, init) => {
    const r = await base(input, init);
    if (String(input).endsWith("/runtime-bindings")) throw new TypeError("synthetic reply lost");
    return r;
  }) as typeof fetch;
  const a = createMerchantConnectionService({ ...h.serviceOptions, fetchImpl: lost });
  await a.begin();
  await expect(a.reconcile()).rejects.toThrow();
  expect(h.catalog.counts.binds).toBe(1);
  expect((sessionRecord(h.dataDir).operation_claim as { state: string }).state).toBe("unknown");
  const b = createMerchantConnectionService(h.serviceOptions);
  await expect(b.reconcile()).rejects.toMatchObject({ code: "CONNECTION_OPERATION_UNKNOWN" });
  expect(h.catalog.counts.binds).toBe(1);
  const expired = createMerchantConnectionService({
    ...h.serviceOptions,
    now: () => new Date(Date.now() + 3600000),
  });
  await expect(expired.begin()).rejects.toMatchObject({ code: "CONNECTION_OPERATION_UNKNOWN" });
  expect(h.catalog.counts.deviceCreates).toBe(1);
  expect(readEnrollmentStore(h.dataDir).consumed).toEqual([]);
});
it("concurrent begin claims creation before network, does not create a duplicate enrollment", async () => {
  const h = await makeHarness(),
    base = h.serviceOptions.fetchImpl;
  let arrived!: () => void, release!: () => void;
  const seen = new Promise<void>((r) => (arrived = r)),
    gate = new Promise<void>((r) => (release = r));
  const held = (async (input, init) => {
    const r = await base(input, init);
    if (String(input).endsWith("/enrollments/device")) {
      arrived();
      await gate;
    }
    return r;
  }) as typeof fetch;
  const a = createMerchantConnectionService({ ...h.serviceOptions, fetchImpl: held }),
    b = createMerchantConnectionService(h.serviceOptions);
  const first = a.begin();
  await seen;
  await expect(b.begin()).rejects.toMatchObject({ code: "CONNECTION_OPERATION_UNKNOWN" });
  release();
  await first;
  expect(h.catalog.counts.deviceCreates).toBe(1);
  expect((await b.begin()).status).toBe("awaiting_confirmation");
  expect(h.catalog.counts.deviceCreates).toBe(1);
});
