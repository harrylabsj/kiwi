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
 * JSON-RPC 2.0 帧（A2A JSONRPC binding，§43）。请求构造 + 响应解析。
 *
 * 响应解析 fail-closed：非对象 / jsonrpc 非 "2.0" / id 不匹配 / result 与 error
 * 非二选一 / error 结构非法，全部抛 invalid_response。
 */

import { A2AClientError, invalidResponse } from "./error.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcParseResult = { result: unknown } | { error: JsonRpcError };

export function buildJsonRpcRequest(method: string, params: unknown, id: string): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

function requireJsonRpcError(value: unknown): JsonRpcError {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse("error must be an object");
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.code !== "number" || typeof obj.message !== "string") {
    throw invalidResponse("error must have numeric code and string message");
  }
  const parsed: JsonRpcError = { code: obj.code, message: obj.message };
  if (obj.data !== undefined) parsed.data = obj.data;
  return parsed;
}

/**
 * 解析 JSON-RPC 响应。返回 discriminated union；`error` 分支由调用方决定是否
 * 抛出（client.request 会抛 jsonrpc_error）。
 */
export function parseJsonRpcResponse(raw: unknown, requestId: string): JsonRpcParseResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidResponse("response must be a JSON-RPC object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0") {
    throw invalidResponse('jsonrpc must be "2.0"');
  }
  if (typeof obj.id !== "string" || obj.id !== requestId) {
    throw invalidResponse("response id does not match request id");
  }
  const hasResult = "result" in obj;
  const hasError = "error" in obj;
  if (hasResult === hasError) {
    throw invalidResponse("response must have exactly one of result/error");
  }
  if (hasError) {
    return { error: requireJsonRpcError(obj.error) };
  }
  return { result: obj.result };
}

/** 非 2xx + 合法 JSON-RPC error 体的识别（HTTP 错误携带 JSON-RPC error 的兼容路径）。 */
export function tryParseJsonRpcError(raw: unknown, requestId: string): JsonRpcError | undefined {
  try {
    const parsed = parseJsonRpcResponse(raw, requestId);
    return "error" in parsed ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/** 断言请求是合法 JSON-RPC 对象（本地构造侧校验）。 */
export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.jsonrpc === "2.0" &&
    // JSON-RPC 规范允许 string 或 number id（issue 10：官方 SDK 用数字 id）。
    (typeof obj.id === "string" || typeof obj.id === "number") &&
    typeof obj.method === "string" &&
    ("params" in obj ? obj.params !== undefined : true)
  );
}

export { A2AClientError };
