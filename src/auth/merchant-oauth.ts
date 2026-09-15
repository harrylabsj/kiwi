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
 * Merchant MCP 的 OAuth 2.1 授权服务器（WorkBuddy Buddy 应用 V2 阶段一）。
 *
 * Spike 结论（https://open.workbuddy.cn/docs/connector）：WorkBuddy 内置 OAuth
 * 管理器只做客户端侧（OAuth 2.1 + PKCE、公共客户端、动态注册），服务端端点
 * 须自建。本模块实现：
 *   - GET  /.well-known/oauth-protected-resource（RFC 9728）
 *   - GET  /.well-known/oauth-authorization-server（RFC 8414）
 *   - POST /oauth/register（RFC 7591 动态客户端注册；只接受公共客户端，
 *     响应回显 redirect_uris）
 *   - GET  /oauth/authorize（授权确认页：商家名 + 申请 scope + 同意/拒绝；
 *     PKCE S256 强制；redirect_uri 字符串精确匹配；state 透传；CSRF 一次性令牌）
 *   - POST /oauth/authorize（表单提交 → 授权码 302 回跳）
 *   - POST /oauth/token（authorization_code / refresh_token；授权码一次性、
 *     10 分钟有效；access_token 1 小时、refresh_token 30 天，刷新即轮换）
 *   - POST /oauth/revoke（RFC 7009）
 *
 * 持久化：授权码/token/客户端注册落状态目录 oauth.sqlite（单 owner 写约束
 * 沿用现有模式；目录 0700）。授权码与 token 只存 sha256 摘要——明文不落盘、
 * 不进日志。错误一律 OAuth 2.1 标准格式（{error, error_description?}）。
 * 生产强制 HTTPS：issuer 非 https 且非 loopback 时构造即拒绝（fail-closed）。
 */

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { isLoopbackHost } from "../a2a/client/url-policy.js";

/** 授权码有效期（10 分钟，一次性使用）。 */
export const OAUTH_CODE_TTL_MS = 10 * 60 * 1000;
/** access_token 有效期（1 小时）。 */
export const OAUTH_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
/** refresh_token 有效期（30 天）。 */
export const OAUTH_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 授权请求（授权页挂起单）有效期（10 分钟）。 */
export const OAUTH_AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

/** WorkBuddy 私有协议回调（source 占位替换为实际连接器 source）。 */
export function workbuddyCallbackUri(source: string): string {
  return `workbuddy://workbuddy/mcp/connector%3A${source}/oauth/callback`;
}

