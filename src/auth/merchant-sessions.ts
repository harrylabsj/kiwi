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
 * 商家管理登录会话（BUG-01/BUG-03 修复）。
 *
 * 账户来源设计（单商家实例语义）：安装/初始化时由商家管理员经 CLI
 * （`kiwi merchant mcp admin-passwd`，新口令只从环境变量读取，绝不出现在
 * 命令行/日志）设置管理员口令；口令以 scrypt 哈希落 `admin-credentials.json`
 * （0600，不明文落盘）。管理员即本实例 principal（profile.agent_id）。
 *
 * 登录会话：POST /admin/login 校验口令（恒定时间比较）→ 签发短期会话
 * （HttpOnly + SameSite=Lax + 生产 Secure cookie），会话记录落 oauth.sqlite
 * （可撤销、12 小时过期）。OAuth 授权页与 /admin/* 均要求有效会话；
 * 授权挂起单绑定会话认证的 principal_id + merchant_id——token 主体来自
 * 认证用户，不再来自服务启动参数。
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** 管理会话有效期（12 小时）。 */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 会话 cookie 名。 */
export const ADMIN_SESSION_COOKIE = "kiwi_admin";

// ── 口令哈希（scrypt，node:crypto 内置；不明文落盘）─────────────────────────

const SCRYPT_N = 16384;

/** scrypt 哈希（格式 scrypt$N$salt$hash，base64url）。 */
export function hashAdminPassword(password: string): string {
  if (password.length < 8) throw new Error("管理员口令至少 8 位");
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N }).toString("base64url");
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}

/** 恒定时间校验。 */
export function verifyAdminPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const salt = parts[2] ?? "";
  const expected = Buffer.from(parts[3] ?? "", "base64url");
  const actual = scryptSync(password, salt, expected.length, { N: Number(parts[1]) });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ── 管理员凭据（状态目录 admin-credentials.json，0600）─────────────────────

export interface MerchantAdminCredentials {
  principal_id: string;
  merchant_id: string;
  password_hash: string;
  created_at: string;
}

export function adminCredentialsPath(dir: string): string {
  return path.join(dir, "admin-credentials.json");
}

/** 初始化管理员凭据（已存在且未 force → 拒绝，防覆盖）。 */
export function writeAdminCredentials(
  dir: string,
  input: { principalId: string; merchantId: string; password: string; force?: boolean },
): MerchantAdminCredentials {
  const file = adminCredentialsPath(dir);
  if (existsSync(file) && input.force !== true) {
    throw new Error(`管理员凭据已存在（${file}）；重置需显式 --force`);
  }
  const creds: MerchantAdminCredentials = {
    principal_id: input.principalId,
    merchant_id: input.merchantId,
    password_hash: hashAdminPassword(input.password),
    created_at: new Date().toISOString(),
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  return creds;
}

/** 读取管理员凭据；未初始化 → undefined（登录不可用，fail-closed）。 */
export function readAdminCredentials(dir: string): MerchantAdminCredentials | undefined {
  const file = adminCredentialsPath(dir);
  if (!existsSync(file)) return undefined;
  const raw = JSON.parse(readFileSync(file, "utf8")) as MerchantAdminCredentials;
  return raw;
}

// ── 会话存储（oauth.sqlite admin_sessions 表）──────────────────────────────

export const ADMIN_SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_sessions (
  session_digest TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
`;

export interface AdminSession {
  principal_id: string;
  merchant_id: string;
  expires_at: string;
}

export class MerchantAdminSessions {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now?: () => string }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.db.exec(ADMIN_SESSION_SCHEMA);
  }

  /** 登录成功签发会话（明文只在响应 cookie 中；落库为 sha256 摘要）。 */
  createSession(input: { principalId: string; merchantId: string }): {
    sessionId: string;
    expiresAt: string;
  } {
    const sessionId = `kadm_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.parse(this.now()) + ADMIN_SESSION_TTL_MS).toISOString();
    this.db
      .prepare(
        "INSERT INTO admin_sessions (session_digest, principal_id, merchant_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sessionDigest(sessionId), input.principalId, input.merchantId, expiresAt, this.now());
    return { sessionId, expiresAt };
  }

  /** 校验会话（未过期、未撤销才返回）。 */
  getSession(sessionId: string): AdminSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM admin_sessions WHERE session_digest = ?")
      .get(sessionDigest(sessionId)) as
      | { principal_id: string; merchant_id: string; expires_at: string; revoked_at: string | null }
      | undefined;
    if (row === undefined || row.revoked_at !== null) return undefined;
    if (row.expires_at <= this.now()) return undefined;
    return {
      principal_id: row.principal_id,
      merchant_id: row.merchant_id,
      expires_at: row.expires_at,
    };
  }

  /** 撤销会话（登出/失效）。 */
  revoke(sessionId: string): void {
    this.db
      .prepare(
        "UPDATE admin_sessions SET revoked_at = ? WHERE session_digest = ? AND revoked_at IS NULL",
      )
      .run(this.now(), sessionDigest(sessionId));
  }
}

function sessionDigest(value: string): string {
  // 会话 id 是高熵随机串，sha256 摘要落库（与 oauth token 同口径）
  return createHash("sha256").update(value).digest("hex");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 登录页（最小可用；与 OAuth 授权页同风格）。 */
export function renderAdminLoginPage(options: { error?: string; next?: string }): string {
  const error = options.error === undefined ? undefined : escapeHtml(options.error);
  const next = escapeHtml(options.next ?? "/admin/pending");
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>商家管理员登录 — Kiwi</title></head>
<body>
  <h1>商家管理员登录</h1>
  ${error !== undefined ? `<p style="color:red">${error}</p>` : ""}
  <form method="post" action="/admin/login">
    <input type="hidden" name="next" value="${next}">
    <label>管理员口令：<input type="password" name="password" required></label>
    <button type="submit">登录</button>
  </form>
</body>
</html>`;
}
