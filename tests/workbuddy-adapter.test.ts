/**
 * WorkBuddy 本机适配器离线测试：
 *   - 固定实例绑定拒绝任意 URL/跨源 issuer；
 *   - token 文件加密、绑定指纹、篡改/换绑拒绝；
 *   - OAuth discovery/register/PKCE/token/refresh/revoke 全部走 X-Share-Code；
 *   - MCP 客户端只发送 X-Kiwi-Authorization，不发送标准 Authorization。
 *
 * 不访问网络、不使用真实分享码/token；只构造固定字符串。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createFixedInstanceBinding,
  bindingFingerprint,
} from "../src/workbuddy-adapter/binding.js";
import {
  createAuthorizationRequest,
  discoverOAuth,
  ensureAdapterToken,
  exchangeAdapterCode,
  refreshAdapterToken,
  registerAdapterClient,
  revokeAdapterToken,
  validateAdapterToken,
} from "../src/workbuddy-adapter/oauth.js";
import { AdapterTokenStore } from "../src/workbuddy-adapter/token-store.js";
import { FixedInstanceMcpClient } from "../src/workbuddy-adapter/mcp-client.js";
import { TokenBoundClientCache } from "../src/workbuddy-adapter/client-cache.js";

const INSTANCE = "https://shop.example/mcp";
const SHARE = "share-test-value";
const REDIRECT = "http://127.0.0.1:43210/callback";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-workbuddy-adapter-"));
  dirs.push(dir);
  return dir;
}

function metadata(binding = createFixedInstanceBinding({ instanceUrl: INSTANCE })) {
  return {
    issuer: binding.issuer,
    authorization_endpoint: `${binding.issuer}/oauth/authorize`,
    token_endpoint: `${binding.issuer}/oauth/token`,
    registration_endpoint: `${binding.issuer}/oauth/register`,
    revocation_endpoint: `${binding.issuer}/oauth/revoke`,
    scopes_supported: ["merchant:read"],
    code_challenge_methods_supported: ["S256"],
  };
}

describe("fixed binding", () => {
  it("只接受 https（或 loopback http）且路径恰为 /mcp、同源 issuer", () => {
    const binding = createFixedInstanceBinding({ instanceUrl: INSTANCE });
    expect(binding.mcpUrl).toBe(INSTANCE);
    expect(binding.issuer).toBe("https://shop.example");
    expect(bindingFingerprint(binding)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => createFixedInstanceBinding({ instanceUrl: "http://shop.example/mcp" })).toThrow();
    expect(() => createFixedInstanceBinding({ instanceUrl: "https://shop.example/other" })).toThrow();
    expect(() =>
      createFixedInstanceBinding({ instanceUrl: "https://shop.example/mcp?x=1" }),
    ).toThrow();
    expect(() =>
      createFixedInstanceBinding({
        instanceUrl: INSTANCE,
        issuer: "https://other.example",
      }),
    ).toThrow();
  });
});

describe("encrypted token store", () => {
  it("加密落盘、按绑定读取、明文不出现", () => {
    const binding = createFixedInstanceBinding({ instanceUrl: INSTANCE });
    const file = path.join(tempDir(), "token.enc");
    const store = new AdapterTokenStore({ file, binding, secret: "test-secret" });
    store.save({
      access_token: "access-token-0123456789",
      refresh_token: "refresh-token-0123456789",
      share_code: "share-test-value",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      scope: ["merchant:read"],
    });
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("access-token-0123456789");
    expect(raw).not.toContain("refresh-token-0123456789");
    expect(raw).not.toContain("share-test-value");
    expect(store.load()?.scope).toEqual(["merchant:read"]);
    expect(store.load()?.access_token).toBe("access-token-0123456789");
    expect(store.load()?.share_code).toBe("share-test-value");
  });

  it("换绑/篡改/无密钥 fail-closed", () => {
    const binding = createFixedInstanceBinding({ instanceUrl: INSTANCE });
    const other = createFixedInstanceBinding({ instanceUrl: "https://other.example/mcp" });
    const file = path.join(tempDir(), "token.enc");
    const store = new AdapterTokenStore({ file, binding, secret: "test-secret" });
    store.save({
      access_token: "access-token-0123456789",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      scope: ["merchant:read"],
    });
    const wrongBinding = new AdapterTokenStore({ file, binding: other, secret: "test-secret" });
    expect(() => wrongBinding.load()).toThrow(/绑定不匹配/);
    const wrongKey = new AdapterTokenStore({ file, binding, secret: "other-secret" });
    expect(() => wrongKey.load()).toThrow(/解密失败/);
    expect(() => AdapterTokenStore.secretFromEnv({})).toThrow(/未配置/);
  });
});

describe("adapter OAuth", () => {
  it("discovery/register/authorize/token/refresh/revoke 使用固定实例与 X-Share-Code", async () => {
    const binding = createFixedInstanceBinding({ instanceUrl: INSTANCE });
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fake = (async (url: string | URL | Request, init?: NonNullable<Parameters<typeof fetch>[1]>) => {
      const href = String(url);
      seen.push({
        url: href,
        headers: { ...(init?.headers as Record<string, string> | undefined) },
      });
      if (href.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(JSON.stringify(metadata(binding)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href.endsWith("/oauth/register")) {
        return new Response(
          JSON.stringify({ client_id: "client-1", redirect_uris: [REDIRECT] }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (href.endsWith("/oauth/token")) {
        const body = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            access_token: body.includes("refresh_token")
              ? "access-token-refreshed-0123456789"
              : "access-token-0123456789",
            refresh_token: "refresh-token-0123456789",
            token_type: "Bearer",
            scope: "merchant:read",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (href.endsWith("/oauth/revoke")) {
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected ${href}`);
    }) as typeof fetch;

    const meta = await discoverOAuth(binding, SHARE, fake);
    const clientId = await registerAdapterClient(binding, meta, REDIRECT, SHARE, fake);
    expect(clientId).toBe("client-1");
    const auth = createAuthorizationRequest({
      binding,
      metadata: meta,
      clientId,
      redirectUri: REDIRECT,
      shareCode: SHARE,
    });
    expect(new URL(auth.url).searchParams.get("sharecode")).toBe(SHARE);
    expect(new URL(auth.url).searchParams.get("code_challenge_method")).toBe("S256");
    const token = await exchangeAdapterCode({
      binding,
      metadata: meta,
      shareCode: SHARE,
      clientId,
      redirectUri: REDIRECT,
      code: "code-1",
      verifier: auth.verifier,
      fetchImpl: fake,
    });
    expect(token.access_token).toBe("access-token-0123456789");
    expect(token.scope).toEqual(["merchant:read"]);
    const refreshed = await refreshAdapterToken({
      binding,
      metadata: meta,
      shareCode: SHARE,
      clientId,
      refreshToken: token.refresh_token ?? "",
      fetchImpl: fake,
    });
    expect(refreshed.access_token).toBe("access-token-refreshed-0123456789");
    expect(await revokeAdapterToken({ binding, metadata: meta, shareCode: SHARE, token: token.access_token, fetchImpl: fake })).toBe(true);
    for (const request of seen) {
      expect(request.headers["x-share-code"]).toBe(SHARE);
    }
  });

  it("owner scope 只能显式请求且实例必须声明；缺省/越权请求拒绝", () => {
    const binding = createFixedInstanceBinding({ instanceUrl: INSTANCE });
    const readonlyMeta = { ...metadata(binding), scopes_supported: ["merchant:read"] };
    expect(() =>
      createAuthorizationRequest({
        binding,
        metadata: readonlyMeta,
        clientId: "client-1",
        redirectUri: REDIRECT,
        shareCode: SHARE,
        scopes: ["merchant:read", "merchant:owner"],
      }),
    ).toThrow(/merchant:owner/);
    const ownerMeta = {
      ...metadata(binding),
      scopes_supported: ["merchant:read", "merchant:owner"],
    };
    const auth = createAuthorizationRequest({
      binding,
      metadata: ownerMeta,
      clientId: "client-1",
      redirectUri: REDIRECT,
      shareCode: SHARE,
      scopes: ["merchant:read", "merchant:owner"],
    });
    expect(new URL(auth.url).searchParams.get("scope")).toBe("merchant:read merchant:owner");
    expect(() =>
      createAuthorizationRequest({
        binding,
        metadata: ownerMeta,
        clientId: "client-1",
        redirectUri: REDIRECT,
        shareCode: SHARE,
        scopes: ["merchant:write"],
      }),
    ).toThrow(/不允许/);
    expect(() =>
      createAuthorizationRequest({
        binding,
        metadata: ownerMeta,
        clientId: "client-1",
        redirectUri: REDIRECT,
        shareCode: SHARE,
        scopes: ["merchant:owner"],
      }),
    ).toThrow(/必须包含 merchant:read/);
  });

  it("token 返回超出本次请求的 scope 被拒绝", () => {
    expect(() =>
      validateAdapterToken(
        {
          access_token: "access-token-0123456789",
          token_type: "Bearer",
          scope: "merchant:read merchant:owner",
          expires_in: 3600,
        },
        Date.now(),
        ["merchant:read"],
      ),
    ).toThrow(/未授权/);
  });

  it("ensureAdapterToken 对过期 token 自动 refresh 并加密写回", async () => {
    const binding = createFixedInstanceBinding({ instanceUrl: INSTANCE });
    const file = path.join(tempDir(), "token.enc");
    const store = new AdapterTokenStore({ file, binding, secret: "test-secret" });
    store.save({
      access_token: "expired-access-token-0123456789",
      refresh_token: "refresh-token-0123456789",
      share_code: "share-test-value",
      expires_at: new Date(Date.now() - 1000).toISOString(),
      scope: ["merchant:read"],
    });
    const fake = (async (_url: string | URL | Request, _init?: NonNullable<Parameters<typeof fetch>[1]>) =>
      new Response(
        JSON.stringify({
          access_token: "refreshed-access-token-0123456789",
          refresh_token: "refreshed-refresh-token-0123456789",
          token_type: "Bearer",
          scope: "merchant:read",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const token = await ensureAdapterToken({
      store,
      binding,
      metadata: metadata(binding),
      shareCode: SHARE,
      clientId: "client-1",
      fetchImpl: fake,
    });
    expect(token.access_token).toBe("refreshed-access-token-0123456789");
    expect(store.load()?.access_token).toBe("refreshed-access-token-0123456789");
    expect(store.load()?.share_code).toBe("share-test-value");
  });
});

describe("token-bound client cache", () => {
  it("同一 token 复用客户端；token 更新后创建新客户端（不沿用旧 MCP 会话）", async () => {
    const cache = new TokenBoundClientCache<string>();
    let created = 0;
    const factory = async (token: { access_token: string }) => {
      created += 1;
      return `client:${token.access_token}`;
    };
    const first = await cache.get(
      {
        access_token: "access-a",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        scope: ["merchant:read"],
      },
      factory,
    );
    const again = await cache.get(
      {
        access_token: "access-a",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        scope: ["merchant:read"],
      },
      factory,
    );
    expect(first).toBe("client:access-a");
    expect(again).toBe(first);
    expect(created).toBe(1);

    const renewed = await cache.get(
      {
        access_token: "access-b",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        scope: ["merchant:read"],
      },
      factory,
    );
    expect(renewed).toBe("client:access-b");
    expect(created).toBe(2);
  });
});

describe("fixed MCP client", () => {  it("只发送 X-Kiwi-Authorization，不发送标准 Authorization；只访问固定 URL", async () => {
    const binding = createFixedInstanceBinding({ instanceUrl: INSTANCE });
    const seen: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fake = (async (url: string | URL | Request, init?: NonNullable<Parameters<typeof fetch>[1]>) => {
      expect(String(url)).toBe(INSTANCE);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      seen.push({
        headers: { ...(init?.headers as Record<string, string>) },
        body,
      });
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
        });
      }
      if (body.method === "tools/list") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "kiwi_merchant_get_operations_report" }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (body.method === "tools/call") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error("unexpected method");
    }) as typeof fetch;

    const client = new FixedInstanceMcpClient({
      binding,
      accessToken: "access-token-0123456789",
      shareCode: SHARE,
      fetchImpl: fake,
    });
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["kiwi_merchant_get_operations_report"]);
    const call = await client.callTool("kiwi_merchant_get_operations_report", { period: "day" });
    expect(call.isError).toBe(false);
    expect(call.text).toBe("ok");
    for (const request of seen) {
      expect(request.headers["x-kiwi-authorization"]).toBe("Bearer access-token-0123456789");
      expect(request.headers["authorization"]).toBeUndefined();
      expect(request.headers["x-share-code"]).toBe(SHARE);
    }
    expect(seen.find((entry) => entry.body.method === "tools/list")?.headers["mcp-session-id"]).toBe("session-1");
  });
});
