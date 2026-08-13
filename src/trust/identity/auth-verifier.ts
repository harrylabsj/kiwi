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
 * HttpMessageSignatureVerifier —— AuthVerifier 接缝的完整身份方案（WP5）。
 *
 * 在 a2a/server 的认证接缝上落地：
 *   1. 请求带 HTTP Message Signature（RFC 9421）→ 验签（算法 / 时间窗口 /
 *      nonce / content-digest 完整性）；
 *   2. 验签通过的 keyid → 本地信任锚档案（profile：identity / organization /
 *      role / trustLevel）；
 *   3. TrustPolicy 按档案 trust level 决定是否强制 Agent Card JWS（§31：是否
 *      强制由策略决定，不是算法自带的）；
 *   4. 身份绑定冲突（宣称 profile vs 密钥档案）→ identity_rejected（§18）。
 *
 * 未签名请求：按 anonymousTrustLevel（默认 T0 UNKNOWN）评估策略。默认策略表
 * T0 不强制签名，因此匿名可访问；部署方想 fail-closed 可传
 * `requireHttpSignature: 恒真` 的策略或把 anonymousTrustLevel 设为 T1。
 *
 * 请求头约定（本实现自有的最小约定）：
 *   - `x-agent-card-jws`：请求携带的 Agent Card compact JWS（T2+ 强制时校验）；
 *   - `x-kiwi-claimed-identity`：可选 JSON `{ identity?, organization?, role? }`，
 *     用于身份绑定冲突检测。
 */

import type { AuthContext, AuthResult, AuthVerifier } from "../../a2a/server/types.js";
import { bindIdentity, type ClaimedIdentity, type VerifiedPrincipal } from "./identity-binding.js";
import type { KeyResolver } from "./keys.js";
import { verifyHttpMessageSignature } from "./message-signature.js";
import type { NonceStore } from "./nonce.js";
import { headerValue } from "./signature-base.js";
import {
  DEFAULT_TRUST_POLICY,
  type TrustLevel,
  type TrustPolicy,
} from "./trust-policy.js";

/** 请求携带 Agent Card JWS 的自定义头。 */
export const CARD_JWS_HEADER = "x-agent-card-jws";
/** 请求宣称身份的 JSON 头（untrusted，仅用于冲突检测）。 */
export const CLAIMED_IDENTITY_HEADER = "x-kiwi-claimed-identity";

export type CardJwsVerificationResult =
  | { ok: true; identity?: string; organization?: string; role?: "buyer" | "merchant" }
  | { ok: false; reason: string };

export interface HttpMessageSignatureVerifierOptions {
  /** keyid → 公钥 + 档案（本地信任锚 / JWKS 接缝）。 */
  resolver: KeyResolver;
  /** 信任策略；默认 DEFAULT_TRUST_POLICY（T0 匿名 / T1+ 强制签名 / T2+ 强制 JWS / T3 强制 nonce）。 */
  policy?: TrustPolicy;
  nonceStore?: NonceStore;
  /** 时钟（unix 秒）；默认 Date.now()/1000。 */
  now?: () => number;
  /** @target-uri 重建用 scheme；默认取 AuthContext.scheme 再回落此值。 */
  scheme?: "http" | "https";
  /** 未签名请求的 trust level；默认 T0。 */
  anonymousTrustLevel?: TrustLevel;
  /** 未签名（匿名放行）时的幂等身份；默认 "anonymous"。 */
  anonymousIdentity?: string;
  /** 验证请求携带的 Agent Card JWS；T2+ 时必需。 */
  verifyCardJws?: (jws: string) => CardJwsVerificationResult;
  /** created/expires 时钟偏差（秒）；默认 300。 */
  maxClockSkewSeconds?: number;
  /** 无 expires 的签名最大年龄（秒）；默认 900。 */
  maxSignatureAgeSeconds?: number;
  /**
   * 服务端广告主机（SNI/TLS 证书 host / 公开 base URL host）。审查 K-M8：
   * authority 由客户端 Host 头重建时，签名对 host A 可被重放到 host B——设置
   * 本字段后强制「声明的 authority 必须等于广告主机」，跨主机重放失效。缺省
   * （undefined）保持 Host 头行为（反代/本地拓扑下向后兼容）。
   */
  expectedAuthority?: string;
}

/**
 * 解析 `x-kiwi-claimed-identity` 头（JSON）。非 JSON / 形状非法返回 undefined
 * （untrusted 输入，解析失败不阻断——冲突检测只在有宣称值时生效）。
 */
export function parseClaimedIdentityHeader(
  headers: Record<string, string | string[] | undefined>,
): ClaimedIdentity | undefined {
  const value = headerValue(headers, CLAIMED_IDENTITY_HEADER);
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const out: ClaimedIdentity = {};
  if (typeof obj.identity === "string") out.identity = obj.identity;
  if (typeof obj.organization === "string") out.organization = obj.organization;
  if (obj.role === "buyer" || obj.role === "merchant") out.role = obj.role;
  return out;
}

/** 完整 HTTP Message Signature 入站验证器（AuthVerifier 实现）。 */
export class HttpMessageSignatureVerifier implements AuthVerifier {
  readonly name = "http-message-signature";
  private readonly resolver: KeyResolver;
  private readonly policy: TrustPolicy;
  private readonly nonceStore: NonceStore | undefined;
  private readonly now: () => number;
  private readonly scheme: "http" | "https";
  private readonly anonymousTrustLevel: TrustLevel;
  private readonly anonymousIdentity: string;
  private readonly verifyCardJws: ((jws: string) => CardJwsVerificationResult) | undefined;
  private readonly maxClockSkewSeconds: number;
  private readonly maxSignatureAgeSeconds: number;
  private readonly expectedAuthority: string | undefined;

