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
 * kiwi-buyer-mcp stdio server（战略 v2.5 §6.1）。
 *
 * 最小 JSON-RPC 2.0 MCP 实现：initialize 握手（version negotiation，fail-closed）、
 * notifications/initialized、tools/list、tools/call；未实现方法一律
 * METHOD_NOT_FOUND；初始化前调用 tools/* 返回 SERVER_NOT_INITIALIZED。
 * 一行一行读 stdin（readline），每行一个 JSON-RPC 消息，响应写 stdout 换行分隔。
 *
 * 本 server 不持有任何商业状态——状态唯一权威在 KiwiBuyerService 的持久 store。
 * 输入/输出均投影，不保存第二套状态机（§6.2）。
 */

import { createInterface } from "node:readline";
import { MCP_ERROR, type JsonRpcRequest, type JsonRpcResponse, type McpCallToolResult, type McpTool } from "./types.js";
import { MCP_PROTOCOL_VERSIONS, type McpInitializeResult, type McpListToolsResult } from "./types.js";
import { McpError } from "../buyer-core/errors.js";
import type { KiwiToolDefinition } from "./types.js";

export interface McpServerOptions {
  tools: KiwiToolDefinition[];
  serverInfo: { name: string; version: string };
}

export class McpServer {
  private readonly tools: Map<string, KiwiToolDefinition>;
  private readonly serverInfo: { name: string; version: string };
  private initialized = false;
  private initRequested = false;

  constructor(options: McpServerOptions) {
    this.tools = new Map(options.tools.map((t) => [t.name, t]));
    this.serverInfo = options.serverInfo;
  }

  /** 处理单个 JSON-RPC 消息，返回响应（notification 返回 undefined）。 */
  async handleMessage(raw: string): Promise<JsonRpcResponse | undefined> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return this.error(null, MCP_ERROR.PARSE_ERROR, "parse error: not valid JSON");
    }
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return this.error(request.id, MCP_ERROR.INVALID_REQUEST, "invalid request: expected jsonrpc 2.0 request");
    }

    try {
      switch (request.method) {
        case "initialize":
          return await this.handleInitialize(request);
        case "notifications/initialized":
          if (this.initRequested) this.initialized = true;
          return undefined;
        case "tools/list":
          return this.requireInit(request, () => this.handleListTools(request));
        case "tools/call":
          return this.requireInit(request, () => this.handleCallTool(request));
        default:
          return this.error(request.id, MCP_ERROR.METHOD_NOT_FOUND, `method not found: ${request.method}`);
      }
    } catch (error) {
      if (error instanceof McpError) {
        return this.error(request.id, error.toJsonRpc().code, error.message, error.detail);
      }
      return this.error(
        request.id,
        MCP_ERROR.INTERNAL_ERROR,
        `internal error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async requireInit(
    request: JsonRpcRequest,
    fn: () => Promise<JsonRpcResponse> | JsonRpcResponse,
  ): Promise<JsonRpcResponse> {
    if (!this.initialized) {
      return this.error(request.id, MCP_ERROR.SERVER_NOT_INITIALIZED, "server not initialized: call initialize first");
    }
    return fn();
  }

  private async handleInitialize(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = (request.params ?? {}) as { protocolVersion?: string };
    const requested = params.protocolVersion;
    if (typeof requested !== "string" || !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
      // version negotiation fail-closed：未知版本拒绝（§6.10 兼容矩阵 fail closed）。
      return this.error(
        request.id,
        MCP_ERROR.INVALID_PARAMS,
        `unsupported MCP protocol version: ${String(requested)}`,
      );
    }
    // 规范：initialize 只协商版本；随后客户端发 notifications/initialized 后才允许
    // tools/*。因此这里只标记 initRequested，不放行工具调用。
    this.initRequested = true;
    const result: McpInitializeResult = {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.serverInfo,
    };
    return this.result(request.id, result);
  }

  private handleListTools(request: JsonRpcRequest): JsonRpcResponse {
    const result: McpListToolsResult = {
      tools: [...this.tools.values()].map(
        (t): McpTool => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }),
      ),
    };
    return this.result(request.id, result);
  }

  private async handleCallTool(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== "string") {
      return this.error(request.id, MCP_ERROR.INVALID_PARAMS, "tools/call requires params.name");
    }
    const tool = this.tools.get(params.name);
    if (tool === undefined) {
      return this.error(request.id, MCP_ERROR.TOOL_NOT_FOUND, `tool not found: ${params.name}`);
    }
    const args =
      params.arguments !== undefined && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};
    const toolResult: McpCallToolResult = await tool.handle(args);
    return this.result(request.id, toolResult);
  }

  private result(id: number | string | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  private error(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message, data } };
  }

  /** 阻塞运行 stdio 循环（CLI 入口）。逐行读 stdin，逐行写 stdout。 */
  async serve(): Promise<void> {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      if (line.trim() === "") continue;
      const response = await this.handleMessage(line);
      if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}
