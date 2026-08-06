/**
 * A2A 出站 client 错误。所有失败路径（timeout / network / 非 2xx / JSON-RPC
 * error / 畸形响应 / URL 安全 / schema 校验）统一 fail-closed 为 A2AClientError，
 * 不产生任何隐式重试或降级。
 */

export type A2AClientErrorKind =
  | "timeout"
  | "network"
  | "http_status"
  | "invalid_response"
  | "jsonrpc_error"
  | "unsafe_target"
  | "schema_invalid";

export interface A2AClientErrorOptions {
  httpStatus?: number;
  jsonrpcCode?: number;
  jsonrpcData?: unknown;
}

export class A2AClientError extends Error {
  readonly kind: A2AClientErrorKind;
  readonly httpStatus?: number;
  readonly jsonrpcCode?: number;
  readonly jsonrpcData?: unknown;

  constructor(kind: A2AClientErrorKind, message: string, options: A2AClientErrorOptions = {}) {
    super(message);
    this.name = "A2AClientError";
    this.kind = kind;
    this.httpStatus = options.httpStatus;
    this.jsonrpcCode = options.jsonrpcCode;
    this.jsonrpcData = options.jsonrpcData;
  }
}

/** 畸形响应 / 响应对象结构不符协议的统一构造。 */
export function invalidResponse(detail: string): A2AClientError {
  return new A2AClientError("invalid_response", `malformed A2A response: ${detail}`);
}
