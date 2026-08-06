/**
 * AuthVerifier 参考实现（接缝定义见 types.ts）。
 *
 * 三个参考实现：
 *   - NoneAuthVerifier           总是放行（显式可信网络 / 测试用；生产不推荐）。
 *   - StaticBearerAuthVerifier   校验 `Authorization: Bearer <token>`（静态 token；
 *                                WP5 会替换为完整身份方案）。
 *   - LoopbackOnlyAuthVerifier   只放行 loopback 对端 —— 未配置 verifier 时的
 *                                fail-closed 默认（§4.6）：一个本地-only Kiwi 的
 *                                A2A Server 不接受远端连接，直到显式配置认证。
 *
 * identity 语义：认证通过时返回调用方身份，pipeline 用它作为幂等主键
 * (sender_identity, message_id) 的 sender 侧（子规范 §20.1）。WP5 完整身份
 * 方案接入前，loopback 默认以 socket 地址为 identity，静态 bearer 以配置的
 * identity 为 identity（同一 token 的客户端共享一个幂等身份，message_id 不
 * 冲突即不会误判 —— 幂等冲突仅在同 message_id 异 digest 时触发）。
 */

import { isLoopbackHost } from "../client/url-policy.js";
import type { AuthContext, AuthResult, AuthVerifier } from "./types.js";

/** IPv4-mapped IPv6（::ffff:127.0.0.1）剥前缀后按内嵌 IPv4 判定 loopback。 */
function isLoopbackAddress(addr: string): boolean {
  const lower = addr.toLowerCase();
  const embedded = lower.startsWith("::ffff:") ? lower.slice("::ffff:".length) : lower;
  return isLoopbackHost(embedded);
}

/** 总是放行。identity 固定为 "anonymous"。 */
export class NoneAuthVerifier implements AuthVerifier {
  readonly name = "none";
  verify(_ctx: AuthContext): AuthResult {
    return { authenticated: true, identity: "anonymous" };
  }
}

/** 静态 Bearer token 校验。 */
export class StaticBearerAuthVerifier implements AuthVerifier {
  readonly name = "static-bearer";
  private readonly token: string;
  private readonly identity: string;

  constructor(token: string, options: { identity?: string } = {}) {
    if (token.length === 0) throw new Error("StaticBearerAuthVerifier requires a non-empty token");
    this.token = token;
    this.identity = options.identity ?? "bearer";
  }

  verify(ctx: AuthContext): AuthResult {
    const header = ctx.authorizationHeader;
    if (header === undefined || header === "") {
      return {
        authenticated: false,
        protocolCode: "authentication_required",
        reason: "missing Authorization header",
      };
    }
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) {
      return {
        authenticated: false,
        protocolCode: "authorization_failed",
        reason: "Authorization header is not a bearer token",
      };
    }
    const presented = match[1];
    if (presented !== this.token) {
      return {
        authenticated: false,
        protocolCode: "authorization_failed",
        reason: "invalid bearer token",
      };
    }
    return { authenticated: true, identity: this.identity };
  }
}

/** 只放行 loopback 对端（127.0.0.1 / ::1 / ::ffff:127.0.0.1）。 */
export class LoopbackOnlyAuthVerifier implements AuthVerifier {
  readonly name = "loopback-only";
  verify(ctx: AuthContext): AuthResult {
    const addr = ctx.remoteAddress;
    if (addr === undefined) {
      return {
        authenticated: false,
        protocolCode: "authorization_failed",
        reason: "no remote address",
      };
    }
    if (isLoopbackAddress(addr)) {
      return { authenticated: true, identity: `loopback:${addr}` };
    }
    return {
      authenticated: false,
      protocolCode: "authorization_failed",
      reason: "non-loopback peer rejected (fail-closed default)",
    };
  }
}

/** 未配置 verifier 时的 fail-closed 默认。 */
export function defaultAuthVerifier(): AuthVerifier {
  return new LoopbackOnlyAuthVerifier();
}
