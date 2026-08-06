/**
 * A2A Server（入站侧，WP2）node:http 实现。零新增依赖。
 *
 * 端点面：
 *   GET  {wellKnownPath}   Agent Card（基线 §26 / 子规范 §24.1），默认
 *                          `/.well-known/agent-card.json`；
 *   POST {a2aPath}         JSON-RPC A2A endpoint（默认 "/"）：message/send、
 *                          tasks/get；其他 method → -32601。
 *
 * 请求路径顺序（全部 fail-closed）：
 *   1. 路由 → 2. 认证（AuthVerifier 接缝，缺省 loopback-only）→
 *   3. body 大小上限（默认 1 MiB）→ 4. JSON 解析（失败 400）→
 *   5. JSON-RPC 帧校验（失败 400）→ 6. method 分发 → 7. InboundPipeline。
 *
 * 内部异常一律收敛为通用 "internal error"（-32603），绝不把 handler / ledger 的
 * 内部细节回显给远端（基线 §4.5 / §36-11）。
 */

import http from "node:http";
import { isJsonRpcRequest } from "../client/index.js";
import { NegotiationValidationError } from "../../negotiation/domain/common.js";
import { parseUcpAgentHeader, UCP_AGENT_HEADER } from "../ucp-agent.js";
import { buildAgentCard } from "./card.js";
import { buildUcpProfile, WELL_KNOWN_UCP_PATH } from "./ucp.js";
import type { BuiltUcpProfile, UcpPublishOptions } from "./ucp.js";
import { defaultAuthVerifier } from "./auth.js";
import { defaultHandler } from "./handler.js";
import { InboundPipeline } from "./pipeline.js";
import { TaskRegistry } from "./task-registry.js";
import {
  authError,
  fromNegotiationError,
  internalServerError,
  JSONRPC_CODES,
  payloadTooLarge,
  ServerProtocolError,
} from "./errors.js";
import type { JsonRpcErrorBody } from "./errors.js";
import type {
  AgentCardConfig,
  AgentCardConfigProvider,
  AuthVerifier,
  A2AServerOptions,
} from "./types.js";

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_WELL_KNOWN_PATH = "/.well-known/agent-card.json";

function normalizePath(p: string | undefined): string {
  if (p === undefined || p === "") return "/";
  return p.startsWith("/") ? p : `/${p}`;
}

function resolveCardConfig(provider: AgentCardConfigProvider): AgentCardConfig {
  return typeof provider === "function" ? provider() : provider;
}

function pathOf(url: string | undefined): string {
  if (url === undefined) return "/";
  const queryIndex = url.indexOf("?");
  return queryIndex >= 0 ? url.slice(0, queryIndex) : url;
}

function requireParamsObject(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new ServerProtocolError({
      code: JSONRPC_CODES.INVALID_PARAMS,
      message: "params must be an object",
    });
  }
  return params as Record<string, unknown>;
}

interface Caller {
  identity: string;
  remoteAddress: string | undefined;
}

