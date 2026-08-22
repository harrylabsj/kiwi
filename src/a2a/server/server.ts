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
import { buildAgentCard, buildExtendedAgentCard } from "./card.js";
// issue 07：1.0 双栈（版本头/扩展激活/方法路由/Part 解码）。
import { A2A_EXTENSIONS_HEADER, A2A_VERSION_HEADER, activateKnp, parseExtensions, parseVersion } from "../v1/headers.js";
import {
  METHOD_CANCEL_TASK,
  METHOD_CREATE_PUSH_CONFIG,
  METHOD_DELETE_PUSH_CONFIG,
  METHOD_GET_EXTENDED_AGENT_CARD,
  METHOD_GET_PUSH_CONFIG,
  METHOD_GET_TASK,
  METHOD_LIST_PUSH_CONFIGS,
  METHOD_LIST_TASKS,
  METHOD_SEND_MESSAGE,
  METHOD_SEND_STREAMING_MESSAGE,
} from "../v1/methods.js";
import { decodeV1Part, isKnpDataPart, isV1InputPartSupported } from "../v1/part.js";
import { LEGACY_TO_V1_STATE } from "../v1/types.js";
import { buildUcpProfile, WELL_KNOWN_UCP_PATH } from "./ucp.js";
import type { BuiltUcpProfile, UcpPublishOptions } from "./ucp.js";
import { defaultAuthVerifier } from "./auth.js";
import { defaultHandler } from "./handler.js";
import { InboundPipeline } from "./pipeline.js";
import { TaskRegistry } from "./task-registry.js";
import { A2AServerThrottle, domainFromUcpProfile } from "./throttle.js";
import type { ThrottleOptions } from "./throttle.js";
import type { TrustLevel } from "../../trust/identity/trust-policy.js";
import {
  authError,
  fromNegotiationError,
  internalServerError,
  JSONRPC_CODES,
  payloadTooLarge,
  rateLimited,
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

/** issue 10：A2A 错误码 → 1.0 ErrorInfo reason（标准 JSON-RPC 错误无 reason）。 */
function v1ErrorReasonFor(code: number): string | undefined {
  switch (code) {
    case JSONRPC_CODES.TASK_NOT_FOUND:
      return "TASK_NOT_FOUND";
    case JSONRPC_CODES.TASK_NOT_CANCELABLE:
      return "TASK_NOT_CANCELABLE";
    case JSONRPC_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED:
      return "PUSH_NOTIFICATION_NOT_SUPPORTED";
    case JSONRPC_CODES.UNSUPPORTED_OPERATION:
      return "UNSUPPORTED_OPERATION";
    case JSONRPC_CODES.CONTENT_TYPE_NOT_SUPPORTED:
      return "CONTENT_TYPE_NOT_SUPPORTED";
    case JSONRPC_CODES.VERSION_NOT_SUPPORTED:
      return "VERSION_NOT_SUPPORTED";
    default:
      return undefined;
  }
}

/** issue 10：兼容 SDK 的 proto 枚举名（ROLE_USER/ROLE_AGENT）与规范小写 role。 */
function normalizeV1Role(role: unknown): unknown {
  if (role === "ROLE_USER") return "user";
  if (role === "ROLE_AGENT") return "agent";
  return role;
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
  trustLevel?: TrustLevel;
  identityVerified?: boolean;
  fingerprintChanged?: boolean;
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
  private readonly throttle: A2AServerThrottle | undefined;

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
    this.throttle =
      options.throttle === undefined
        ? undefined
        : options.throttle instanceof A2AServerThrottle
          ? options.throttle
          : new A2AServerThrottle(options.throttle as ThrottleOptions);
    this.pipeline = new InboundPipeline({
      handler,
      idempotency: options.idempotency,
      ledger: options.ledger,
      tasks,
      now: this.now,
      logError: this.logError,
      throttle: this.throttle,
      genericResponder: options.genericResponder,
      stats: options.stats,
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
    return {
      identity: result.identity ?? "unknown",
      remoteAddress: req.socket.remoteAddress,
      trustLevel: result.trustLevel,
      identityVerified: result.identityVerified,
      fingerprintChanged: result.fingerprintChanged,
    };
  }

  private async handleWellKnown(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== "GET") {
      sendText(res, 405, "method not allowed");
      return;
    }
    // Agent Card 是公开发现元数据（catalog 验证 / buyer 发现都要匿名拉取），
    // 不套用 A2A 端点认证；敏感字段本就在构造时被 secrets 扫描器剥离。
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
  private async handleUcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      sendText(res, 405, "method not allowed");
      return;
    }
    // UCP Profile 同 Agent Card：公开发现元数据，不套用 A2A 端点认证。
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
    // issue 10 / TCK JSONRPC-SSE-002 content_type：非 application/json 的
    // Content-Type 在 HTTP 层 415 拒绝（text body，不进入 JSON-RPC 解析）。
    // 兼容 MIME 后缀（application/json; charset=utf-8）；缺省头按空串放行。
    const contentType = String(req.headers["content-type"] ?? "");
    if (contentType !== "" && !contentType.startsWith("application/json")) {
      sendText(res, 415, "content type not supported");
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
    // issue 07：读 A2A-Version / A2A-Extensions 头，按版本 dispatch。
    const version = parseVersion(String(req.headers[A2A_VERSION_HEADER.toLowerCase()] ?? ""));
    const extensions = parseExtensions(String(req.headers[A2A_EXTENSIONS_HEADER.toLowerCase()] ?? ""));
    try {
      const result = await this.dispatch(method, params, auth, ucpAgentProfile, version, extensions);
      sendJson(res, 200, { jsonrpc: "2.0", id, result });
    } catch (err) {
      sendJsonError(res, id, 200, this.toJsonRpcErrorBody(err, version));
    }
  }

  private toJsonRpcErrorBody(err: unknown, version?: string): JsonRpcErrorBody {
    const body =
      err instanceof ServerProtocolError
        ? err.body
        : err instanceof NegotiationValidationError
          ? fromNegotiationError(err).body
          : (this.logError("a2a jsonrpc request failed", err), internalServerError().body);
    // issue 08/10：1.0 错误体 —— `error.data` 是 google.rpc.ErrorInfo **数组**
    // （domain a2a-protocol.org + 标准 reason；TCK JSONRPC-ERR-003）。
    if (version !== "1.0") return body;
    const reason = v1ErrorReasonFor(body.code);
    return {
      code: body.code,
      message: body.message,
      data: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          domain: "a2a-protocol.org",
          reason: reason ?? "UNKNOWN",
        },
      ],
    };
  }

  private async dispatch(
    method: string,
    params: unknown,
    caller: Caller,
    ucpAgentProfile?: string,
    version?: string,
    extensions?: string[],
  ): Promise<unknown> {
    // issue 07：版本校验——不支持的版本 fail-closed（1.0 错误体在 issue 08 升级）。
    if (version !== undefined && version !== "1.0" && version !== "0.3") {
      throw new ServerProtocolError({
        code: JSONRPC_CODES.VERSION_NOT_SUPPORTED,
        message: `unsupported A2A version ${version}`,
      });
    }
    if (version === "1.0") {
      // KNP 扩展激活：未知扩展 fail-closed（包裹为 ServerProtocolError，
      // 而非 internal error）；声明 KNP 才走磋商。
      try {
        activateKnp(extensions ?? [], this.supportedExtensionUris());
      } catch (err) {
        throw new ServerProtocolError({
          code: JSONRPC_CODES.INVALID_REQUEST,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      switch (method) {
        case METHOD_SEND_MESSAGE:
          return this.handleMessageSendV1(params, caller, ucpAgentProfile);
        case METHOD_GET_TASK:
          return this.upperTaskState(await this.handleTasksGet(params, caller, ucpAgentProfile));
        case METHOD_LIST_TASKS:
          return this.handleListTasks();
        case METHOD_CANCEL_TASK:
          return this.upperTaskState(await this.handleCancelTask(params));
        case METHOD_GET_EXTENDED_AGENT_CARD:
          return this.handleGetExtendedAgentCard();
        // issue 10 / TCK JSONRPC-SSE-002：不支持的操作返回标准错误码而非
        // MethodNotFound——流式未声明支持 → -32004 UnsupportedOperationError；
        // push 通知未声明支持 → -32003 PushNotificationNotSupportedError。
        case METHOD_SEND_STREAMING_MESSAGE:
          throw new ServerProtocolError({
            code: JSONRPC_CODES.UNSUPPORTED_OPERATION,
            message: "streaming is not supported",
          });
        case METHOD_CREATE_PUSH_CONFIG:
        case METHOD_GET_PUSH_CONFIG:
        case METHOD_LIST_PUSH_CONFIGS:
        case METHOD_DELETE_PUSH_CONFIG:
          throw new ServerProtocolError({
            code: JSONRPC_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
            message: "push notifications are not supported",
          });
        default:
          throw new ServerProtocolError({
            code: JSONRPC_CODES.METHOD_NOT_FOUND,
            message: `method ${method} not found`,
          });
      }
    }
    switch (method) {
      case "message/send":
        return this.handleMessageSend(params, caller, ucpAgentProfile);
      case "tasks/get":
        return this.handleTasksGet(params, caller, ucpAgentProfile);
      default:
        throw new ServerProtocolError({
          code: JSONRPC_CODES.METHOD_NOT_FOUND,
          message: `method ${method} not found`,
        });
    }
  }

  /** 服务器自身声明的扩展 URI 集合（来自 Card capabilities.extensions）。 */
  private supportedExtensionUris(): ReadonlySet<string> {
    const config = resolveCardConfig(this.cardConfig);
    const card = buildAgentCard(config);
    const uris = new Set<string>();
    for (const ext of card.capabilities?.extensions ?? []) {
      uris.add(ext.uri);
    }
    return uris;
  }

  /** 1.0 SendMessage：解码统一 Part → 复用 0.3 磋商内核 → 响应 TaskState 大写。 */
  private async handleMessageSendV1(
    params: unknown,
    caller: Caller,
    ucpAgentProfile?: string,
  ): Promise<unknown> {
    const p = requireParamsObject(params);
    const rawMessage = p.message as
      | { role?: unknown; parts?: unknown[]; taskId?: unknown; contextId?: unknown }
      | undefined;
    if (rawMessage === undefined || !Array.isArray(rawMessage.parts)) {
      throw new ServerProtocolError({
        code: JSONRPC_CODES.INVALID_REQUEST,
        message: "params.message is required",
      });
    }
    // 先验证每个 unified Part 的运行时形状。输入来自远端，不能把 null、数组
    // 或缺字段对象交给 `in`/解码逻辑，否则会把坏请求升级为 500。
    if (!rawMessage.parts.every((part) => isV1InputPartSupported(part as never))) {
      throw new ServerProtocolError({
        code: JSONRPC_CODES.INVALID_REQUEST,
        message: "params.message.parts contains an invalid or unsupported Part",
      });
    }
    // KNP 检测在**原始** parts 上做（不先解码）：未知 Part（raw/file/url）不进
    // decodeV1Part（后者对 0.3 无等价物会抛错）。TCK CORE-SEND-003：带未知
    // mediaType 的普通消息按参考 SUT 语义直接回显成功（ContentTypeNotSupported
    // 由 HTTP 层 Content-Type 守卫覆盖，见 handleA2a）。
    const hasKnp = rawMessage.parts.some((part) => isKnpDataPart(part as never));
    // issue 10 / TCK CORE-SEND/EXECUTION-MODE/MULTI：无 KNP envelope 的普通
    // A2A 消息走通用处理（不强制磋商管线）。回显**原始 1.0 消息**（role/parts
    // 保持 1.0 wire 形状：ROLE_USER + 统一 Part），否则 TCK schema 拒绝。
    // taskId 语义校验（CORE-MULTI-004/006、CORE-SEND-002）**只对通用消息生效**：
    // KNP 磋商会话由 (sender_identity, message_id) 幂等驱动，客户端跨回合复用
    // merchant 已终态化的 taskId 是既有设计（interop 双边流），不受 A2A 通用
    // 消息语义约束。
    if (!hasKnp) {
      if (typeof rawMessage.taskId === "string" && rawMessage.taskId.length > 0) {
        const existing = await this.pipeline.getTask(rawMessage.taskId);
        if (existing === null) {
          // CORE-MULTI-004：不存在的 taskId → TaskNotFound。
          throw new ServerProtocolError({
            code: JSONRPC_CODES.TASK_NOT_FOUND,
            message: `task ${rawMessage.taskId} not found`,
            data: { taskId: rawMessage.taskId },
          });
        }
        // CORE-SEND-002：向终态任务发消息 → UnsupportedOperation。
        const state = existing.status.state;
        if (state === "completed" || state === "canceled" || state === "failed") {
          throw new ServerProtocolError({
            code: JSONRPC_CODES.UNSUPPORTED_OPERATION,
            message: `task ${rawMessage.taskId} is in terminal state ${state}`,
            data: { taskId: rawMessage.taskId },
          });
        }
        // CORE-MULTI-006：contextId 与任务已记录的 contextId 不匹配 → 拒绝。
        if (
          typeof rawMessage.contextId === "string" &&
          rawMessage.contextId.length > 0 &&
          existing.contextId !== undefined &&
          rawMessage.contextId !== existing.contextId
        ) {
          throw new ServerProtocolError({
            code: JSONRPC_CODES.INVALID_REQUEST,
            message: "contextId does not match the task's contextId",
            data: { taskId: rawMessage.taskId },
          });
        }
      }
      const generic = this.pipeline.sendGenericMessage(rawMessage);
      return this.upperTaskState(generic);
    }
    const decoded = {
      ...rawMessage,
      // issue 10：兼容 SDK 的 proto 枚举名（ROLE_USER）与规范小写（user）。
      role: normalizeV1Role(rawMessage.role),
      parts: rawMessage.parts.map((part) => decodeV1Part(part as never)),
    };
    const result = await this.handleMessageSend(
      { ...p, message: decoded },
      caller,
      ucpAgentProfile,
    );
    return this.upperTaskState(result);
  }

  /**
   * 1.0 响应：状态、Role、Part 均映射为 A2A 1.0 wire。
   *
   * 磋商管线内部仍使用 0.3 领域模型（`kind` + 小写 role），但 1.0
   * 响应不能把这个内部形状泄漏到线上；否则官方 SDK 会拿到一个看似成功
   * 的 Task，却在解析 status.message/artifacts 时失败。
   */
  private upperTaskState(value: unknown): unknown {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const obj = value as { task?: Record<string, unknown> };
    const task = obj.task;
    if (task === undefined || typeof task !== "object") return value;
    const status = task.status as Record<string, unknown> | undefined;
    if (status === undefined || typeof status !== "object") return value;
    const v1State =
      typeof status.state === "string"
        ? LEGACY_TO_V1_STATE[status.state] ?? status.state
        : status.state;
    const encodeMessage = (message: unknown): unknown => {
      if (message === null || typeof message !== "object" || Array.isArray(message)) return message;
      const m = message as Record<string, unknown>;
      const parts = Array.isArray(m.parts)
        ? m.parts.map((part) => {
            if (part === null || typeof part !== "object" || Array.isArray(part)) return part;
            const p = part as Record<string, unknown>;
            if (p.kind === "text" && typeof p.text === "string") return { text: p.text };
            if (p.kind === "data" && p.data !== null && typeof p.data === "object" && !Array.isArray(p.data)) {
              return { data: p.data, mediaType: "application/json" };
            }
            return part;
          })
        : m.parts;
      const role = m.role === "agent" ? "ROLE_AGENT" : m.role === "user" ? "ROLE_USER" : m.role;
      return { ...m, ...(role !== undefined ? { role } : {}), ...(parts !== undefined ? { parts } : {}) };
    };
    const artifacts = Array.isArray((task as Record<string, unknown>).artifacts)
      ? ((task as Record<string, unknown>).artifacts as unknown[]).map((artifact) => {
          if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) return artifact;
          const a = artifact as Record<string, unknown>;
          const parts = Array.isArray(a.parts)
            ? a.parts.map((part) => {
                if (part === null || typeof part !== "object" || Array.isArray(part)) return part;
                const p = part as Record<string, unknown>;
                if (p.kind === "text" && typeof p.text === "string") return { text: p.text };
                if (p.kind === "data" && p.data !== null && typeof p.data === "object" && !Array.isArray(p.data)) {
                  return { data: p.data, mediaType: "application/json" };
                }
                return part;
              })
            : a.parts;
          return { ...a, ...(parts !== undefined ? { parts } : {}) };
        })
      : (task as Record<string, unknown>).artifacts;
    return {
      ...obj,
      task: {
        ...task,
        status: {
          ...status,
          state: v1State,
          ...(status.message !== undefined ? { message: encodeMessage(status.message) } : {}),
        },
        ...(artifacts !== undefined ? { artifacts } : {}),
      },
    };
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
      {
        senderIdentity: caller.identity,
        remoteAddress: caller.remoteAddress,
        ucpAgentProfile,
        trustLevel: caller.trustLevel,
        identityVerified: caller.identityVerified,
        fingerprintChanged: caller.fingerprintChanged,
      },
    );
    return { task: result.task };
  }

  private async handleTasksGet(
    params: unknown,
    caller: Caller,
    ucpAgentProfile?: string,
  ): Promise<unknown> {
    const p = requireParamsObject(params);
    const id = p.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new ServerProtocolError({
        code: JSONRPC_CODES.INVALID_PARAMS,
        message: "params.id must be a non-empty string",
      });
    }
    // 限流（评审项 B3）：tasks/get 对未知 id 走全 Ledger 线性扫描且此前完全
    // 不受限流（throttle 只挂在 message/send）——认证客户端可高频刷 CPU 且
    // 开销随 Ledger 规模线性放大。与 message/send 同档位判定（identity/
    // domain 窗口 + malformed budget）。
    if (this.throttle !== undefined) {
      const decision = this.throttle.check({
        identity: caller.identity,
        remoteAddress: caller.remoteAddress,
        domain: domainFromUcpProfile(ucpAgentProfile),
        identityVerified: caller.identityVerified,
        trustLevel: caller.trustLevel,
        fingerprintChanged: caller.fingerprintChanged,
      });
      if (!decision.allowed) {
        throw rateLimited(decision.retryAfterSeconds, decision.reason);
      }
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

  /** ListTasks（issue 10 / TCK CORE-LIST）：返回任务列表（1.0 wire state）。 */
  private handleListTasks(): unknown {
    const tasks = this.pipeline.listTasks().tasks.map((t) => {
      const up = this.upperTaskState({ task: t });
      return (up as { task: unknown }).task;
    });
    return { tasks };
  }

  /** CancelTask（issue 10 / TCK CORE-CANCEL）。 */
  private async handleCancelTask(params: unknown): Promise<unknown> {
    const p = requireParamsObject(params);
    const id = p.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new ServerProtocolError({
        code: JSONRPC_CODES.INVALID_PARAMS,
        message: "params.id must be a non-empty string",
      });
    }
    const result = this.pipeline.cancelTask(id);
    if (result.outcome === "not_found") {
      throw new ServerProtocolError({
        code: JSONRPC_CODES.TASK_NOT_FOUND,
        message: `task ${id} not found`,
        data: { taskId: id },
      });
    }
    if (result.outcome === "not_cancelable") {
      throw new ServerProtocolError({
        code: JSONRPC_CODES.TASK_NOT_CANCELABLE,
        message: `task ${id} is not cancelable`,
        data: { taskId: id },
      });
    }
    // getTask 是 async（内存优先，Ledger 兜底）；必须 await，否则 Promise 被
    // 序列化为 {}（TCK CORE-CANCEL：CancelTask 响应必须带 task.id）。
    const task = await this.pipeline.getTask(id);
    return { task: task ?? { id, status: { state: "canceled" as const } } };
  }

  /** GetExtendedAgentCard（issue 10 / TCK CARD-EXT-001）：返回 snake_case 扩展 card 本体。 */
  private handleGetExtendedAgentCard(): unknown {
    return buildExtendedAgentCard(resolveCardConfig(this.cardConfig));
  }
}
