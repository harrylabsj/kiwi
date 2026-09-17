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
 * Merchant Workbench 标准远程 MCP Server（WorkBuddy Buddy 应用开发计划 阶段二）。
 *
 * 官方 @modelcontextprotocol/sdk 的 StreamableHTTPServerTransport（无状态模式，
 * sessionIdGenerator: undefined——每个请求独立的 Server+Transport，天然适配
 * 远程连接器，不维护进程内会话状态），承载在 Node http 上。
 *
 * 边界：
 *   - 独立端口/路径（缺省 9100 / /mcp），不复用 A2A `/` 端点；
 *   - 单商家一服务（MVP）：一个实例绑定一个 MerchantWorkbenchService（其
 *     expectedMerchantId = profile.owner_id），租户校验在 Facade 内；
 *   - Bearer 认证由调用方注入校验器（merchant-auth.ts）；本层只负责在配置
 *     了校验器时强制执行（401，不回显原因细节之外的信息）；
 *   - 不持有任何商业状态——状态唯一权威在 MerchantWorkbenchService 背后的
 *     Ledger/Store。
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { MerchantWorkbenchSurface } from "../merchant/workbench-service.js";
import type { MerchantOAuthServer, OAuthHttpResult } from "../auth/merchant-oauth.js";
import type { MerchantMcpAuthVerifier } from "./merchant-auth.js";
import {
  buildMerchantMcpTools,
  type MerchantMcpCallResult,
  type MerchantMcpToolDefinition,
} from "./merchant-tools.js";
import type { buildMerchantPresentationResources } from "./merchant-resources.js";
import { renderPendingPage, type MerchantAdminSurface } from "../merchant-admin/pending-page.js";
import {
  ADMIN_SESSION_COOKIE,
  readAdminCredentials,
  renderAdminLoginPage,
  verifyAdminPassword,
  type MerchantAdminSessions,
} from "../auth/merchant-sessions.js";
import type { MerchantOAuthStore } from "../auth/merchant-oauth.js";
import { contentHash } from "../agent/merchant/action-candidate.js";
import { issuePairedCredential, redeemPairingCode } from "../auth/merchant-pairing.js";

/** 从 Cookie 头取值（管理会话）。 */
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

/** 只允许管理面内部相对路径，避免 XSS 和开放重定向。 */
function safeAdminNext(value: string | undefined): string {
  if (
    value === undefined ||
    value === "" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/admin/pending";
  }
  return value;
}

/** 缺省监听地址（远程连接器形态；fail-closed 由 merchant-auth 守卫）。 */
export const DEFAULT_MERCHANT_MCP_HOST = "0.0.0.0";
/** 缺省端口（与 A2A 9000 分离）。 */
export const DEFAULT_MERCHANT_MCP_PORT = 9100;
/** 缺省 MCP endpoint 路径。 */
export const DEFAULT_MERCHANT_MCP_PATH = "/mcp";

/** POST body 上限（防御性；MCP 工具入参都很小）。 */
const MAX_BODY_BYTES = 1_048_576;

