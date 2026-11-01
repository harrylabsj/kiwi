/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * 真实三方跨进程联调（开放询价）：买家（本进程，真实买家代码）→ 真实目录
 * ASGI（uvicorn + TLS，独立 python 进程）→ 真实商家 A2A（独立 node 进程，
 * 前置模拟网关剥码）。
 *
 * 真实性边界（如实记录，不夸大）：
 *   - 目录→商家：真实 socket + TLS 握手（测试 CA 签发的 merchant.test 证书，
 *     目录进程经 SSL_CERT_FILE 信任）+ pinned-IP 直连 + 原样签名头/字节 + 网关
 *     校验并剥离分享参数；**唯一替身**是目录进程内 `merchant.test` 的
 *     DNS→127.0.0.3 映射（白名单内受控主机名）——生产 DNS+SSRF 路径（公网 IP、
 *     系统 DNS、真实 CA）无法在无根单机上安全构造，IP 黑名单本身由既有单测
 *     覆盖（discovery fetcher blocked-range 测试）。
 *   - 买家→目录：真实 TLS（测试 CA，证书 SAN IP:127.0.0.2）。
 *   - 全部身份为测试身份；证据只写临时目录；不触碰生产与真实凭据。
 */
import { execFile, spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";

import { CatalogClient } from "../src/cloud/catalog-client.js";
import { buildWorkbuddyAccessConfig, parseWorkbuddyShareLink, WORKBUDDY_CUSTODY_TERMS_VERSION } from "../src/cloud/access/workbuddy-share-link.js";
import { loadOrCreateA2aSigningIdentity, toJwsSigningIdentity } from "../src/a2a/signing-key.js";
import { OpenInquirySource } from "../src/discovery/catalog-source/open-inquiry.js";
import { loadOpenInquirySigner } from "../src/buyer-core/open-inquiry-signer.js";
import { buildA2AClient } from "../src/buyer-core/a2a-knp.js";

const CATALOG_ORIGIN = "https://127.0.0.1:9443"; // 商家 8443(TrustPolicy 白名单端口);目录 9443 仅买家访问
const MERCHANT_ORIGIN = "https://merchant.test:8443"; // 127.0.0.1:8443;DNS 由目录进程内测试替身映射
const MERCHANT_A2A = `${MERCHANT_ORIGIN}/a2a`;
const AGENT_ID = "cagt_e2e_openinquiry";
const MERCHANT_ID = "mkt_e2e_openinquiry";
const TERMS = WORKBUDDY_CUSTODY_TERMS_VERSION;
const SHARE_SECRET = `e2e-share-${createHash("sha256").update(String(process.pid)).digest("hex").slice(0, 16)}`;
const CATALOG_REPO = path.resolve("../kiwi-catalog");
// 明确有界时限:每个等待都有上限,目录就绪最多 2 次尝试;失败即出结构化诊断,
// 绝不无界重试。所有等待用 waitUntil(有界),子进程只按记录的句柄 kill。
const MERCHANT_READY_TIMEOUT_MS = 15_000;
const CATALOG_READY_TIMEOUT_MS = 30_000;
const CATALOG_ATTEMPTS = 2;

const UNCOVERED_SCOPE = [
  "无账号发起与响应(sendMessage/getTask 全链路)",
  "不同买家会话隔离(-32001)",
  "重放拒绝(502 通用收敛)",
  "商家侧开放询价开关 off/on",
  "授权撤回后买家探测 404",
  "网关剥码证据(线上有效、零泄露)",
];

const cleanups: Array<() => void> = [];
let EVIDENCE = "";
let state: {
  grant: string;
  catalog: CatalogClient;
  runtimeDir: string;
  flagFile: string;
  merchantEvidence: string;
  bindingId: string;
  context: { agentId: string; bindingId: string; keyId: string; runtimeOrigin: string; serviceEpoch: number };
  identity: { signingIdentity: ReturnType<typeof toJwsSigningIdentity>; keyId: string };
  buyer: OpenInquirySource;
  route: Awaited<ReturnType<OpenInquirySource["get"]>>;
  taskId?: string;
  firstWire?: { url: string; body: Buffer; headers: Record<string, string> };
} | null = null;

const run = (cmd: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, ...options }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`${cmd} failed: ${stderr || error.message}`));
      else resolve(String(stdout));
    });
  });

