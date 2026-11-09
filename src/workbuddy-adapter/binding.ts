/**
 * WorkBuddy Kiwi 商家本机适配器：固定实例绑定。
 *
 * 目标由部署/配置显式给出，运行期不可由模型、工具参数或远端响应改写。
 * 只允许 HTTPS（开发 loopback 可 http）且 MCP 路径恰为 `/mcp`，禁止
 * userinfo/query/fragment；issuer 必须与实例同源。
 */

import { createHash } from "node:crypto";

import { isLoopbackHost } from "../a2a/client/url-policy.js";

export interface FixedInstanceBinding {
  readonly instanceOrigin: string;
  readonly mcpUrl: string;
  readonly issuer: string;
}

function safeUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} URL 非法`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${label} 不得包含 userinfo`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`${label} 必须为 HTTPS（开发 loopback 可 http）`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`${label} 不得包含查询串或片段`);
  }
  return url;
}

export function createFixedInstanceBinding(input: {
  instanceUrl: string;
  issuer?: string;
}): FixedInstanceBinding {
  const mcp = safeUrl(input.instanceUrl, "实例 MCP");
  if (mcp.pathname !== "/mcp") throw new Error("实例 MCP 路径必须恰为 /mcp");
  const issuer = safeUrl(input.issuer ?? mcp.origin, "OAuth issuer");
  if (issuer.origin !== mcp.origin) throw new Error("OAuth issuer 必须与实例同源");
  if (issuer.pathname !== "/" && issuer.pathname !== "") {
    throw new Error("OAuth issuer 必须为 origin（不得带路径）");
  }
  return Object.freeze({
    instanceOrigin: mcp.origin,
    mcpUrl: mcp.toString(),
    issuer: issuer.origin,
  });
}

export function bindingFingerprint(binding: FixedInstanceBinding): string {
  return createHash("sha256")
    .update(`${binding.instanceOrigin}\u0000${binding.mcpUrl}\u0000${binding.issuer}`)
    .digest("hex");
}

/** 任何运行期目标都必须与固定绑定精确一致；不接受模型/远端传入的新 URL。 */
export function assertFixedBindingUrl(binding: FixedInstanceBinding, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("目标 URL 非法");
  }
  if (url.toString() !== binding.mcpUrl && url.origin !== binding.issuer) {
    throw new Error("目标 URL 不属于固定实例绑定");
  }
  if (url.toString() !== binding.mcpUrl && url.pathname !== "/") {
    throw new Error("目标 URL 不属于固定实例绑定");
  }
}
