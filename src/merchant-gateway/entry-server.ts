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
 * 商家连接器（「Kiwi 商家运营」）的远程 MCP 入口。
 *
 * merchant-buddy 第 1 版设计 §1.6 / §4「两个连接器」与商家连接器发布计划 §2：
 * 买方连接器（`kiwi-sourcing`，本地 stdio）保持不变；商家 Buddy 使用本入口，
 * 服务端连接共享 `kiwi-catalog`、按**已验证主体**提供第 0 版目录能力，并按
 * 服务端注册表路由到第 1 版的商家专属实例。
 *
 * 只服务商家侧：本入口不承载买方工具，也不复用 `kiwi-sourcing` 的身份或回调
 * （两者 source、平台 ID、凭据互不通用）。本文件只负责入口的 HTTP 面
 * （OAuth + 连接流程 + MCP 传输），工具集合与租户路由由注入的 provider 决定。
 *
 * 身份建立（本版实现）：
 *
 * ```
 * WorkBuddy --GET /oauth/authorize--> 入口（无会话）
 *   303 /connect?next=<原 authorize URL>
 *   → 创建 catalog 一次性授权请求（connector token）
 *   303 <catalog login_url>（商家在 Kiwi 页面登录/注册 + 确认）
 *   → catalog 303 /connect/callback?resume=<原 authorize URL>&request_id&code
 *   → 服务端兑换 {merchant_id, merchant_name} → 建会话 cookie
 *   303 <原 authorize URL>（此时有会话 → 授权同意页 → 授权码回跳 WorkBuddy）
 * ```
 *
 * 硬边界：
 *   - `merchant_id` 只来自 catalog 兑换结果，绝不来自工具参数/URL/模型输出；
 *   - 会话是 HttpOnly cookie，目录密码与一次性 code 都不进入 token 或日志；
 *   - `next` / `resume` 只接受站内相对路径（防开放重定向）。
 */

import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createSecureServer } from "node:https";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { MerchantAuthorization } from "../auth/merchant-authorization.js";
import type { MerchantOAuthServer, OAuthHttpResult } from "../auth/merchant-oauth.js";
import { ADMIN_SESSION_COOKIE, type MerchantAdminSessions } from "../auth/merchant-sessions.js";
import type { MerchantMcpAuthVerifier } from "../mcp/merchant-auth.js";
import { createProtocolServer, type ScopedMcpTools } from "../mcp/merchant-server.js";
import type { MerchantCredentialStore } from "./credential-vault.js";
import {
  bindInstance,
  unbindInstance,
  type InstanceRegistrationWriter,
  type ProbeResult,
} from "./instance-registration.js";

export const DEFAULT_GATEWAY_ENTRY_PORT = 9200;
export const DEFAULT_GATEWAY_ENTRY_PATH = "/mcp";

const MAX_BODY_BYTES = 1_048_576;
const NO_STORE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  pragma: "no-cache",
};

/** catalog 连接能力（生产实现见 discovery/catalog-source/connector-identity.ts）。 */
export interface GatewayIdentityProvider {
  createRequest(input: {
    returnUrl: string;
    clientLabel?: string;
  }): Promise<{ requestId: string; loginUrl: string; expiresAt: string }>;
  exchange(input: { requestId: string; code: string }): Promise<{
    merchantId: string;
    merchantName: string;
    credential: { accessToken: string; scope: string; expiresAt: string };
  }>;
}

