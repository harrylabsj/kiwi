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
import { inImmediateTransaction } from "../merchant-core/storage/transaction.js";
import { MERCHANT_THEME_CSS } from "../merchant-ui/theme.js";
import {
  DEFAULT_MERCHANT_SCOPES,
  MERCHANT_OWNER_SCOPE,
} from "./merchant-scopes.js";

export { MERCHANT_OWNER_SCOPE };

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

/**
 * OAuth 回调策略（可配置：source、期望回调与 loopback 回退都随部署确定）。
 *
 * - ``expectedCallbackUri``：显式期望的回调地址；缺省按连接器 source 派生
 *   WorkBuddy 私有协议回调（`workbuddy://…/connector%3A<source>/oauth/callback`）。
 *   平台侧回调规则未实机核验前，保持“由 source 派生”即可；核验后如平台给出
 *   不同形式，用本项覆盖而不改代码；
 * - ``allowLoopbackFallback``：私有协议回调被平台拒绝时是否允许 http loopback
 *   回退（官方文档的回退路径）。缺省 true；如需严格锁定为单一回调可置 false。
 */
export interface OAuthCallbackPolicy {
  expectedCallbackUri?: string;
  allowLoopbackFallback?: boolean;
}

/** 解析生效的期望回调地址（显式配置优先，否则按 source 派生）。 */
export function expectedCallbackUri(
  connectorSource: string,
  policy: OAuthCallbackPolicy = {},
): string {
  return policy.expectedCallbackUri ?? workbuddyCallbackUri(connectorSource);
}

