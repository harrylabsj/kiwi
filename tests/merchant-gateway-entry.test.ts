/**
 * 商家连接器（「Kiwi 商家运营」）远程入口的身份闭环测试。
 *
 * 覆盖 merchant-buddy 第 1 版设计 §3.2 / 商家连接器发布计划 §3.1 的完整链路：
 *   无会话 authorize → /connect → catalog 一次性身份授权（登录/注册 + 确认）
 *   → /connect/callback 兑换 merchant_id → 会话 cookie → 授权同意页
 *   → 授权码回跳 → token → 带 token 调用 MCP 工具（scope 过滤）。
 *
 * 失败路径：商家在目录拒绝（access_denied）、兑换失败（server_error）、
 * resume 被指向站外（400）、无 token 调用（401 + resource_metadata）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  MerchantOAuthServer,
  MerchantOAuthStore,
  workbuddyCallbackUri,
} from "../src/auth/merchant-oauth.js";
import { MerchantOAuthVerifier } from "../src/auth/merchant-authorization.js";
import { MerchantAdminSessions } from "../src/auth/merchant-sessions.js";
import { CatalogConnectorIdentityClient } from "../src/discovery/catalog-source/connector-identity.js";
import {
  startGatewayEntryServer,
  type GatewayEntryServerHandle,
} from "../src/merchant-gateway/entry-server.js";
import { InstanceRegistrationStore } from "../src/merchant-gateway/instance-registration.js";
import { GatewayCredentialVault } from "../src/merchant-gateway/credential-vault.js";
import { TenantBackendRegistry } from "../src/merchant-gateway/tenant-registry.js";

const CONNECTOR_TOKEN = "connector-token-test";
const MERCHANT_ID = "mkt_acme_1";
const MERCHANT_NAME = "Acme 商贸";
/** PKCE：授权请求带 S256 challenge，换 token 时回同一 verifier。 */
const CODE_VERIFIER = "entry-test-verifier-0123456789abcdef0123456789abcdef";
const CODE_CHALLENGE = createHash("sha256").update(CODE_VERIFIER).digest("base64url");

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn !== undefined) await fn();
  }
});

interface FakeCatalog {
  url: string;
  /** 最近一次创建请求收到的 return_url（浏览器应被回跳的地址）。 */
  lastReturnUrl: () => string;
  /** 最近一次创建请求的 request_id。 */
  lastRequestId: () => string;
  /** 设为 true 时 exchange 一律失败（模拟目录不可达/凭据被拒）。 */
  failExchange: boolean;
  close: () => Promise<void>;
}

/** 最小 catalog 桩：只实现一次性身份授权的两条机器接口。 */
async function startFakeCatalog(): Promise<FakeCatalog> {
  let returnUrl = "";
  let requestId = "";
  const state = { failExchange: false };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
        string,
        unknown
      >;
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.headers.authorization !== `Bearer ${CONNECTOR_TOKEN}`) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid connector token" }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/connector-identity/requests") {
        returnUrl = String(body.return_url ?? "");
        requestId = `creq_${state.failExchange ? "fail" : "ok"}_1`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            request: {
              request_id: requestId,
              status: "pending",
              created_at: "2026-09-17T10:00:00+00:00",
              expires_at: "2099-01-01T00:10:00+00:00",
            },
            login_url: `http://127.0.0.1:1/portal/connect?request_id=${requestId}`,
          }),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/connector-identity/exchange") {
        if (state.failExchange || body.code !== "the-code") {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid connector identity code" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            identity: { merchant_id: MERCHANT_ID, merchant_name: MERCHANT_NAME },
            credential: {
              access_token: "cmt_test-credential",
              scope: "catalog:read catalog:write",
              expires_at: "2099-01-01T00:00:00+00:00",
            },
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return {
    url: `http://127.0.0.1:${port}`,
    lastReturnUrl: () => returnUrl,
    lastRequestId: () => requestId,
    get failExchange() {
      return state.failExchange;
    },
    set failExchange(value: boolean) {
      state.failExchange = value;
    },
    close: async () => undefined,
  };
}

interface EntryStack {
  issuer: string;
  handle: GatewayEntryServerHandle;
  catalog: FakeCatalog;
  /** 连接成功后入口写入的商家目录凭据（内存实现）。 */
  credentials: Map<string, { token: string; expiresAt: string }>;
  /** 实例自助绑定用的注册表与加密保管库（同一 oauth.sqlite）。 */
  registrations: InstanceRegistrationStore;
  vault: GatewayCredentialVault;
  registry: TenantBackendRegistry;
}

