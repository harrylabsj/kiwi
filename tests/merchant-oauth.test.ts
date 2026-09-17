/**
 * Merchant OAuth 授权服务器测试（V2 阶段一）：
 * - 元数据发现（RFC 9728 / RFC 8414）；
 * - 动态注册（RFC 7591）：公共客户端、redirect_uris 回显与白名单拒绝；
 * - authorize：PKCE S256 强制、redirect_uri 精确匹配、授权页 CSRF、同意/拒绝；
 * - token：授权码一次性、10 分钟过期、PKCE 校验、client/redirect_uri 匹配；
 * - refresh_token 轮换与撤销（RFC 7009）；
 * - OAuthBearerVerifier：有效 token 通过并带授权上下文、过期/撤销/越权租户拒绝；
 * - HTTP 端到端：/mcp 无 token 401（带 resource_metadata），OAuth 全流程后访问通过。
 *
 * 确定性：内存 SQLite + 注入时钟；HTTP 用 ephemeral 端口。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MerchantOAuthServer,
  MerchantOAuthStore,
  isAllowedRedirectUri,
  pkceS256,
  workbuddyCallbackUri,
} from "../src/auth/merchant-oauth.js";
import {
  MerchantOAuthVerifier,
  MERCHANT_OAUTH_SCOPES,
} from "../src/auth/merchant-authorization.js";
import { MerchantAdminSessions, writeAdminCredentials } from "../src/auth/merchant-sessions.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MerchantWorkbenchService } from "../src/merchant/workbench-service.js";
import {
  startMerchantMcpServer,
  type MerchantMcpServerHandle,
} from "../src/mcp/merchant-server.js";
import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../src/agent/merchant/fake-merchant-client.js";
import { testProfile } from "./helpers.js";

const T0 = "2026-09-15T10:00:00.000Z";
const ISSUER = "http://127.0.0.1:9100";
const CALLBACK = workbuddyCallbackUri("kiwi-merchant");
const VERIFIER = "test-code-verifier-0123456789abcdef0123456789";

interface OAuthHarness {
  store: MerchantOAuthStore;
  server: MerchantOAuthServer;
  clock: { value: string };
  /** BUG-01 修复后：authorize 需要管理登录会话主体。 */
  session: { principal_id: string; merchant_id: string };
}

function setupOAuth(overrides: { merchantId?: string } = {}): OAuthHarness {
  const clock = { value: T0 };
  const store = new MerchantOAuthStore({
    db: new DatabaseSync(":memory:"),
    now: () => clock.value,
  });
  const server = new MerchantOAuthServer({
    store,
    issuer: ISSUER,
    resource: `${ISSUER}/mcp`,
    connectorSource: "kiwi-merchant",
    merchantName: "Veyquo 手工陶瓷",
    merchantId: overrides.merchantId ?? "merchant-001",
    now: () => clock.value,
  });
  return {
    store,
    server,
    clock,
    session: { principal_id: "merchant-agent:merchant-001", merchant_id: "merchant-001" },
  };
}

function registerClient(server: MerchantOAuthServer, redirectUris: string[] = [CALLBACK]): string {
  const result = server.register({ client_name: "WorkBuddy", redirect_uris: redirectUris });
  expect(result.status).toBe(201);
  const body = result.body as { client_id: string; redirect_uris: string[] };
  expect(body.redirect_uris).toEqual(redirectUris); // 必须回显
  return body.client_id;
}

function authorizeQuery(clientId: string): Record<string, string> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: MERCHANT_OAUTH_SCOPES.join(" "),
    state: "state-abc",
    code_challenge: pkceS256(VERIFIER),
    code_challenge_method: "S256",
  };
}