export interface GatewayEntryServerOptions {
  /** 入口对外地址（OAuth issuer；https，loopback 开发可为 http）。 */
  publicBaseUrl: string;
  oauth: MerchantOAuthServer;
  sessions: MerchantAdminSessions;
  identity: GatewayIdentityProvider;
  /** 入口提供的工具束（V0 目录工具 / V1 商家工具）。 */
  tools?: ScopedMcpTools;
  /**
   * 按已验证主体构造工具束（推荐）：商户隔离要求工具只能看到令牌绑定的
   * merchant_id，而不是所有租户共用一份 bundler。
   */
  toolsFor?: (authorization: MerchantAuthorization | undefined) => ScopedMcpTools | undefined;
  /** 商家目录凭据保管（连接成功时写入；工具按 merchant_id 取用）。 */
  credentials?: MerchantCredentialStore;
  /**
   * 实例自助绑定（§8.4 第一期）：提供时挂载 `/instance` 页面（需商家会话）。
   * 令牌只经该页面表单提交，**不进对话/模型上下文**；页面永不回显令牌。
   */
  instanceBinding?: {
    registrations: InstanceRegistrationWriter;
    credentials: MerchantCredentialStore;
    /** 探活实现（缺省走真实网络）；测试可注入。 */
    probe?: (mcpUrl: string, token: string) => Promise<ProbeResult>;
  };
  /** 入站 Bearer 校验器（OAuth access token → 主体 + scope）。 */
  auth?: MerchantMcpAuthVerifier;
  host?: string;
  port?: number;
  mcpPath?: string;
  /** https 部署置 true（会话 cookie 加 Secure）。 */
  secureCookies?: boolean;
  /**
   * 由本进程直接终止 TLS（生产可选形态之一）。缺省时进程不做 TLS：
   * 只应监听 loopback，由受信反向代理终止 TLS（部署侧保证，见 CLI 校验）。
   */
  tls?: { certPath: string; keyPath: string };
  serverInfo?: { name: string; version: string };
  /** 商家连接器在目录确认页展示的来源名（缺省「Kiwi 商家运营」）。 */
  clientLabel?: string;
}

export interface GatewayEntryServerHandle {
  host: string;
  port: number;
  path: string;
  url: string;
  /** true = 本进程直接终止 TLS（否则应由受信反向代理终止）。 */
  secure: boolean;
  close: () => Promise<void>;
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function writeHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    ...NO_STORE_HEADERS,
    "x-content-type-options": "nosniff",
  });
  res.end(html);
}

/** 只接受站内相对路径（拒绝协议相对 URL 与反斜杠变体，防开放重定向）。 */
export function safeRelativePath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//")) return undefined;
  if (path.includes("\\") || path.includes("\n") || path.includes("\r")) return undefined;
  return path;
}

/** 连接流程的回跳目标必须是入口自己的 authorize 端点。 */
function safeResume(value: string | undefined): string | undefined {
  const path = safeRelativePath(value);
  if (path === undefined) return undefined;
  if (path !== "/oauth/authorize" && !path.startsWith("/oauth/authorize?")) return undefined;
  return path;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function readForm(req: IncomingMessage): Promise<Record<string, string | undefined>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    return JSON.parse(text) as Record<string, string | undefined>;
  }
  return Object.fromEntries(new URLSearchParams(text).entries());
}

function withQueryParam(target: string, key: string, value: string): string {
  const sep = target.includes("?") ? "&" : "?";
  return `${target}${sep}${new URLSearchParams({ [key]: value }).toString()}`;
}

/**
 * 启动商家连接器入口。返回 handle 含实际 host/port 与优雅关闭。
 */