/** redirect_uri 白名单判定：期望回调（source 派生或显式配置） 或 http loopback 回退。 */
export function isAllowedRedirectUri(
  uri: string,
  connectorSource: string,
  policy: OAuthCallbackPolicy = {},
): boolean {
  if (uri === expectedCallbackUri(connectorSource, policy)) return true;
  if (policy.allowLoopbackFallback === false) return false;
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
  principal_id TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS oauth_consents (
  client_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (client_id, merchant_id, scope)
);
`;

/** BUG-10 迁移：refresh_token 独立过期（老库 ALTER 补列，老数据按 created_at+30d
 *  回填——比库创建时还旧的 refresh 自然过期，fail-closed）。迁移与回填在构造
 *  函数中以单事务执行（见构造函数审查 P2 注释），SQL 已内联。 */

/** BUG-01 迁移：授权挂起单绑定认证主体（老库补 principal_id 列；老挂起单
 *  10 分钟内过期，给空串占位即不可再被消费——consumeAuthRequest 拒绝）。 */
const OAUTH_MIGRATION_AUTH_REQUEST_PRINCIPAL = `
ALTER TABLE oauth_auth_requests ADD COLUMN principal_id TEXT NOT NULL DEFAULT '';
`;

/** BUG-02 一次性确认凭证：绑定候选内容摘要 + 主体 + 商家 + 动作 + 有效期，
 *  单次用途（管理确认页批准/拒绝的唯一可信通道；模型 MCP 工具已移除）。 */
const OAUTH_CONFIRMATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_confirmations (
  token_digest TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
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
    this.db.exec(OAUTH_CONFIRMATIONS_SCHEMA);
    // BUG-10 迁移：老库补 refresh_expires_at 列。审查 P2：ALTER 与回填
    // UPDATE 在同一事务提交——半途崩溃不会留下「列存在但全 NULL」的库
    // （NULL 行会让 refresh 永不过期，fail-open）；列已存在时仍幂等重跑
    // 回填，补齐历史中断遗留的 NULL 行。
    const columns = this.db.prepare("PRAGMA table_info(oauth_tokens)").all() as Array<{
      name: string;
    }>;
    inImmediateTransaction(this.db, () => {
      if (!columns.some((c) => c.name === "refresh_expires_at")) {
        this.db.exec("ALTER TABLE oauth_tokens ADD COLUMN refresh_expires_at TEXT;");
      }
      this.db.exec(
        "UPDATE oauth_tokens SET refresh_expires_at = " +
          "strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+30 days') WHERE refresh_expires_at IS NULL;",
      );
    });
    // BUG-01 迁移：老库补授权挂起单 principal_id 列（老挂起单不可再消费）。
    const reqColumns = this.db.prepare("PRAGMA table_info(oauth_auth_requests)").all() as Array<{
      name: string;
    }>;
    if (!reqColumns.some((c) => c.name === "principal_id")) {
      this.db.exec(OAUTH_MIGRATION_AUTH_REQUEST_PRINCIPAL);
    }
    this.cleanupExpired();
  }

  /**
   * 过期行清理（审查 P2：此前全库只增不删，长期运行单调膨胀）。只删完全
   * 失效的行：挂起单/授权码/一次性凭证按各自 expires_at；token 需 access
   * 与 refresh 双过期（撤销行在 refresh 未过期前保留可查）。
   */
  cleanupExpired(): void {
    const now = this.now();
    this.db.prepare("DELETE FROM oauth_auth_requests WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM oauth_confirmations WHERE expires_at <= ?").run(now);
    this.db
      .prepare("DELETE FROM oauth_tokens WHERE expires_at <= ? AND refresh_expires_at <= ?")
      .run(now, now);
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
    /** 认证主体（BUG-01：来自管理登录会话，不是启动参数）。 */
    principal_id: string;
  }): string {
    const csrf = randomToken("oauth_req");
    this.db
      .prepare(
        `INSERT INTO oauth_auth_requests
           (csrf, client_id, redirect_uri, scope, state, code_challenge, merchant_id, principal_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        csrf,
        input.client_id,
        input.redirect_uri,
        input.scope,
        input.state ?? null,
        input.code_challenge,
        input.merchant_id,
        input.principal_id,
        this.isoAfter(OAUTH_AUTH_REQUEST_TTL_MS),
        this.now(),
      );
    return csrf;
  }

  /** 取出并删除（一次性；过期或缺认证主体（迁移老数据）视为不存在）。 */
  consumeAuthRequest(csrf: string):
    | {
        client_id: string;
        redirect_uri: string;
        scope: string;
        state?: string;
        code_challenge: string;
        merchant_id: string;
        principal_id: string;
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
          principal_id: string;
          expires_at: string;
        }
      | undefined;
    if (row === undefined) return undefined;
    this.db.prepare("DELETE FROM oauth_auth_requests WHERE csrf = ?").run(csrf);
    if (this.expired(row.expires_at)) return undefined;
    if (row.principal_id === "") return undefined; // 迁移老挂起单：无认证主体
    return {
      client_id: row.client_id,
      redirect_uri: row.redirect_uri,
      scope: row.scope,
      ...(row.state !== null ? { state: row.state } : {}),
      code_challenge: row.code_challenge,
      merchant_id: row.merchant_id,
      principal_id: row.principal_id,
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

  /** 核销授权码（一次性；过期/已用返回 undefined）。事务 + 条件更新：与
   *  rotateRefreshToken 同口径，双进程误开同一 oauth.sqlite 时同一授权码也
   *  只能被核销一次（审查 P2：原 SELECT→UPDATE 无原子性）。 */
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
    return inImmediateTransaction(this.db, () => {
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
      if (row === undefined || row.used_at !== null || this.expired(row.expires_at)) {
        // 只读早退：fn 内 return，wrapper 提交空事务（与 ROLLBACK 等价）
        return undefined;
      }
      const used = this.db
        .prepare("UPDATE oauth_codes SET used_at = ? WHERE code_digest = ? AND used_at IS NULL")
        .run(this.now(), digest);
      if (used.changes !== 1) {
        // 并发核销：另一方先到。UPDATE 零变更，提交空事务与 ROLLBACK 等价。
        return undefined;
      }
      return row;
    });
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
           (access_digest, refresh_digest, client_id, principal_id, merchant_id, scope, expires_at, refresh_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        digestOf(accessToken),
        digestOf(refreshToken),
        input.client_id,
        input.principal_id,
        input.merchant_id,
        input.scope,
        this.isoAfter(OAUTH_ACCESS_TOKEN_TTL_MS),
        // BUG-10：refresh 独立过期（30 天），不再永不过期。
        this.isoAfter(OAUTH_REFRESH_TOKEN_TTL_MS),
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

  /**
   * 刷新轮换（BUG-10）：同一事务内验证旧 refresh 未撤销、未过期（独立
   *  refresh_expires_at）并核销，再签发新 token 对——并发轮换只有一个成功
   *  （UPDATE … WHERE revoked_at IS NULL 的条件更新，未命中即已被轮换）。
   */
  rotateRefreshToken(
    refreshToken: string,
    expectedClientId?: string,
  ): { access_token: string; refresh_token: string; expires_in: number } | undefined {
    const digest = digestOf(refreshToken);
    const now = this.now();
    return inImmediateTransaction(this.db, () => {
      const row = this.db
        .prepare("SELECT * FROM oauth_tokens WHERE refresh_digest = ?")
        .get(digest) as
        | {
            client_id: string;
            principal_id: string;
            merchant_id: string;
            scope: string;
            revoked_at: string | null;
            refresh_expires_at: string | null;
          }
        | undefined;
      if (row === undefined || row.revoked_at !== null) {
        // 只读早退：fn 内 return，wrapper 提交空事务（与 ROLLBACK 等价）
        return undefined;
      }
      // 独立 refresh 过期检查（审查 P2：NULL = 迁移遗留的不可判定行，
      // fail-closed 拒绝；正常路径构造函数迁移已回填，不会出现 NULL）。
      if (row.refresh_expires_at === null || row.refresh_expires_at <= now) {
        return undefined;
      }
      // RFC 6749 §6 / OAuth 2.1：refresh grant 绑定原 client_id（审查 P2）。
      if (expectedClientId !== undefined && row.client_id !== expectedClientId) {
        return undefined;
      }
      const revoked = this.db
        .prepare(
          "UPDATE oauth_tokens SET revoked_at = ? WHERE refresh_digest = ? AND revoked_at IS NULL",
        )
        .run(now, digest);
      if (revoked.changes === 0) {
        // 并发轮换：另一方先核销。UPDATE 零变更，提交空事务与 ROLLBACK 等价。
        return undefined;
      }
      return this.issueTokenPair({
        client_id: row.client_id,
        principal_id: row.principal_id,
        merchant_id: row.merchant_id,
        scope: row.scope,
      });
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

  /** 该 token 属于哪个 client/merchant（撤销时同步忘掉记住的授权）。 */
  tokenOwner(token: string): { client_id: string; merchant_id: string } | undefined {
    const digest = digestOf(token);
    const row = this.db
      .prepare(
        "SELECT client_id, merchant_id FROM oauth_tokens WHERE access_digest = ? OR refresh_digest = ?",
      )
      .get(digest, digest) as { client_id?: string; merchant_id?: string } | undefined;
    if (row?.client_id === undefined || row?.merchant_id === undefined) return undefined;
    return { client_id: row.client_id, merchant_id: row.merchant_id };
  }

  // ---- 记住授权（同一 client+merchant+scope 在有效期内不再重复确认）---------

  recordConsent(input: {
    client_id: string;
    merchant_id: string;
    scope: string;
    expires_at: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO oauth_consents (client_id, merchant_id, scope, granted_at, expires_at)" +
          " VALUES (?, ?, ?, ?, ?)" +
          " ON CONFLICT(client_id, merchant_id, scope)" +
          " DO UPDATE SET granted_at = excluded.granted_at, expires_at = excluded.expires_at",
      )
      .run(
        input.client_id,
        input.merchant_id,
        canonicalScope(input.scope),
        this.now(),
        input.expires_at,
      );
  }

  hasConsent(input: {
    client_id: string;
    merchant_id: string;
    scope: string;
    now: string;
  }): boolean {
    const row = this.db
      .prepare(
        "SELECT expires_at FROM oauth_consents WHERE client_id = ? AND merchant_id = ? AND scope = ?",
      )
      .get(input.client_id, input.merchant_id, canonicalScope(input.scope)) as
      | { expires_at?: string }
      | undefined;
    if (row?.expires_at === undefined) return false;
    return String(row.expires_at) > input.now;
  }

  revokeConsent(input: { client_id: string; merchant_id: string }): void {
    this.db
      .prepare("DELETE FROM oauth_consents WHERE client_id = ? AND merchant_id = ?")
      .run(input.client_id, input.merchant_id);
  }

  // ---- 一次性确认凭证（BUG-02：批准/拒绝的唯一可信通道） --------------------

  /**
   * 签发一次性确认凭证（管理确认页渲染时按候选生成；绑定候选内容摘要 +
   * 主体 + 商家 + 动作 + 10 分钟有效期）。返回明文 token（只进表单，不落库）。
   */
  createConfirmation(input: {
    candidateId: string;
    candidateDigest: string;
    principalId: string;
    merchantId: string;
    action: "approve" | "reject";
  }): string {
    const token = randomToken("kcfrm");
    this.db
      .prepare(
        `INSERT INTO oauth_confirmations
           (token_digest, candidate_id, candidate_digest, principal_id, merchant_id, action, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        digestOf(token),
        input.candidateId,
        input.candidateDigest,
        input.principalId,
        input.merchantId,
        input.action,
        this.isoAfter(OAUTH_CODE_TTL_MS),
        this.now(),
      );
    return token;
  }

  /**
   * 核销确认凭证（单次用途；逐项核对候选/摘要/主体/商家/动作，未过期未使用
   * 才返回记录）。核对失败返回 undefined（fail-closed）。
   */
  consumeConfirmation(
    token: string,
    expected: {
      candidateId: string;
      candidateDigest: string;
      principalId: string;
      merchantId: string;
      action: "approve" | "reject";
    },
  ):
    | {
        candidate_id: string;
        principal_id: string;
        action: "approve" | "reject";
        created_at: string;
      }
    | undefined {
    const digest = digestOf(token);
    return inImmediateTransaction(this.db, () => {
      const row = this.db
        .prepare("SELECT * FROM oauth_confirmations WHERE token_digest = ?")
        .get(digest) as
        | {
            candidate_id: string;
            candidate_digest: string;
            principal_id: string;
            merchant_id: string;
            action: "approve" | "reject";
            expires_at: string;
            used_at: string | null;
            created_at: string;
          }
        | undefined;
      const valid =
        row !== undefined &&
        row.used_at === null &&
        row.expires_at > this.now() &&
        row.candidate_id === expected.candidateId &&
        row.candidate_digest === expected.candidateDigest &&
        row.principal_id === expected.principalId &&
        row.merchant_id === expected.merchantId &&
        row.action === expected.action;
      if (!valid) {
        // 只读早退：fn 内 return，wrapper 提交空事务（与 ROLLBACK 等价）
        return undefined;
      }
      this.db
        .prepare("UPDATE oauth_confirmations SET used_at = ? WHERE token_digest = ?")
        .run(this.now(), digest);
      return row === undefined
        ? undefined
        : {
            candidate_id: row.candidate_id,
            principal_id: row.principal_id,
            action: row.action,
            created_at: row.created_at,
          };
    });
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
  /** 单商家实例的展示名；通用网关省略时由已认证会话提供。 */
  merchantName?: string;
  /** 单商家实例归属商家；通用网关省略时由已认证会话决定。 */
  merchantId?: string;
  /** 只有通用网关才可开启：由经过验证的会话决定商家，不能意外省略 merchantId。 */
  multiMerchant?: boolean;
  /** 支持的 scope（缺省 merchant:read / merchant:write）。 */
  scopes?: string[];
  /** 回调策略（缺省按 connectorSource 派生 + 允许 loopback 回退）。 */
  callbackPolicy?: OAuthCallbackPolicy;
  /**
   * 无会话时 authorize 的 303 落点（缺省单商家管理登录页 /admin/login）。
   * 商家连接器入口传连接流程入口（如 /connect）：它负责把商家送到目录登录/注册，
   * 完成后带着会话回到同一 authorize 请求。
   */
  loginPath?: string;
  now?: () => string;
  /**
   * 记住授权：同一 client + merchant + scope 在 consentTtlMs 内不再重复展示
   * 确认页，直接签发授权码（标准 OAuth 的 consent memory）。默认关闭，由
   * 通用连接器网关显式开启；scope 集合变化或过期后重新要求确认。
   */
  rememberConsent?: boolean;
  /** 记住授权的有效期（缺省 30 天）。 */
  consentTtlMs?: number;
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

/** 记住授权（consent memory）有效期：30 天。 */
const CONSENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 从环境变量小时数解析记住授权 TTL（缺省/非法 → 30 天；夹在 1 小时..1 年）。 */
export function consentTtlMsFromHours(raw: string | undefined): number {
  const text = String(raw ?? "").trim();
  const hours = text === "" ? 720 : Number(text);
  if (!Number.isFinite(hours) || hours <= 0) return CONSENT_TTL_MS;
  return Math.min(Math.max(hours, 1), 8760) * 60 * 60 * 1000;
}

/** scope 集合的规范形式（排序去重），作为 consent 的键。 */
function canonicalScope(scopes: string): string {
  return scopes.split(" ").map((s) => s.trim()).filter((s) => s !== "").sort().join(" ");
}

/** OAuth scope 的中文说明（确认页逐条展示，避免只给技术代号）。 */
const SCOPE_LABELS: Readonly<Record<string, string>> = {
  "catalog:read": "读取目录里的公开资料",
  "catalog:write": "写入目录草稿、发布状态与撤回",
  "merchant:read": "读取商家实例的商品、报价规则与磋商",
  "merchant:write": "执行商家操作（仍需在商家应用内逐次确认）",
  "merchant:owner": "读取本商家的真实报价金额（仅店主授权，且须客户端明确申请）",
};

/**
 * 店主金额 scope 的定义与缺省白名单见 `merchant-scopes.ts`。
 * 该 scope 不在缺省集合中：实例显式启用、客户端显式申请、owner 会话三者
 * 同时满足才签发；静态/配对 token 没有 OAuth 授权上下文，拿不到该 scope。
 */

export class MerchantOAuthServer {
  private readonly store: MerchantOAuthStore;
  private readonly issuer: string;
  private readonly resource: string;
  private readonly connectorSource: string;
  private readonly merchantName: string | undefined;
  private readonly merchantId: string | undefined;
  private readonly scopes: string[];
  private readonly loginPath: string;
  private readonly callbackPolicy: OAuthCallbackPolicy;
  private readonly rememberConsent: boolean;
  private readonly consentTtlMs: number;
  private readonly now: () => string;

  constructor(options: MerchantOAuthServerOptions) {
    const issuerUrl = new URL(options.issuer);
    // 生产强制 HTTPS；本地开发可 http loopback（对齐连接器文档的本地回退）。
    if (issuerUrl.protocol !== "https:" && !isLoopbackHost(issuerUrl.hostname)) {
      throw new Error(`OAuth issuer 必须 https（或 loopback http 开发地址）：${options.issuer}`);
    }
    if (options.multiMerchant === true) {
      if (options.merchantId !== undefined) {
        throw new Error("通用 OAuth 入口不能同时固定 merchantId");
      }
    } else if (!options.merchantId) {
      throw new Error("单商家 OAuth 入口必须配置 merchantId；通用入口须显式 multiMerchant=true");
    }
    this.store = options.store;
    this.issuer = options.issuer.replace(/\/+$/, "");
    this.resource = options.resource;
    this.connectorSource = options.connectorSource;
    this.merchantName = options.merchantName;
    this.merchantId = options.merchantId;
    this.scopes = options.scopes ?? [...DEFAULT_MERCHANT_SCOPES];
    this.loginPath = options.loginPath ?? "/admin/login";
    this.callbackPolicy = options.callbackPolicy ?? {};
    this.rememberConsent = options.rememberConsent === true;
    this.consentTtlMs = options.consentTtlMs ?? CONSENT_TTL_MS;
    this.now = options.now ?? (() => new Date().toISOString());
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
        // 只在单商家实例且管理员显式把 owner scope 加入白名单时广告；
        // 通用网关（multiMerchant）即使误配也不暴露私有金额能力。
        scopes_supported:
          this.merchantId !== undefined && this.scopes.includes(MERCHANT_OWNER_SCOPE)
            ? this.scopes
            : this.scopes.filter((s) => s !== MERCHANT_OWNER_SCOPE),
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
      if (!isAllowedRedirectUri(uri, this.connectorSource, this.callbackPolicy)) {
        return oauthError(
          400,
          "invalid_redirect_uri",
          `redirect_uri 不在白名单（期望 ${expectedCallbackUri(this.connectorSource, this.callbackPolicy)}` +
            `${this.callbackPolicy.allowLoopbackFallback === false ? "，不允许 loopback 回退" : " 或 http loopback"}）：${uri}`,
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
  /**
   * GET /oauth/authorize：校验请求 → 授权确认页（CSRF 挂起单）。
   * BUG-01：授权前必须持有有效管理登录会话——未登录 → 303 登录页（回跳
   * 原授权 URL）；会话商家 ≠ 本实例商家 → 拒绝（跨商家授权拒绝）。
   * 挂起单绑定会话认证的 principal_id，授权码主体只能来自认证用户。
   */
  authorize(
    query: Record<string, string | undefined>,
    session?: {
      principal_id: string;
      merchant_id: string;
      merchant_name?: string;
      /** 管理会话角色；merchant:owner 只在 owner 角色下授予。 */
      role?: string;
    },
  ): OAuthHttpResult {
    if (session === undefined) {
      const next = `/oauth/authorize?${new URLSearchParams(
        Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined),
      ).toString()}`;
      return {
        status: 303,
        headers: { location: `${this.loginPath}?next=${encodeURIComponent(next)}` },
      };
    }
    if (!session.merchant_id || !session.principal_id) {
      return oauthError(403, "access_denied", "登录会话缺商家或授权主体");
    }
    if (this.merchantId !== undefined && session.merchant_id !== this.merchantId) {
      return oauthError(403, "access_denied", "登录用户不属于本商家实例（跨商家授权拒绝）");
    }
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
    // owner 必须由客户端显式申请：缺省请求即使实例已启用 owner 也不包含它。
    const requestedScopes = (
      query.scope ?? this.scopes.filter((s) => s !== MERCHANT_OWNER_SCOPE).join(" ")
    )
      .split(" ")
      .filter((s) => s !== "");
    // 严格按实例配置的 scopes 白名单校验；未把 owner 加入白名单的实例不能申请。
    const unknownScope = requestedScopes.find((s) => !this.scopes.includes(s));
    if (unknownScope !== undefined) {
      return redirectFail("invalid_scope", `不支持的 scope：${unknownScope}`);
    }
    if (requestedScopes.includes(MERCHANT_OWNER_SCOPE)) {
      // 三重门：显式启用（scopes 白名单）+ 单商家实例 + owner 会话。
      const ownerEnabled = this.merchantId !== undefined && this.scopes.includes(MERCHANT_OWNER_SCOPE);
      if (!ownerEnabled) {
        return redirectFail(
          "invalid_scope",
          "merchant:owner 未由该实例显式启用；共享网关不得代理私有金额",
        );
      }
      if (session.role !== "owner") {
        return redirectFail("invalid_scope", "merchant:owner 仅限店主管理会话申请");
      }
    }
    const clientId = query.client_id;
    const challenge = query.code_challenge;
    const createPending = (): string =>
      this.store.createAuthRequest({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: requestedScopes.join(" "),
        ...(query.state !== undefined ? { state: query.state } : {}),
        code_challenge: challenge,
        merchant_id: session.merchant_id,
        principal_id: session.principal_id,
      });
    // 记住授权：同一 client+merchant+scope 在有效期内直接签发，不再重复确认。
    if (
      this.rememberConsent &&
      this.store.hasConsent({
        client_id: clientId,
        merchant_id: session.merchant_id,
        scope: requestedScopes.join(" "),
        now: this.now(),
      })
    ) {
      const rememberedCsrf = createPending();
      return this.authorizeSubmit({ csrf: rememberedCsrf, decision: "approve" }, session);
    }
    const csrf = createPending();
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      html: `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>授权确认 — Kiwi 商家工作台</title>
<style>${MERCHANT_THEME_CSS}
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
  .auth-shell { width: 100%; max-width: 560px; }
  .auth-brand { margin-bottom: 18px; }
  .auth-card h1 { margin: 0 0 8px; font-size: 21px; line-height: 1.4; font-weight: 650; }
  .auth-card .lead { color: #53665b; margin: 0 0 14px; }
  .auth-scopes { margin: 0 0 18px; padding-left: 20px; }
  .auth-scopes li { margin: 4px 0; }
  .auth-actions { display: flex; align-items: center; gap: 12px; }
  .warn { background: #fcf2de; color: #795309; border: 1px solid #e8d6ac; border-radius: 8px; padding: 10px 14px; font-size: 12px; margin: 0 0 18px; overflow-wrap: anywhere; }
  .auth-card code { font: 12px ui-monospace, SFMono-Regular, monospace; background: #f4f8f3; border-radius: 4px; padding: 1px 6px; }
  @media (max-width: 640px) { body { padding: 16px; } }
</style>
</head>
<body>
<main class="auth-shell">
  <div class="brand auth-brand"><span class="brand-name" aria-label="Kiwi">kiwi</span><span class="brand-title">商家工作台</span></div>
  <section class="card auth-card">
    <h1>授权连接器访问你的商家</h1>
    <p class="lead">应用「${escapeHtml(client.client_name ?? query.client_id)}」（客户端自报名称）请求以商家「${escapeHtml(this.merchantName ?? session.merchant_name ?? session.merchant_id)}」的身份访问：</p>
    <p class="warn">客户端 ID：<code>${escapeHtml(client.client_id)}</code>（注册于 ${escapeHtml(client.created_at)}）。请核对该 ID 与连接器文档一致后再授权——client_name 为应用自报，不作为身份依据。</p>
    <ul class="auth-scopes">
      ${requestedScopes.map((s) => `<li><code>${escapeHtml(s)}</code>：${escapeHtml(SCOPE_LABELS[s] ?? "未识别的权限")}</li>`).join("\n      ")}
    </ul>
    <p class="muted">授权后可在目录门户拒绝或撤销；商家写操作仍需你在商家应用内逐次确认。</p>
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="auth-actions">
        <button type="submit" class="act primary" name="decision" value="approve">同意授权</button>
        <button type="submit" class="act" name="decision" value="deny">拒绝</button>
      </div>
    </form>
  </section>
</main>
</body>
</html>`,
    };
  }

  /**
   * 授权流程在建立会话之前被中止（商家在目录拒绝了连接、连接失败）时的
   * OAuth 2.1 错误回跳。
   *
   * 与 authorize 同一校验口径：client_id 与 redirect_uri 校验通过才回跳，
   * 否则返回 400（防开放重定向）。客户端据此看到标准的 access_denied /
   * server_error，而不是一个卡住的授权窗口。
   */
  authorizationError(
    query: Record<string, string | undefined>,
    error: string,
    description: string,
  ): OAuthHttpResult {
    if (query.response_type !== "code") {
      return oauthError(400, "invalid_request", "response_type 必须是 code");
    }
    if (query.client_id === undefined) return oauthError(400, "invalid_request", "缺 client_id");
    const client = this.store.getClient(query.client_id);
    if (client === undefined) {
      return oauthError(400, "invalid_client", "未知 client_id（请先动态注册）");
    }
    const redirectUri = query.redirect_uri;
    if (redirectUri === undefined || !client.redirect_uris.includes(redirectUri)) {
      return oauthError(400, "invalid_request", "redirect_uri 与注册值不匹配（字符串精确匹配）");
    }
    return redirectTo(redirectUri, {
      error,
      error_description: description,
      ...(query.state !== undefined ? { state: query.state } : {}),
    });
  }

  /** POST /oauth/authorize（表单）：会话 + CSRF 校验 → 授权码回跳 / access_denied。 */
  authorizeSubmit(
    form: Record<string, string | undefined>,
    session: { principal_id: string; merchant_id: string; role?: string },
  ): OAuthHttpResult {
    const pending =
      typeof form.csrf === "string" ? this.store.consumeAuthRequest(form.csrf) : undefined;
    if (pending === undefined) {
      return oauthError(
        400,
        "invalid_request",
        "授权请求无效或已过期（CSRF/state 校验失败），请重新发起",
      );
    }
    if (
      !session.merchant_id ||
      !session.principal_id ||
      (this.merchantId !== undefined && session.merchant_id !== this.merchantId) ||
      session.merchant_id !== pending.merchant_id ||
      session.principal_id !== pending.principal_id
    ) {
      return oauthError(403, "access_denied", "当前登录会话与授权请求主体不匹配");
    }
    if (pending.scope.split(" ").includes(MERCHANT_OWNER_SCOPE)) {
      // 二次校验：配置未启用、共享网关、非 owner 角色任一不满足都绝不下发。
      const ownerEnabled =
        this.merchantId !== undefined && this.scopes.includes(MERCHANT_OWNER_SCOPE);
      if (!ownerEnabled || session.role !== "owner") {
        return oauthError(403, "access_denied", "merchant:owner 未启用或非店主会话，拒绝确认");
      }
    }
    if (form.decision !== "approve") {
      if (this.rememberConsent) {
        this.store.revokeConsent({
          client_id: pending.client_id,
          merchant_id: pending.merchant_id,
        });
      }
      return redirectTo(pending.redirect_uri, {
        error: "access_denied",
        error_description: "用户拒绝授权",
        ...(pending.state !== undefined ? { state: pending.state } : {}),
      });
    }
    if (this.rememberConsent) {
      this.store.recordConsent({
        client_id: pending.client_id,
        merchant_id: pending.merchant_id,
        scope: pending.scope,
        expires_at: new Date(Date.parse(this.now()) + this.consentTtlMs).toISOString(),
      });
    }
    const code = this.store.createCode({
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      scope: pending.scope,
      // BUG-01：token 主体来自挂起单中的认证用户（管理登录会话），
      // 不再来自服务启动参数。
      principal_id: pending.principal_id,
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
      // RFC 6749 §6 / OAuth 2.1：refresh grant 必须携带原 client_id（审查 P2）。
      if (typeof form.client_id !== "string" || form.client_id === "") {
        return oauthError(400, "invalid_request", "refresh_token grant 缺 client_id");
      }
      const pair = this.store.rotateRefreshToken(form.refresh_token, form.client_id);
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
    if (typeof form.token === "string" && form.token !== "") {
      const owner = this.store.tokenOwner(form.token);
      this.store.revokeToken(form.token);
      // 商家撤销访问 = 忘掉记住的授权；下次连接重新确认。
      if (owner !== undefined) this.store.revokeConsent(owner);
    }
    return { status: 200, body: {} };
  }
}
