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
 * JSON-RPC 错误映射（A2A JSONRPC binding + KNP §18 协议错误）。
 *
 * 分层（子规范 §24 A2A Binding）：
 * - transport 层：HTTP 状态码表达帧级/传输级失败（400 解析失败 / 401-403 认证 /
 *   413 body 超限 / 404 未知路径 / 405 方法不允许）。
 * - JSON-RPC 层：合法帧内的失败用 JSON-RPC error object 表达；KNP 协议错误
 *   用固定 code=-32050 携带 `data.protocol_code`（词表见
 *   negotiation/domain/common.ts PROTOCOL_ERROR_CODES）。
 *
 * fail-closed（基线 §4.6 / §36）：任何无法证明合法即拒绝；内部异常细节一律
 * 不落回远端响应（§4.5 Remote Content Is Untrusted / 不变量 11）。
 *
 * 错误码映射表（本模块为单一事实来源）：
 *
 * | 条件                                             | HTTP | JSON-RPC code | data.protocol_code        |
 * |--------------------------------------------------|------|---------------|---------------------------|
 * | body 非 JSON / 非 JSON-RPC 对象                   | 400  | -32700        | —                         |
 * | JSON-RPC 帧非法（非 2.0 / 缺 method / id 非串）    | 400  | -32600        | —                         |
 * | 未知 method                                      | 200  | -32601        | —                         |
 * | method 参数形状非法                                | 200  | -32602        | —                         |
 * | tasks/get 未知 taskId                             | 200  | -32004        | —                         |
 * | A2A Message / KNP envelope schema 非法            | 200  | -32050        | schema_invalid            |
 * | KNP 版本不支持                                    | 200  | -32050        | protocol_version_unsupported |
 * | 幂等同 key 异 digest                              | 200  | -32050        | idempotency_conflict      |
 * | handler 返回协议错误                               | 200  | -32050        | <handler.protocolCode>    |
 * | handler / ledger 内部异常（不泄漏细节）            | 200  | -32603        | temporarily_unavailable   |
 * | 认证缺失（未携带凭据）                             | 401  | -32051        | authentication_required   |
 * | 认证失败（凭据无效 / 非 loopback 拒绝）            | 403  | -32051        | authorization_failed      |
 * | body 超过 maxPayloadBytes                         | 413  | -32052        | payload_too_large         |
 */

import { NegotiationValidationError } from "../../negotiation/domain/common.js";
import type { ProtocolErrorCode } from "../../negotiation/domain/common.js";

/** JSON-RPC 2.0 标准 code + A2A/KNP 应用 code。 */
export const JSONRPC_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** A2A v1.0: TaskNotFound。 */
  TASK_NOT_FOUND: -32004,
  /** KNP 协议错误载体：真实 code 在 data.protocol_code（§18 词表）。 */
  KNP_PROTOCOL_ERROR: -32050,
  /** 认证失败载体：protocol_code ∈ {authentication_required, authorization_failed}。 */
  AUTH_ERROR: -32051,
  /** body 超限载体：protocol_code = payload_too_large。 */
  PAYLOAD_TOO_LARGE: -32052,
} as const;

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * 服务器内协议级失败信号。pipeline / http 层内部抛出，由 JSON-RPC 响应层捕获
 * 并翻译为 error object。message 是给日志/调用方看的通用文案，不含内部细节。
 */
export class ServerProtocolError extends Error {
  readonly body: JsonRpcErrorBody;
  constructor(body: JsonRpcErrorBody) {
    super(body.message);
    this.name = "ServerProtocolError";
    this.body = body;
  }
}

/** KNP 协议错误（§18 词表）。 */
export function protocolError(code: ProtocolErrorCode, detail: string): ServerProtocolError {
  return new ServerProtocolError({
    code: JSONRPC_CODES.KNP_PROTOCOL_ERROR,
    message: detail,
    data: { protocol_code: code, detail },
  });
}

/** 入站内容 schema 非法（§4.6 fail-closed 默认码）。 */
export function schemaInvalid(detail: string): ServerProtocolError {
  return protocolError("schema_invalid", detail);
}

/** 内部异常 → 通用错误，绝不携带原始异常 message（§4.5 / §36-11）。 */
export function internalServerError(): ServerProtocolError {
  return new ServerProtocolError({
    code: JSONRPC_CODES.INTERNAL_ERROR,
    message: "internal error",
    data: { protocol_code: "temporarily_unavailable" },
  });
}

/**
 * 认证失败（HTTP 层使用，帧 id 未知故返回 null）。
 * protocol_code ∈ {authentication_required, authorization_failed, identity_rejected,
 * replay_detected}。identity_rejected 与 replay_detected 是 §32 词表里认证相关的
 * 额外结果：身份绑定冲突（403，永久拒绝）与重放（401，换新签名可重试）。
 */
export function authError(
  protocolCode:
    "authentication_required" | "authorization_failed" | "identity_rejected" | "replay_detected",
): {
  httpStatus: number;
  body: JsonRpcErrorBody;
} {
  let httpStatus: number;
  let message: string;
  switch (protocolCode) {
    case "authentication_required":
      httpStatus = 401;
      message = "authentication required";
      break;
    case "replay_detected":
      httpStatus = 401;
      message = "replay detected";
      break;
    case "authorization_failed":
      httpStatus = 403;
      message = "authorization failed";
      break;
    case "identity_rejected":
      httpStatus = 403;
      message = "identity rejected";
      break;
  }
  return {
    httpStatus,
    body: {
      code: JSONRPC_CODES.AUTH_ERROR,
      message,
      data: { protocol_code: protocolCode },
    },
  };
}

/**
 * 限流拒绝（WP3 §31）：走既有 KNP 协议错误载体（-32050），protocol_code =
 * rate_limited，data 携带 retry_after（秒）对齐 UCP 429/503 的 backoff 语义。
 */
export function rateLimited(retryAfterSeconds: number, detail: string): ServerProtocolError {
  return new ServerProtocolError({
    code: JSONRPC_CODES.KNP_PROTOCOL_ERROR,
    message: detail,
    data: { protocol_code: "rate_limited", retry_after: retryAfterSeconds, detail },
  });
}

/** 取任意异常的 protocol_code（错误表统一读取口；未知返回 undefined）。 */
export function protocolCodeOf(err: unknown): ProtocolErrorCode | undefined {
  if (err instanceof ServerProtocolError) {
    const data = err.body.data as { protocol_code?: unknown } | undefined;
    if (data !== undefined && typeof data.protocol_code === "string") {
      return data.protocol_code as ProtocolErrorCode;
    }
  }
  if (err instanceof NegotiationValidationError) return err.code;
  return undefined;
}

/** body 超限（HTTP 层使用）。 */
export function payloadTooLarge(maxBytes: number): { httpStatus: number; body: JsonRpcErrorBody } {
  return {
    httpStatus: 413,
    body: {
      code: JSONRPC_CODES.PAYLOAD_TOO_LARGE,
      message: "request body exceeds maximum payload size",
      data: { protocol_code: "payload_too_large", max_bytes: maxBytes },
    },
  };
}

/** 把 KNP 校验错误（validateEnvelope 等）翻译为协议错误。 */
export function fromNegotiationError(err: NegotiationValidationError): ServerProtocolError {
  return protocolError(err.code, err.message);
}

/** 任务不存在（A2A -32004）。 */
export function taskNotFound(taskId: string): JsonRpcErrorBody {
  return {
    code: JSONRPC_CODES.TASK_NOT_FOUND,
    message: `task ${taskId} not found`,
    data: { taskId },
  };
}
