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
 * 把多个带 scope 的工具束合成一个（入口同时提供第 0 版目录工具与第 1 版
 * 实例工具）。
 *
 * 语义：
 *   - `listTools`：按名去重后拼接（同名工具以先出现的束为准）；
 *   - `call`：按工具名路由到提供它的束；都没有则返回可解释错误；
 *   - 空数组返回 `undefined`（调用方据此对调用方隐藏全部工具）。
 */

import type { ScopedMcpTools } from "../mcp/merchant-server.js";
import type { MerchantMcpCallResult, MerchantMcpToolDefinition } from "../mcp/merchant-tools.js";

export function combineScopedTools(
  bundles: Array<ScopedMcpTools | undefined>,
): ScopedMcpTools | undefined {
  const active = bundles.filter((bundle): bundle is ScopedMcpTools => bundle !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    scopes: string[] | undefined,
  ): Promise<MerchantMcpCallResult | undefined> => {
    for (const bundle of active) {
      const tools = await bundle.listTools(scopes);
      if (tools.some((tool) => tool.name === name)) {
        return await bundle.call(name, args, scopes);
      }
    }
    return undefined;
  };

  return {
    listTools: async (scopes) => {
      const merged: MerchantMcpToolDefinition[] = [];
      const seen = new Set<string>();
      for (const bundle of active) {
        for (const tool of await bundle.listTools(scopes)) {
          if (seen.has(tool.name)) continue;
          seen.add(tool.name);
          merged.push(tool);
        }
      }
      return merged;
    },
    call: async (name, args, scopes) => {
      const result = await callTool(name, args, scopes);
      if (result !== undefined) return result;
      return {
        content: [{ type: "text", text: `未提供工具 ${name}（可能未授权、或该商家尚未连接实例）` }],
        isError: true,
      };
    },
  };
}