function makeHttpsFetch(caPem: string): typeof fetch {
  const ca = readFileSync(caPem);
  return (async (input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : String(input));
    const rawBody = init?.body;
    const body = rawBody === undefined || rawBody === null
      ? undefined
      : Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(typeof rawBody === "string" ? rawBody : String(rawBody));
    const message = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const request = httpsRequest(
        {
          host: url.hostname, port: Number(url.port || 443), path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()),
          ca, servername: url.hostname,
        },
        resolve,
      );
      request.on("error", reject);
      if (body !== undefined) request.end(body); else request.end();
    });
    const chunks: Buffer[] = [];
    for await (const chunk of message) chunks.push(Buffer.from(chunk as Buffer));
    const headers = new Headers();
    for (const [name, value] of Object.entries(message.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    }
    return new Response(Buffer.concat(chunks), { status: message.statusCode ?? 0, headers });
  }) as typeof fetch;
}

const appendSync = (file: string, text: string): void => {
  writeFileSync(file, text, { flag: "a" });
};
const safeRead = (file: string): string => existsSync(file) ? readFileSync(file, "utf8") : "";

const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 60_000, step = 300): Promise<void> => {
  const started = Date.now();
  while (true) {
    let ok = false;
    try { ok = await predicate(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() - started > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, step));
  }
};

const MERCHANT_ENTRY = `
import { createServer } from "node:https";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { A2AServer } from "<SRC>/a2a/server/index.js";
import { echoHandler } from "<SRC>/a2a/server/handler.js";
import { createA2aAuthVerifier } from "<SRC>/a2a/node.js";
import { InquiryNonceStore } from "<SRC>/a2a/inquiry-nonce-store.js";
import { createEnrollmentChallengeResponder } from "<SRC>/cloud/binding/enrollment-challenge.js";
import { createChallengeResponder } from "<SRC>/cloud/binding/runtime-challenge.js";
import { loadA2aSigningIdentityFromFile, toJwsSigningIdentity } from "<SRC>/a2a/signing-key.js";
import { LedgerStore } from "<SRC>/negotiation/ledger/index.js";
import { IdempotencyStore } from "<SRC>/negotiation/idempotency/index.js";

const [origin, shareSecret, runtimeDir, flagFile, evidenceFile, agentId, merchantId] = process.argv.slice(2);
const nonces = new InquiryNonceStore(runtimeDir);
const identityRaw = loadA2aSigningIdentityFromFile(path.join(runtimeDir, "a2a-signing-key.json"));
const server = new A2AServer({
  card: () => ({ name: "E2E Merchant", description: "three-party e2e merchant",
    providerOrganization: "e2e", version: "1.0.0", baseUrl: origin, a2aPath: "/a2a" }),
  ledger: new LedgerStore({ dir: path.join(runtimeDir, "ledger") }),
  idempotency: new IdempotencyStore({ dir: path.join(runtimeDir, "idem") }),
  handler: echoHandler(),
  authVerifier: createA2aAuthVerifier({ mode: "signature", signingKeyDir: runtimeDir,
    signingKeyId: origin, advertisedBase: origin, authoritySource: "declared",
    openInquiryNonceStore: nonces, openInquiryEnabled: () => existsSync(flagFile) }),
});
const a2aHandler = server.handler();
const challengeHandler = createEnrollmentChallengeResponder({
  dataDir: runtimeDir, signingIdentity: toJwsSigningIdentity(identityRaw) });
// PUT runtime-access 的端点挑战(/control/challenge):direct 身份接线,只认
// 本地已验证绑定身份;generation = service_epoch(7)。
const accessChallengeHandler = createChallengeResponder({
  signingIdentity: toJwsSigningIdentity(identityRaw),
  expectedMerchantId: "unused", expectedAgentId: "unused",
  expectedBindingIdentity: () => ({ merchantId, agentId }),
  currentGeneration: 7, expectedOrigin: origin, expectedPath: "/a2a",
});
const app = (req, res) => {
  const url = new URL(req.url ?? "/", origin);
  const code = url.searchParams.get("sharecode");
  if (code !== null) {
    appendFileSync(evidenceFile, JSON.stringify({ path: url.pathname, sharecode_on_wire: true, code_valid: code === shareSecret }) + "\\n");
    if (code !== shareSecret) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "gateway_forbidden" }));
      return;
    }
    req.url = url.pathname; // 模拟网关:校验后剥离分享参数,源站只见裸路径
  } else {
    appendFileSync(evidenceFile, JSON.stringify({ path: url.pathname, sharecode_on_wire: false }) + "\\n");
  }
  if (url.pathname === "/.well-known/kiwi-binding-challenge") { challengeHandler(req, res); return; }
  if (url.pathname === "/control/challenge") { accessChallengeHandler(req, res); return; }
  a2aHandler(req, res);
};
createServer({ key: readFileSync(path.join(runtimeDir, "merchant.key")),
  cert: readFileSync(path.join(runtimeDir, "merchant.crt")) }, app)
  .listen(8443, "127.0.0.1", () => console.log("merchant ready"));
`;