export interface MerchantMcpServerOptions {
  service: MerchantWorkbenchSurface;
  host?: string;
  port?: number;
  path?: string;
  /** 入站认证校验器；提供时所有请求必须携带有效 Bearer token。 */
  auth?: MerchantMcpAuthVerifier;
  /** OAuth 授权服务器（V2 阶段一）：提供时挂载
   *  /.well-known/oauth-*、/oauth/register|authorize|token|revoke 端点。 */
  oauth?: MerchantOAuthServer;
  /** 七类 presentation 的 MCP 资源（V2 阶段二；提供时挂载 resources/list|read）。 */
  presentations?: ReturnType<typeof buildMerchantPresentationResources>;
  /** 配套商家确认页面（V2 阶段三；BUG-01/03 修复后：cookie 会话 + 一次性
   *  确认凭证；write 面由会话主体逐次校验）。 */
  admin?: {
    merchantName: string;
    surface: MerchantAdminSurface;
    sessions: MerchantAdminSessions;
    /** 一次性确认凭证存储（oauth.sqlite）。 */
    store: MerchantOAuthStore;
    /** 管理员凭据目录（admin-credentials.json）。 */
    adminDir: string;
    /** https 部署置 true（cookie 加 Secure）。 */
    secureCookies?: boolean;
  };
  /**
   * 一次性配对码兑换（设计 §8.4 第二期）：挂载 `POST /pairing/redeem`。
   * 商家在实例机器上 `kiwi merchant mcp pair` 生成码，网关用它兑换内部凭据，
   * 从而无需把长期令牌贴进表单。仅 token 模式（存在静态内部令牌）才有意义。
   */
  pairing?: {
    /**
     * 配对码与配对凭据所在目录（通常为实例数据目录）。兑换时会**新签**一份
     * 配对凭据（最小授权：由实例签发并持有，网关只拿到调用凭据；重配对即轮换）。
     */
    dir: string;
    /** 实例身份（回给网关留痕；不含任何凭据）。 */
    instance: () => { ownerId: string; principalId: string };
  };
  serverInfo?: { name: string; version: string };
  /** 响应体大小上限（字符）。 */
  maxChars?: number;
  /** 单次工具调用超时（ms）。 */
  requestTimeoutMs?: number;
}

export interface MerchantMcpServerHandle {
  host: string;
  port: number;
  path: string;
  url: string;
  close: () => Promise<void>;
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
}

/** RFC 6749 §5.1：token/授权/管理面响应必须 no-store（审查 P2：token 与
 *  一次性确认凭证不得落入共享缓存）。 */
const NO_STORE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  pragma: "no-cache",
};

/** 读 POST body（超上限直接拒绝，绝不流入解析）。 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** 带 scope 的 MCP 工具束形状（merchant 工具与商家连接器目录工具共用）。 */
export interface ScopedMcpTools {
  /** 允许异步（网关需要先向实例取工具清单）；协议层会 await。 */
  listTools(
    scopes: string[] | undefined,
  ): MerchantMcpToolDefinition[] | Promise<MerchantMcpToolDefinition[]>;
  call(
    name: string,
    args: Record<string, unknown>,
    scopes: string[] | undefined,
  ): Promise<MerchantMcpCallResult>;
}

/** 每个请求独立的协议 Server（无状态模式），handlers 引用共享的工具分发器。
 *  scopes 来自本次请求的授权上下文（OAuth access_token）；undefined = 静态
 *  token 过渡模式（全量 scope）。tools/list 按 scope 过滤，tools/call 逐次强制。 */
export function createProtocolServer(
  serverInfo: { name: string; version: string },
  toolsBundle: ScopedMcpTools,
  scopes: string[] | undefined,
  presentations?: ReturnType<typeof buildMerchantPresentationResources>,
): Server {
  const server = new Server(
    { name: serverInfo.name, version: serverInfo.version },
    { capabilities: { tools: {}, ...(presentations !== undefined ? { resources: {} } : {}) } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await toolsBundle.listTools(scopes),
  }));
  if (presentations !== undefined) {
    server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: scopes === undefined || scopes.includes("merchant:read") ? presentations.list() : [],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (scopes !== undefined && !scopes.includes("merchant:read")) {
        throw new Error("scope 不足：resources/read 需要 merchant:read");
      }
      return await presentations.read(request.params.uri);
    });
  }
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await toolsBundle.call(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      scopes,
    );
    // SDK 1.30 的 CallToolResult 含 task 增强变体；本 server 只用经典
    // content/structuredContent/isError 形状。
    return result as CallToolResult;
  });
  return server;
}

/**
 * 启动 Merchant MCP Server（streamable HTTP，无状态）。
 * 返回 handle 含实际 host/port（port 传 0 时取 ephemeral 端口）与优雅关闭。
 */
