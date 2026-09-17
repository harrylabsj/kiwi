/**
 * 通用 Merchant MCP Gateway 的已认证请求分发层。
 *
 * 后端 URL 来自服务端 TenantBackendRegistry；模型参数无法更换租户。
 * 这只是网关的一层，不负责 WorkBuddy OAuth 登录、服务托管或公网监听。
 */

import type { MerchantAuthorization } from "../auth/merchant-authorization.js";
import { requiredScopeForTool } from "../mcp/merchant-tools.js";
import { TenantBackendError, TenantBackendRegistry } from "./tenant-registry.js";

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;
const ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "kiwi_merchant_list_products",
  "kiwi_merchant_get_product",
  "kiwi_merchant_get_inventory",
  "kiwi_merchant_list_a2a_negotiations",
  "kiwi_merchant_list_human_reviews",
  "kiwi_merchant_get_analytics",
  "kiwi_merchant_prepare_product_change",
  "kiwi_merchant_prepare_product_create",
  "kiwi_merchant_prepare_inventory_update",
  "kiwi_merchant_prepare_listing_change",
  "kiwi_merchant_prepare_review_resolve",
  "kiwi_merchant_prepare_policy_change",
  "kiwi_merchant_prepare_products_import",
  "kiwi_merchant_prepare_products_withdraw",
  "kiwi_merchant_get_operation",
]);

export interface McpGatewayRequest {
  method: "POST" | "GET";
  body?: string;
  accept?: string;
  protocolVersion?: string;
  authorization: MerchantAuthorization;
}

export interface McpGatewayResponse {
  status: number;
  contentType: string;
  body: string;
}

function json(status: number, body: unknown): McpGatewayResponse {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

function scopeAllowed(authorization: MerchantAuthorization, scope: string): boolean {
  return authorization.scopes.includes(scope);
}

function gateRpc(body: string, authorization: MerchantAuthorization): McpGatewayResponse | undefined {
  let rpc: unknown;
  try {
    rpc = JSON.parse(body) as unknown;
  } catch {
    return json(400, { error: "invalid_json", message: "MCP JSON-RPC 请求无效" });
  }
  if (rpc === null || typeof rpc !== "object" || Array.isArray(rpc)) {
    return json(400, { error: "invalid_request", message: "MCP JSON-RPC 请求无效" });
  }
  const request = rpc as Record<string, unknown>;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return json(400, { error: "invalid_request", message: "MCP JSON-RPC 请求无效" });
  }
  const method = request.method;
  if (["initialize", "notifications/initialized", "ping"].includes(method)) return undefined;
  if (["tools/list", "resources/list", "resources/read"].includes(method)) {
    if (!scopeAllowed(authorization, "merchant:read")) {
      return json(403, { error: "insufficient_scope", required_scope: "merchant:read" });
    }
    if (method === "resources/read") {
      const params = request.params as { uri?: unknown } | undefined;
      if (
        typeof params?.uri !== "string" ||
        !/^kiwi-merchant:\/\/presentation\/[a-z_]+$/.test(params.uri)
      ) {
        return json(403, { error: "resource_not_allowed" });
      }
    }
    return undefined;
  }
  if (method === "tools/call") {
    const params = request.params as { name?: unknown } | undefined;
    if (typeof params?.name !== "string" || !ALLOWED_TOOLS.has(params.name)) {
      return json(403, { error: "tool_not_allowed" });
    }
    const required = requiredScopeForTool(params.name);
    if (!scopeAllowed(authorization, required)) {
      return json(403, { error: "insufficient_scope", required_scope: required });
    }
    return undefined;
  }
  return json(403, { error: "method_not_allowed" });
}

async function readBoundedResponse(response: Response): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(next.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    reader.releaseLock();
  }
}

/**
 * 代理一个 MCP 请求。只支持 stateless JSON 响应；SSE/重定向 fail-closed。
 * WorkBuddy 真实联调前须验证它与客户端的 Accept/transport 协商一致。
 */
export async function proxyTenantMcp(
  request: McpGatewayRequest,
  registry: TenantBackendRegistry,
  fetchImpl: typeof fetch = fetch,
): Promise<McpGatewayResponse> {
  if (!request.authorization.merchant_id || !request.authorization.principal_id) {
    return json(401, { error: "unauthorized" });
  }
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }
  const body = request.body ?? "";
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    return json(413, { error: "request_too_large" });
  }
  const gated = gateRpc(body, request.authorization);
  if (gated !== undefined) return gated;

  // 只能在完成 OAuth 校验与 tool/scope gate 之后解析后端；不存在的商家没有
  // 任何“缺省商家”回退。Backend secret 不进入返回结果或错误正文。
  let backend;
  try {
    backend = registry.resolve(request.authorization);
  } catch (error) {
    if (error instanceof TenantBackendError) {
      return json(503, { error: error.code });
    }
    throw error;
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(backend.mcpUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${backend.bearerToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(request.protocolVersion !== undefined
          ? { "mcp-protocol-version": request.protocolVersion }
          : {}),
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return json(502, { error: "backend_unavailable" });
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return json(502, { error: "backend_redirect_rejected" });
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    return json(502, { error: "backend_content_type_unsupported" });
  }
  const contentLength = Number(upstream.headers.get("content-length") ?? "0");
  if (contentLength > MAX_RESPONSE_BYTES) return json(502, { error: "backend_response_too_large" });
  let responseBody: string | undefined;
  try {
    responseBody = await readBoundedResponse(upstream);
  } catch {
    return json(502, { error: "backend_response_unreadable" });
  }
  if (responseBody === undefined) {
    return json(502, { error: "backend_response_too_large" });
  }
  if (JSON.parse(body).method === "tools/list" && upstream.ok) {
    let payload: { result?: { tools?: Array<{ name?: string }> } };
    try {
      payload = JSON.parse(responseBody) as typeof payload;
    } catch {
      return json(502, { error: "backend_invalid_json" });
    }
    if (Array.isArray(payload.result?.tools)) {
      payload.result.tools = payload.result.tools.filter(
        (tool) =>
          typeof tool.name === "string" &&
          ALLOWED_TOOLS.has(tool.name) &&
          scopeAllowed(request.authorization, requiredScopeForTool(tool.name)),
      );
      return json(upstream.status, payload);
    }
  }
  return { status: upstream.status, contentType: "application/json", body: responseBody };
}