/** 走完 register → authorize → 同意 → 换 token 全流程，返回 token 响应 body。 */
function fullFlow(h: OAuthHarness): {
  clientId: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
} {
  const clientId = registerClient(h.server);
  const page = h.server.authorize(authorizeQuery(clientId), h.session);
  expect(page.status).toBe(200);
  expect(page.html).toContain("Veyquo 手工陶瓷");
  expect(page.html).toContain("merchant:read");
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.html ?? "")?.[1];
  expect(csrf).toBeTruthy();
  const submit = h.server.authorizeSubmit({ csrf, decision: "approve" }, h.session);
  expect(submit.status).toBe(302);
  const location = new URL(submit.headers?.location ?? "");
  expect(location.searchParams.get("state")).toBe("state-abc");
  const code = location.searchParams.get("code");
  expect(code).toBeTruthy();
  const token = h.server.token({
    grant_type: "authorization_code",
    code: code ?? "",
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_verifier: VERIFIER,
  });
  expect(token.status).toBe(200);
  // clientId 一并返回：refresh grant 必须绑定原 client_id（RFC 6749 §6）。
  return {
    clientId,
    ...(token.body as { access_token: string; refresh_token: string; expires_in: number }),
  };
}

describe("redirect_uri 白名单与 issuer 守卫", () => {
  it("允许 workbuddy 私有协议回调与 http loopback；拒绝其他", () => {
    expect(isAllowedRedirectUri(CALLBACK, "kiwi-merchant")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:54321/oauth/callback", "kiwi-merchant")).toBe(
      true,
    );
    expect(isAllowedRedirectUri("http://[::1]:54321/oauth/callback", "kiwi-merchant")).toBe(true);
    expect(isAllowedRedirectUri("https://evil.example.com/cb", "kiwi-merchant")).toBe(false);
    expect(isAllowedRedirectUri("http://0.0.0.0:9000/cb", "kiwi-merchant")).toBe(false);
    expect(
      isAllowedRedirectUri(
        "workbuddy://workbuddy/mcp/connector%3Aother/oauth/callback",
        "kiwi-merchant",
      ),
    ).toBe(false);
  });

  it("issuer 非 https 且非 loopback → 构造即拒绝（生产强制 HTTPS）", () => {
    const store = new MerchantOAuthStore({ db: new DatabaseSync(":memory:") });
    expect(
      () =>
        new MerchantOAuthServer({
          store,
          issuer: "http://mcp.merchant.example.com",
          resource: "http://mcp.merchant.example.com/mcp",
          connectorSource: "kiwi-merchant",
          merchantName: "x",
          merchantId: "m",
        }),
    ).toThrow(/https/);
  });

  it("省略单商家归属不会静默开启通用租户授权", () => {
    const store = new MerchantOAuthStore({ db: new DatabaseSync(":memory:") });
    expect(() => new MerchantOAuthServer({
      store,
      issuer: ISSUER,
      resource: `${ISSUER}/mcp`,
      connectorSource: "kiwi-merchant",
    })).toThrow(/multiMerchant=true/);
    expect(() => new MerchantOAuthVerifier({ store })).toThrow(/multiMerchant=true/);
  });
});