/** redirect_uri 白名单判定：workbuddy 私有协议回调 或 http loopback 回退。 */
export function isAllowedRedirectUri(uri: string, connectorSource: string): boolean {
  if (uri === workbuddyCallbackUri(connectorSource)) return true;
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** 端点处理结果：JSON body / HTML 页面 / 302 重定向。 */
export type OAuthHttpResult = {
  status: number;
  body?: unknown;
  html?: string;
  headers?: Record<string, string>;
};

function oauthError(status: number, error: string, description: string): OAuthHttpResult {
  return { status, body: { error, error_description: description } };
}

function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** 摘要落盘（sha256）：授权码/token 明文绝不落库。 */
function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** PKCE S256：base64url(sha256(verifier))。 */
export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ── 持久化（oauth.sqlite；单 owner 写）──────────────────────────────────────

const OAUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_auth_requests (
  csrf TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_digest TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  access_digest TEXT PRIMARY KEY,
  refresh_digest TEXT UNIQUE,
  client_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
`;

export interface OAuthClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  created_at: string;
}

export interface OAuthTokenRow {
  client_id: string;
  principal_id: string;
  merchant_id: string;
  scope: string[];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export class MerchantOAuthStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now?: () => string }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.db.exec(OAUTH_SCHEMA);
  }

  private isoAfter(ms: number): string {
    return new Date(Date.parse(this.now()) + ms).toISOString();
  }

  private expired(expiresAt: string): boolean {
    return expiresAt <= this.now();
  }

  // ---- clients ----

  registerClient(input: { client_name?: string; redirect_uris: string[] }): OAuthClientRow {
    const row: OAuthClientRow = {
      client_id: randomToken("mcp_client"),
      client_name: input.client_name ?? null,
      redirect_uris: input.redirect_uris,
      created_at: this.now(),
    };
    this.db
      .prepare(
        "INSERT INTO oauth_clients (client_id, client_name, redirect_uris_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(row.client_id, row.client_name, JSON.stringify(row.redirect_uris), row.created_at);
    return row;
  }

  getClient(clientId: string): OAuthClientRow | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as
      | {
          client_id: string;
          client_name: string | null;
          redirect_uris_json: string;
          created_at: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      client_id: row.client_id,
      client_name: row.client_name,
      redirect_uris: JSON.parse(row.redirect_uris_json) as string[],
      created_at: row.created_at,
    };
  }

  // ---- authorization requests（授权页挂起单；csrf 主键一次性消费）----

  createAuthRequest(input: {
    client_id: string;
    redirect_uri: string;
    scope: string;
    state?: string;
    code_challenge: string;
    merchant_id: string;
  }): string {
    const csrf = randomToken("oauth_req");
    this.db
      .prepare(
        `INSERT INTO oauth_auth_requests
           (csrf, client_id, redirect_uri, scope, state, code_challenge, merchant_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        csrf,
        input.client_id,
        input.redirect_uri,
        input.scope,
        input.state ?? null,
        input.code_challenge,
        input.merchant_id,
        this.isoAfter(OAUTH_AUTH_REQUEST_TTL_MS),
        this.now(),
      );
    return csrf;
  }

  /** 取出并删除（一次性；过期视为不存在）。 */
  consumeAuthRequest(csrf: string):
    | {
        client_id: string;
        redirect_uri: string;
        scope: string;
        state?: string;
        code_challenge: string;
        merchant_id: string;
      }
    | undefined {
    const row = this.db.prepare("SELECT * FROM oauth_auth_requests WHERE csrf = ?").get(csrf) as
      | {
          client_id: string;
          redirect_uri: string;
          scope: string;
          state: string | null;
          code_challenge: string;
          merchant_id: string;
          expires_at: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    this.db.prepare("DELETE FROM oauth_auth_requests WHERE csrf = ?").run(csrf);
    if (this.expired(row.expires_at)) return undefined;
    return {
      client_id: row.client_id,
      redirect_uri: row.redirect_uri,
      scope: row.scope,
      ...(row.state !== null ? { state: row.state } : {}),
      code_challenge: row.code_challenge,
      merchant_id: row.merchant_id,
    };
  }

  // ---- authorization codes（一次性，10 分钟）----

  createCode(input: {
    client_id: string;
    redirect_uri: string;
    scope: string;
    principal_id: string;
    merchant_id: string;
    code_challenge: string;
  }): string {
    const code = randomToken("oauth_code");
    this.db
      .prepare(
        `INSERT INTO oauth_codes
           (code_digest, client_id, redirect_uri, scope, principal_id, merchant_id, code_challenge, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        digestOf(code),
        input.client_id,
        input.redirect_uri,
        input.scope,
        input.principal_id,
        input.merchant_id,
        input.code_challenge,
        this.isoAfter(OAUTH_CODE_TTL_MS),
        this.now(),
      );
    return code;
  }

  /** 核销授权码（一次性；过期/已用返回 undefined）。 */
  consumeCode(code: string):
    | {
        client_id: string;
        redirect_uri: string;
        scope: string;
        principal_id: string;
        merchant_id: string;
        code_challenge: string;
      }
    | undefined {
    const digest = digestOf(code);
    const row = this.db.prepare("SELECT * FROM oauth_codes WHERE code_digest = ?").get(digest) as
      | {
          client_id: string;
          redirect_uri: string;
          scope: string;
          principal_id: string;
          merchant_id: string;
          code_challenge: string;
          expires_at: string;
          used_at: string | null;
        }
      | undefined;
    if (row === undefined || row.used_at !== null) return undefined;
    if (this.expired(row.expires_at)) return undefined;
    this.db
      .prepare("UPDATE oauth_codes SET used_at = ? WHERE code_digest = ?")
      .run(this.now(), digest);
    return row;
  }

  // ---- tokens（access 1h / refresh 30d；刷新即轮换）----

  issueTokenPair(input: {
    client_id: string;
    principal_id: string;
    merchant_id: string;
    scope: string;
  }): { access_token: string; refresh_token: string; expires_in: number } {
    const accessToken = randomToken("mcp_at");
    const refreshToken = randomToken("mcp_rt");
    this.db
      .prepare(
        `INSERT INTO oauth_tokens
           (access_digest, refresh_digest, client_id, principal_id, merchant_id, scope, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        digestOf(accessToken),
        digestOf(refreshToken),
        input.client_id,
        input.principal_id,
        input.merchant_id,
        input.scope,
        this.isoAfter(OAUTH_ACCESS_TOKEN_TTL_MS),
        this.now(),
      );
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: Math.floor(OAUTH_ACCESS_TOKEN_TTL_MS / 1000),
    };
  }

  /** 查 access token（未过期、未撤销才返回）。 */
  getAccessToken(accessToken: string): OAuthTokenRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM oauth_tokens WHERE access_digest = ?")
      .get(digestOf(accessToken)) as
      | {
          client_id: string;
          principal_id: string;
          merchant_id: string;
          scope: string;
          expires_at: string;
          revoked_at: string | null;
          created_at: string;
        }
      | undefined;
    if (row === undefined || row.revoked_at !== null) return undefined;
    if (this.expired(row.expires_at)) return undefined;
    return {
      client_id: row.client_id,
      principal_id: row.principal_id,
      merchant_id: row.merchant_id,
      scope: row.scope.split(" ").filter((s) => s !== ""),
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      created_at: row.created_at,
    };
  }

  /** 刷新轮换：核销旧 refresh，签发新 token 对。 */
  rotateRefreshToken(
    refreshToken: string,
  ): { access_token: string; refresh_token: string; expires_in: number } | undefined {
    const digest = digestOf(refreshToken);
    const row = this.db
      .prepare("SELECT * FROM oauth_tokens WHERE refresh_digest = ?")
      .get(digest) as
      | {
          client_id: string;
          principal_id: string;
          merchant_id: string;
          scope: string;
          revoked_at: string | null;
        }
      | undefined;
    if (row === undefined || row.revoked_at !== null) return undefined;
    this.db
      .prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE refresh_digest = ?")
      .run(this.now(), digest);
    return this.issueTokenPair({
      client_id: row.client_id,
      principal_id: row.principal_id,
      merchant_id: row.merchant_id,
      scope: row.scope,
    });
  }

  /** RFC 7009 撤销（access 或 refresh；幂等，未知 token 也视为成功）。 */
  revokeToken(token: string): void {
    const digest = digestOf(token);
    this.db
      .prepare(
        "UPDATE oauth_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND (access_digest = ? OR refresh_digest = ?)",
      )
      .run(this.now(), digest, digest);
  }
}

