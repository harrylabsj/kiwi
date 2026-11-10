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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { MERCHANT_ROLES, type MerchantRole } from "../merchant/application/actor.js";
import { MERCHANT_THEME_CSS } from "../merchant-ui/theme.js";

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
  // 审查 P3：此前直接信任文件内的 N——被篡改成 2^30 时一次登录就耗尽内存
  // （凭据文件可写即 DoS）。只接受受支持的参数范围与 32 字节摘要。
  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost < 16_384 || cost > 1_048_576) return false;
  const salt = parts[2] ?? "";
  if (salt.length < 8 || salt.length > 256) return false;
  const expected = Buffer.from(parts[3] ?? "", "base64url");
  if (expected.length !== 32) return false;
  const actual = scryptSync(password, salt, expected.length, { N: cost });
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
  // mode 参数对已存在文件不生效（审查 P2）：重置口令时收紧历史遗留的宽权限。
  chmodSync(file, 0o600);
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
  created_at TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner'
);
`;

export interface AdminSession {
  principal_id: string;
  merchant_id: string;
  expires_at: string;
  /** 会话角色（BD §7.2 owner/operator/viewer；历史行迁移为 owner）。 */
  role: MerchantRole;
}

export class MerchantAdminSessions {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now?: () => string }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.db.exec(ADMIN_SESSION_SCHEMA);
    this.migrateRoleColumn();
    // 过期会话清理（审查 P2：管理会话表只增不删）。
    this.db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(this.now());
  }

  /** 既有库迁移：admin_sessions 补 role 列（历史会话按 owner 处理）。 */
  private migrateRoleColumn(): void {
    const columns = this.db
      .prepare("SELECT name FROM pragma_table_info('admin_sessions')")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "role")) {
      this.db.exec("ALTER TABLE admin_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'");
    }
  }

  /** 登录成功签发会话（明文只在响应 cookie 中；落库为 sha256 摘要）。 */
  createSession(input: { principalId: string; merchantId: string; role?: MerchantRole }): {
    sessionId: string;
    expiresAt: string;
  } {
    const role = input.role ?? "owner";
    if (!MERCHANT_ROLES.includes(role)) {
      throw new Error(`unknown merchant role: ${String(role)}`);
    }
    const sessionId = `kadm_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.parse(this.now()) + ADMIN_SESSION_TTL_MS).toISOString();
    this.db
      .prepare(
        "INSERT INTO admin_sessions (session_digest, principal_id, merchant_id, expires_at, created_at, role) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(sessionDigest(sessionId), input.principalId, input.merchantId, expiresAt, this.now(), role);
    return { sessionId, expiresAt };
  }

  /** 校验会话（未过期、未撤销才返回）。 */
  getSession(sessionId: string): AdminSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM admin_sessions WHERE session_digest = ?")
      .get(sessionDigest(sessionId)) as
      | {
          principal_id: string;
          merchant_id: string;
          expires_at: string;
          revoked_at: string | null;
          role: string | null;
        }
      | undefined;
    if (row === undefined || row.revoked_at !== null) return undefined;
    if (row.expires_at <= this.now()) return undefined;
    const role = normalizeRole(row.role);
    if (role === undefined) return undefined;
    return {
      principal_id: row.principal_id,
      merchant_id: row.merchant_id,
      expires_at: row.expires_at,
      role,
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

function normalizeRole(raw: string | null): MerchantRole | undefined {
  // 迁移前创建的历史行 role 为空（DEFAULT 'owner' 只对新 ALTER 行生效）——
  // **缺失**按历史管理员语义回 owner；但非空未知值必须拒绝会话（审查 P2：
  // 未知角色 fail-open 成 owner = 最高权限上 fail-open）。
  if (raw === null || raw === "") return "owner";
  return MERCHANT_ROLES.includes(raw as MerchantRole) ? (raw as MerchantRole) : undefined;
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
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>管理员登录 — Kiwi 商家工作台</title>
<style>${MERCHANT_THEME_CSS}
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
  .login-shell { width: 100%; max-width: 430px; }
  .login-brand { margin-bottom: 18px; }
  .login-card h1 { margin: 0 0 6px; font-size: 21px; line-height: 1.4; font-weight: 650; }
  .login-card .hint { margin: 0 0 20px; color: var(--muted); font-size: 12px; }
  .login-field { display: block; margin-bottom: 18px; }
  .login-field span { display: block; margin-bottom: 6px; color: #53665b; font-weight: 550; }
  .login-field input { display: block; }
  .login-actions { display: flex; align-items: center; gap: 16px; }
  .login-actions .muted { margin: 0; }
  .errbox { background: #fcebea; color: #a03933; border: 1px solid #e5c2bd; border-radius: 8px; padding: 10px 14px; font-size: 13px; margin: 0 0 18px; overflow-wrap: anywhere; }
  @media (max-width: 640px) { body { padding: 16px; } }
</style>
</head>
<body>
<main class="login-shell">
  <div class="brand login-brand"><span class="brand-name" aria-label="Kiwi">kiwi</span><span class="brand-title">商家工作台</span></div>
  <section class="card login-card">
    <h1>管理员登录</h1>
    <p class="hint">使用商家管理员口令进入工作台；口令只在本表单中输入，不会出现在地址栏或日志里。</p>
    ${error !== undefined ? `<p class="errbox" role="alert">${error}</p>` : ""}
    <form method="post" action="/admin/login">
      <input type="hidden" name="next" value="${next}">
      <label class="login-field" for="admin-password"><span>管理员口令</span><input id="admin-password" type="password" name="password" required autocomplete="current-password"></label>
      <div class="login-actions">
        <button type="submit" class="act primary">登录</button>
        <a class="muted" href="/merchant/">返回工作台</a>
      </div>
    </form>
  </section>
</main>
</body>
</html>`;
}