  constructor(options: HttpMessageSignatureVerifierOptions) {
    this.resolver = options.resolver;
    this.policy = options.policy ?? DEFAULT_TRUST_POLICY;
    this.nonceStore = options.nonceStore;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.scheme = options.scheme ?? "http";
    this.anonymousTrustLevel = options.anonymousTrustLevel ?? "T0";
    this.anonymousIdentity = options.anonymousIdentity ?? "anonymous";
    this.verifyCardJws = options.verifyCardJws;
    this.maxClockSkewSeconds = options.maxClockSkewSeconds ?? 300;
    this.maxSignatureAgeSeconds = options.maxSignatureAgeSeconds ?? 900;
    this.expectedAuthority = options.expectedAuthority;
  }

  verify(ctx: AuthContext): AuthResult {
    const headers = ctx.headers ?? {};

    // 未签名请求：按匿名等级评估策略。
    if (headerValue(headers, "signature-input") === undefined) {
      if (this.policy.requireHttpSignature(this.anonymousTrustLevel)) {
        return {
          authenticated: false,
          protocolCode: "authentication_required",
          reason: `HTTP Message Signature required at ${this.anonymousTrustLevel}`,
        };
      }
      return { authenticated: true, identity: this.anonymousIdentity };
    }

    // 签名请求：重建 @target-uri / @authority（服务端只有 origin-form req.url）。
    const authority = headerValue(headers, "host") ?? "";
    const scheme = ctx.scheme ?? this.scheme;
    const targetUri =
      ctx.url.startsWith("http://") || ctx.url.startsWith("https://")
        ? ctx.url
        : `${scheme}://${authority}${ctx.url}`;

    // 审查 K-M8：authority 由客户端 Host 头重建——签名对 host A 可被重放到 host B
    // 并在此通过验签（签名绑定的是「签名者声明的目标」而非「实际连接目标」）。
    // 配置 expectedAuthority（自身广告主机 / SNI / TLS 证书 host）时强制绑定：
    // 声明的 authority 必须等于它，跨主机重放直接拒绝。
    if (
      this.expectedAuthority !== undefined &&
      authority.toLowerCase() !== this.expectedAuthority.toLowerCase()
    ) {
      return {
        authenticated: false,
        protocolCode: "authorization_failed",
        reason: `signature authority ${authority === "" ? "(none)" : authority} does not match expected authority ${this.expectedAuthority}`,
      };
    }

    const result = verifyHttpMessageSignature({
      method: ctx.method,
      targetUri,
      authority,
      headers,
      body: ctx.body ?? Buffer.alloc(0),
      resolver: this.resolver,
      nonceStore: this.nonceStore,
      now: this.now,
      maxClockSkewSeconds: this.maxClockSkewSeconds,
      maxSignatureAgeSeconds: this.maxSignatureAgeSeconds,
    });
    if (!result.ok) {
      return { authenticated: false, protocolCode: result.code, reason: result.reason };
    }

    const principal: VerifiedPrincipal = {
      identity: result.profile?.identity ?? result.keyid,
      keyid: result.keyid,
      trustLevel: result.profile?.trustLevel ?? this.anonymousTrustLevel,
      profile: result.profile,
    };

    // nonce 强制（策略表 T3）：签名必须携带 nonce 才能满足重放保护要求。
    if (this.policy.requireNonce(principal.trustLevel) && result.params.nonce === undefined) {
      return {
        authenticated: false,
        protocolCode: "authorization_failed",
        reason: `signature nonce required at ${principal.trustLevel}`,
      };
    }

    // Agent Card JWS 强制由 TrustPolicy 决定（§31）。
    const cardJws = headerValue(headers, CARD_JWS_HEADER);
    let cardClaims: CardJwsVerificationResult | undefined;
    if (this.policy.requireCardJws(principal.trustLevel)) {
      if (cardJws === undefined) {
        return {
          authenticated: false,
          protocolCode: "authentication_required",
          reason: `Agent Card JWS required at ${principal.trustLevel}`,
        };
      }
      if (this.verifyCardJws === undefined) {
        return {
          authenticated: false,
          protocolCode: "authorization_failed",
          reason: "Agent Card JWS verification is not configured",
        };
      }
      cardClaims = this.verifyCardJws(cardJws);
      if (!cardClaims.ok) {
        return {
          authenticated: false,
          protocolCode: "authorization_failed",
          reason: `invalid Agent Card JWS: ${cardClaims.reason}`,
        };
      }
    }

    // 身份绑定冲突 → identity_rejected（§18 / §32）。
    const claimed = {
      ...(parseClaimedIdentityHeader(headers) ?? {}),
      ...(cardClaims !== undefined && cardClaims.ok ? cardClaims : {}),
    };
    const bound = bindIdentity({ verified: principal, claimed });
    if (!bound.ok) {
      return { authenticated: false, protocolCode: "identity_rejected", reason: bound.reason };
    }
    // 验签通过：identity 是 HTTP Message Signature 验证出的对端身份。
    // identityVerified=true 让 pipeline 把该身份写入入站 Ledger identity
    // snapshot 的 counterparty 侧（§22，与 buyer 侧记录对称）。
    return { authenticated: true, identity: bound.senderIdentity, identityVerified: true };
  }
}