// ── 授权服务器端点 ──────────────────────────────────────────────────────────

export interface MerchantOAuthServerOptions {
  store: MerchantOAuthStore;
  /** 本服务 base URL（https；loopback 开发可 http）。 */
  issuer: string;
  /** 被保护资源地址（MCP endpoint URL）。 */
  resource: string;
  /** 连接器 source（workbuddy 回调白名单用）。 */
  connectorSource: string;
  /** 授权页展示的商家名。 */
  merchantName: string;
  /** 授权通过后 token 绑定的 principal / merchant（单商家实例固定）。 */
  principalId: string;
  merchantId: string;
  /** 支持的 scope（缺省 merchant:read / merchant:write）。 */
  scopes?: string[];
  now?: () => string;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function redirectTo(uri: string, params: Record<string, string>): OAuthHttpResult {
  const sep = uri.includes("?") ? "&" : "?";
  return {
    status: 302,
    headers: { location: `${uri}${sep}${new URLSearchParams(params).toString()}` },
  };
}

export class MerchantOAuthServer {
  private readonly store: MerchantOAuthStore;
  private readonly issuer: string;
  private readonly resource: string;
  private readonly connectorSource: string;
  private readonly merchantName: string;
  private readonly principalId: string;
  private readonly merchantId: string;
  private readonly scopes: string[];

  constructor(options: MerchantOAuthServerOptions) {
    const issuerUrl = new URL(options.issuer);
    // 生产强制 HTTPS；本地开发可 http loopback（对齐连接器文档的本地回退）。
    if (issuerUrl.protocol !== "https:" && !isLoopbackHost(issuerUrl.hostname)) {
      throw new Error(`OAuth issuer 必须 https（或 loopback http 开发地址）：${options.issuer}`);
    }
    this.store = options.store;
    this.issuer = options.issuer.replace(/\/+$/, "");
    this.resource = options.resource;
    this.connectorSource = options.connectorSource;
    this.merchantName = options.merchantName;
    this.principalId = options.principalId;
    this.merchantId = options.merchantId;
    this.scopes = options.scopes ?? ["merchant:read", "merchant:write"];
  }