/** 取一个空闲端口（OAuth issuer 必须在构造时确定，不能先起服务再看端口）。 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    probe.close(() => resolve());
  });
  return port;
}

/** 入口的工具束（与目录工具包同形；回显绑定到的 merchant_id 以验证按主体构造）。 */
function entryTools(boundMerchantId: string) {
  const tools = [
    { name: "kiwi_catalog_get_merchant_profile", scope: "catalog:read" },
    { name: "kiwi_catalog_save_publication_draft", scope: "catalog:write" },
  ];
  return {
    listTools: (scopes: string[] | undefined) =>
      tools
        .filter((t) => scopes === undefined || scopes.includes(t.scope))
        .map((t) => ({
          name: t.name,
          description: `${t.name}（测试桩）`,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        })),
    call: async (name: string) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ tool: name, merchant_id: boundMerchantId }),
        },
      ],
    }),
  };
}

async function startEntry(): Promise<EntryStack> {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-gateway-entry-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, "oauth.sqlite"));
  cleanup.push(() => db.close());

  const catalog = await startFakeCatalog();
  const credentials = new Map<string, { token: string; expiresAt: string }>();
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const oauthStore = new MerchantOAuthStore({ db });
  const registrations = new InstanceRegistrationStore({ db });
  const redeemedCodes = new Set<string>();
  const vault = new GatewayCredentialVault({ db, secret: "entry-test-secret" });
  const registry = new TenantBackendRegistry(
    [],
    {},
    {
      credentials: vault,
      dynamic: { lookup: (id) => registrations.get(id) },
    },
  );
  const handle = await startGatewayEntryServer({
    publicBaseUrl: issuer,
    oauth: new MerchantOAuthServer({
      store: oauthStore,
      issuer,
      resource: `${issuer}/mcp`,
      connectorSource: "kiwi-merchant",
      multiMerchant: true,
      scopes: ["catalog:read", "catalog:write"],
      loginPath: "/connect",
    }),
    sessions: new MerchantAdminSessions({ db }),
    identity: new CatalogConnectorIdentityClient({
      baseUrl: catalog.url,
      connectorToken: CONNECTOR_TOKEN,
    }),
    auth: new MerchantOAuthVerifier({ store: oauthStore, multiMerchant: true }),
    instanceBinding: {
      registrations,
      credentials: vault,
      // 联调替身：真实实现会真的打实例（见 instance-registration.test.ts）
      probe: async (mcpUrl: string) => ({
        mcpUrl,
        toolCount: 2,
        serverName: "kiwi-merchant",
        serverVersion: "0.8.0",
      }),
      redeem: async (_mcpUrl: string, code: string) => {
        const valid = "AAAA-BBBB-CCCC";
        if (code.trim().toUpperCase() !== valid) {
          throw new Error("配对码无效或已过期");
        }
        if (redeemedCodes.has(valid)) {
          throw new Error("配对码已使用");
        }
        redeemedCodes.add(valid);
        return {
          credential: "paired-internal-token",
          ownerId: MERCHANT_ID,
          principalId: "p",
          serverName: "kiwi-merchant",
          serverVersion: "0.8.0",
        };
      },
    },
    credentials: {
      put: (merchantId, token, expiresAt) => {
        credentials.set(merchantId, { token, expiresAt });
      },
      get: (merchantId) => credentials.get(merchantId),
      delete: (merchantId) => {
        credentials.delete(merchantId);
      },
    },
    toolsFor: (authorization) => entryTools(authorization?.merchant_id ?? ""),
    host: "127.0.0.1",
    port,
  });
  cleanup.push(() => handle.close());
  return { issuer, handle, catalog, credentials, registrations, vault, registry };
}

export interface BindResult {
  clientId: string;
  redirectUri: string;
  cookie: string;
  authorizeUrl: string;
  accessToken: string;
}