const E2E_CARD = {
  name: "E2E Merchant", description: "three-party e2e merchant",
  provider: { organization: "e2e" }, version: "1.0.0", url: MERCHANT_ORIGIN,
  supportedInterfaces: [{ url: MERCHANT_A2A, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
};

const SEED_PY = `
import hashlib, json, os, sys
from datetime import datetime, timedelta, timezone
sys.path.insert(0, "<CATALOG_REPO>")
EVIDENCE = sys.argv[1]
RUNTIME_JWK = json.loads(sys.argv[2])
APPROVED_DIGEST = sys.argv[3]
from kiwi_catalog.a2a.binding_claims import jwk_thumbprint
from kiwi_catalog.db.session import open_connection
from kiwi_catalog.services import enrollments as enrollment_service
conn = open_connection(os.path.join(EVIDENCE, "catalog.sqlite"))
conn.execute("insert into catalog_agents(catalog_agent_id,merchant_id,display_name,source_type,"
             "first_seen_at,last_seen_at,created_at,updated_at) values(?,?,?,'self_registered','t','t','t','t')",
             ("<AGENT>", "<MERCHANT>", "E2E Merchant"))
enrollment_id = "enr_e2e_openinquiry"
device_code = "device-code-e2e-" + "x" * 36
device_hash = hashlib.sha256(device_code.encode()).hexdigest()
now = datetime.now(timezone.utc).replace(microsecond=0)
grant = enrollment_service._stable_grant(enrollment_id, device_hash)
conn.execute(
    "insert into enrollments(enrollment_id,device_code_hash,user_code,status,key_id,key_thumbprint,"
    "key_jwk_json,runtime_origin,a2a_endpoint,generation,service_epoch,public_preview_json,"
    "public_profile_revision,approved_card_digest,merchant_id,catalog_agent_id,grant_hash,scopes_json,"
    "expected_binding_version,binding_id,created_at,expires_at,grant_expires_at) "
    "values(?,?,?,?,?,?,?,?,?,1,7,?,'profile-v1',?,?,?,?,?,1,'',?,?,?)",
    (enrollment_id, device_hash, "E2E12345", "authorized", "<ORIGIN>", jwk_thumbprint(RUNTIME_JWK),
     json.dumps(RUNTIME_JWK, separators=(",", ":")), "<ORIGIN>", "<ENDPOINT>",
     json.dumps({"name": "E2E Merchant", "description": "public", "skills": []}),
     APPROVED_DIGEST, "<MERCHANT>", "<AGENT>",
     hashlib.sha256(grant.encode()).hexdigest(),
     json.dumps(["runtime:bind", "card:publish", "heartbeat"]),
     now.isoformat(), (now + timedelta(minutes=30)).isoformat(),
     (now + timedelta(minutes=30)).isoformat()))
conn.commit(); conn.close()
print(json.dumps({"enrollment_id": enrollment_id, "grant": grant}))
`.replaceAll("<AGENT>", AGENT_ID).replaceAll("<MERCHANT>", MERCHANT_ID)
 .replaceAll("<ORIGIN>", MERCHANT_ORIGIN).replaceAll("<ENDPOINT>", MERCHANT_A2A);

const CATALOG_DRIVER_PY = `
import os, sys
sys.path.insert(0, "<CATALOG_REPO>")
DB, CERT, KEY = sys.argv[1], sys.argv[2], sys.argv[3]
# 测试替身(仅 DNS→IP 映射,白名单内受控主机名):生产 DNS+SSRF 路径无法在
# 无根单机上安全构造;真实 TLS/socket/签名/网关/业务全部保持真实。
import kiwi_catalog.discovery.fetcher as fetcher
TEST_HOSTS = {"merchant.test": "127.0.0.1"}
_original = fetcher._resolve_and_validate
def _test_resolve_and_validate(hostname, port, *, deadline=None):
    if hostname in TEST_HOSTS:
        return TEST_HOSTS[hostname]
    return _original(hostname, port, deadline=deadline)
fetcher._resolve_and_validate = _test_resolve_and_validate
import uvicorn
from kiwi_catalog.api.app import create_catalog_app
if os.environ.get("KIWI_E2E_DRILL_CATALOG_BIND_FAILURE") == "1":
    # 受控演练:占住端口模拟 uvicorn 绑定失败,验证有界重试与结构化诊断路径。
    import socket as _socket
    _s = _socket.socket(); _s.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
    _s.bind(("127.0.0.1", 9443)); _s.listen(1)
    print("driver: DRILL socket occupying 9443", flush=True)
print("driver: starting uvicorn on 127.0.0.1:9443", flush=True)
uvicorn.run(create_catalog_app(DB), host="127.0.0.1", port=9443,
            ssl_certfile=CERT, ssl_keyfile=KEY, log_level="info", access_log=False)
`.replaceAll("<CATALOG_REPO>", CATALOG_REPO);

describe("three-party open-inquiry cross-process E2E", () => {
  let buyerFetch: typeof fetch;
  let issuerJwk: { kty: string; crv: string; x: string };

  beforeAll(async () => {
    EVIDENCE = mkdtempSync(path.join(tmpdir(), "kiwi-three-party-e2e-"));
    // 证据目录保留不删(排查与审计用);基线记录见测试输出。

    // 1) 测试 CA 与两张服务器证书(目录=IP 127.0.0.2;商家=DNS merchant.test)。
    const caKey = path.join(EVIDENCE, "ca.key"), caPem = path.join(EVIDENCE, "ca.pem");
    await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", caKey, "-out", caPem,
      "-days", "2", "-nodes", "-subj", "/CN=kiwi-e2e-test-ca",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    const issueCert = async (name: string, cn: string, san: string): Promise<string> => {
      const key = path.join(EVIDENCE, `${name}.key`), csr = path.join(EVIDENCE, `${name}.csr`);
      const crt = path.join(EVIDENCE, `${name}.crt`), ext = path.join(EVIDENCE, `${name}.ext`);
      writeFileSync(ext, `subjectAltName=${san}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
      await run("openssl", ["req", "-newkey", "rsa:2048", "-keyout", key, "-out", csr, "-nodes", "-subj", `/CN=${cn}`]);
      await run("openssl", ["x509", "-req", "-in", csr, "-CA", caPem, "-CAkey", caKey, "-CAcreateserial",
        "-out", crt, "-days", "2", "-extfile", ext]);
      return crt;
    };
    const catalogCert = await issueCert("catalog", "127.0.0.1", "IP:127.0.0.1");
    await issueCert("merchant", "merchant.test", "DNS:merchant.test,IP:127.0.0.1");

    // 2) 运行时身份(商家 A2A、目录控制面共用同一持久密钥)。
    const runtimeDir = path.join(EVIDENCE, "runtime-state");
    const identity = loadOrCreateA2aSigningIdentity(runtimeDir, MERCHANT_ORIGIN);
    const { runtimePublicKey } = await import("../src/cloud/catalog-client.js");
    const runtimeIdentity = { signingIdentity: toJwsSigningIdentity(identity), keyId: MERCHANT_ORIGIN };
    const runtimeKey = runtimePublicKey(runtimeIdentity);
    const runtimeJwk = runtimeKey.keyJwk;
    // 与真实运行时一致:发起 enrollment 时在本地写 enrollment 会话记录,
    // 挑战应答器据它核对挑战与持有密钥(否则 403 enrollment_not_authorized)。
    const futureExpiry = new Date(Date.now() + 30 * 60_000).toISOString();
    writeFileSync(path.join(runtimeDir, "merchant-enrollments.json"), JSON.stringify({
      version: 1,
      sessions: [{ version: 1, enrollment_id: "enr_e2e_openinquiry", status: "authorized",
        runtime_origin: MERCHANT_ORIGIN, a2a_endpoint: MERCHANT_A2A,
        key_id: MERCHANT_ORIGIN, key_thumbprint: runtimeKey.keyThumbprint,
        merchant_id: MERCHANT_ID, catalog_agent_id: AGENT_ID, generation: 1,
        catalog_origin: CATALOG_ORIGIN, expires_at: futureExpiry }],
      consumed: [],
    }));
    writeFileSync(path.join(runtimeDir, "merchant.key"), readFileSync(path.join(EVIDENCE, "merchant.key")));
    writeFileSync(path.join(runtimeDir, "merchant.crt"), readFileSync(path.join(EVIDENCE, "merchant.crt")));
    void identity;

    // 3) 目录 issuer(测试身份):买家信任锚与目录 env 同一把。
    const issuer = generateKeyPairSync("ed25519");
    writeFileSync(path.join(EVIDENCE, "issuer.pem"),
      issuer.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    issuerJwk = {
      kty: "OKP", crv: "Ed25519",
      x: issuer.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
    };

    // 4) 种子目录库(agent + authorized enrollment,测试身份直写 DB)。
    // 本测试使用**专属 venv**(evidence 目录内,经 UV_PROJECT_ENVIRONMENT 外置):
    // 与其他并发测试(demo-runner 等)的目录环境完全隔离,且 pristine sibling
    // 内绝不产生 .venv/缓存(npm-shipping 守卫要求 sibling 连 ignored 文件都干净)。
    const e2eVenv = path.join(EVIDENCE, "e2e-venv");
    const e2eUvEnv = { ...process.env,
      UV_PROJECT_ENVIRONMENT: e2eVenv, UV_CACHE_DIR: path.join(EVIDENCE, "uv-cache") };
    const seed = path.join(EVIDENCE, "seed.py");
    writeFileSync(seed, SEED_PY);
    // 专属 venv 需含 API 栈(uvicorn/FastAPI):先按 locked 契约同步 --extra api。
    await run("uv", ["sync", "--locked", "--extra", "api"], { cwd: CATALOG_REPO, env: e2eUvEnv });
    const { canonicalize } = await import("../src/negotiation/jcs.js");
    const approvedDigest = `sha256:${createHash("sha256").update(canonicalize(E2E_CARD as unknown as Record<string, unknown>), "utf8").digest("hex")}`;
    const seedOut = await run("uv", ["run", "--locked", "python", seed, EVIDENCE,
      JSON.stringify(runtimeJwk), approvedDigest], {
      cwd: CATALOG_REPO,
      env: { ...e2eUvEnv, KIWI_CATALOG_OWNER_TOKEN_SECRET: "e2e-owner-secret-not-real" },
    });
    const { grant } = JSON.parse(seedOut.trim()) as { grant: string };

    // 5) 打包并启动商家进程(443@127.0.0.3:网关剥码 + 真实 A2A + enrollment 挑战)。
    const merchantEvidence = path.join(EVIDENCE, "merchant-requests.jsonl");
    writeFileSync(merchantEvidence, "");
    const flagFile = path.join(EVIDENCE, "open-inquiry-enabled.flag");
    writeFileSync(flagFile, "on");
    const entry = path.join(EVIDENCE, "merchant-entry.mjs");
    writeFileSync(entry, MERCHANT_ENTRY.replaceAll("<SRC>", path.resolve("src")));
    await build({ entryPoints: [entry], outfile: path.join(EVIDENCE, "merchant.mjs"),
      bundle: true, format: "esm", platform: "node", target: "node22", sourcemap: false, logLevel: "silent" });
    const merchant = spawn(process.execPath, [path.join(EVIDENCE, "merchant.mjs"),
      MERCHANT_ORIGIN, SHARE_SECRET, runtimeDir, flagFile, merchantEvidence, AGENT_ID, MERCHANT_ID],
      { stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_PATH: path.resolve("node_modules") } });
    merchant.stdout.on("data", (c) => appendSync(path.join(EVIDENCE, "merchant.stdout.log"), String(c)));
    merchant.stderr.on("data", (c) => appendSync(path.join(EVIDENCE, "merchant.stderr.log"), String(c)));
    cleanups.push(() => merchant.kill("SIGTERM"));

    // 6) 启动目录进程(uvicorn + TLS;env 含 issuer/代管加密/测试 CA)。
    const fernetKey = Buffer.from(createHash("sha256").update("e2e-fernet").digest()).toString("base64");
    const driver = path.join(EVIDENCE, "catalog-driver.py");
    writeFileSync(driver, CATALOG_DRIVER_PY);
    // 买家侧 TLS fetch 先行就绪(目录/商家就绪探测都依赖它)。
    buyerFetch = makeHttpsFetch(caPem);
    // 目录就绪:最多 CATALOG_ATTEMPTS 次有界尝试;每次日志独立落盘;失败即报。
    const completedSteps: string[] = [
      "test CA + server certs issued (openssl)",
      "runtime identity + issuer identity generated",
      "merchant enrollment store seeded (test identity)",
      "catalog sqlite seeded (agent + authorized enrollment)",
      "merchant entry bundled + spawned (gateway/A2A/challenge on 127.0.0.1:8443)",
      "merchant ready probed over real TLS",
    ];
    let catalogChild: ReturnType<typeof spawn> | undefined;
    const attemptLogs: string[] = [];
    let catalogReady = false;
    for (let attempt = 1; attempt <= CATALOG_ATTEMPTS && !catalogReady; attempt += 1) {
      completedSteps.push(`catalog start attempt ${attempt}/${CATALOG_ATTEMPTS}`);
      attemptLogs.push(`--- attempt ${attempt} ---`);
      // 直接用专属 venv python:uv run 的孙进程在 SIGTERM 下可能存活并占用
      // 端口,直启让 kill 精确命中 uvicorn 本体(仅本测试记录的子进程)。
      catalogChild = spawn(path.join(e2eVenv, "bin", "python"), [driver,
        path.join(EVIDENCE, "catalog.sqlite"), catalogCert, path.join(EVIDENCE, "catalog.key")], {
        cwd: CATALOG_REPO,
        env: {
          ...e2eUvEnv,
          KIWI_CATALOG_ISSUER_KEY_FILE: path.join(EVIDENCE, "issuer.pem"),
          KIWI_CATALOG_ISSUER_KID: "catalog-issuer-e2e",
          KIWI_CATALOG_ISSUER_NAME: "catalog.e2e.test",
          KIWI_CATALOG_PUBLIC_ORIGIN: CATALOG_ORIGIN,
          KIWI_CATALOG_ACCESS_CONFIG_KEYS_JSON: JSON.stringify({ "ka-e2e-v1": fernetKey }),
          KIWI_CATALOG_ACCESS_CONFIG_ACTIVE_KEY_ID: "ka-e2e-v1",
          KIWI_CATALOG_ACCESS_CUSTODY_ENABLED: "1",
          SSL_CERT_FILE: caPem,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdoutLog = path.join(EVIDENCE, `catalog.attempt${attempt}.stdout.log`);
      const stderrLog = path.join(EVIDENCE, `catalog.attempt${attempt}.stderr.log`);
      catalogChild.stdout?.on("data", (c) => appendSync(stdoutLog, String(c)));
      catalogChild.stderr?.on("data", (c) => appendSync(stderrLog, String(c)));
      catalogChild.on("exit", (code) => appendSync(path.join(EVIDENCE, `catalog.attempt${attempt}.exit.log`), `exit ${code}\n`));
      catalogChild.on("error", (error) => appendSync(path.join(EVIDENCE, `catalog.attempt${attempt}.exit.log`), `spawn-error ${error}\n`));
      cleanups.push(() => catalogChild?.kill("SIGTERM"));
      const child = catalogChild; // 闭包内收窄非空
      let lastProbe = "";
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`not ready within ${CATALOG_READY_TIMEOUT_MS}ms (last probe: ${lastProbe})`)),
            CATALOG_READY_TIMEOUT_MS);
          const poll = setInterval(() => {
            if ((child.exitCode !== null && child.exitCode !== undefined) || child.signalCode !== null) {
              clearTimeout(timer); clearInterval(poll);
              reject(new Error(`catalog process exited early (code=${child.exitCode}, signal=${child.signalCode}; last probe: ${lastProbe})`));
              return;
            }
            void (async () => {
              try {
                const probe = await buyerFetch(`${CATALOG_ORIGIN}/v1/agents/${AGENT_ID}/public-inquiry`);
                lastProbe = `status=${probe.status}`;
                if (probe.status === 404) { clearTimeout(timer); clearInterval(poll); resolve(); }
              } catch (error) {
                lastProbe = `error=${error instanceof Error ? error.message : String(error)}`;
              }
            })();
          }, 250);
        });
        catalogReady = true;
        completedSteps.push("catalog ready probed over real TLS (404 = up, consent off)");
      } catch {
        catalogChild.kill("SIGTERM"); // 仅终止本测试记录的子进程
        attemptLogs.push(`attempt ${attempt} lastProbe: ${lastProbe || "(none)"}; stderr/stdout tail: ${
          (safeRead(stderrLog) + safeRead(stdoutLog)).slice(-900) || "(empty)"}`);
      }
    }
    if (!catalogReady) {
      // 结构化诊断:已完成步骤 + 各次尝试日志 + 未覆盖范围;不重试、不声称通过。
      const diagnostics = {
        failure: "catalog process did not become ready within bounded retries",
        completedSteps, attemptLogs,
        uncoveredScope: UNCOVERED_SCOPE,
        evidenceDir: EVIDENCE,
      };
      writeFileSync(path.join(EVIDENCE, "diagnostics.json"), JSON.stringify(diagnostics, null, 1));
      throw new Error(`CATALOG NOT READY — 已完成: ${completedSteps.join(" | ")}\n` +
        `尝试日志: ${attemptLogs.join(" || ")}\n未覆盖范围: ${UNCOVERED_SCOPE.join("; ")}\n` +
        `证据目录: ${EVIDENCE}(diagnostics.json)`);
    }

    // 7) 双端就绪探测(经真实 TLS;买家 fetch 已在上方初始化)。
    try {
      await waitUntil(async () =>
        (await buyerFetch(`${CATALOG_ORIGIN}/v1/agents/${AGENT_ID}/public-inquiry`)).status === 404);
    } catch (error) {
      throw new Error(`catalog not ready: ${error as string} | stderr: ${
        (safeRead(path.join(EVIDENCE, "catalog.stderr.log")) + safeRead(path.join(EVIDENCE, "catalog.stdout.log"))).slice(-1500)}`,
        { cause: error });
    }
    // 商家就绪探测:直连回环 IP + SNI=merchant.test(买家业务路径从不直连商家)。
    await waitUntil(async () => {
      const raw = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const request = httpsRequest({ host: "127.0.0.1", port: 8443,
          path: "/.well-known/agent-card.json", method: "GET",
          ca: readFileSync(path.join(EVIDENCE, "ca.pem")), servername: "merchant.test" }, resolve);
        request.on("error", reject);
        request.end();
      });
      const status = raw.statusCode ?? 0;
      raw.resume();
      return status === 200;
    }, MERCHANT_READY_TIMEOUT_MS);

    // 调试记录:目录控制面非 2xx 响应体落盘(定位发布拒绝原因)。
    const debugFetch: typeof fetch = async (input, init) => {
      const response = await buyerFetch(input, init);
      if (response.status >= 400) {
        const text = await response.clone().text();
        appendSync(path.join(EVIDENCE, "catalog-4xx.log"),
          `${new URL(typeof input === "string" ? input : String(input)).pathname} ${response.status} ${text.slice(0, 400)}\n`);
      }
      return response;
    };
    state = {
      grant,
      catalog: new CatalogClient({ baseUrl: CATALOG_ORIGIN, fetchImpl: debugFetch }),
      runtimeDir, flagFile, merchantEvidence,
      bindingId: "",
      context: { agentId: AGENT_ID, bindingId: "", keyId: MERCHANT_ORIGIN, runtimeOrigin: MERCHANT_ORIGIN, serviceEpoch: 7 },
      identity: runtimeIdentity,
      buyer: new OpenInquirySource({
        catalogOrigin: CATALOG_ORIGIN,
        trust: { resolveIssuerKey: (kid) => kid === "catalog-issuer-e2e" ? issuerJwk : undefined },
        signer: loadOpenInquirySigner(path.join(EVIDENCE, "buyer-a"), "principal-e2e-a", "buyer-a"),
        fetchImpl: buyerFetch,
      }),
      route: null,
    };
  }, 240_000);

  afterAll(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it("后台未开放:无授权时买家探测不可用(404),路由为 null", async () => {
    expect(await state!.buyer.get(AGENT_ID, MERCHANT_ID)).toBeNull();
  }, 30_000);

  it("授权并全链路:绑定(真实挑战跳)→ 托管 → 同意 → 买家无账号发起并获得响应", async () => {
    const { catalog, identity } = state!;
    // 绑定:accessConfig 随绑提交 → 目录经真实 TLS 向商家挑战(网关剥码)→ bound。
    const binding = await catalog.bindEnrollment({
      enrollmentId: "enr_e2e_openinquiry",
      grant: state!.grant,
      catalogAgentId: AGENT_ID,
      merchantId: MERCHANT_ID,
      runtimeOrigin: MERCHANT_ORIGIN,
      a2aEndpoint: MERCHANT_A2A,
      generation: 1,
      serviceEpoch: 7,
      authorizationEpoch: 1,
      accessConfig: buildWorkbuddyAccessConfig(
        parseWorkbuddyShareLink(`https://merchant.test/?sharecode=${SHARE_SECRET}`), 0, TERMS),
    }, identity);
    expect(binding.bindingId).toBeTruthy();
    expect(binding.runtimeAccess?.applied).toBe(true);
    state!.bindingId = binding.bindingId;
    state!.context = { ...state!.context, bindingId: binding.bindingId };

    // 发布名片并激活(买家解析依赖)。
    await catalog.publishCard({
      agentId: AGENT_ID, bindingId: binding.bindingId, generation: 1, expectedRevision: 0,
      a2aEndpoint: MERCHANT_A2A, runtimeOrigin: MERCHANT_ORIGIN,
      agentCard: E2E_CARD,
    }, identity);
    await catalog.activateCard({ agentId: AGENT_ID, bindingId: binding.bindingId,
      cardRevision: 1, expectedRevision: 0 }, identity);

    // 代管托管(签名 PUT)与开放询价同意(独立授权)。
    await catalog.updateRuntimeAccess(state!.context, identity,
      buildWorkbuddyAccessConfig(parseWorkbuddyShareLink(`https://merchant.test/?sharecode=${SHARE_SECRET}`), 1, TERMS));
    expect(await catalog.setPublicInquiryConsent(state!.context, identity, true))
      .toMatchObject({ granted: true });

    // 买家:无账号解析 + 经目录的真实中继发起询价并获得响应。
    const route = await state!.buyer.get(AGENT_ID, MERCHANT_ID);
    expect(route).not.toBeNull();
    expect(route!.endpoint).toBe(MERCHANT_A2A);
    state!.route = route;
    const client = buildA2AClient(route!.endpoint, {
      signer: route!.signer, skipDnsCheck: true,
      fetchImpl: recording(route!.fetchImpl),
    });
    const task = await client.sendMessage({
      role: "user", messageId: "e2e-inquiry-1",
      parts: [{ kind: "text", text: "请对 SKU-1 报价" }],
    });
    expect(task.id).toBeTruthy();
    state!.taskId = task.id;
    expect((await client.getTask(task.id)).id).toBe(task.id);
    // 买家请求不带任何账号凭据;分享码不出现在买家可见的请求与响应。
    expect(Object.keys(state!.firstWire!.headers)).not.toContain("authorization");
    expect(state!.firstWire!.body.toString()).not.toContain(SHARE_SECRET);
  }, 180_000);

  it("不同买家会话隔离:第二个会话读不到第一个会话的任务", async () => {
    const route = await state!.buyer.get(AGENT_ID, MERCHANT_ID);
    const client = buildA2AClient(route!.endpoint, {
      signer: loadOpenInquirySigner(path.join(EVIDENCE, "buyer-b"), "principal-e2e-b", "buyer-b"),
      skipDnsCheck: true, fetchImpl: route!.fetchImpl,
    });
    await expect(client.getTask(state!.taskId!)).rejects.toThrow();
  }, 90_000);

  it("重放拒绝:原样重发同一签名请求 → 目录收敛为 502 通用错误且不泄露", async () => {
    const wire = state!.firstWire!;
    // 原样重发:经与原请求完全相同的买家传输路径(transport 改写到目录网关)。
    const replay = await state!.route!.fetchImpl(wire.url, { method: "POST", headers: wire.headers, body: wire.body });
    expect(replay.status).toBe(502);
    const text = await replay.text();
    expect(text).not.toContain(SHARE_SECRET);
    expect(text).toContain("商家服务暂不可用");
  }, 90_000);

  it("后台未开放(商家侧开关):关闭后经目录的请求被拒,恢复后可用", async () => {
    rmSync(state!.flagFile, { force: true });
    const route = await state!.buyer.get(AGENT_ID, MERCHANT_ID);
    const client = buildA2AClient(route!.endpoint, {
      signer: route!.signer, skipDnsCheck: true, fetchImpl: route!.fetchImpl,
    });
    await expect(client.sendMessage({
      role: "user", messageId: "e2e-gate-off", parts: [{ kind: "text", text: "hi" }],
    })).rejects.toThrow();
    writeFileSync(state!.flagFile, "on");
    const task = await client.sendMessage({
      role: "user", messageId: "e2e-gate-on", parts: [{ kind: "text", text: "hi again" }],
    });
    expect(task.id).toBeTruthy();
  }, 120_000);

  it("授权撤回:同意关闭后买家探测 404(目录 enabled() fail-closed)", async () => {
    expect(await state!.catalog.setPublicInquiryConsent(state!.context, state!.identity, false))
      .toMatchObject({ granted: false });
    expect(await state!.buyer.get(AGENT_ID, MERCHANT_ID)).toBeNull();
  }, 90_000);

  it("网关剥码证据:分享码在目录→商家的线上出现过且全部有效,但从未进入任何响应", async () => {
    const evidence = readFileSync(state!.merchantEvidence, "utf8").trim().split("\n")
      .filter((line) => line !== "").map((line) => JSON.parse(line) as { path: string; sharecode_on_wire: boolean; code_valid?: boolean });
    expect(evidence.some((row) => row.sharecode_on_wire && row.code_valid === true)).toBe(true);
    expect(evidence.some((row) => row.sharecode_on_wire && row.code_valid === false)).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain(SHARE_SECRET);
  });
});

function recording(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    if (init?.method === "POST" && init.body !== undefined && url.includes("/a2a")) {
      state!.firstWire = {
        url, body: Buffer.isBuffer(init.body) ? init.body : Buffer.from(String(init.body)),
        headers: Object.fromEntries(new Headers(init.headers).entries()),
      };
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
}
