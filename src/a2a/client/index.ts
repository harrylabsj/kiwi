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
  serializeRfc8941String,
  serializeUcpAgentHeader,
  UCP_AGENT_HEADER,
  UCP_AGENT_PROFILE_MEMBER,
} from "../ucp-agent.js";
export {
  assertResolvableTargetUrl,
  assertSafeTargetUrl,
  isLoopbackHost,
  isReservedIpv4,
  isReservedIpv6,
} from "./url-policy.js";
export type { ResolvableTargetUrlOptions, SafeTargetUrlOptions } from "./url-policy.js";