/** 走到「已建立商家会话 + 已同意授权 + 拿到 token」为止的完整客户端流程。 */
async function connectAndAuthorize(stack: EntryStack): Promise<BindResult> {
  const { issuer } = stack;
  const redirectUri = workbuddyCallbackUri("kiwi-merchant");
  const reg = await fetch(`${issuer}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "WorkBuddy", redirect_uris: [redirectUri] }),
  });
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as { client_id: string };
  const authorizeQuery = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    scope: "catalog:read catalog:write",
    state: "wb-state",
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
  }).toString();
  const authorizeUrl = `${issuer}/oauth/authorize?${authorizeQuery}`;

  // 1. 无会话：入口把浏览器送到连接流程（不是 /admin/login）。
  const first = await fetch(authorizeUrl, { redirect: "manual" });
  expect(first.status).toBe(303);
  const connectLocation = first.headers.get("location") ?? "";
  expect(connectLocation.startsWith("/connect?next=")).toBe(true);

  // 2. 连接入口 → catalog 登录地址（并记录 return_url）。
  const connect = await fetch(`${issuer}${connectLocation}`, { redirect: "manual" });
  expect(connect.status).toBe(303);
  const connectCookie = (connect.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(connectCookie).toContain("kiwi_connect_state=");
  expect(
    (connect.headers.get("location") ?? "").startsWith("http://127.0.0.1:1/portal/connect"),
  ).toBe(true);
  const returnUrl = stack.catalog.lastReturnUrl();
  expect(returnUrl).toContain("/connect/callback?resume=");

  // 3. 商家在目录确认后，浏览器回到入口 callback（携带一次性 code）。
  const callback = await fetch(
    `${returnUrl}&request_id=${stack.catalog.lastRequestId()}&code=the-code`,
    { headers: { cookie: connectCookie }, redirect: "manual" },
  );
  expect(callback.status).toBe(303);
  const cookie = (callback.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toContain("kiwi_admin=");
  expect(callback.headers.get("location")).toBe(authorizeUrl.replace(issuer, ""));

  // 4. 有会话：授权同意页。
  const page = await fetch(authorizeUrl, { headers: { cookie }, redirect: "manual" });
  expect(page.status).toBe(200);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  expect(csrf).not.toBe("");

  // 5. 同意 → 授权码回跳。
  const submit = await fetch(`${issuer}/oauth/authorize`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, decision: "approve" }).toString(),
    redirect: "manual",
  });
  expect(submit.status).toBe(302);
  const code = new URL(submit.headers.get("location") ?? "").searchParams.get("code") ?? "";
  expect(code).not.toBe("");

  // 6. 换 token。
  const token = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: CODE_VERIFIER,
    }).toString(),
  });
  const tokenBody = (await token.json()) as { access_token?: string; error?: string };
  return {
    clientId: client.client_id,
    redirectUri,
    cookie,
    authorizeUrl,
    accessToken: tokenBody.access_token ?? "",
  };
}

async function mcpRequest(
  issuer: string,
  accessToken: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${issuer}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken === "" ? {} : { authorization: `Bearer ${accessToken}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

const INSTANCE_URL = "https://instance.example/mcp";

describe("实例自助绑定页（§8.4 第一期）", () => {
  it("无会话访问 /instance 先走连接流程", async () => {
    const stack = await startEntry();
    const response = await fetch(`${stack.issuer}/instance`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location") ?? "").toContain("/connect?next=");
  });

  it("绑定 → 注册表可路由 → 解绑；页面不回显令牌", async () => {
    const stack = await startEntry();
    const bound = await connectAndAuthorize(stack);
    const cookie = bound.cookie;

    const page = await fetch(`${stack.issuer}/instance`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("连接我的 Kiwi Merchant 服务");
    expect(html).toContain("尚未绑定");

    const bind = await fetch(`${stack.issuer}/instance/bind`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        mcp_url: INSTANCE_URL,
        token: "instance-internal-token",
      }).toString(),
      redirect: "manual",
    });
    expect(bind.status).toBe(303);
    expect(bind.headers.get("location")).toBe("/instance?status=bound");
    expect(stack.registrations.get(MERCHANT_ID)?.mcpUrl).toBe(INSTANCE_URL);
    expect(stack.vault.get(`instance:${MERCHANT_ID}`)?.token).toBe("instance-internal-token");
    expect(stack.registry.has(MERCHANT_ID)).toBe(true);

    const after = await fetch(`${stack.issuer}/instance`, { headers: { cookie } });
    const afterHtml = await after.text();
    expect(afterHtml).toContain(INSTANCE_URL);
    expect(afterHtml).not.toContain("instance-internal-token");
    expect(afterHtml).toContain("解除绑定");

    const unbind = await fetch(`${stack.issuer}/instance/unbind`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "",
      redirect: "manual",
    });
    expect(unbind.status).toBe(303);
    expect(stack.registrations.get(MERCHANT_ID)).toBeUndefined();
    expect(stack.registry.has(MERCHANT_ID)).toBe(false);
  });

  it("用一次性配对码绑定：兑换成功即落库，重复使用被拒", async () => {
    const stack = await startEntry();
    const bound = await connectAndAuthorize(stack);

    const pair = await fetch(`${stack.issuer}/instance/pair`, {
      method: "POST",
      headers: { cookie: bound.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mcp_url: INSTANCE_URL, code: "AAAA-BBBB-CCCC" }).toString(),
      redirect: "manual",
    });
    expect(pair.status).toBe(303);
    expect(pair.headers.get("location")).toBe("/instance?status=paired");
    expect(stack.vault.get(`instance:${MERCHANT_ID}`)?.token).toBe("paired-internal-token");
    expect(stack.registrations.get(MERCHANT_ID)?.mcpUrl).toBe(INSTANCE_URL);
    expect(stack.registry.has(MERCHANT_ID)).toBe(true);

    // 同一配对码不可重用；解绑后旧码也不能复活
    const replay = await fetch(`${stack.issuer}/instance/pair`, {
      method: "POST",
      headers: { cookie: bound.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mcp_url: INSTANCE_URL, code: "AAAA-BBBB-CCCC" }).toString(),
      redirect: "manual",
    });
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location") ?? "").toContain("error=");
  });

  it("配对码页面不显示已存凭据，且换码不覆盖已有绑定（失败即无副作用）", async () => {
    const stack = await startEntry();
    const bound = await connectAndAuthorize(stack);
    await fetch(`${stack.issuer}/instance/pair`, {
      method: "POST",
      headers: { cookie: bound.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mcp_url: INSTANCE_URL, code: "AAAA-BBBB-CCCC" }).toString(),
      redirect: "manual",
    });
    const page = await fetch(`${stack.issuer}/instance`, { headers: { cookie: bound.cookie } });
    const html = await page.text();
    expect(html).toContain("用一次性配对码绑定");
    expect(html).not.toContain("paired-internal-token");

    const bad = await fetch(`${stack.issuer}/instance/pair`, {
      method: "POST",
      headers: { cookie: bound.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mcp_url: INSTANCE_URL, code: "WRONG-CODE-XXXX" }).toString(),
      redirect: "manual",
    });
    expect(bad.headers.get("location") ?? "").toContain("error=");
    // 失败不改变已绑定状态
    expect(stack.vault.get(`instance:${MERCHANT_ID}`)?.token).toBe("paired-internal-token");
  });

  it("地址不合规时拒绝绑定且不留状态", async () => {
    const stack = await startEntry();
    const bound = await connectAndAuthorize(stack);
    const bind = await fetch(`${stack.issuer}/instance/bind`, {
      method: "POST",
      headers: { cookie: bound.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        mcp_url: "http://merchant.example.com/mcp", // 公网明文 http
        token: "instance-internal-token",
      }).toString(),
      redirect: "manual",
    });
    expect(bind.status).toBe(303);
    expect(bind.headers.get("location") ?? "").toContain("error=");
    expect(stack.registrations.get(MERCHANT_ID)).toBeUndefined();
    expect(stack.vault.get(`instance:${MERCHANT_ID}`)).toBeUndefined();
  });
});