export async function startMerchantMcpServer(
  options: MerchantMcpServerOptions,
): Promise<MerchantMcpServerHandle> {
  const host = options.host ?? DEFAULT_MERCHANT_MCP_HOST;
  const port = options.port ?? DEFAULT_MERCHANT_MCP_PORT;
  const mcpPath = options.path ?? DEFAULT_MERCHANT_MCP_PATH;
  const serverInfo = options.serverInfo ?? { name: "kiwi-merchant-workbench", version: "0.0.0" };
  const toolsBundle = buildMerchantMcpTools(options.service, {
    ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
  });

  // 活跃连接跟踪：close() 时连同 transport 一起关闭，优雅退出。
  const transports = new Set<StreamableHTTPServerTransport>();
  let closing = false;

  // 审查 P2：无认证端点限速（进程内计数，重启归零可接受——目标是抬高脚本
  // 刷注册/在线爆破口令的成本，不做分布式级配额）。
  const registerHits = new Map<string, { count: number; windowStart: number }>();
  const loginFailures = new Map<string, { count: number; blockedUntil: number }>();
  const REGISTER_LIMIT_PER_HOUR = 20;
  const LOGIN_MAX_FAILURES = 10;
  const LOGIN_BLOCK_MS = 5 * 60 * 1000;
  const clientKey = (req: IncomingMessage): string => req.socket.remoteAddress ?? "unknown";
  const pruneRateLimits = (nowMs: number): void => {
    if (registerHits.size > 4096) {
      for (const [k, v] of registerHits) {
        if (nowMs - v.windowStart > 60 * 60 * 1000) registerHits.delete(k);
      }
    }
    if (loginFailures.size > 4096) {
      for (const [k, v] of loginFailures) {
        if (nowMs >= v.blockedUntil && v.count === 0) loginFailures.delete(k);
      }
    }
  };

  /** OAuth 端点结果写出（JSON / HTML 授权页 / 302 回跳）。统一附加 no-store。 */
  const writeOAuthResult = (res: ServerResponse, result: OAuthHttpResult): void => {
    const headers = { ...NO_STORE_HEADERS, ...(result.headers ?? {}) };
    if (result.html !== undefined) {
      res.writeHead(result.status, {
        "content-type": "text/html; charset=utf-8",
        ...headers,
      });
      res.end(result.html);
      return;
    }
    if (headers.location !== undefined) {
      res.writeHead(result.status, headers);
      res.end();
      return;
    }
    writeJson(res, result.status, result.body ?? {}, headers);
  };

  /** 读表单/JSON body（/oauth/token 等用 application/x-www-form-urlencoded）。 */
  const readForm = async (req: IncomingMessage): Promise<Record<string, string | undefined>> => {
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
  };

  /** OAuth 端点路由（授权流程本身不需要 Bearer；/mcp 才校验）。 */
  const routeOAuth = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const oauth = options.oauth;
    if (oauth === undefined) return false;
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
      // 限速（审查 P2）：注册无认证，按来源 IP 限每小时次数。
      const nowMs = Date.now();
      pruneRateLimits(nowMs);
      const ip = clientKey(req);
      const reg = registerHits.get(ip);
      if (reg === undefined || nowMs - reg.windowStart > 60 * 60 * 1000) {
        registerHits.set(ip, { count: 1, windowStart: nowMs });
      } else {
        reg.count += 1;
        if (reg.count > REGISTER_LIMIT_PER_HOUR) {
          writeJson(res, 429, {
            error: "slow_down",
            error_description: "too many client registrations from this source",
          });
          return true;
        }
      }
      // RFC 7591：畸形 body 属客户端错误 → 400 invalid_client_metadata，
      // 不冒泡成 500（审查 P2：此前 500 且顶层 catch 静默无日志）。
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (err) {
        process.stderr.write(
          `[merchant oauth] /oauth/register body 解析失败：${err instanceof Error ? err.message : String(err)}\n`,
        );
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
      // BUG-01：授权页需要管理登录会话（cookie）；无会话 → 303 登录页。
      const sessionId = cookieValue(req, ADMIN_SESSION_COOKIE);
      const session =
        sessionId !== undefined && options.admin !== undefined
          ? options.admin.sessions.getSession(sessionId)
          : undefined;
      writeOAuthResult(
        res,
        oauth.authorize(Object.fromEntries(url.searchParams.entries()), session),
      );
      return true;
    }
    if (
      req.method === "POST" &&
      (p === "/oauth/authorize" || p === "/oauth/token" || p === "/oauth/revoke")
    ) {
      let form: Record<string, string | undefined>;
      try {
        form = await readForm(req);
      } catch (err) {
        process.stderr.write(
          `[merchant oauth] ${p} body 解析失败：${err instanceof Error ? err.message : String(err)}\n`,
        );
        writeJson(res, 400, {
          error: "invalid_request",
          error_description: "malformed request body",
        });
        return true;
      }
      let result: OAuthHttpResult;
      if (p === "/oauth/authorize") {
        const sessionId = cookieValue(req, ADMIN_SESSION_COOKIE);
        const session =
          sessionId !== undefined && options.admin !== undefined
            ? options.admin.sessions.getSession(sessionId)
            : undefined;
        if (session === undefined) {
          writeOAuthResult(res, {
            status: 401,
            body: {
              error: "login_required",
              error_description: "授权提交需要有效的商家管理会话",
            },
          });
          return true;
        }
        result = oauth.authorizeSubmit(form, session);
      } else if (p === "/oauth/token") {
        result = oauth.token(form);
      } else {
        result = oauth.revoke(form);
      }
      writeOAuthResult(res, result);
      return true;
    }
    if (p.startsWith("/oauth/") || p.startsWith("/.well-known/oauth-")) {
      writeJson(res, 404, { error: "not_found", message: `unknown OAuth endpoint ${p}` });
      return true;
    }
    return false;
  };

  const httpServer: HttpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (await routeOAuth(req, res, url)) return;
      // 一次性配对码兑换（设计 §8.4 第二期）：只能兑换一次，过期即失效；
      // 成功才返回内部凭据（供商家连接器网关按 merchant_id 路由使用）。
      if (
        options.pairing !== undefined &&
        req.method === "POST" &&
        url.pathname === "/pairing/redeem"
      ) {
        const nowMs = Date.now();
        pruneRateLimits(nowMs);
        const ip = clientKey(req);
        const hits = registerHits.get(`pair:${ip}`);
        if (hits === undefined || nowMs - hits.windowStart > 60 * 60 * 1000) {
          registerHits.set(`pair:${ip}`, { count: 1, windowStart: nowMs });
        } else {
          hits.count += 1;
          if (hits.count > 30) {
            writeJson(res, 429, { error: "slow_down", message: "配对码尝试过于频繁" });
            return;
          }
        }
        let form: Record<string, string | undefined>;
        try {
          form = await readForm(req);
        } catch {
          writeJson(res, 400, { error: "invalid_request", message: "请求体解析失败" });
          return;
        }
        const code = String(form.code ?? "");
        if (!redeemPairingCode(options.pairing.dir, code)) {
          writeJson(res, 403, {
            error: "invalid_pairing_code",
            message: "配对码无效或已过期（请在实例上重新生成）",
          });
          return;
        }
        const identity = options.pairing.instance();
        // 兑换即签发：新凭据覆盖旧的（单槽轮换），明文只在此响应里出现一次。
        const issued = issuePairedCredential(options.pairing.dir);
        process.stderr.write(
          `[merchant pairing] issued paired credential for owner=${identity.ownerId}` +
            `（旧配对凭据已失效）\n`,
        );
        writeJson(res, 200, {
          ok: true,
          instance: { owner_id: identity.ownerId, principal_id: identity.principalId },
          // 能力探测：实例自报名称/版本，供网关在绑定页展示与兼容性判断。
          server_info: { name: serverInfo.name, version: serverInfo.version },
          credential: issued.credential,
        });
        return;
      }
      // 配套商家管理面（BUG-01/03 修复后）：登录用 cookie 会话（HttpOnly/
      // SameSite=Lax/生产 Secure）；/admin/pending 需会话；/admin/decision
      // 需会话 + 一次性确认凭证（绑定候选摘要/主体/商家/动作，单次用途）。
      if (options.admin !== undefined && url.pathname.startsWith("/admin/")) {
        const admin = options.admin;
        // 登录端点（公开；口令校验后签发会话）。失败退避（审查 P2：scrypt
        // 单次成本不足以挡在线爆破，按来源连续失败 10 次锁 5 分钟）。
        if (url.pathname === "/admin/login") {
          if (req.method === "GET") {
            res.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              ...NO_STORE_HEADERS,
            });
            res.end(
              renderAdminLoginPage({
                next: safeAdminNext(url.searchParams.get("next") ?? undefined),
              }),
            );
            return;
          }
          if (req.method === "POST") {
            const nowMs = Date.now();
            pruneRateLimits(nowMs);
            const ip = clientKey(req);
            const failure = loginFailures.get(ip);
            if (failure !== undefined && nowMs < failure.blockedUntil) {
              res.writeHead(429, {
                "content-type": "text/html; charset=utf-8",
                ...NO_STORE_HEADERS,
              });
              res.end(renderAdminLoginPage({ error: "失败次数过多，请 5 分钟后再试" }));
              return;
            }
            const form = await readForm(req);
            const creds = readAdminCredentials(admin.adminDir);
            const password = form.password ?? "";
            if (creds === undefined || !verifyAdminPassword(password, creds.password_hash)) {
              const count = (failure?.count ?? 0) + 1;
              loginFailures.set(ip, {
                count,
                blockedUntil:
                  count >= LOGIN_MAX_FAILURES ? nowMs + LOGIN_BLOCK_MS : failure?.blockedUntil ?? 0,
              });
              res.writeHead(200, {
                "content-type": "text/html; charset=utf-8",
                ...NO_STORE_HEADERS,
              });
              res.end(renderAdminLoginPage({ error: "口令错误或管理员未初始化" }));
              return;
            }
            loginFailures.delete(ip);
            const session = admin.sessions.createSession({
              principalId: creds.principal_id,
              merchantId: creds.merchant_id,
            });
            const secure = admin.secureCookies === true ? "; Secure" : "";
            res.writeHead(303, {
              location: safeAdminNext(form.next),
              "set-cookie": `${ADMIN_SESSION_COOKIE}=${session.sessionId}; HttpOnly; SameSite=Lax; Path=/${secure}`,
            });
            res.end();
            return;
          }
        }
        // 其余 /admin/* 需要有效会话
        const sessionId = cookieValue(req, ADMIN_SESSION_COOKIE);
        const session = sessionId !== undefined ? admin.sessions.getSession(sessionId) : undefined;
        if (session === undefined) {
          res.writeHead(303, { location: "/admin/login" });
          res.end();
          return;
        }
        if (req.method === "GET" && url.pathname === "/admin/pending") {
          const commands = admin.surface.listPending();
          // 按候选签发一次性确认凭证（表单 CSRF + 确认绑定，单次用途）
          const tokenFor = (candidateId: string, action: "approve" | "reject"): string => {
            const candidate = commands.find((c) => c.candidate_id === candidateId);
            if (candidate === undefined) return "";
            return admin.store.createConfirmation({
              candidateId,
              candidateDigest: contentHash({
                arguments: candidate.arguments,
                preconditions: candidate.preconditions,
              }),
              principalId: session.principal_id,
              merchantId: session.merchant_id,
              action,
            });
          };
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            // 页面内嵌一次性确认凭证（审查 P2）：绝不进缓存。
            ...NO_STORE_HEADERS,
          });
          res.end(renderPendingPage(admin.merchantName, commands, tokenFor));
          return;
        }
        if (req.method === "POST" && url.pathname === "/admin/decision") {
          const form = await readForm(req);
          const commandId = form.command_id ?? "";
          const action =
            form.decision === "approve"
              ? "approve"
              : form.decision === "reject"
                ? "reject"
                : undefined;
          if (action === undefined) {
            writeJson(res, 400, {
              error: "invalid_request",
              message: "decision 必须是 approve/reject",
            });
            return;
          }
          const candidate = admin.surface.listPending().find((c) => c.candidate_id === commandId);
          if (candidate === undefined) {
            writeJson(res, 400, {
              error: "not_found",
              message: `未知或非 pending 命令 ${commandId}`,
            });
            return;
          }
          // 一次性确认凭证由执行层（命令日志）逐项核对并核销（候选内容摘要/
          // 主体/商家/动作/有效期/单次用途）——路由不再预消费，防双重核销。
          try {
            if (action === "approve") {
              await admin.surface.executeApproved(
                commandId,
                session.principal_id,
                form.confirmation,
              );
            } else {
              await admin.surface.rejectCandidate(
                commandId,
                session.principal_id,
                form.confirmation,
              );
            }
          } catch (err) {
            // 不回显异常消息（可能含内部细节）：只按「确认凭证失效」与「其余失败」
            // 两类给稳定结论，原文进 stderr。
            const expired = err instanceof Error && err.message.includes("确认凭证");
            process.stderr.write(
              `[merchant mcp] /admin/decision 失败：${err instanceof Error ? err.message : String(err)}\n`,
            );
            writeJson(res, expired ? 403 : 400, {
              error: expired ? "invalid_confirmation" : "command_failed",
              message: expired ? "确认凭证无效或已过期，请刷新待批准页重试" : "审批未执行（详见服务日志）",
            });
            return;
          }
          // 回跳待批准页（PRG 模式）
          res.writeHead(303, { location: "/admin/pending" });
          res.end();
          return;
        }
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      if (url.pathname !== mcpPath) {
        writeJson(res, 404, { error: "not_found", message: `unknown path ${url.pathname}` });
        return;
      }
      let scopes: string[] | undefined;
      if (options.auth !== undefined) {
        const verdict = options.auth.verify({
          ...(typeof req.headers.authorization === "string"
            ? { authorizationHeader: req.headers.authorization }
            : {}),
        });
        if (!verdict.ok) {
          // RFC 9728：401 携带 resource_metadata 指引客户端发现授权服务器。
          writeJson(
            res,
            401,
            { error: "unauthorized", message: "认证失败：需要有效的 Bearer token" },
            {
              "www-authenticate":
                options.oauth !== undefined
                  ? `Bearer resource_metadata="${options.oauth.resourceMetadataUrl}"`
                  : "Bearer",
            },
          );
          return;
        }
        // OAuth 模式按 token scope 过滤；静态 token 过渡模式全量（undefined）。
        scopes = verdict.authorization?.scopes;
      }
      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        writeJson(res, 405, { error: "method_not_allowed" }, { allow: "POST, GET, DELETE" });
        return;
      }
      let body: unknown;
      try {
        body = req.method === "POST" ? await readBody(req) : undefined;
      } catch (err) {
        // 超限 413；其余（JSON 解析失败等）属客户端错误 → 400（审查 P2）。
        const tooLarge = err instanceof Error && err.message.includes("exceeds");
        if (!tooLarge) {
          process.stderr.write(
            `[merchant mcp] /mcp body 解析失败：${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        // 不回显异常消息：响应只给稳定结论，细节已在上面进 stderr。
        writeJson(res, tooLarge ? 413 : 400, {
          error: "invalid_request",
          message: tooLarge ? "请求体超过大小上限" : "请求体无法解析",
        });
        return;
      }
      const protocolServer = createProtocolServer(
        serverInfo,
        toolsBundle,
        scopes,
        options.presentations,
      );
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
        // 内部异常消息（可能含栈/上游响应内容）只进 stderr，不回显给调用方。
        process.stderr.write(
          `[merchant mcp] /mcp transport error：${err instanceof Error ? err.message : String(err)}\n`,
        );
        if (!res.headersSent) {
          writeJson(res, 500, { error: "internal_error", message: "服务内部错误" });
        } else {
          res.end();
        }
      }
    })().catch((err) => {
      // 审查 P2：顶层静默吞错让排障无迹——记错误摘要（不含 body 与凭据）。
      process.stderr.write(
        `[merchant mcp] ${req.method} ${req.url ?? "/"} 处理异常：` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
      if (!res.headersSent) writeJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });
  const address = httpServer.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  return {
    host,
    port: boundPort,
    path: mcpPath,
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${boundPort}${mcpPath}`,
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
