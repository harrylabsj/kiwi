/**
 * 本机适配器 MCP 客户端：固定实例 + WorkBuddy 专用头。
 *
 * 不跟随重定向、不记录 session id/token/响应正文；只调用固定实例的 `/mcp`。
 * 运营查询与对话都经此客户端，目标不能由模型输入改变。
 */

import {
  assertFixedBindingUrl,
  type FixedInstanceBinding,
} from "./binding.js";

const MAX_BYTES = 256 * 1024;

export interface AdapterToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function parseMcpPayload(contentType: string, buffer: Buffer): unknown {
  const text = buffer.toString("utf8");
  if (contentType.toLowerCase().includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      try {
        return JSON.parse(data) as unknown;
      } catch {
        // 忽略损坏事件
      }
    }
    return undefined;
  }
  if (contentType.toLowerCase().includes("application/json") || text.trim().startsWith("{")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function readLimited(response: Response): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error("MCP 响应过大");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

export class FixedInstanceMcpClient {
  private readonly binding: FixedInstanceBinding;
  private readonly token: string;
  private readonly shareCode: string;
  private readonly fetchImpl: typeof fetch;
  private sessionId = "";
  private nextId = 1;

  constructor(options: {
    binding: FixedInstanceBinding;
    accessToken: string;
    shareCode: string;
    fetchImpl?: typeof fetch;
  }) {
    if (options.accessToken === "") throw new Error("MCP 客户端缺 access token");
    this.binding = options.binding;
    this.token = options.accessToken;
    this.shareCode = options.shareCode;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async initialize(): Promise<void> {
    const result = await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "kiwi-workbuddy-adapter", version: "0.1.0" },
    });
    if (result.sessionId !== "") this.sessionId = result.sessionId;
    await this.rpc("notifications/initialized", {}, true);
  }

  async listTools(): Promise<AdapterToolDefinition[]> {
    const result = await this.rpc("tools/list", {});
    const tools = (result.payload as { result?: { tools?: unknown } } | undefined)?.result?.tools;
    if (!Array.isArray(tools)) return [];
    return tools
      .filter((tool): tool is Record<string, unknown> => tool !== null && typeof tool === "object")
      .map((tool) => ({
        name: typeof tool.name === "string" ? tool.name : "",
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.inputSchema !== null && typeof tool.inputSchema === "object"
          ? { inputSchema: tool.inputSchema as Record<string, unknown> }
          : {}),
      }))
      .filter((tool) => tool.name !== "");
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; structuredContent?: Record<string, unknown>; isError: boolean }> {
    const result = await this.rpc("tools/call", { name, arguments: args });
    const record = result.payload as
      | {
          result?: {
            content?: Array<{ type?: string; text?: string }>;
            structuredContent?: Record<string, unknown>;
            isError?: boolean;
          };
        }
      | undefined;
    const content = Array.isArray(record?.result?.content) ? record.result.content : [];
    const text = content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text ?? "")
      .join("\n");
    return {
      text,
      ...(record?.result?.structuredContent !== undefined
        ? { structuredContent: record.result.structuredContent }
        : {}),
      isError: record?.result?.isError === true,
    };
  }

  private async rpc(method: string, params: Record<string, unknown>, notification = false) {
    assertFixedBindingUrl(this.binding, this.binding.mcpUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.binding.mcpUrl, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-kiwi-authorization": `Bearer ${this.token}`,
            ...(this.shareCode !== "" ? { "x-share-code": this.shareCode } : {}),
            ...(this.sessionId !== "" ? { "mcp-session-id": this.sessionId } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            ...(notification ? {} : { id: this.nextId++ }),
            method,
            params,
          }),
        });
      } catch {
        throw new Error("MCP 实例不可达或超时");
      }
      if (response.status >= 300 && response.status < 400) {
        throw new Error("MCP 拒绝重定向");
      }
      const buffer = await readLimited(response);
      if (response.status === 401 || response.status === 403) {
        throw new Error("MCP 认证失败或授权已撤销");
      }
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
      const payload = parseMcpPayload(
        String(response.headers.get("content-type") ?? ""),
        buffer,
      );
      return {
        payload,
        sessionId: response.headers.get("mcp-session-id") ?? "",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
