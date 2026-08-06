/**
 * Trust Levels 与 TrustPolicy（基线 §28 / §31）。
 *
 * Trust level 只控制协议/自动化风险，不等于产品或 Merchant 推荐等级（§28）。
 * 本策略表把「是否强制某类身份证据」按对端 trust level 分级：
 *
 * | level | 含义                    | 强制 HTTP Message Signature | 强制 Agent Card JWS | 强制 nonce |
 * |-------|-------------------------|-----------------------------|----------------------|------------|
 * | T0    | UNKNOWN                 | 否（未认证可匿名访问）       | 否                   | 否         |
 * | T1    | DISCOVERED              | 是                          | 否                   | 否         |
 * | T2    | AUTHENTICATED           | 是                          | 是                   | 否         |
 * | T3    | VERIFIED_RELATIONSHIP   | 是                          | 是                   | 是         |
 *
 * §31（digest ≠ authentication）：签名/验签与完整性是两件事。HTTP Message
 * Signature 提供认证与防篡改绑定；Agent Card JWS 提供「卡片确实是该 key 所属方
 * 发布的」证据。是否强制由部署策略（本表）决定，不由算法本身决定。
 */

export type TrustLevel = "T0" | "T1" | "T2" | "T3";

export const TRUST_LEVELS: readonly TrustLevel[] = ["T0", "T1", "T2", "T3"];

export function isTrustLevel(value: unknown): value is TrustLevel {
  return typeof value === "string" && (TRUST_LEVELS as readonly string[]).includes(value);
}

/** T0=0 … T3=3。 */
export function trustLevelRank(level: TrustLevel): number {
  return TRUST_LEVELS.indexOf(level);
}

/**
 * 信任策略：按对端 trust level 决定对请求身份证据的强制程度。
 * 全部为纯查询接口，便于测试矩阵。
 */
export interface TrustPolicy {
  /** 该 level 是否强制请求携带 HTTP Message Signature。 */
  requireHttpSignature(level: TrustLevel): boolean;
  /** 该 level 是否强制请求/卡片携带可验证的 Agent Card JWS。 */
  requireCardJws(level: TrustLevel): boolean;
  /** 该 level 是否强制签名携带 nonce（防重放）。 */
  requireNonce(level: TrustLevel): boolean;
  /** created/expires 时钟偏差容忍（秒）。 */
  maxClockSkewSeconds(level: TrustLevel): number;
  /** 无 expires 时签名允许的最大年龄（秒）。 */
  maxSignatureAgeSeconds(level: TrustLevel): number;
}

/** 默认部署策略（上面的矩阵）。可注入自定义策略。 */
export const DEFAULT_TRUST_POLICY: TrustPolicy = {
  requireHttpSignature: (level) => level !== "T0",
  requireCardJws: (level) => level === "T2" || level === "T3",
  requireNonce: (level) => level === "T3",
  maxClockSkewSeconds: () => 300,
  maxSignatureAgeSeconds: () => 900,
};

export interface PolicyEvaluationInput {
  level: TrustLevel;
  hasHttpSignature: boolean;
  hasCardJws: boolean;
  /** 卡片 JWS 是否验证通过（未提供时 undefined）。 */
  cardJwsValid?: boolean;
  hasNonce?: boolean;
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  /** 未通过时的协议错误码。 */
  protocolCode?: "authentication_required" | "authorization_failed";
  reason?: string;
  /** 缺失的证据类别（diagnostic）。 */
  missing: string[];
}

/**
 * 按策略表评估一次请求的身份证据。这是 TrustPolicy 矩阵的单一入口：
 * 签名是否强制、JWS 是否强制、nonce 是否强制都在这里判定。
 */
export function evaluatePolicy(
  policy: TrustPolicy,
  input: PolicyEvaluationInput,
): PolicyEvaluationResult {
  const missing: string[] = [];
  if (policy.requireHttpSignature(input.level) && !input.hasHttpSignature) {
    return {
      allowed: false,
      protocolCode: "authentication_required",
      reason: `HTTP Message Signature required at ${input.level}`,
      missing: ["http-signature"],
    };
  }
  if (policy.requireCardJws(input.level)) {
    if (!input.hasCardJws) {
      return {
        allowed: false,
        protocolCode: "authentication_required",
        reason: `Agent Card JWS required at ${input.level}`,
        missing: ["card-jws"],
      };
    }
    if (input.cardJwsValid === false) {
      return {
        allowed: false,
        protocolCode: "authorization_failed",
        reason: `Agent Card JWS verification failed at ${input.level}`,
        missing: [],
      };
    }
  }
  if (
    policy.requireNonce(input.level) &&
    input.hasHttpSignature &&
    input.hasNonce !== true
  ) {
    // hasNonce 缺省/未知按缺失处理（fail-closed）：T3 的 nonce 强制不容模糊。
    return {
      allowed: false,
      protocolCode: "authorization_failed",
      reason: `signature nonce required at ${input.level}`,
      missing: ["nonce"],
    };
  }
  return { allowed: true, missing };
}
