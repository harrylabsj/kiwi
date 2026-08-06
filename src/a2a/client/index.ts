/**
 * a2a/client — A2A JSONRPC binding 出站 client（WP1）。
 */

export { A2AClient } from "./client.js";
export type { A2AClientErrorKind, A2AClientErrorOptions } from "./error.js";
export { A2AClientError, invalidResponse } from "./error.js";
export {
  buildJsonRpcRequest,
  isJsonRpcRequest,
  parseJsonRpcResponse,
  tryParseJsonRpcError,
} from "./jsonrpc.js";
export type { JsonRpcError, JsonRpcParseResult, JsonRpcRequest } from "./jsonrpc.js";
export { parseTaskResult } from "./parse.js";
export type {
  A2AArtifact,
  A2AMessage,
  A2AClientOptions,
  A2APart,
  A2ATask,
  A2ATaskState,
  A2ATaskStatus,
} from "./types.js";
export { A2A_TASK_STATES } from "./types.js";
export {
  assertResolvableTargetUrl,
  assertSafeTargetUrl,
  isLoopbackHost,
  isReservedIpv4,
  isReservedIpv6,
} from "./url-policy.js";
export type { ResolvableTargetUrlOptions, SafeTargetUrlOptions } from "./url-policy.js";
