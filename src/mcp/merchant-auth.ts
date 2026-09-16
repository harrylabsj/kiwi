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
 * Merchant MCP Server 入站认证（WorkBuddy Buddy 应用开发计划 阶段二）。
 *
 * 兼容「用户自填 Token」模式：静态 Bearer token，恒定时间比较。
 * 正式 WorkBuddy 连接器使用 OAuth；此校验器保留给显式 token 过渡包。
 * 校验器接口（MerchantMcpAuthVerifier）让两种方案共用 server 传输层。
 *
 * Token 来源与 A2A 一致的安全惯例：profile 只存环境变量名
 * （merchant_mcp.token_env，缺省 KIWI_MERCHANT_MCP_TOKEN），secret 值绝不写
 * profile / 日志 / 返回值。
 *
 * fail-closed（对齐 A2A 公网广告形态的守卫语义）：
 *   - 监听非 loopback 地址且未配置校验器 → 拒绝启动；
 *   - loopback 监听且未配置校验器 → 允许启动，但返回警告文案（调用方打 stderr）。
 */

import { timingSafeEqual } from "node:crypto";

import { isLoopbackHost } from "../a2a/client/url-policy.js";

/** 缺省 token 环境变量名（profile merchant_mcp.token_env 可覆盖）。 */
export const DEFAULT_MERCHANT_MCP_TOKEN_ENV = "KIWI_MERCHANT_MCP_TOKEN";

export interface MerchantMcpAuthContext {
  /** 原始 Authorization 头（未设置时为 undefined）。 */
  authorizationHeader?: string;
}

export type MerchantMcpAuthResult =
  | {
      ok: true;
      /** OAuth 校验通过时携带的授权上下文（principal/merchant/scope；V2 阶段一）。 */
      authorization?: {
        principal_id: string;
        merchant_id: string;
        scopes: string[];
      };
    }
  | { ok: false; reason: string };

/** MCP 入站校验器接口（Bearer 为当前唯一实现；OAuth 校验器后续叠加）。 */
export interface MerchantMcpAuthVerifier {
  readonly name: string;
  verify(ctx: MerchantMcpAuthContext): MerchantMcpAuthResult;
}

/** 常量时间 token 比较：长度恒等预检 + timingSafeEqual（与
 *  a2a/server/auth.ts tokenEquals、agent/memory/vault.ts fingerprintEquals
 *  同一模式——逐字节短路会构成时序侧信道）。 */
function bearerTokenEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 静态 Bearer token 校验（`Authorization: Bearer <token>`）。 */
export class StaticBearerTokenVerifier implements MerchantMcpAuthVerifier {
  readonly name = "static-bearer";
  private readonly token: string;

  constructor(token: string) {
    if (token.length === 0) {
      throw new Error("StaticBearerTokenVerifier requires a non-empty token");
    }
    this.token = token;
  }

  verify(ctx: MerchantMcpAuthContext): MerchantMcpAuthResult {
    const header = ctx.authorizationHeader;
    if (header === undefined || header === "") {
      return { ok: false, reason: "missing Authorization header" };
    }
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) {
      return { ok: false, reason: "Authorization header is not a bearer token" };
    }
    if (!bearerTokenEquals(match[1] ?? "", this.token)) {
      return { ok: false, reason: "invalid bearer token" };
    }
    return { ok: true };
  }
}

/**
 * 从环境变量解析 Bearer 校验器。tokenEnv 缺省 DEFAULT_MERCHANT_MCP_TOKEN_ENV；
 * 环境变量未设置或为空 → undefined（由 fail-closed 判定决定是否允许启动）。
 */
export function resolveMerchantMcpVerifier(
  tokenEnv?: string,
  env: Record<string, string | undefined> = process.env,
): StaticBearerTokenVerifier | undefined {
  const envName = tokenEnv ?? DEFAULT_MERCHANT_MCP_TOKEN_ENV;
  const token = (env[envName] ?? "").trim();
  if (token === "") return undefined;
  return new StaticBearerTokenVerifier(token);
}

/**
 * 启动前 fail-closed 判定。
 * - 非 loopback host + 无校验器 → 抛错（拒绝启动）；
 * - loopback host + 无校验器 → 返回警告文案（允许启动，调用方打 stderr）；
 * - 有校验器 → undefined（无警告）。
 */
export function assertMerchantMcpAuthPolicy(
  host: string,
  verifier: MerchantMcpAuthVerifier | undefined,
): string | undefined {
  if (verifier !== undefined) return undefined;
  if (!isLoopbackHost(host)) {
    throw new Error(
      `merchant MCP server 监听非 loopback 地址（${host}）但未配置认证 token，` +
        `fail-closed 拒绝启动：请设置 ${DEFAULT_MERCHANT_MCP_TOKEN_ENV} 环境变量` +
        "（或 profile merchant_mcp.token_env 指向的环境变量），或改用 127.0.0.1 监听。",
    );
  }
  return (
    `⚠️ [kiwi] merchant MCP server 未配置认证 token（${DEFAULT_MERCHANT_MCP_TOKEN_ENV}），` +
    `仅接受 ${host} 上的本地连接；公网暴露前务必配置 Bearer token。`
  );
}