describe("商家连接器入口：连接与授权闭环", () => {
  it("无会话 authorize 走目录连接，兑换后建立会话并完成授权码流程", async () => {
    const stack = await startEntry();
    const bound = await connectAndAuthorize(stack);
    expect(bound.accessToken).not.toBe("");

    const listed = await mcpRequest(stack.issuer, bound.accessToken, "tools/list");
    expect(listed.status).toBe(200);
    const tools = (listed.body.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    );
    expect(tools).toContain("kiwi_catalog_get_merchant_profile");
    expect(tools).toContain("kiwi_catalog_save_publication_draft");

    // 连接成功后：目录凭据入库（供工具代表该商家调用目录）。
    expect(stack.credentials.get(MERCHANT_ID)?.token).toBe("cmt_test-credential");
    // 工具束按令牌绑定主体构造：merchant_id 只能来自访问令牌。
    const called = await mcpRequest(stack.issuer, bound.accessToken, "tools/call", {
      name: "kiwi_catalog_get_merchant_profile",
      arguments: {},
    });
    expect(called.status).toBe(200);
    const payload = JSON.parse(
      (called.body.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}",
    ) as { merchant_id?: string };
    expect(payload.merchant_id).toBe(MERCHANT_ID);
  });

  it("无 token 调用 /mcp 返回 401 并指引 resource_metadata", async () => {
    const stack = await startEntry();
    const denied = await mcpRequest(stack.issuer, "", "tools/list");
    expect(denied.status).toBe(401);
    const response = await fetch(`${stack.issuer}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.headers.get("www-authenticate") ?? "").toContain("oauth-protected-resource");
  });

  it("商家在目录拒绝时按 OAuth 语义回跳 access_denied", async () => {
    const stack = await startEntry();
    const redirectUri = workbuddyCallbackUri("kiwi-merchant");
    const reg = await fetch(`${stack.issuer}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "WorkBuddy", redirect_uris: [redirectUri] }),
    });
    const client = (await reg.json()) as { client_id: string };
    const authorizeUrl = `${stack.issuer}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      state: "wb-state",
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
    }).toString()}`;

    const first = await fetch(authorizeUrl, { redirect: "manual" });
    const connectLocation = first.headers.get("location") ?? "";
    const connect = await fetch(`${stack.issuer}${connectLocation}`, { redirect: "manual" });
    const connectCookie = (connect.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const returnUrl = stack.catalog.lastReturnUrl();

    const callback = await fetch(`${returnUrl}&error=access_denied`, {
      headers: { cookie: connectCookie },
      redirect: "manual",
    });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location") ?? "").toContain("connect=denied");
    const denied = await fetch(`${stack.issuer}${callback.headers.get("location") ?? ""}`, {
      redirect: "manual",
    });
    expect(denied.status).toBe(302);
    const location = new URL(denied.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("wb-state");
  });

  it("兑换失败时不建立会话，按 server_error 回跳", async () => {
    const stack = await startEntry();
    stack.catalog.failExchange = true;
    const redirectUri = workbuddyCallbackUri("kiwi-merchant");
    const reg = await fetch(`${stack.issuer}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "WorkBuddy", redirect_uris: [redirectUri] }),
    });
    const client = (await reg.json()) as { client_id: string };
    const authorizeUrl = `${stack.issuer}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
    }).toString()}`;
    const first = await fetch(authorizeUrl, { redirect: "manual" });
    const connect = await fetch(`${stack.issuer}${first.headers.get("location") ?? ""}`, {
      redirect: "manual",
    });
    const connectCookie = (connect.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const returnUrl = stack.catalog.lastReturnUrl();
    const callback = await fetch(
      `${returnUrl}&request_id=${stack.catalog.lastRequestId()}&code=the-code`,
      {
      headers: { cookie: connectCookie },
      redirect: "manual",
      },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("set-cookie")).toBeNull();
    const failed = await fetch(`${stack.issuer}${callback.headers.get("location") ?? ""}`, {
      redirect: "manual",
    });
    expect(new URL(failed.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "server_error",
    );
  });

  it("目录回跳必须带当前浏览器发起连接时的状态 cookie", async () => {
    const stack = await startEntry();
    const redirectUri = workbuddyCallbackUri("kiwi-merchant");
    const reg = await fetch(`${stack.issuer}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "WorkBuddy", redirect_uris: [redirectUri] }),
    });
    const client = (await reg.json()) as { client_id: string };
    const authorizeUrl = `${stack.issuer}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
    }).toString()}`;
    const first = await fetch(authorizeUrl, { redirect: "manual" });
    const connect = await fetch(`${stack.issuer}${first.headers.get("location") ?? ""}`, {
      redirect: "manual",
    });
    const returnUrl = stack.catalog.lastReturnUrl();
    const callback = await fetch(`${returnUrl}&request_id=${stack.catalog.lastRequestId()}&code=the-code`, {
      redirect: "manual",
    });
    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("连接状态无效");
    expect(connect.headers.get("set-cookie")).toContain("kiwi_connect_state=");
  });

  it("会话过期后访问实例绑定页可完成连接回跳", async () => {
    const stack = await startEntry();
    const first = await fetch(`${stack.issuer}/instance`, { redirect: "manual" });
    expect(first.status).toBe(303);
    const connect = await fetch(`${stack.issuer}${first.headers.get("location") ?? ""}`, {
      redirect: "manual",
    });
    const connectCookie = (connect.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const returnUrl = stack.catalog.lastReturnUrl();
    const callback = await fetch(`${returnUrl}&request_id=${stack.catalog.lastRequestId()}&code=the-code`, {
      headers: { cookie: connectCookie },
      redirect: "manual",
    });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/instance");
    const sessionCookie = (callback.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const page = await fetch(`${stack.issuer}/instance`, {
      headers: { cookie: sessionCookie },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("连接我的 Kiwi Merchant 服务");
  });

  it("resume 指向站外时 callback 拒绝（防开放重定向）", async () => {
    const stack = await startEntry();
    const response = await fetch(
      `${stack.issuer}/connect/callback?resume=${encodeURIComponent("https://evil.example/oauth/authorize")}&request_id=x&code=y`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(400);
  });

  it("resume 不是 authorize 端点时 callback 拒绝", async () => {
    const stack = await startEntry();
    const response = await fetch(
      `${stack.issuer}/connect/callback?resume=${encodeURIComponent("/admin/pending")}&request_id=x&code=y`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(400);
  });

  it("/connect 缺少合法 next 时返回 400", async () => {
    const stack = await startEntry();
    const response = await fetch(
      `${stack.issuer}/connect?next=${encodeURIComponent("//evil.example")}`,
      {
        redirect: "manual",
      },
    );
    expect(response.status).toBe(400);
  });

  it("scope 决定 tools/list 可见工具", async () => {
    const stack = await startEntry();
    const redirectUri = workbuddyCallbackUri("kiwi-merchant");
    const reg = await fetch(`${stack.issuer}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "WorkBuddy", redirect_uris: [redirectUri] }),
    });
    const client = (await reg.json()) as { client_id: string };
    const authorizeUrl = `${stack.issuer}/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: "catalog:read",
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
    }).toString()}`;
    const first = await fetch(authorizeUrl, { redirect: "manual" });
    const connect = await fetch(`${stack.issuer}${first.headers.get("location") ?? ""}`, {
      redirect: "manual",
    });
    const connectCookie = (connect.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const returnUrl = stack.catalog.lastReturnUrl();
    const callback = await fetch(
      `${returnUrl}&request_id=${stack.catalog.lastRequestId()}&code=the-code`,
      {
      headers: { cookie: connectCookie },
      redirect: "manual",
      },
    );
    const cookie = (callback.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const page = await fetch(authorizeUrl, { headers: { cookie }, redirect: "manual" });
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const submit = await fetch(`${stack.issuer}/oauth/authorize`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, decision: "approve" }).toString(),
      redirect: "manual",
    });
    const code = new URL(submit.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const token = await fetch(`${stack.issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_verifier: CODE_VERIFIER,
      }).toString(),
    });
    const accessToken = ((await token.json()) as { access_token?: string }).access_token ?? "";
    const listed = await mcpRequest(stack.issuer, accessToken, "tools/list");
    const tools = (listed.body.result as { tools: Array<{ name: string }> }).tools.map(
      (t) => t.name,
    );
    expect(tools).toContain("kiwi_catalog_get_merchant_profile");
    expect(tools).not.toContain("kiwi_catalog_save_publication_draft");
  });
});

describe("应用级 OAuth 回调（GET /oauth/callback，开放平台 → 应用链路）", () => {
  it("code 回跳 → 200 授权完成页，code 值绝不回显；error 回跳显示净化错误码", async () => {
    const stack = await startEntry();
    const ok = await fetch(`${stack.issuer}/oauth/callback?code=SECRET-CODE-77&state=xyz`);
    expect(ok.status).toBe(200);
    const okHtml = await ok.text();
    expect(okHtml).toContain("授权完成");
    expect(okHtml).not.toContain("SECRET-CODE-77");
    expect(ok.headers.get("cache-control")).toContain("no-store");

    const denied = await fetch(`${stack.issuer}/oauth/callback?error=access_denied`);
    expect(denied.status).toBe(200);
    const deniedHtml = await denied.text();
    expect(deniedHtml).toContain("授权未完成");
    expect(deniedHtml).toContain("access_denied");
  });

  it("非平台回跳（无参数）→ 400", async () => {
    const stack = await startEntry();
    const res = await fetch(`${stack.issuer}/oauth/callback`);
    expect(res.status).toBe(400);
  });
});
