/**
 * Compact JWS 验签（EdDSA / ES256）与 Agent Card JWS 绑定验证（基线 §27 / §31）。
 *
 * - `verifyCompactJws`：RFC 7515 compact 形态 `header.payload.signature`
 *   （各段 base64url）。EdDSA → Ed25519；ES256 → P-256 + SHA-256（原始 r||s）。
 * - `verifyAgentCardJws`：JWS 负载必须是该 Agent Card 的规范化 JSON；比较用
 *   JCS（RFC 8785），因此 key 顺序 / 可选字段缺省不影响比对。
 *
 * 是否强制 JWS 由 TrustPolicy.requireCardJws(level) 决定（§31），本模块只提供
 * 「验签 + 卡片绑定」能力，不做强制决策。
 */

import { createPublicKey, KeyObject, type JsonWebKey, verify as nodeVerify } from "node:crypto";
import { parseAgentCard } from "../../discovery/agent-card/index.js";
import type { AgentCard } from "../../discovery/agent-card/index.js";
import { canonicalize } from "../../negotiation/jcs.js";
import { publicKeyObject, type KeyResolver, type SigningKey } from "./keys.js";

export type JwsErrorCode =
  | "malformed"
  | "unsupported_algorithm"
  | "missing_key"
  | "invalid_signature";

export class JwsError extends Error {
  readonly code: JwsErrorCode;
  constructor(code: JwsErrorCode, message: string) {
    super(message);
    this.name = "JwsError";
    this.code = code;
  }
}

export interface VerifiedJws {
  /** 解码后的 JWS header。 */
  header: Record<string, unknown>;
  /** 解码后的负载字节。 */
  payload: Buffer;
  /** alg 值（EdDSA | ES256）。 */
  alg: string;
  /** header.kid（如有）。 */
  keyid?: string;
}

function malformed(detail: string): JwsError {
  return new JwsError("malformed", `malformed compact JWS: ${detail}`);
}

function base64urlToBuffer(value: string, what: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw malformed(`${what} is not base64url`);
  return Buffer.from(value, "base64url");
}

/**
 * 验签一个 compact JWS。publicKey 可以是 SigningKey（推荐，算法自动取）、
 * JsonWebKey 或 KeyObject。
 */
export function verifyCompactJws(
  jws: string,
  publicKey: SigningKey | JsonWebKey | KeyObject,
): VerifiedJws {
  const parts = jws.split(".");
  if (parts.length !== 3) throw malformed("must have exactly 3 segments");
  const headerSegment = parts[0] ?? "";
  const payloadSegment = parts[1] ?? "";
  const signatureSegment = parts[2] ?? "";

  const headerBytes = base64urlToBuffer(headerSegment, "header");
  let header: unknown;
  try {
    header = JSON.parse(headerBytes.toString("utf8"));
  } catch {
    throw malformed("header is not valid JSON");
  }
  if (header === null || typeof header !== "object" || Array.isArray(header)) {
    throw malformed("header must be a JSON object");
  }
  const headerRecord = header as Record<string, unknown>;
  if (typeof headerRecord.alg !== "string" || headerRecord.alg.length === 0) {
    throw malformed("header has no alg");
  }
  const alg = headerRecord.alg;
  const keyid = typeof headerRecord.kid === "string" ? headerRecord.kid : undefined;

  const payload = base64urlToBuffer(payloadSegment, "payload");
  const signature = base64urlToBuffer(signatureSegment, "signature");
  const signingInput = Buffer.from(`${headerSegment}.${payloadSegment}`, "utf8");

  const key = resolveJwsKey(publicKey, alg);
  if (!verifyJwsSignature(alg, signingInput, signature, key)) {
    throw new JwsError("invalid_signature", "JWS signature verification failed");
  }
  return { header: headerRecord, payload, alg, keyid };
}

function resolveJwsKey(publicKey: SigningKey | JsonWebKey | KeyObject, alg: string): KeyObject {
  if (publicKey instanceof KeyObject) return publicKey;
  if (typeof publicKey === "object" && "keyid" in publicKey && "algorithm" in publicKey) {
    const key = publicKey as SigningKey;
    if (key.algorithm !== jwsAlgToSignatureAlgorithm(alg)) {
      throw new JwsError("unsupported_algorithm", `JWS alg ${alg} does not match key algorithm ${key.algorithm}`);
    }
    return publicKeyObject(key);
  }
  const jwk = publicKey as JsonWebKey;
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && alg !== "EdDSA") {
    throw new JwsError("unsupported_algorithm", `key is Ed25519 but JWS alg is ${alg}`);
  }
  if (jwk.kty === "EC" && jwk.crv === "P-256" && alg !== "ES256") {
    throw new JwsError("unsupported_algorithm", `key is P-256 but JWS alg is ${alg}`);
  }
  return createPublicKey({ key: jwk, format: "jwk" });
}

function jwsAlgToSignatureAlgorithm(alg: string): "ed25519" | "es256" | undefined {
  if (alg === "EdDSA") return "ed25519";
  if (alg === "ES256") return "es256";
  return undefined;
}

function verifyJwsSignature(
  alg: string,
  signingInput: Buffer,
  signature: Buffer,
  key: KeyObject,
): boolean {
  switch (alg) {
    case "EdDSA":
      return nodeVerify(null, signingInput, key, signature);
    case "ES256":
      return nodeVerify("sha256", signingInput, { key, dsaEncoding: "ieee-p1363" }, signature);
    default:
      throw new JwsError("unsupported_algorithm", `unsupported JWS alg ${alg}`);
  }
}

/** 读取 compact JWS 的 kid（不验签）；畸形返回 undefined。 */
export function jwsKid(jws: string): string | undefined {
  const firstDot = jws.indexOf(".");
  if (firstDot <= 0) return undefined;
  const headerSegment = jws.slice(0, firstDot);
  let header: unknown;
  try {
    header = JSON.parse(base64urlToBuffer(headerSegment, "header").toString("utf8"));
  } catch {
    return undefined;
  }
  if (header === null || typeof header !== "object") return undefined;
  const kid = (header as Record<string, unknown>).kid;
  return typeof kid === "string" ? kid : undefined;
}

export type AgentCardJwsResult =
  | { ok: true; keyid?: string }
  | { ok: false; reason: string };

/**
 * 验证「Agent Card + 其 JWS」绑定：JWS 验签通过，且 JWS 负载规范化后与该
 * card 一致。card 必须先过 parseAgentCard（结构校验 + secret 扫描）；负载经
 * parseAgentCard 归一后再比对，双方都过 JCS。
 */
export function verifyAgentCardJws(card: AgentCard, jws: string, resolver: KeyResolver): AgentCardJwsResult {
  const kid = jwsKid(jws);
  const key = kid === undefined ? undefined : resolver(kid);
  if (key === undefined) {
    return { ok: false, reason: `no signing key for JWS kid "${kid ?? "(missing)"}"` };
  }
  let verified: VerifiedJws;
  try {
    verified = verifyCompactJws(jws, key);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof JwsError ? err.message : String(err),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(verified.payload.toString("utf8"));
  } catch {
    return { ok: false, reason: "JWS payload is not valid JSON" };
  }
  let normalized: unknown;
  try {
    normalized = parseAgentCard(parsed);
  } catch (err) {
    return { ok: false, reason: `JWS payload is not a valid Agent Card: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (canonicalize(normalized) !== canonicalize(card)) {
    return { ok: false, reason: "JWS payload does not match the presented Agent Card" };
  }
  return { ok: true, keyid: verified.keyid };
}
