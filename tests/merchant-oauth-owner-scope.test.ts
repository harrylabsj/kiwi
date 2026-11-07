/**
 * 店主金额 scope（merchant:owner）的 OAuth 授权隔离：
 *   - 不在缺省 scope 中，必须由客户端显式申请；
 *   - authorize 与 authorizeSubmit 两步都要求管理会话 role=owner；
 *   - 缺失/非 owner 角色一律拒绝（缺失也拒绝，不默认 owner）；
 *   - 通用网关（multiMerchant）不得授予该 scope；
 *   - 未申请时 token 不含 owner scope。
 *
 * 仅测试 OAuth 授权行为，不涉及 MCP 金额投影。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  MERCHANT_OWNER_SCOPE,
  MerchantOAuthServer,
  MerchantOAuthStore,
  pkceS256,
  workbuddyCallbackUri,
} from "../src/auth/merchant-oauth.js";

const T0 = "2026-11-07T06:00:00.000Z";
const ISSUER = "http://127.0.0.1:9100";
const CALLBACK = workbuddyCallbackUri("kiwi-merchant");
const VERIFIER = "owner-scope-test-verifier-0123456789abcdef";

interface Harness {
  server: MerchantOAuthServer;
  store: MerchantOAuthStore;
  clock: { value: string };
}

function setup(
  options: { multiMerchant?: boolean; scopes?: string[] } = {},
): Harness {
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
    ...(options.multiMerchant === true
      ? { multiMerchant: true }
      : { merchantName: "Veyquo 手工陶瓷", merchantId: "merchant-001" }),
    ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
    now: () => clock.value,
  });
  return { server, store, clock };
}

function metadataScopes(server: MerchantOAuthServer): string[] {
  return (server.authorizationServerMetadata().body as { scopes_supported: string[] })
    .scopes_supported;
}

function register(server: MerchantOAuthServer): string {
  const result = server.register({ client_name: "WorkBuddy", redirect_uris: [CALLBACK] });
  const body = result.body as { client_id: string };
  return body.client_id;
}

function query(clientId: string, scope: string): Record<string, string> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope,
    state: "state-owner",
    code_challenge: pkceS256(VERIFIER),
    code_challenge_method: "S256",
  };
}

const OWNER = {
  principal_id: "merchant-agent:merchant-001",
  merchant_id: "merchant-001",
  role: "owner",
} as const;
const VIEWER = {
  principal_id: "merchant-agent:merchant-001",
  merchant_id: "merchant-001",
  role: "viewer",
} as const;
const OPERATOR = {
  principal_id: "merchant-agent:merchant-001",
  merchant_id: "merchant-001",
  role: "operator",
} as const;
const ENABLED = ["merchant:read", MERCHANT_OWNER_SCOPE];

function exchange(server: MerchantOAuthServer, clientId: string, code: string): string {
  const result = server.token({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_verifier: VERIFIER,
  });
  expect(result.status).toBe(200);
  return String((result.body as { scope?: string }).scope ?? "");
}

describe("merchant:owner OAuth scope", () => {
  it("实例显式启用 + 客户端显式申请 + owner 会话：授权页展示，token 含 owner scope", () => {
    const { server } = setup({ scopes: ENABLED });
    expect(metadataScopes(server)).toContain(MERCHANT_OWNER_SCOPE);
    const clientId = register(server);
    const page = server.authorize(query(clientId, `merchant:read ${MERCHANT_OWNER_SCOPE}`), OWNER);
    expect(page.status).toBe(200);
    expect(page.html).toContain(MERCHANT_OWNER_SCOPE);
    expect(page.html).toContain("仅店主授权");
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.html ?? "")?.[1];
    expect(csrf).toBeTruthy();
    const submit = server.authorizeSubmit({ csrf, decision: "approve" }, OWNER);
    expect(submit.status).toBe(302);
    const code = new URL(submit.headers?.location ?? "").searchParams.get("code");
    expect(code).toBeTruthy();
    expect(exchange(server, clientId, code ?? "")).toContain(MERCHANT_OWNER_SCOPE);
  });

  it("已启用但 viewer/operator/缺失 role 申请 owner：authorize 直接拒绝", () => {
    for (const session of [
      VIEWER,
      OPERATOR,
      { principal_id: OWNER.principal_id, merchant_id: OWNER.merchant_id },
    ]) {
      const { server } = setup({ scopes: ENABLED });
      const clientId = register(server);
      const result = server.authorize(
        query(clientId, `merchant:read ${MERCHANT_OWNER_SCOPE}`),
        session,
      );
      expect(result.status).toBe(302);
      expect(result.headers?.location ?? "").toContain("error=invalid_scope");
      expect(result.headers?.location ?? "").not.toContain("code=");
    }
  });

  it("确认时再次校验角色：owner 发起的挂起单被非 owner 会话提交 → 403", () => {
    const { server } = setup({ scopes: ENABLED });
    const clientId = register(server);
    const page = server.authorize(query(clientId, `merchant:read ${MERCHANT_OWNER_SCOPE}`), OWNER);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.html ?? "")?.[1];
    expect(csrf).toBeTruthy();
    const submit = server.authorizeSubmit({ csrf, decision: "approve" }, VIEWER);
    expect(submit.status).toBe(403);
    expect((submit.body as { error?: string }).error).toBe("access_denied");
  });

  it("已启用但客户端未显式申请：token 不含 owner scope（owner 会话也不自动追加）", () => {
    const { server } = setup({ scopes: ENABLED });
    const clientId = register(server);
    const page = server.authorize(query(clientId, "merchant:read"), OWNER);
    expect(page.status).toBe(200);
    expect(page.html).not.toContain(MERCHANT_OWNER_SCOPE);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.html ?? "")?.[1];
    const submit = server.authorizeSubmit({ csrf, decision: "approve" }, OWNER);
    const code = new URL(submit.headers?.location ?? "").searchParams.get("code");
    const scope = exchange(server, clientId, code ?? "");
    expect(scope).toContain("merchant:read");
    expect(scope).not.toContain(MERCHANT_OWNER_SCOPE);
  });

  it("未启用（缺省 read/write 或显式仅 read）：不广告、拒绝 owner 申请", () => {
    for (const scopes of [undefined, ["merchant:read"]]) {
      const { server } = setup(scopes === undefined ? {} : { scopes });
      expect(metadataScopes(server)).not.toContain(MERCHANT_OWNER_SCOPE);
      const clientId = register(server);
      const page = server.authorize(
        query(clientId, `merchant:read ${MERCHANT_OWNER_SCOPE}`),
        OWNER,
      );
      expect(page.status).toBe(302);
      expect(page.headers?.location ?? "").toContain("error=invalid_scope");
    }
  });

  it("未提供 scope 参数：即使实例已启用 owner，也不默认申请/授予", () => {
    const { server } = setup({ scopes: ENABLED });
    const clientId = register(server);
    const withoutScope = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      state: "state-owner",
      code_challenge: pkceS256(VERIFIER),
      code_challenge_method: "S256",
    };
    const page = server.authorize(withoutScope, OWNER);
    expect(page.status).toBe(200);
    expect(page.html).not.toContain(MERCHANT_OWNER_SCOPE);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.html ?? "")?.[1];
    const submit = server.authorizeSubmit({ csrf, decision: "approve" }, OWNER);
    const code = new URL(submit.headers?.location ?? "").searchParams.get("code");
    expect(exchange(server, clientId, code ?? "")).not.toContain(MERCHANT_OWNER_SCOPE);
  });

  it("跨实例：会话 merchant 不属于本实例时 owner 申请被拒", () => {
    const { server } = setup({ scopes: ENABLED });
    const clientId = register(server);
    const page = server.authorize(query(clientId, `merchant:read ${MERCHANT_OWNER_SCOPE}`), {
      principal_id: "merchant-agent:merchant-002",
      merchant_id: "merchant-002",
      role: "owner",
    });
    expect(page.status).toBe(403);
    expect((page.body as { error?: string }).error).toBe("access_denied");
  });

  it("owner token 撤销后不可再通过校验", () => {
    const { server, store } = setup({ scopes: ENABLED });
    const clientId = register(server);
    const page = server.authorize(query(clientId, `merchant:read ${MERCHANT_OWNER_SCOPE}`), OWNER);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.html ?? "")?.[1];
    const submit = server.authorizeSubmit({ csrf, decision: "approve" }, OWNER);
    const code = new URL(submit.headers?.location ?? "").searchParams.get("code");
    const token = server.token({
      grant_type: "authorization_code",
      code: code ?? "",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    });
    const access = String((token.body as { access_token?: string }).access_token ?? "");
    expect(store.getAccessToken(access)).toBeDefined();
    server.revoke({ token: access });
    expect(store.getAccessToken(access)).toBeUndefined();
  });

  it("共享网关（multiMerchant）即使误配 owner scope 也不广告、不授予", () => {
    const { server } = setup({ multiMerchant: true, scopes: ENABLED });
    expect(metadataScopes(server)).not.toContain(MERCHANT_OWNER_SCOPE);
    const clientId = register(server);
    const page = server.authorize(
      query(clientId, `merchant:read ${MERCHANT_OWNER_SCOPE}`),
      OWNER,
    );
    expect(page.status).toBe(302);
    expect(page.headers?.location ?? "").toContain("error=invalid_scope");
  });
});
