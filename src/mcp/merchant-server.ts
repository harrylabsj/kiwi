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
import { buildMerchantMcpTools } from "./merchant-tools.js";
import type { buildMerchantPresentationResources } from "./merchant-resources.js";
import { renderPendingPage, type MerchantAdminSurface } from "../merchant-admin/pending-page.js";

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
  /** 配套商家确认页面（V2 阶段三；Bearer 认证强制，write 面）。 */
  admin?: { merchantName: string; surface: MerchantAdminSurface };
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

/** 每个请求独立的协议 Server（无状态模式），handlers 引用共享的工具分发器。
 *  scopes 来自本次请求的授权上下文（OAuth access_token）；undefined = 静态
 *  token 过渡模式（全量 scope）。tools/list 按 scope 过滤，tools/call 逐次强制。 */
function createProtocolServer(
  serverInfo: { name: string; version: string },
  toolsBundle: ReturnType<typeof buildMerchantMcpTools>,
  scopes: string[] | undefined,
  presentations?: ReturnType<typeof buildMerchantPresentationResources>,
): Server {
  const server = new Server(
    { name: serverInfo.name, version: serverInfo.version },
    { capabilities: { tools: {}, ...(presentations !== undefined ? { resources: {} } : {}) } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolsBundle.listTools(scopes),
  }));
  if (presentations !== undefined) {
    server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: presentations.list(),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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

  /** OAuth 端点结果写出（JSON / HTML 授权页 / 302 回跳）。 */
  const writeOAuthResult = (res: ServerResponse, result: OAuthHttpResult): void => {
    if (result.html !== undefined) {
      res.writeHead(result.status, {
        "content-type": "text/html; charset=utf-8",
        ...(result.headers ?? {}),
      });
      res.end(result.html);
      return;
    }
    if (result.headers?.location !== undefined) {
      res.writeHead(result.status, result.headers);
      res.end();
      return;
    }
    writeJson(res, result.status, result.body ?? {}, result.headers ?? {});
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
      writeOAuthResult(res, oauth.register(await readBody(req)));
      return true;
    }
    if (req.method === "GET" && p === "/oauth/authorize") {
      writeOAuthResult(res, oauth.authorize(Object.fromEntries(url.searchParams.entries())));
      return true;
    }
    if (
      req.method === "POST" &&
      (p === "/oauth/authorize" || p === "/oauth/token" || p === "/oauth/revoke")
    ) {
      const form = await readForm(req);
      const result =
        p === "/oauth/authorize"
          ? oauth.authorizeSubmit(form)
          : p === "/oauth/token"
            ? oauth.token(form)
            : oauth.revoke(form);
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
      // 配套商家确认页面（V2 阶段三）：Bearer 认证强制（write 面由服务端逐次校验）。
      if (options.admin !== undefined && url.pathname.startsWith("/admin/")) {
        const verdict = options.auth?.verify({
          ...(typeof req.headers.authorization === "string"
            ? { authorizationHeader: req.headers.authorization }
            : {}),
        });
        if (verdict === undefined || !verdict.ok) {
          writeJson(res, 401, {
            error: "unauthorized",
            message: "认证失败：需要有效的 Bearer token",
          });
          return;
        }
        if (req.method === "GET" && url.pathname === "/admin/pending") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            renderPendingPage(options.admin.merchantName, options.admin.surface.listPending()),
          );
          return;
        }
        if (req.method === "POST" && url.pathname === "/admin/decision") {
          const form = await readForm(req);
          const commandId = form.command_id ?? "";
          try {
            if (form.decision === "approve") {
              await options.admin.surface.executeApproved(commandId);
            } else if (form.decision === "reject") {
              await options.admin.surface.rejectCandidate(commandId);
            } else {
              writeJson(res, 400, {
                error: "invalid_request",
                message: "decision 必须是 approve/reject",
              });
              return;
            }
          } catch (err) {
            writeJson(res, 400, {
              error: "command_failed",
              message: err instanceof Error ? err.message : String(err),
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
        writeJson(res, 413, {
          error: "invalid_request",
          message: err instanceof Error ? err.message : String(err),
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
        if (!res.headersSent) {
          writeJson(res, 500, {
            error: "internal_error",
            message: err instanceof Error ? err.message : String(err),
          });
        } else {
          res.end();
        }
      }
    })().catch(() => {
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