describe("元数据与注册", () => {
  it("protected-resource 与 authorization-server 元数据", () => {
    const h = setupOAuth();
    const pr = h.server.protectedResourceMetadata();
    expect(pr.status).toBe(200);
    expect(pr.body).toEqual({ resource: `${ISSUER}/mcp`, authorization_servers: [ISSUER] });
    const as = h.server.authorizationServerMetadata();
    expect(as.status).toBe(200);
    expect(as.body).toMatchObject({
      issuer: ISSUER,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("注册：非法 redirect_uri / 空数组拒绝（标准错误格式）", () => {
    const h = setupOAuth();
    const bad = h.server.register({ redirect_uris: ["https://evil.example.com/cb"] });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toBe("invalid_redirect_uri");
    const empty = h.server.register({ redirect_uris: [] });
    expect(empty.status).toBe(400);
    expect((empty.body as { error: string }).error).toBe("invalid_client_metadata");
  });
});

describe("authorize / token 流程", () => {
  it("通用入口：同一 OAuth issuer 为 A/B 分别签发绑定已认证 merchant_id 的 token", () => {
    const store = new MerchantOAuthStore({ db: new DatabaseSync(":memory:") });
    const server = new MerchantOAuthServer({
      store,
      issuer: ISSUER,
      resource: `${ISSUER}/mcp`,
      connectorSource: "kiwi-merchant",
      multiMerchant: true,
    });
    const clientId = registerClient(server);
    const gatewayVerifier = new MerchantOAuthVerifier({ store, multiMerchant: true });

    for (const session of [
      { principal_id: "account:A", merchant_id: "merchant-A", merchant_name: "A 商家" },
      { principal_id: "account:B", merchant_id: "merchant-B", merchant_name: "B 商家" },
    ]) {
      const page = server.authorize(authorizeQuery(clientId), session);
      expect(page.status).toBe(200);
      expect(page.html).toContain(session.merchant_name);
      const csrf = /name="csrf" value="([^"]+)"/.exec(page.html ?? "")?.[1] ?? "";
      const approved = server.authorizeSubmit({ csrf, decision: "approve" }, session);
      expect(approved.status).toBe(302);
      const code = new URL(approved.headers?.location ?? "").searchParams.get("code") ?? "";
      const pair = server.token({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        code,
        code_verifier: VERIFIER,
      });
      expect(pair.status).toBe(200);
      const access = (pair.body as { access_token: string }).access_token;
      const claim = gatewayVerifier.verify({ authorizationHeader: `Bearer ${access}` });
      expect(claim.ok).toBe(true);
      if (claim.ok) {
        expect(claim.authorization?.merchant_id).toBe(session.merchant_id);
        expect(claim.authorization?.principal_id).toBe(session.principal_id);
      }
      const wrongTenant = new MerchantOAuthVerifier({
        store,
        expectedMerchantId: session.merchant_id === "merchant-A" ? "merchant-B" : "merchant-A",
      });
      expect(wrongTenant.verify({ authorizationHeader: `Bearer ${access}` }).ok).toBe(false);
    }
    expect(server.authorize(authorizeQuery(clientId), {
      principal_id: "account:empty",
      merchant_id: "",
    }).status).toBe(403);
  });

  it("完整流程：register → 授权页（商家名+scope）→ 同意 → code → token", () => {
    const h = setupOAuth();
    const pair = fullFlow(h);
    expect(pair.access_token).toMatch(/^mcp_at_/);
    expect(pair.refresh_token).toMatch(/^mcp_rt_/);
    expect(pair.expires_in).toBe(3600);
  });

  it("缺 PKCE（非 S256）→ 回跳 invalid_request；未知 scope → invalid_scope", () => {
    const h = setupOAuth();
    const clientId = registerClient(h.server);
    const noPkce = h.server.authorize(
      {
        ...authorizeQuery(clientId),
        code_challenge_method: "plain",
      },
      h.session,
    );
    expect(noPkce.status).toBe(302);
    expect(noPkce.headers?.location).toContain("error=invalid_request");
    const badScope = h.server.authorize(
      { ...authorizeQuery(clientId), scope: "merchant:admin" },
      h.session,
    );
    expect(badScope.status).toBe(302);
    expect(badScope.headers?.location).toContain("error=invalid_scope");
  });

  it("redirect_uri 与注册值不匹配 → 400 且不回跳（防开放重定向）", () => {
    const h = setupOAuth();
    const clientId = registerClient(h.server);
    const result = h.server.authorize(
      {
        ...authorizeQuery(clientId),
        redirect_uri: `${CALLBACK}x`,
      },
      h.session,
    );
    expect(result.status).toBe(400);
    expect(result.headers?.location).toBeUndefined();
    const unknownClient = h.server.authorize(authorizeQuery("mcp_client_nope"), h.session);
    expect(unknownClient.status).toBe(400);
  });

  it("拒绝授权 → access_denied 回跳；CSRF 无效 → 400；授权页一次性", () => {
    const h = setupOAuth();
    const clientId = registerClient(h.server);
    const page = h.server.authorize(authorizeQuery(clientId), h.session);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.html ?? "")?.[1] ?? "";
    const denied = h.server.authorizeSubmit({ csrf, decision: "deny" }, h.session);
    expect(denied.status).toBe(302);
    expect(denied.headers?.location).toContain("error=access_denied");
    // CSRF 一次性：同一 csrf 再用即失败
    expect(h.server.authorizeSubmit({ csrf, decision: "approve" }, h.session).status).toBe(400);
    expect(h.server.authorizeSubmit({ csrf: "oauth_req_forged", decision: "approve" }, h.session).status).toBe(
      400,
    );
  });

  it("授权码一次性 + PKCE 校验 + client/redirect_uri 匹配", () => {
    const h = setupOAuth();
    const clientId = registerClient(h.server);
    const page = h.server.authorize(authorizeQuery(clientId), h.session);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.html ?? "")?.[1] ?? "";
    const submit = h.server.authorizeSubmit({ csrf, decision: "approve" }, h.session);
    const code = new URL(submit.headers?.location ?? "").searchParams.get("code") ?? "";

    const wrongVerifier = h.server.token({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: "wrong-verifier",
    });
    expect(wrongVerifier.status).toBe(400);
    expect((wrongVerifier.body as { error: string }).error).toBe("invalid_grant");

    // PKCE 失败即核销授权码（fail-closed：防 verifier 爆破），后续正确 verifier 也拒绝
    const afterFail = h.server.token({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(afterFail.status).toBe(400);
    expect((afterFail.body as { error: string }).error).toBe("invalid_grant");

    // 正常路径：新授权码换 token 成功，且授权码一次性
    const page2 = h.server.authorize(authorizeQuery(clientId), h.session);
    const csrf2 = /name="csrf" value="([^"]+)"/.exec(page2.html ?? "")?.[1] ?? "";
    const submit2 = h.server.authorizeSubmit({ csrf: csrf2, decision: "approve" }, h.session);
    const code2 = new URL(submit2.headers?.location ?? "").searchParams.get("code") ?? "";
    const ok = h.server.token({
      grant_type: "authorization_code",
      code: code2,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(ok.status).toBe(200);
    // 授权码一次性：重用拒绝
    const reuse = h.server.token({
      grant_type: "authorization_code",
      code: code2,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(reuse.status).toBe(400);
    expect((reuse.body as { error: string }).error).toBe("invalid_grant");
  });

  it("授权码 10 分钟过期；refresh 轮换后旧 refresh 失效；revoke 后 access 失效", () => {
    const h = setupOAuth();
    const pair = fullFlow(h);
    // refresh 轮换
    const refreshed = h.server.token({
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token,
      client_id: pair.clientId,
    });
    expect(refreshed.status).toBe(200);
    const newPair = refreshed.body as { access_token: string; refresh_token: string };
    const again = h.server.token({
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token,
      client_id: pair.clientId,
    });
    expect(again.status).toBe(400); // 旧 refresh 已轮换失效
    // revoke 新 access
    h.server.revoke({ token: newPair.access_token });
    const verifier = new MerchantOAuthVerifier({
      store: h.store,
      expectedMerchantId: "merchant-001",
    });
    expect(verifier.verify({ authorizationHeader: `Bearer ${newPair.access_token}` }).ok).toBe(
      false,
    );

    // 授权码过期（时钟推进 11 分钟）
    const clientId = registerClient(h.server);
    const page = h.server.authorize(authorizeQuery(clientId), h.session);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.html ?? "")?.[1] ?? "";
    const submit = h.server.authorizeSubmit({ csrf, decision: "approve" }, h.session);
    const code = new URL(submit.headers?.location ?? "").searchParams.get("code") ?? "";
    h.clock.value = new Date(Date.parse(T0) + 11 * 60 * 1000).toISOString();
    const expired = h.server.token({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    expect(expired.status).toBe(400);
    expect((expired.body as { error: string }).error).toBe("invalid_grant");
  });

  it("BUG-10：refresh 30 天独立过期拒绝；旧 token 重放拒绝；迁移老数据回填", () => {
    const h = setupOAuth();
    const pair = fullFlow(h);
    // 30 天内可轮换
    h.clock.value = new Date(Date.parse(T0) + 29 * 24 * 3600 * 1000).toISOString();
    const ok = h.server.token({
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token,
      client_id: pair.clientId,
    });
    expect(ok.status).toBe(200);
    // 旧 token 重放（已轮换核销）拒绝
    const replay = h.server.token({
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token,
      client_id: pair.clientId,
    });
    expect(replay.status).toBe(400);
    // 新 refresh 过 30 天独立过期
    const rotated = (ok.body as { refresh_token: string }).refresh_token;
    h.clock.value = new Date(Date.parse(T0) + 60 * 24 * 3600 * 1000).toISOString();
    const expired = h.server.token({
      grant_type: "refresh_token",
      refresh_token: rotated,
      client_id: pair.clientId,
    });
    expect(expired.status).toBe(400);

    // 审查 P2：refresh grant 绑定原 client_id——换 client_id 直接拒绝
    const wrongClient = h.server.token({
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token,
      client_id: "mcp_client_someone_else",
    });
    expect(wrongClient.status).toBe(400);
    expect((wrongClient.body as { error: string }).error).toBe("invalid_grant");

    // 迁移：老库（无 refresh_expires_at 列）ALTER 补列并回填 created_at+30d
    const legacy = new DatabaseSync(":memory:");
    legacy.exec(`CREATE TABLE oauth_tokens (
      access_digest TEXT PRIMARY KEY, refresh_digest TEXT UNIQUE, client_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, merchant_id TEXT NOT NULL, scope TEXT NOT NULL,
      expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL)`);
    const legacyStore = new MerchantOAuthStore({ db: legacy, now: () => T0 });
    const issued = legacyStore.issueTokenPair({
      client_id: "c",
      principal_id: "p",
      merchant_id: "m",
      scope: "merchant:read",
    });
    // 回填后可轮换（created_at=T0 → 29 天后仍有效；迁移在构造时已执行）
    const rotatedLegacy = legacyStore.rotateRefreshToken(issued.refresh_token);
    expect(rotatedLegacy).toBeDefined();
    legacy.close();
  });

  it("BUG-10：并发轮换只成功一次（同一 refresh 两个轮换调用）", () => {
    const h = setupOAuth();
    const pair = fullFlow(h);
    const first = h.store.rotateRefreshToken(pair.refresh_token);
    const second = h.store.rotateRefreshToken(pair.refresh_token);
    expect(first).not.toBeNull();
    expect(second).toBeUndefined(); // 后者因 revoked_at 条件更新未命中而失败
    expect(first === undefined).toBe(false);
  });

  it("未知 grant_type → unsupported_grant_type", () => {
    const h = setupOAuth();
    const result = h.server.token({ grant_type: "client_credentials" });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe("unsupported_grant_type");
  });
});

describe("OAuthBearerVerifier（租户与有效期）", () => {
  it("有效 token 通过并携带 principal/merchant/scope；越权租户拒绝", () => {
    const h = setupOAuth();
    const pair = fullFlow(h);
    const verifier = new MerchantOAuthVerifier({
      store: h.store,
      expectedMerchantId: "merchant-001",
    });
    const ok = verifier.verify({ authorizationHeader: `Bearer ${pair.access_token}` });
    expect(ok).toEqual({
      ok: true,
      authorization: {
        principal_id: "merchant-agent:merchant-001",
        merchant_id: "merchant-001",
        scopes: [...MERCHANT_OAUTH_SCOPES],
      },
    });
    // 另一个商家实例（expectedMerchantId 不同）拒绝同一 token
    const other = new MerchantOAuthVerifier({ store: h.store, expectedMerchantId: "merchant-999" });
    expect(other.verify({ authorizationHeader: `Bearer ${pair.access_token}` }).ok).toBe(false);
    // 缺头/伪造 token 拒绝
    expect(verifier.verify({}).ok).toBe(false);
    expect(verifier.verify({ authorizationHeader: "Bearer mcp_at_forged" }).ok).toBe(false);
  });

  it("access_token 过期后拒绝（时钟推进 1 小时+）", () => {
    const h = setupOAuth();
    const pair = fullFlow(h);
    const verifier = new MerchantOAuthVerifier({
      store: h.store,
      expectedMerchantId: "merchant-001",
    });
    expect(verifier.verify({ authorizationHeader: `Bearer ${pair.access_token}` }).ok).toBe(true);
    h.clock.value = new Date(Date.parse(T0) + 61 * 60 * 1000).toISOString();
    expect(verifier.verify({ authorizationHeader: `Bearer ${pair.access_token}` }).ok).toBe(false);
  });
});

const ADMIN_PW = "test-admin-password-1";

/** HTTP 栈：OAuth + 管理面（登录会话 + 确认凭证）挂载；返回已登录 cookie。 */
async function startHttpStack(): Promise<{
  issuer: string;
  handle: MerchantMcpServerHandle;
  cookie: string;
  adminDir: string;
  cleanup: () => Promise<void>;
}> {
  const clock = { value: T0 };
  const sharedDb = new DatabaseSync(":memory:");
  const oauthStore = new MerchantOAuthStore({ db: sharedDb, now: () => clock.value });
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run("merchant-agent:merchant-001", T0, T0);
  const service = new MerchantWorkbenchService({
    profile: testProfile(),
    merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
    approvals: new WriteApprovalCandidateStore({
      db,
      principalId: "merchant-agent:merchant-001",
      now: () => clock.value,
    }),
    mode: () => "supervised",
    now: () => clock.value,
  });
  const probe = await startMerchantMcpServer({ service, host: "127.0.0.1", port: 0 });
  const issuer = `http://127.0.0.1:${probe.port}`;
  await probe.close();
  const oauth = new MerchantOAuthServer({
    store: oauthStore,
    issuer,
    resource: `${issuer}/mcp`,
    connectorSource: "kiwi-merchant",
    merchantName: "Veyquo 手工陶瓷",
    merchantId: "merchant-001",
    now: () => clock.value,
  });
  const adminDir = mkdtempSync(path.join(tmpdir(), "kiwi-admin-test-"));
  writeAdminCredentials(adminDir, {
    principalId: "merchant-agent:merchant-001",
    merchantId: "merchant-001",
    password: ADMIN_PW,
  });
  const handle = await startMerchantMcpServer({
    service,
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
      sessions: new MerchantAdminSessions({ db: sharedDb, now: () => clock.value }),
      store: oauthStore,
      adminDir,
    },
  });
  const login = await fetch(`${issuer}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: ADMIN_PW, next: "/admin/pending" }).toString(),
    redirect: "manual",
  });
  expect(login.status).toBe(303);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toContain("kiwi_admin=");
  return {
    issuer,
    handle,
    cookie,
    adminDir,
    cleanup: async () => {
      await handle.close();
      db.close();
      sharedDb.close();
      rmSync(adminDir, { recursive: true, force: true });
    },
  };
}

describe("HTTP 端到端（OAuth 挂载到 MCP server）", () => {
  it("无 token 401 带 resource_metadata；OAuth 全流程后访问 /mcp 通过", async () => {
    const stack = await startHttpStack();
    const issuer = stack.issuer;
    try {
      // 元数据发现
      const meta = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
      expect(meta.status).toBe(200);
      expect((await meta.json()) as { issuer: string }).toMatchObject({ issuer });

      // 无 token → 401 + resource_metadata 指引
      const denied = await fetch(`${issuer}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toContain("oauth-protected-resource");

      // OAuth 全流程（HTTP）：register → authorize 页 → 同意 → token
      const registered = await fetch(`${issuer}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "WorkBuddy", redirect_uris: [CALLBACK] }),
      });
      expect(registered.status).toBe(201);
      const clientId = ((await registered.json()) as { client_id: string }).client_id;
      const page = await fetch(
        `${issuer}/oauth/authorize?${new URLSearchParams(authorizeQuery(clientId)).toString()}`,
        { headers: { cookie: stack.cookie } },
      );
      expect(page.status).toBe(200);
      const html = await page.text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
      const submit = await fetch(`${issuer}/oauth/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: stack.cookie,
        },
        body: new URLSearchParams({ csrf, decision: "approve" }).toString(),
        redirect: "manual",
      });
      expect(submit.status).toBe(302);
      const code = new URL(submit.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const tokenRes = await fetch(`${issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: CALLBACK,
          code_verifier: VERIFIER,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const tokens = (await tokenRes.json()) as { access_token: string };

      // 带 access_token 访问 /mcp → 通过（initialize）
      const allowed = await fetch(`${issuer}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        }),
      });
      expect(allowed.status).toBe(200);
    } finally {
      await stack.cleanup();
    }
  });
});

