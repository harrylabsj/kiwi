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
 * 第 1 版实例工具：把已配对商家实例的 `kiwi_merchant_*` 工具暴露给该商家。
 *
 * 路由与隔离：
 *   - 工具列表**从实例现取**（`tools/list` 经 mcp-proxy 转发并按 scope 过滤），
 *     网关不硬编码工具清单，避免与实例版本漂移；
 *   - 调用经 `proxyTenantMcp` 转发，租户仍由已验证 token 的 `merchant_id` 决定；
 *   - 未配对实例、内部凭据缺失或实例不可用时，第 1 版工具**不出现/明确报错**，
 *     第 0 版目录能力不受影响（发布计划 §4 第 1 条）。
 *
 * 缓存的只是工具清单（按商家 60 秒），不含任何业务数据；凭据从不进入缓存。
 */

import type { MerchantAuthorization } from "../auth/merchant-authorization.js";
import type { ScopedMcpTools } from "../mcp/merchant-server.js";
import type { MerchantMcpCallResult, MerchantMcpToolDefinition } from "../mcp/merchant-tools.js";
import { proxyTenantMcp } from "./mcp-proxy.js";
import { TenantBackendError, TenantBackendRegistry } from "./tenant-registry.js";

const DEFAULT_TOOL_CACHE_TTL_MS = 60_000;

/** 工具清单缓存（每商家一条；TTL 内复用，避免每次 tools/list 都打实例）。 */
export class InstanceToolListCache {
  private readonly entries = new Map<
    string,
    { tools: MerchantMcpToolDefinition[]; expiresAt: number }
  >();

  constructor(private readonly ttlMs: number = DEFAULT_TOOL_CACHE_TTL_MS) {}

  get(merchantId: string, nowMs: number): MerchantMcpToolDefinition[] | undefined {
    const entry = this.entries.get(merchantId);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= nowMs) {
      this.entries.delete(merchantId);
      return undefined;
    }
    return entry.tools;
  }

  set(merchantId: string, tools: MerchantMcpToolDefinition[], nowMs: number): void {
    this.entries.set(merchantId, { tools, expiresAt: nowMs + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface InstanceToolDeps {
  registry: TenantBackendRegistry;
  authorization: MerchantAuthorization;
  fetchImpl?: typeof fetch;
  cache?: InstanceToolListCache;
  now?: () => number;
}

function fail(message: string): MerchantMcpCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** 解析实例返回的 tools/list 结果（形状不符的条目直接丢弃，不编造工具）。 */
export function parseToolList(payload: unknown): MerchantMcpToolDefinition[] {
  if (payload === null || typeof payload !== "object") return [];
  const result = (payload as { result?: unknown }).result;
  if (result === null || typeof result !== "object") return [];
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  const parsed: MerchantMcpToolDefinition[] = [];
  for (const element of tools) {
    if (element === null || typeof element !== "object") continue;
    const record = element as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (name === "") continue;
    parsed.push({
      name,
      description: typeof record.description === "string" ? record.description : "",
      inputSchema:
        record.inputSchema !== null && typeof record.inputSchema === "object"
          ? (record.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} },
    });
  }
  return parsed;
}

/** 解析实例返回的 tools/call 结果 → 网关的调用结果形状。 */
export function parseCallResult(payload: unknown): MerchantMcpCallResult {
  if (payload === null || typeof payload !== "object") {
    return fail("商家实例返回了无法解析的结果");
  }
  const record = payload as Record<string, unknown>;
  if (record.error !== undefined && record.error !== null) {
    const message =
      typeof record.error === "object" && record.error !== null
        ? String((record.error as { message?: unknown }).message ?? "未知错误")
        : String(record.error);
    return fail(`商家实例返回错误：${message}`);
  }
  const result = record.result;
  if (result === null || typeof result !== "object") {
    return fail("商家实例未返回工具结果");
  }
  const content = (result as { content?: unknown }).content;
  const textItems: Array<{ type: "text"; text: string }> = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item === null || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (entry.type === "text" && typeof entry.text === "string") {
        textItems.push({ type: "text", text: entry.text });
      } else {
        textItems.push({ type: "text", text: JSON.stringify(entry) });
      }
    }
  }
  const isError = (result as { isError?: unknown }).isError === true;
  const outcome: MerchantMcpCallResult = {
    content: textItems.length > 0 ? textItems : [{ type: "text", text: "{}" }],
    ...(isError ? { isError: true as const } : {}),
  };
  return outcome;
}

/**
 * 构建绑定到该商家实例的工具束。
 *
 * 未配对实例（注册表无该 merchant_id）或内部凭据不可用时返回 `undefined`：
 * 第 1 版工具对调用方**不可见**，第 0 版目录工具与目录发布继续可用。
 */
export function buildInstanceTools(deps: InstanceToolDeps): ScopedMcpTools | undefined {
  try {
    deps.registry.resolve(deps.authorization);
  } catch (err) {
    if (err instanceof TenantBackendError) return undefined;
    throw err;
  }
  const merchantId = deps.authorization.merchant_id;
  const cache = deps.cache ?? new InstanceToolListCache();
  const now = deps.now ?? (() => Date.now());

  const rpc = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: true; payload: unknown } | { ok: false; message: string }> => {
    const response = await proxyTenantMcp(
      {
        method: "POST",
        authorization: deps.authorization,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      },
      deps.registry,
      deps.fetchImpl ?? fetch,
    );
    let payload: unknown;
    try {
      payload = JSON.parse(response.body) as unknown;
    } catch {
      return { ok: false, message: "商家实例返回了无法解析的响应" };
    }
    if (response.status >= 400) {
      const code =
        payload !== null &&
        typeof payload === "object" &&
        typeof (payload as { error?: unknown }).error === "string"
          ? String((payload as { error: string }).error)
          : `HTTP ${response.status}`;
      return { ok: false, message: `商家实例暂不可用（${code}）` };
    }
    return { ok: true, payload };
  };

  return {
    listTools: async (_scopes) => {
      // 工具清单由实例现取，mcp-proxy 已按**令牌 scope** 过滤（与 tools/call
      // 同一道门禁）并按工具名 allowlist 收敛；这里不再二次过滤，避免两处
      // 规则漂移。缓存的是该令牌视角下的清单，TTL 60 秒。
      const cached = cache.get(merchantId, now());
      if (cached !== undefined) return cached;
      const result = await rpc("tools/list", {});
      if (!result.ok) return []; // 实例不可达：第 1 版工具不可见，第 0 版照常
      const tools = parseToolList(result.payload);
      if (tools.length > 0) cache.set(merchantId, tools, now());
      return tools;
    },
    call: async (name, args, _scopes) => {
      const cached = cache.get(merchantId, now());
      if (cached !== undefined && !cached.some((tool) => tool.name === name)) {
        return fail(`商家实例未提供工具 ${name}（或当前授权不含所需 scope）`);
      }
      const result = await rpc("tools/call", { name, arguments: args });
      if (!result.ok) return fail(result.message);
      return parseCallResult(result.payload);
    },
  };
}
