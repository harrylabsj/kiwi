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
 * kiwi-buyer-mcp 薄 facade 的 MCP 协议类型（战略 v2.5 §6.1 / §6.2）。
 *
 * 手写 stdio JSON-RPC 2.0 最小 MCP 实现（零新运行时依赖）：只实现 initialize
 * 握手、notifications/initialized、tools/list、tools/call 与 JSON-RPC 错误面。
 * 其余 MCP 能力（resources/prompts/sampling/roots）不在 v0.1 范围内——严格
 * fail-closed，遇到未实现方法返回 METHOD_NOT_FOUND。
 *
 * 对外只暴露 5—7 个高层 Sourcing Tools，不暴露 KNP 底层消息、不复制 UCP 的
 * Catalog/Checkout primitives（§6.1）。每个写 tool 绑定 idempotency_key 并返回
 * 稳定 task_id / candidate_id / approval_id / agreement_id（§6.2）。
 */

/** MCP 协议版本：本 server 接受并回显的标准版本（v0.1）。Hermes v0.20.1 协商 2025-11-25。 */
export const MCP_PROTOCOL_VERSIONS = ["2024-11-05", "2025-06-18", "2025-11-25"] as const;

/** MCP 错误码（JSON-RPC 标准 + MCP 扩展）。 */
export const MCP_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_INITIALIZED: -32002,
  TOOL_NOT_FOUND: -32002,
} as const;

export type McpJsonRpcVersion = "2.0";

export interface JsonRpcRequest {
  jsonrpc: McpJsonRpcVersion;
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: McpJsonRpcVersion;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP initialize 请求参数（§6.1 version negotiation）。 */
export interface McpInitializeParams {
  protocolVersion: string;
  capabilities?: Record<string, unknown>;
  clientInfo?: { name: string; version?: string };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: { tools: { listChanged: boolean } };
  serverInfo: { name: string; version: string };
}

export interface McpListToolsResult {
  tools: McpTool[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpCallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** 一个高层 Kiwi Sourcing Tool 的声明（§6.1 词表）。 */
export interface KiwiToolDefinition {
  name: string;
  description: string;
  /** 输入 JSON Schema（2020-12，自包含）。 */
  inputSchema: Record<string, unknown>;
  handle(args: Record<string, unknown>): Promise<McpCallToolResult>;
}

/** 顶层 Kiwi Sourcing Tool 词表（单一来源，§6.1）。 */
export const KIWI_SOURCING_TOOLS = [
  "kiwi_search",
  "kiwi_request_quotes",
  "kiwi_get_task",
  "kiwi_negotiate",
  "kiwi_accept_agreement",
  "kiwi_get_agreement",
  "kiwi_handoff",
  "kiwi_approve",
  "kiwi_reject",
] as const;
export type KiwiSourcingToolName = (typeof KIWI_SOURCING_TOOLS)[number];