  /** RFC 9728 resource metadata URL（401 WWW-Authenticate 指引用）。 */
  get resourceMetadataUrl(): string {
    return `${this.issuer}/.well-known/oauth-protected-resource`;
  }

  /** RFC 9728 protected resource metadata。 */
  protectedResourceMetadata(): OAuthHttpResult {
    return {
      status: 200,
      body: { resource: this.resource, authorization_servers: [this.issuer] },
    };
  }

  /** RFC 8414 authorization server metadata。 */
  authorizationServerMetadata(): OAuthHttpResult {
    return {
      status: 200,
      body: {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/oauth/authorize`,
        token_endpoint: `${this.issuer}/oauth/token`,
        registration_endpoint: `${this.issuer}/oauth/register`,
        revocation_endpoint: `${this.issuer}/oauth/revoke`,
        scopes_supported: this.scopes,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      },
    };
  }

  /** RFC 7591 动态注册：只接受公共客户端（无 client_secret）；回显 redirect_uris。 */
  register(body: unknown): OAuthHttpResult {
    const input = (body ?? {}) as Record<string, unknown>;
    const redirectUris = input.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.some((u) => typeof u !== "string" || u === "")
    ) {
      return oauthError(400, "invalid_client_metadata", "redirect_uris 必须是非空字符串数组");
    }
    for (const uri of redirectUris as string[]) {
      if (!isAllowedRedirectUri(uri, this.connectorSource)) {
        return oauthError(
          400,
          "invalid_redirect_uri",
          `redirect_uri 不在白名单（workbuddy 回调或 http loopback）：${uri}`,
        );
      }
    }
    const client = this.store.registerClient({
      ...(typeof input.client_name === "string" ? { client_name: input.client_name } : {}),
      redirect_uris: redirectUris as string[],
    });
    return {
      status: 201,
      body: {
        client_id: client.client_id,
        ...(client.client_name !== null ? { client_name: client.client_name } : {}),
        redirect_uris: client.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    };
  }

  /** GET /oauth/authorize：校验请求 → 授权确认页（CSRF 挂起单）。 */
  authorize(query: Record<string, string | undefined>): OAuthHttpResult {
    const fail = (error: string, description: string): OAuthHttpResult =>
      oauthError(400, error, description);
    const redirectUri = query.redirect_uri;
    if (query.response_type !== "code") return fail("invalid_request", "response_type 必须是 code");
    if (query.client_id === undefined) return fail("invalid_request", "缺 client_id");
    const client = this.store.getClient(query.client_id);
    if (client === undefined) return fail("invalid_client", "未知 client_id（请先动态注册）");
    if (redirectUri === undefined || !client.redirect_uris.includes(redirectUri)) {
      // redirect_uri 不可信时绝不回跳（防开放重定向），直接报错。
      return fail("invalid_request", "redirect_uri 与注册值不匹配（字符串精确匹配）");
    }
    // 之后的错误可以安全回跳 redirect_uri（OAuth 2.1 标准）。
    const redirectFail = (error: string, description: string): OAuthHttpResult =>
      redirectTo(redirectUri, {
        error,
        error_description: description,
        ...(query.state !== undefined ? { state: query.state } : {}),
      });
    if (
      query.code_challenge === undefined ||
      query.code_challenge === "" ||
      query.code_challenge_method !== "S256"
    ) {
      return redirectFail(
        "invalid_request",
        "必须 PKCE：code_challenge + code_challenge_method=S256",
      );
    }
    const requestedScopes = (query.scope ?? this.scopes.join(" "))
      .split(" ")
      .filter((s) => s !== "");
    const unknownScope = requestedScopes.find((s) => !this.scopes.includes(s));
    if (unknownScope !== undefined) {
      return redirectFail("invalid_scope", `不支持的 scope：${unknownScope}`);
    }
    const csrf = this.store.createAuthRequest({
      client_id: query.client_id,
      redirect_uri: redirectUri,
      scope: requestedScopes.join(" "),
      ...(query.state !== undefined ? { state: query.state } : {}),
      code_challenge: query.code_challenge,
      merchant_id: this.merchantId,
    });
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      html: `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>授权确认 — Kiwi 商家工作台</title></head>
<body>
  <h1>Kiwi 商家运营工作台</h1>
  <p>应用「${escapeHtml(client.client_name ?? query.client_id)}」请求访问商家「${escapeHtml(this.merchantName)}」的：</p>
  <ul>
    ${requestedScopes.map((s) => `<li>${escapeHtml(s)}</li>`).join("\n    ")}
  </ul>
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <button type="submit" name="decision" value="approve">同意授权</button>
    <button type="submit" name="decision" value="deny">拒绝</button>
  </form>
</body>
</html>`,
    };
  }

  /** POST /oauth/authorize（表单）：CSRF 校验 → 授权码回跳 / access_denied。 */
  authorizeSubmit(form: Record<string, string | undefined>): OAuthHttpResult {
    const pending =
      typeof form.csrf === "string" ? this.store.consumeAuthRequest(form.csrf) : undefined;
    if (pending === undefined) {
      return oauthError(
        400,
        "invalid_request",
        "授权请求无效或已过期（CSRF/state 校验失败），请重新发起",
      );
    }
    if (form.decision !== "approve") {
      return redirectTo(pending.redirect_uri, {
        error: "access_denied",
        error_description: "用户拒绝授权",
        ...(pending.state !== undefined ? { state: pending.state } : {}),
      });
    }
    const code = this.store.createCode({
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      scope: pending.scope,
      principal_id: this.principalId,
      merchant_id: pending.merchant_id,
      code_challenge: pending.code_challenge,
    });
    return redirectTo(pending.redirect_uri, {
      code,
      ...(pending.state !== undefined ? { state: pending.state } : {}),
    });
  }

  /** POST /oauth/token：authorization_code（PKCE 校验）/ refresh_token（轮换）。 */
  token(form: Record<string, string | undefined>): OAuthHttpResult {
    if (form.grant_type === "authorization_code") {
      const code = typeof form.code === "string" ? this.store.consumeCode(form.code) : undefined;
      if (code === undefined) {
        return oauthError(400, "invalid_grant", "授权码无效、已使用或已过期");
      }
      if (form.client_id !== code.client_id) {
        return oauthError(400, "invalid_grant", "client_id 与授权码不匹配");
      }
      if (form.redirect_uri !== code.redirect_uri) {
        return oauthError(400, "invalid_grant", "redirect_uri 与授权码不匹配");
      }
      if (
        typeof form.code_verifier !== "string" ||
        pkceS256(form.code_verifier) !== code.code_challenge
      ) {
        return oauthError(400, "invalid_grant", "PKCE 校验失败（code_verifier 不匹配）");
      }
      const pair = this.store.issueTokenPair({
        client_id: code.client_id,
        principal_id: code.principal_id,
        merchant_id: code.merchant_id,
        scope: code.scope,
      });
      return {
        status: 200,
        body: {
          access_token: pair.access_token,
          token_type: "Bearer",
          expires_in: pair.expires_in,
          refresh_token: pair.refresh_token,
          scope: code.scope,
        },
      };
    }
    if (form.grant_type === "refresh_token") {
      if (typeof form.refresh_token !== "string") {
        return oauthError(400, "invalid_request", "缺 refresh_token");
      }
      const pair = this.store.rotateRefreshToken(form.refresh_token);
      if (pair === undefined) {
        return oauthError(400, "invalid_grant", "refresh_token 无效或已撤销");
      }
      const issued = this.store.getAccessToken(pair.access_token);
      return {
        status: 200,
        body: {
          access_token: pair.access_token,
          token_type: "Bearer",
          expires_in: pair.expires_in,
          refresh_token: pair.refresh_token,
          scope: issued?.scope.join(" ") ?? "",
        },
      };
    }
    return oauthError(
      400,
      "unsupported_grant_type",
      "grant_type 只支持 authorization_code / refresh_token",
    );
  }

  /** POST /oauth/revoke（RFC 7009；幂等，未知 token 也返回 200）。 */
  revoke(form: Record<string, string | undefined>): OAuthHttpResult {
    if (typeof form.token === "string" && form.token !== "") this.store.revokeToken(form.token);
    return { status: 200, body: {} };
  }
}