export async function startGatewayEntryServer(
  options: GatewayEntryServerOptions,
): Promise<GatewayEntryServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_GATEWAY_ENTRY_PORT;
  const mcpPath = options.mcpPath ?? DEFAULT_GATEWAY_ENTRY_PATH;
  const serverInfo = options.serverInfo ?? { name: "kiwi-merchant-entry", version: "0.0.0" };
  const publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, "");
  const clientLabel = options.clientLabel ?? "Kiwi 商家运营";
  let closing = false;

  const transports = new Set<StreamableHTTPServerTransport>();

  const writeOAuthResult = (res: ServerResponse, result: OAuthHttpResult): void => {
    const headers = { ...NO_STORE_HEADERS, ...(result.headers ?? {}) };
    if (result.html !== undefined) {
      writeHtml(res, result.status, result.html);
      return;
    }
    if (headers.location !== undefined) {
      res.writeHead(result.status, headers);
      res.end();
      return;
    }
    writeJson(res, result.status, result.body ?? {}, headers);
  };

  const sessionFor = (req: IncomingMessage) => {
    const sessionId = cookieValue(req, ADMIN_SESSION_COOKIE);
    if (sessionId === undefined) return undefined;
    return options.sessions.getSession(sessionId);
  };

  /**
   * 开始连接：向 catalog 申请一次性身份授权，把商家浏览器送到目录登录页。
   * resume 是入口自己的 authorize 相对路径，连接完成后原样回到该授权请求。
   */
  const startConnect = async (res: ServerResponse, resume: string): Promise<void> => {
    const returnUrl = withQueryParam(`${publicBaseUrl}/connect/callback`, "resume", resume);
    let request: { requestId: string; loginUrl: string; expiresAt: string };
    try {
      request = await options.identity.createRequest({ returnUrl, clientLabel });
    } catch (err) {
      // 目录不可达：明确失败页（不假装已连接，也不把错误细节暴露给浏览器）。
      process.stderr.write(
        `[gateway entry] connector identity request failed: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      writeHtml(
        res,
        502,
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>连接暂不可用</title></head><body>
<h1>暂时无法开始 Kiwi 目录连接</h1>
<p>请稍后重试；如果你还没有商家账号，可以在重试时于 Kiwi 页面注册并验证邮箱。</p>
</body></html>`,
      );
      return;
    }
    res.writeHead(303, { location: request.loginUrl, ...NO_STORE_HEADERS });
    res.end();
  };

  /** GET /connect/callback：目录回跳（携带一次性 code 或 access_denied）。 */
  const handleConnectCallback = async (res: ServerResponse, url: URL): Promise<void> => {
    const resume = safeResume(url.searchParams.get("resume") ?? undefined);
    if (resume === undefined) {
      writeHtml(
        res,
        400,
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>连接参数无效</title></head><body>
<h1>连接参数无效</h1><p>请返回 Buddy 重新发起连接。</p></body></html>`,
      );
      return;
    }
    const denied = url.searchParams.get("error");
    if (denied !== null) {
      // 商家在目录拒绝（或目录返回错误）：按 OAuth 语义把失败带回客户端。
      res.writeHead(303, {
        location: withQueryParam(
          resume,
          "connect",
          denied === "access_denied" ? "denied" : "failed",
        ),
        ...NO_STORE_HEADERS,
      });
      res.end();
      return;
    }
    const requestId = url.searchParams.get("request_id") ?? "";
    const code = url.searchParams.get("code") ?? "";
    let identity: {
      merchantId: string;
      merchantName: string;
      credential: { accessToken: string; scope: string; expiresAt: string };
    };
    try {
      identity = await options.identity.exchange({ requestId, code });
    } catch (err) {
      process.stderr.write(
        `[gateway entry] connector identity exchange failed: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      res.writeHead(303, {
        location: withQueryParam(resume, "connect", "failed"),
        ...NO_STORE_HEADERS,
      });
      res.end();
      return;
    }
    // 目录商家凭据入库（加密保管）：入口以此代表该商家调用目录商家接口。
    // 存储失败不阻断连接（工具会在缺凭据时明确报「需要重新连接」）。
    if (options.credentials !== undefined) {
      try {
        options.credentials.put(
          identity.merchantId,
          identity.credential.accessToken,
          identity.credential.expiresAt,
        );
      } catch (err) {
        process.stderr.write(
          `[gateway entry] credential vault write failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
    // 会话主体：principal 取商家身份（目录 account 已确认过的 merchant_id 归属）。
    const session = options.sessions.createSession({
      principalId: `merchant:${identity.merchantId}`,
      merchantId: identity.merchantId,
    });
    const secure = options.secureCookies === true ? "; Secure" : "";
    res.writeHead(303, {
      location: resume,
      "set-cookie": `${ADMIN_SESSION_COOKIE}=${session.sessionId}; HttpOnly; SameSite=Lax; Path=/${secure}`,
      ...NO_STORE_HEADERS,
    });
    res.end();
  };

  const routeOAuth = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const oauth = options.oauth;
    const p = url.pathname;
    if (req.method === "GET" && p === "/.well-known/oauth-protected-resource") {
      writeOAuthResult(res, oauth.protectedResourceMetadata());
      return true;
    }
    if (req.method === "GET" && p === "/.well-known/oauth-authorization-server") {
      writeOAuthResult(res, oauth.authorizationServerMetadata());
      return true;
    }
    if (req.method === "POST" && p === "/oauth/register") {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        writeJson(res, 400, {
          error: "invalid_client_metadata",
          error_description: "request body must be valid JSON",
        });
        return true;
      }
      writeOAuthResult(res, oauth.register(body as Record<string, string | undefined>));
      return true;
    }
    if (req.method === "GET" && p === "/oauth/authorize") {
      const query = Object.fromEntries(url.searchParams.entries());
      const session = sessionFor(req);
      if (session === undefined) {
        // 无会话：先走目录连接（loginPath 在 CLI 侧配置为 /connect）。
        const next = `/oauth/authorize?${new URLSearchParams(
          Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined),
        ).toString()}`;
        // 连接失败/被拒绝的标记只用于回跳语义，不进入 OAuth 参数。
        const connect = query.connect;
        delete query.connect;
        if (connect === "denied" || connect === "failed") {
          writeOAuthResult(
            res,
            oauth.authorizationError(
              query,
              connect === "denied" ? "access_denied" : "server_error",
              connect === "denied"
                ? "商家未在 Kiwi 目录完成连接"
                : "商家身份连接失败，请返回应用重试",
            ),
          );
          return true;
        }
        writeOAuthResult(res, {
          status: 303,
          headers: { location: `/connect?next=${encodeURIComponent(next)}` },
        });
        return true;
      }
      writeOAuthResult(res, oauth.authorize(query, session));
      return true;
    }
    if (req.method === "POST" && p === "/oauth/authorize") {
      let form: Record<string, string | undefined>;
      try {
        form = await readForm(req);
      } catch {
        writeJson(res, 400, { error: "invalid_request", error_description: "malformed body" });
        return true;
      }
      const session = sessionFor(req);
      if (session === undefined) {
        writeJson(
          res,
          401,
          { error: "login_required", error_description: "授权提交需要已连接的商家会话" },
          NO_STORE_HEADERS,
        );
        return true;
      }
      writeOAuthResult(res, oauth.authorizeSubmit(form, session));
      return true;
    }
    if (req.method === "POST" && p === "/oauth/token") {
      let form: Record<string, string | undefined>;
      try {
        form = await readForm(req);
      } catch {
        writeJson(res, 400, { error: "invalid_request", error_description: "malformed body" });
        return true;
      }
      writeOAuthResult(res, oauth.token(form));
      return true;
    }
    if (req.method === "POST" && p === "/oauth/revoke") {
      let form: Record<string, string | undefined>;
      try {
        form = await readForm(req);
      } catch {
        writeJson(res, 400, { error: "invalid_request", error_description: "malformed body" });
        return true;
      }
      writeOAuthResult(res, oauth.revoke(form));
      return true;
    }
    if (p.startsWith("/oauth/") || p.startsWith("/.well-known/oauth-")) {
      writeJson(res, 404, { error: "not_found", message: `unknown OAuth endpoint ${p}` });
      return true;
    }
    return false;
  };

  /** 连接入口（OAuth loginPath）：有会话直接回到授权请求，否则开始目录连接。 */
  const handleConnect = (res: ServerResponse, url: URL): void => {
    const next = safeRelativePath(url.searchParams.get("next") ?? undefined);
    if (next === undefined) {
      writeHtml(
        res,
        400,
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>连接参数无效</title></head><body>
<h1>连接参数无效</h1><p>请返回 Buddy 重新发起连接。</p></body></html>`,
      );
      return;
    }
    void startConnect(res, next);
  };

  const escapeHtml = (text: string): string =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  /** `/instance` 页面：展示当前绑定 + 绑定/解绑表单（需商家会话）。 */
  const renderInstancePage = (
    registration: { mcpUrl: string; updatedAt: string } | undefined,
    notice: { kind: "ok" | "error"; text: string } | undefined,
    merchantId: string,
  ): string => {
    const bound = registration !== undefined;
    const noticeHtml =
      notice === undefined
        ? ""
        : `<p class="${notice.kind === "ok" ? "ok" : "err"}">${escapeHtml(notice.text)}</p>`;
    const current = bound
      ? `<p>当前已绑定实例：<code>${escapeHtml(registration.mcpUrl)}</code>（更新于 ${escapeHtml(
          registration.updatedAt,
        )}）</p>
       <form method="post" action="/instance/unbind">
         <button type="submit">解除绑定</button>
       </form>`
      : `<p>尚未绑定自有 Kiwi Merchant 实例。未绑定时第 0 版目录能力照常可用。</p>`;
    return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>连接我的 Kiwi Merchant 服务</title>
<style>
 body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; line-height: 1.7; color: #1a1f1a; }
 h1 { font-size: 1.4rem; } code { background: #f2f5f2; padding: 2px 6px; border-radius: 4px; }
 .card { border: 1px solid #dde5dd; border-radius: 12px; padding: 20px; margin: 18px 0; }
 .ok { color: #1b5e20; } .err { color: #b3261e; }
 label { display: block; font-weight: 600; margin: 12px 0 4px; font-size: 0.92rem; }
 input { width: 100%; padding: 10px 12px; border: 1px solid #dde5dd; border-radius: 8px; font-size: 0.95rem; }
 button { margin-top: 14px; padding: 10px 20px; border: none; border-radius: 999px; background: #1b5e20; color: #fff; font-weight: 600; cursor: pointer; }
 .small { color: #4b554b; font-size: 0.88rem; }
</style></head>
<body>
<h1>连接我的 Kiwi Merchant 服务</h1>
<p class="small">已连接商家：<code>${escapeHtml(merchantId)}</code></p>
${noticeHtml}
<div class="card">
${current}
</div>
<div class="card">
  <h2 style="font-size:1.05rem;margin:0 0 6px">${bound ? "更换或重新绑定实例" : "绑定我的实例"}</h2>
  <p class="small">实例需由你自己部署并保持运行（<code>kiwi merchant mcp serve</code>），
    公网地址必须为 HTTPS；同机部署可用 <code>http://127.0.0.1:&lt;端口&gt;/mcp</code>。
    内部令牌即实例的 <code>KIWI_MERCHANT_MCP_TOKEN</code>；本页不会回显令牌，网关会加密保存。</p>
  <form method="post" action="/instance/bind">
    <label for="mcp_url">实例 MCP 地址</label>
    <input id="mcp_url" name="mcp_url" placeholder="https://your-merchant.example/mcp" autocomplete="off">
    <label for="token">内部令牌（KIWI_MERCHANT_MCP_TOKEN）</label>
    <input id="token" name="token" type="password" autocomplete="new-password">
    <button type="submit">绑定并探活</button>
  </form>
  <p class="small">绑定前网关会带该令牌调用实例的 initialize 与 tools/list：
    地址可达、令牌正确、确为 MCP 实例，三者同时成立才会保存。</p>
</div>
</body></html>`;
  };

  const handleInstancePage = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> => {
    const binding = options.instanceBinding;
    if (binding === undefined) {
      writeJson(res, 404, { error: "not_found", message: "未启用实例绑定" });
      return;
    }
    const session = sessionFor(req);
    if (session === undefined) {
      // 复用连接流程建立会话后回到本页。
      res.writeHead(303, {
        location: `/connect?next=${encodeURIComponent("/instance")}`,
        ...NO_STORE_HEADERS,
      });
      res.end();
      return;
    }
    const merchantId = session.merchant_id;
    const noticeFromQuery = (): { kind: "ok" | "error"; text: string } | undefined => {
      const kind = url.searchParams.get("status");
      const error = url.searchParams.get("error");
      if (error !== null) return { kind: "error", text: error };
      if (kind === "bound") return { kind: "ok", text: "实例已绑定（已探活通过）。" };
      if (kind === "unbound")
        return { kind: "ok", text: "实例已解绑；目录公开资料与买家关注不受影响。" };
      return undefined;
    };

    if (req.method === "GET") {
      const registration = binding.registrations.get(merchantId);
      writeHtml(
        res,
        200,
        renderInstancePage(
          registration === undefined
            ? undefined
            : { mcpUrl: registration.mcpUrl, updatedAt: registration.updatedAt },
          noticeFromQuery(),
          merchantId,
        ),
      );
      return;
    }
    if (
      req.method === "POST" &&
      (url.pathname === "/instance/bind" || url.pathname === "/instance/unbind")
    ) {
      let form: Record<string, string | undefined>;
      try {
        form = await readForm(req);
      } catch {
        res.writeHead(303, {
          location: `/instance?error=${encodeURIComponent("表单解析失败，请重试")}`,
          ...NO_STORE_HEADERS,
        });
        res.end();
        return;
      }
      if (url.pathname === "/instance/unbind") {
        unbindInstance(
          { registrations: binding.registrations, credentials: binding.credentials },
          merchantId,
        );
        res.writeHead(303, { location: "/instance?status=unbound", ...NO_STORE_HEADERS });
        res.end();
        return;
      }
      const mcpUrl = (form.mcp_url ?? "").trim();
      const token = form.token ?? "";
      try {
        // 探活成功才落库；merchantId 取自会话，表单里的任何 id 都被忽略。
        await bindInstance(
          { registrations: binding.registrations, credentials: binding.credentials },
          { merchantId, mcpUrl, token },
          binding.probe !== undefined ? { probe: binding.probe } : {},
        );
      } catch (err) {
        // 失败不落任何状态；错误信息只含策略/网络结论，不含令牌。
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(303, {
          location: `/instance?error=${encodeURIComponent(message)}`,
          ...NO_STORE_HEADERS,
        });
        res.end();
        return;
      }
      res.writeHead(303, { location: "/instance?status=bound", ...NO_STORE_HEADERS });
      res.end();
      return;
    }
    writeJson(res, 405, { error: "method_not_allowed" });
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const oauth = options.oauth;
    let scopes: string[] | undefined;
    let authorization: MerchantAuthorization | undefined;
    if (options.auth !== undefined) {
      const verdict = options.auth.verify({
        ...(typeof req.headers.authorization === "string"
          ? { authorizationHeader: req.headers.authorization }
          : {}),
      });
      if (!verdict.ok) {
        writeJson(
          res,
          401,
          { error: "unauthorized", message: "认证失败：需要有效的 Bearer token" },
          {
            "www-authenticate": `Bearer resource_metadata="${oauth.resourceMetadataUrl}"`,
          },
        );
        return;
      }
      scopes = verdict.authorization?.scopes;
      authorization = verdict.authorization;
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      writeJson(res, 405, { error: "method_not_allowed" }, { allow: "POST, GET, DELETE" });
      return;
    }
    // 每请求按已验证主体构造工具束：merchant_id 只能来自令牌，不看入参。
    const tools = options.toolsFor?.(authorization) ?? options.tools;
    if (tools === undefined) {
      writeJson(res, 503, { error: "no_tools", message: "入口尚未装配任何工具" });
      return;
    }
    let body: unknown;
    try {
      body = req.method === "POST" ? await readBody(req) : undefined;
    } catch (err) {
      const tooLarge = err instanceof Error && err.message.includes("exceeds");
      writeJson(res, tooLarge ? 413 : 400, {
        error: "invalid_request",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const protocolServer = createProtocolServer(serverInfo, tools, scopes);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    transports.add(transport);
    res.on("close", () => {
      transports.delete(transport);
      void transport.close().catch(() => undefined);
      void protocolServer.close().catch(() => undefined);
    });
    try {
      await protocolServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        writeJson(res, 500, {
          error: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        });
      } else {
        res.end();
      }
    }
  };

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = new URL(req.url ?? "/", publicBaseUrl);
      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, { ok: true, service: "kiwi-merchant-entry" });
        return;
      }
      if (await routeOAuth(req, res, url)) return;
      if (req.method === "GET" && url.pathname === "/connect") {
        handleConnect(res, url);
        return;
      }
      if (req.method === "GET" && url.pathname === "/connect/callback") {
        await handleConnectCallback(res, url);
        return;
      }
      if (url.pathname === "/instance" || url.pathname.startsWith("/instance/")) {
        await handleInstancePage(req, res, url);
        return;
      }
      if (url.pathname === mcpPath) {
        await handleMcp(req, res);
        return;
      }
      writeJson(res, 404, { error: "not_found", message: `unknown path ${url.pathname}` });
    })().catch((err) => {
      process.stderr.write(
        `[gateway entry] ${req.method} ${req.url ?? "/"} 处理异常：` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      if (!res.headersSent) writeJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  };

  const httpServer: HttpServer =
    options.tls === undefined
      ? createServer(requestHandler)
      : (createSecureServer(
          {
            cert: readFileSync(options.tls.certPath),
            key: readFileSync(options.tls.keyPath),
          },
          requestHandler,
        ) as unknown as HttpServer);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });
  const address = httpServer.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  const scheme = options.tls === undefined ? "http" : "https";
  return {
    host,
    port: boundPort,
    path: mcpPath,
    secure: options.tls !== undefined,
    url: `${scheme}://${host === "0.0.0.0" ? "127.0.0.1" : host}:${boundPort}${mcpPath}`,
    close: async () => {
      if (closing) return;
      closing = true;
      for (const transport of transports) {
        await transport.close().catch(() => undefined);
      }
      transports.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    },
  };
}