type ReadBodyResult = { ok: true; body: Buffer } | { ok: false };

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<ReadBodyResult> {
  return new Promise((resolve) => {
    const contentLength = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      req.resume();
      resolve({ ok: false });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: ReadBodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.pause();
        finish({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ ok: true, body: Buffer.concat(chunks) }));
    req.on("error", () => finish({ ok: false }));
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendJsonError(
  res: http.ServerResponse,
  id: string | null,
  status: number,
  error: JsonRpcErrorBody,
): void {
  sendJson(res, status, { jsonrpc: "2.0", id, error });
}

function sendText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

export class A2AServer {
  private readonly cardConfig: AgentCardConfigProvider;
  private readonly authVerifier: AuthVerifier;
  private readonly maxPayloadBytes: number;
  private readonly now: () => string;
  private readonly wellKnownPath: string;
  private readonly ucpOptions: UcpPublishOptions | undefined;
  private readonly pipeline: InboundPipeline;

  constructor(options: A2AServerOptions) {
    this.cardConfig = options.card;
    this.authVerifier = options.authVerifier ?? defaultAuthVerifier();
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    if (this.maxPayloadBytes <= 0) {
      throw new Error("A2AServer: maxPayloadBytes must be positive");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.wellKnownPath = options.wellKnownPath ?? DEFAULT_WELL_KNOWN_PATH;

    const ucpOpt = options.ucp;
    if (
      ucpOpt === undefined ||
      ucpOpt === false ||
      (typeof ucpOpt === "object" && ucpOpt.enabled === false)
    ) {
      this.ucpOptions = undefined;
    } else {
      this.ucpOptions = ucpOpt === true ? {} : ucpOpt;
    }

    const handler = options.handler ?? defaultHandler();
    const tasks = new TaskRegistry();
    this.pipeline = new InboundPipeline({
      handler,
      idempotency: options.idempotency,
      ledger: options.ledger,
      tasks,
      now: this.now,
      logError: this.logError,
    });
  }

  private logError = (message: string, err: unknown): void => {
    // 服务端日志；细节绝不回显给远端（§4.5）。
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[a2a-server] ${message}: ${detail}`);
  };

  /** 返回 node:http request listener。 */
  handler(): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    return (req, res) => {
      void this.handleRequest(req, res);
    };
  }

  /** 创建并返回绑定本 handler 的 node:http server。 */
  createServer(): http.Server {
    const server = http.createServer(this.handler());
    server.on("clientError", () => {
      // 忽略畸形客户端流量（中止的 socket 等），不让其崩溃 server。
    });
    return server;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const pathname = pathOf(req.url);
      const cardConfig = resolveCardConfig(this.cardConfig);
      const a2aPath = normalizePath(cardConfig.a2aPath);
      if (pathname === this.wellKnownPath) {
        await this.handleWellKnown(req, res);
        return;
      }
      // WP3 §25：UCP Profile 标准发现入口（/.well-known/ucp）。未配置发布时 404。
      if (pathname === WELL_KNOWN_UCP_PATH) {
        if (this.ucpOptions === undefined) {
          sendText(res, 404, "not found");
          return;
        }
        await this.handleUcp(req, res);
        return;
      }
      if (pathname === a2aPath) {
        await this.handleA2a(req, res);
        return;
      }
      sendText(res, 404, "not found");
    } catch (err) {
      this.logError("a2a request routing failed", err);
      if (!res.headersSent) {
        sendText(res, 500, "internal error");
      } else {
        res.end();
      }
    }
  }

  private async authenticate(
    req: http.IncomingMessage,
    body?: Buffer,
  ): Promise<Caller | { error: { httpStatus: number; body: JsonRpcErrorBody } }> {
    // node:http 的 IncomingMessage.socket 静态类型是 net.Socket；TLS 下实为
    // TLSSocket（带 encrypted）。用类型守卫读取，HTTPS 部署下 scheme 才是 https。
    const socketTls = req.socket as { encrypted?: boolean };
    const result = await this.authVerifier.verify({
      remoteAddress: req.socket.remoteAddress,
      authorizationHeader: req.headers.authorization,
      method: req.method ?? "",
      url: req.url ?? "",
      // WP5 HTTP Message Signature 需要原始头、请求体与 scheme（@target-uri 重建）。
      scheme: socketTls.encrypted === true ? "https" : "http",
      headers: req.headers,
      body,
    });
    if (!result.authenticated) {
      const { httpStatus, body } = authError(result.protocolCode ?? "authorization_failed");
      return { error: { httpStatus, body } };
    }
    return { identity: result.identity ?? "unknown", remoteAddress: req.socket.remoteAddress };
  }

  private async handleWellKnown(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== "GET") {
      sendText(res, 405, "method not allowed");
      return;
    }
    const auth = await this.authenticate(req);
    if ("error" in auth) {
      sendJsonError(res, null, auth.error.httpStatus, auth.error.body);
      return;
    }
    let card: unknown;
    try {
      card = buildAgentCard(resolveCardConfig(this.cardConfig));
    } catch (err) {
      this.logError("failed to build agent card", err);
      sendText(res, 500, "internal error");
      return;
    }
    sendJson(res, 200, card);
  }

  /**
   * UCP Profile 端点（WP3）：GET /.well-known/ucp。
   * 响应头 Cache-Control: public, max-age=N（N>=60，UCP 规范强制）；
   * 内容由 buildUcpProfile 强制过 validate 自洽（fail-closed）。
   */
  private async handleUcp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== "GET") {
      sendText(res, 405, "method not allowed");
      return;
    }
    const auth = await this.authenticate(req);
    if ("error" in auth) {
      sendJsonError(res, null, auth.error.httpStatus, auth.error.body);
      return;
    }
    let built: BuiltUcpProfile;
    try {
      built = buildUcpProfile(resolveCardConfig(this.cardConfig), {
        wellKnownPath: this.wellKnownPath,
        ...this.ucpOptions,
      });
    } catch (err) {
      this.logError("failed to build UCP profile", err);
      sendText(res, 500, "internal error");
      return;
    }
    const payload = JSON.stringify(built.profile);
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      "cache-control": built.cacheControl,
    });
    res.end(payload);
  }

  private async handleA2a(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendText(res, 405, "method not allowed");
      return;
    }
    // 先读 body（有大小上限）：WP5 content-digest 验签需要请求体；顺序调整对
    // 既有认证语义无影响——认证失败仍返回 401/403，只是 body 先被读取。
    const bodyResult = await readBody(req, this.maxPayloadBytes);
    if (!bodyResult.ok) {
      const { httpStatus, body } = payloadTooLarge(this.maxPayloadBytes);
      sendJsonError(res, null, httpStatus, body);
      return;
    }

    const auth = await this.authenticate(req, bodyResult.body);
    if ("error" in auth) {
      sendJsonError(res, null, auth.error.httpStatus, auth.error.body);
      return;
    }

    // WP3 §25.1：解析对端 UCP-Agent 宣告（只读，不强制 —— 缺失/畸形不拒绝）。
    const ucpAgentProfile = parseUcpAgentHeader(req.headers[UCP_AGENT_HEADER]);

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyResult.body.toString("utf8"));
    } catch {
      sendJsonError(res, null, 400, {
        code: JSONRPC_CODES.PARSE_ERROR,
        message: "request body is not valid JSON",
      });
      return;
    }

    if (!isJsonRpcRequest(parsed)) {
      sendJsonError(res, null, 400, {
        code: JSONRPC_CODES.INVALID_REQUEST,
        message: "invalid JSON-RPC request",
      });
      return;
    }

    const { id, method, params } = parsed;
    try {
      const result = await this.dispatch(method, params, auth, ucpAgentProfile);
      sendJson(res, 200, { jsonrpc: "2.0", id, result });
    } catch (err) {
      sendJsonError(res, id, 200, this.toJsonRpcErrorBody(err));
    }
  }

  private toJsonRpcErrorBody(err: unknown): JsonRpcErrorBody {
    if (err instanceof ServerProtocolError) return err.body;
    if (err instanceof NegotiationValidationError) return fromNegotiationError(err).body;
    this.logError("a2a jsonrpc request failed", err);
    return internalServerError().body;
  }

  private async dispatch(
    method: string,
    params: unknown,
    caller: Caller,
    ucpAgentProfile?: string,
  ): Promise<unknown> {
    switch (method) {
      case "message/send":
        return this.handleMessageSend(params, caller, ucpAgentProfile);
      case "tasks/get":
        return this.handleTasksGet(params);
      default:
        throw new ServerProtocolError({
          code: JSONRPC_CODES.METHOD_NOT_FOUND,
          message: `method ${method} not found`,
        });
    }
  }

  private async handleMessageSend(
    params: unknown,
    caller: Caller,
    ucpAgentProfile?: string,
  ): Promise<unknown> {
    const p = requireParamsObject(params);
    if (p.message === undefined) {
      throw new ServerProtocolError({
        code: JSONRPC_CODES.INVALID_PARAMS,
        message: "params.message is required",
      });
    }
    const result = await this.pipeline.sendMessage(
      { message: p.message, contextId: p.contextId },
      { senderIdentity: caller.identity, remoteAddress: caller.remoteAddress, ucpAgentProfile },
    );
    return { task: result.task };
  }

  private async handleTasksGet(params: unknown): Promise<unknown> {
    const p = requireParamsObject(params);
    const id = p.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new ServerProtocolError({
        code: JSONRPC_CODES.INVALID_PARAMS,
        message: "params.id must be a non-empty string",
      });
    }
    const task = await this.pipeline.getTask(id);
    if (task === null) {
      throw new ServerProtocolError({
        code: JSONRPC_CODES.TASK_NOT_FOUND,
        message: `task ${id} not found`,
        data: { taskId: id },
      });
    }
    return { task };
  }
}
