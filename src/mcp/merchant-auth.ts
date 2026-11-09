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
import { matchesPairedCredential } from "../auth/merchant-pairing.js";

import { isLoopbackHost } from "../a2a/client/url-policy.js";

/** 缺省 token 环境变量名（profile merchant_mcp.token_env 可覆盖）。 */
export const DEFAULT_MERCHANT_MCP_TOKEN_ENV = "KIWI_MERCHANT_MCP_TOKEN";

export interface MerchantMcpAuthContext {
  /** 原始 Authorization 头（未设置时为 undefined）。 */
  authorizationHeader?: string;
  /**
   * node:http 的原始头对数组（`req.rawHeaders`）。WorkBuddy 专用头模式用它
   * 区分「缺失 / 单字段 / 重复字段 / 逗号合并」；其他模式忽略。
   */
  rawHeaders?: readonly string[];
}

/** WorkBuddy 实例专用认证头（平台实测可单字段透传；标准 Authorization 会被注入）。 */
export const WORKBUDDY_AUTH_HEADER = "x-kiwi-authorization";

/** 专用头长度上限（只允许一个 OAuth Bearer token）。 */
export const WORKBUDDY_AUTH_HEADER_MAX_BYTES = 8 * 1024;

/** 控制字符按码点判定，避免 no-control-regex；语义保持 C0 + DEL 拒绝。 */
function containsControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
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
 * 配对凭据校验器（设计 §8.4 第二期，最小授权）：接受由**本实例**签发、
 * 网关持有的那份凭据（`paired-credential.json`，只存摘要，逐请求恒定时间比较）。
 * 与静态令牌并存——静态令牌是运维自己的入口，配对凭据是可随时轮换的那份。
 */
export class PairedCredentialVerifier implements MerchantMcpAuthVerifier {
  readonly name = "paired-credential";
  constructor(private readonly dir: string) {}

  verify(ctx: MerchantMcpAuthContext): MerchantMcpAuthResult {
    const header = ctx.authorizationHeader;
    if (header === undefined || header === "") {
      return { ok: false, reason: "missing Authorization header" };
    }
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) {
      return { ok: false, reason: "Authorization header is not a bearer token" };
    }
    if (!matchesPairedCredential(this.dir, match[1] ?? "")) {
      return { ok: false, reason: "invalid paired credential" };
    }
    // 与静态令牌同语义：不带 scope（undefined = 全量），工具级门禁由网关侧
    // 按**用户 OAuth 令牌**的 scope 逐次执行（mcp-proxy），实例不重复判定。
    return { ok: true };
  }
}

/**
 * WorkBuddy 实例专用头模式（显式 opt-in）。
 *
 * 平台隔离实测：单字段 `X-Kiwi-Authorization` 可短/长 GET/POST 透传；客户端
 * 重复字段到源站会变成 1 个，标准 Authorization 会被平台注入/改写。该证据
 * 只属于隔离应用，真实 Linkluck/平台全局行为未证明。
 *
 * 因此本校验器：
 *   - 只读取 `X-Kiwi-Authorization`，**完全忽略** `Authorization`，绝不回退；
 *   - 要求原始头恰好出现 1 次；缺失、重复、逗号合并、含控制字符、超长、
 *     非严格 `Bearer <token>` 一律拒绝；
 *   - 通过后只把专用头里的 token 交给原 OAuth 校验器，scope/merchant/
 *     revocation 校验保持原样；
 *   - 未开启该模式的实例仍使用标准 OAuth 校验器，行为不变。
 */
export class WorkBuddyHeaderAuthVerifier implements MerchantMcpAuthVerifier {
  readonly name = "workbuddy-header-oauth";
  constructor(private readonly inner: MerchantMcpAuthVerifier) {}

  verify(ctx: MerchantMcpAuthContext): MerchantMcpAuthResult {
    if (ctx.rawHeaders === undefined) {
      return { ok: false, reason: "WorkBuddy header context missing" };
    }
    const values: string[] = [];
    for (let i = 0; i + 1 < ctx.rawHeaders.length; i += 2) {
      const name = String(ctx.rawHeaders[i] ?? "").toLowerCase();
      if (name === WORKBUDDY_AUTH_HEADER) values.push(String(ctx.rawHeaders[i + 1] ?? ""));
    }
    if (values.length === 0) {
      return { ok: false, reason: "missing WorkBuddy authorization header" };
    }
    if (values.length !== 1) {
      return { ok: false, reason: "duplicate WorkBuddy authorization header" };
    }
    const raw = values[0] ?? "";
    if (
      raw.length === 0 ||
      raw.length > WORKBUDDY_AUTH_HEADER_MAX_BYTES ||
      raw.includes(",") ||
      containsControlChar(raw)
    ) {
      return { ok: false, reason: "invalid WorkBuddy authorization header" };
    }
    // 只接受单空格 Bearer；token 字符集与 OAuth bearer token 一致，拒绝多值/
    // 多余空白/协议拼接。
    const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/i.exec(raw.trim());
    if (match === null) {
      return { ok: false, reason: "invalid WorkBuddy authorization header" };
    }
    const token = match[1] ?? "";
    if (token === "") {
      return { ok: false, reason: "invalid WorkBuddy authorization header" };
    }
    // 只把专用头 token 交给原 OAuth 校验；不传 authorizationHeader，避免
    // 任何内部实现误用平台注入的标准头。
    return this.inner.verify({ authorizationHeader: `Bearer ${token}` });
  }
}

/**
 * 组合校验器：任一子校验器通过即通过（静态令牌 + 配对凭据并存）。
 * 全部失败时返回最后一个原因，不回显任何凭据内容。
 */
export class CompositeMerchantMcpVerifier implements MerchantMcpAuthVerifier {
  readonly name = "composite";
  constructor(private readonly verifiers: MerchantMcpAuthVerifier[]) {}

  verify(ctx: MerchantMcpAuthContext): MerchantMcpAuthResult {
    let last: MerchantMcpAuthResult = { ok: false, reason: "no verifier configured" };
    for (const verifier of this.verifiers) {
      const result = verifier.verify(ctx);
      if (result.ok) return result;
      last = result;
    }
    return last;
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
