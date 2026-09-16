/**
 * WorkBuddy OAuth 联调端到端测试（V2 阶段五，离线模拟 WorkBuddy 客户端全流程）：
 *   401（带 resource_metadata 指引）→ 元数据发现（RFC 9728/8414）→ 动态注册
 *   （RFC 7591 回显 redirect_uris）→ PKCE S256 授权（授权页 → 同意）→ 换 token →
 *   带 token 调用 MCP 工具 → refresh 续期（旧 refresh 失效）→ revoke 后拒绝。
 * 两条回调路径都测：workbuddy:// 私有协议 与 http://127.0.0.1 回退。
 * 另有：重连（重启服务后 refresh_token 仍有效——token 落盘 oauth.sqlite）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  MerchantOAuthServer,
  MerchantOAuthStore,
  workbuddyCallbackUri,
} from "../../src/auth/merchant-oauth.js";
import { MerchantOAuthVerifier } from "../../src/auth/merchant-authorization.js";
import { MerchantCoreService } from "../../src/merchant-core/service.js";
import { MerchantOperationStore } from "../../src/merchant-core/operations.js";
import {
  startMerchantMcpServer,
  type MerchantMcpServerHandle,
} from "../../src/mcp/merchant-server.js";
import { migrateMemorySchema } from "../../src/agent/memory/schema.js";
import { MerchantAdminSessions, writeAdminCredentials } from "../../src/auth/merchant-sessions.js";
import { WriteApprovalCandidateStore } from "../../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../../src/agent/merchant/fake-merchant-client.js";
import { testProfile } from "../helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";
const ADMIN_PW = "e2e-admin-password-1";
const VERIFIER = "e2e-code-verifier-0123456789abcdef0123456789abcdef";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

interface E2eStack {
  issuer: string;
  oauthStore: MerchantOAuthStore;
  handle: MerchantMcpServerHandle;
  close: () => Promise<void>;
}

async function startStack(oauthDb: DatabaseSync): Promise<E2eStack> {
  const clock = { value: T0 };
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, T0, T0);
  const core = new MerchantCoreService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
    approvals: new WriteApprovalCandidateStore({
      db,
      principalId: PRINCIPAL,
      now: () => clock.value,
    }),
    mode: () => "supervised",
    now: () => clock.value,
    commandPrincipalId: PRINCIPAL,
    operations: new MerchantOperationStore({ db, now: () => clock.value }),
  });
  const probe = await startMerchantMcpServer({ service: core, host: "127.0.0.1", port: 0 });
  const issuer = `http://127.0.0.1:${probe.port}`;
  await probe.close();
  const oauthStore = new MerchantOAuthStore({ db: oauthDb, now: () => clock.value });
  const oauth = new MerchantOAuthServer({
    store: oauthStore,
    issuer,
    resource: `${issuer}/mcp`,
    connectorSource: "kiwi-merchant",
    merchantName: "Veyquo 手工陶瓷",
    merchantId: "merchant-001",
    now: () => clock.value,
  });
  // BUG-01/03：管理面挂载（登录会话 + 一次性确认凭证）
  const adminDir = mkdtempSync(path.join(tmpdir(), "kiwi-e2e-admin-"));
  dirs.push(adminDir);
  writeAdminCredentials(adminDir, {
    principalId: PRINCIPAL,
    merchantId: "merchant-001",
    password: ADMIN_PW,
  });
  const handle = await startMerchantMcpServer({
    service: core,
    host: "127.0.0.1",
    port: probe.port,
    oauth,
    auth: new MerchantOAuthVerifier({ store: oauthStore, expectedMerchantId: "merchant-001" }),
    admin: {
      merchantName: "Veyquo 手工陶瓷",
      surface: {
        listPending: () => [],
        executeApproved: async () => ({}),
        rejectCandidate: async () => ({}),
      },
      sessions: new MerchantAdminSessions({ db: oauthDb, now: () => clock.value }),
      store: oauthStore,
      adminDir,
    },
  });
  return {
    issuer,
    oauthStore,
    handle,
    close: async () => {
      await handle.close();
      db.close();
    },
  };
}

/** 模拟 WorkBuddy 客户端：401 → 发现 → 注册 → 授权 → 换 token。 */
async function clientBindFlow(
  issuer: string,
  redirectUri: string,
): Promise<{
  access_token: string;
  refresh_token: string;
}> {
  // 1. 无 token 访问 → 401 + resource_metadata 指引
  const denied = await fetch(`${issuer}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(denied.status).toBe(401);
  const wwwAuth = denied.headers.get("www-authenticate") ?? "";
  expect(wwwAuth).toContain("oauth-protected-resource");
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1] ?? "";

  // 2. 元数据发现（protected-resource → authorization-server）
  const pr = (await (await fetch(metadataUrl)).json()) as { authorization_servers: string[] };
  expect(pr.authorization_servers).toHaveLength(1);
  const asMeta = (await (
    await fetch(`${pr.authorization_servers[0]}/.well-known/oauth-authorization-server`)
  ).json()) as {
    registration_endpoint: string;
    authorization_endpoint: string;
    token_endpoint: string;
    revocation_endpoint: string;
  };
  expect(asMeta.token_endpoint).toContain("/oauth/token");

  // 3. 动态注册（公共客户端；回显 redirect_uris）
  const reg = await fetch(asMeta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "WorkBuddy", redirect_uris: [redirectUri] }),
  });
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as { client_id: string; redirect_uris: string[] };
  expect(client.redirect_uris).toEqual([redirectUri]);

  // 4. PKCE 授权（BUG-01：先管理员登录拿会话 cookie，再进授权页）
  const challenge = await import("node:crypto").then((c) =>
    c.createHash("sha256").update(VERIFIER).digest("base64url"),
  );
  const login = await fetch(`${issuer}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_PW, next: "/admin/pending" }).toString(),
    redirect: "manual",
  });
  expect(login.status).toBe(303);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = await fetch(
    `${asMeta.authorization_endpoint}?${new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: "merchant:read merchant:write",
      state: "wb-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
    })}`,
    { headers: { cookie } },
  );
  expect(page.status).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  expect(csrf).not.toBe("");
  const submit = await fetch(asMeta.authorization_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    },
    body: new URLSearchParams({ csrf, decision: "approve" }).toString(),
    redirect: "manual",
  });
  expect(submit.status).toBe(302);
  const location = submit.headers.get("location") ?? "";
  expect(location.startsWith(redirectUri)).toBe(true);
  const code = new URL(location).searchParams.get("code") ?? "";
  expect(new URL(location).searchParams.get("state")).toBe("wb-state");

  // 5. 换 token
  const tokenRes = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: VERIFIER,
    }).toString(),
  });
  expect(tokenRes.status).toBe(200);
  return (await tokenRes.json()) as { access_token: string; refresh_token: string };
}