describe("tools/list 按 scope 过滤（V2 阶段一）", () => {
  /** 以指定 scope 走完整 OAuth 流程（含管理登录会话 cookie），拿到 access_token。 */
  async function issueTokenWithScopes(
    issuer: string,
    scopes: string,
    cookie: string,
  ): Promise<string> {
    const registered = await fetch(`${issuer}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "WorkBuddy", redirect_uris: [CALLBACK] }),
    });
    const clientId = ((await registered.json()) as { client_id: string }).client_id;
    const query = { ...authorizeQuery(clientId), scope: scopes };
    const page = await fetch(`${issuer}/oauth/authorize?${new URLSearchParams(query).toString()}`, {
      headers: { cookie },
    });
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const submit = await fetch(`${issuer}/oauth/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
      },
      body: new URLSearchParams({ csrf, decision: "approve" }).toString(),
      redirect: "manual",
    });
    const code = new URL(submit.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const tokenRes = await fetch(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_verifier: VERIFIER,
      }).toString(),
    });
    return ((await tokenRes.json()) as { access_token: string }).access_token;
  }

  function mcpRpc(
    token: string,
    issuer: string,
    method: string,
    params: unknown,
  ): Promise<Response> {
    return fetch(`${issuer}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  }

  it("read-only token：tools/list 过滤写工具；call 写工具返回 scope 不足", async () => {
    const stack = await startHttpStack();
    const issuer = stack.issuer;
    try {
      const readToken = await issueTokenWithScopes(issuer, "merchant:read", stack.cookie);
      // initialize（无 scope 要求）
      await mcpRpc(readToken, issuer, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      });
      const listRes = await mcpRpc(readToken, issuer, "tools/list", {});
      const tools = (
        (await listRes.json()) as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((t) => t.name);
      expect(tools).toContain("kiwi_merchant_list_products");
      expect(tools).not.toContain("kiwi_merchant_prepare_product_change");
      expect(tools.some((t) => t.includes("prepare_") || t.includes("execute_"))).toBe(false);
      // 写工具逐次强制：即使客户端知道名字也被拒（可读错误）
      const callRes = await mcpRpc(readToken, issuer, "tools/call", {
        name: "kiwi_merchant_prepare_product_change",
        arguments: { sku: "sku-001", changes: { price: 88 } },
      });
      const callBody = (await callRes.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      expect(callBody.result.isError).toBe(true);
      expect(callBody.result.content[0]?.text).toContain("merchant:write");
      // 只读工具正常
      const readRes = await mcpRpc(readToken, issuer, "tools/call", {
        name: "kiwi_merchant_list_products",
        arguments: {},
      });
      expect(
        ((await readRes.json()) as { result: { isError?: boolean } }).result.isError,
      ).toBeUndefined();

      // 全量 scope → 15 个工具全列出（execute/reject 已移出 MCP 注册表——BUG-02）
      const fullToken = await issueTokenWithScopes(
        issuer,
        "merchant:read merchant:write",
        stack.cookie,
      );
      const fullList = await mcpRpc(fullToken, issuer, "tools/list", {});
      const fullTools = (
        (await fullList.json()) as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((t) => t.name);
      expect(fullTools).toHaveLength(15);
      expect(fullTools).toContain("kiwi_merchant_prepare_product_change");
    } finally {
      await stack.cleanup();
    }
  });
});