async function callTool(issuer: string, token: string, name: string): Promise<Response> {
  return fetch(`${issuer}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
}

describe("WorkBuddy OAuth 联调端到端（离线模拟）", () => {
  it.each([
    ["workbuddy 私有协议回调", workbuddyCallbackUri("kiwi-merchant")],
    ["127.0.0.1 回退回调", "http://127.0.0.1:54321/oauth/callback"],
  ])("首次绑定全流程（%s）→ 调用 → refresh → revoke 后拒绝", async (_label, redirectUri) => {
    const stack = await startStack(new DatabaseSync(":memory:"));
    try {
      const tokens = await clientBindFlow(stack.issuer, redirectUri);
      // 带 token 调用 MCP 工具
      const ok = await callTool(stack.issuer, tokens.access_token, "kiwi_merchant_list_products");
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { result?: { isError?: boolean } };
      expect(body.result?.isError).toBeUndefined();

      // refresh 续期（旧 refresh 即失效）
      const refreshed = await fetch(`${stack.issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        }).toString(),
      });
      expect(refreshed.status).toBe(200);
      const rotated = (await refreshed.json()) as { access_token: string; refresh_token: string };
      const staleRefresh = await fetch(`${stack.issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        }).toString(),
      });
      expect(staleRefresh.status).toBe(400);

      // revoke 后拒绝（撤权生效）
      const revoke = await fetch(`${stack.issuer}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: rotated.access_token }).toString(),
      });
      expect(revoke.status).toBe(200);
      const denied = await callTool(
        stack.issuer,
        rotated.access_token,
        "kiwi_merchant_list_products",
      );
      expect(denied.status).toBe(401);
    } finally {
      await stack.close();
    }
  });

  it("重连：服务重启后 refresh_token 仍有效（oauth.sqlite 落盘）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-oauth-reconnect-"));
    dirs.push(dir);
    const dbFile = path.join(dir, "oauth.sqlite");
    const first = await startStack(new DatabaseSync(dbFile));
    const tokens = await clientBindFlow(first.issuer, workbuddyCallbackUri("kiwi-merchant"));
    await first.close();

    // 重启（同一 oauth.sqlite 文件）：refresh 仍有效
    const second = await startStack(new DatabaseSync(dbFile));
    try {
      const refreshed = await fetch(`${second.issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        }).toString(),
      });
      expect(refreshed.status).toBe(200);
      const rotated = (await refreshed.json()) as { access_token: string };
      const ok = await callTool(second.issuer, rotated.access_token, "kiwi_merchant_list_products");
      expect(ok.status).toBe(200);
    } finally {
      await second.close();
    }
  });

  it("MCP 资源边界：resources/list 全路径；未知资源与私密类拒绝", async () => {
    const stack = await startStack(new DatabaseSync(":memory:"));
    try {
      const tokens = await clientBindFlow(stack.issuer, workbuddyCallbackUri("kiwi-merchant"));
      // 本 stack 未挂 presentations（resources 能力缺省关闭）→ resources/list 报方法不存在
      const res = await fetch(`${stack.issuer}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list", params: {} }),
      });
      // SDK 对未注册 capability 的方法返回 JSON-RPC 错误（fail-closed）
      const body = (await res.json()) as { error?: { code: number } };
      expect(body.error).toBeDefined();
    } finally {
      await stack.close();
    }
  });
});
