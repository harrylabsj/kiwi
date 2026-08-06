/**
 * 签名密钥模型与 keyid → 公钥解析接缝。
 *
 * 两个来源（基线 §27 Identity Trust：HTTP Message Signatures / UCP signing keys）：
 *   - `signing_keys` 本地配置信任锚：{ keyid, algorithm, publicKey, profile }；
 *   - JWKS 接缝：{ keys: JsonWebKey[] }，kid → OKP(Ed25519) / EC(P-256)。
 *
 * 公钥材料三种等价形态：SPKI PEM、JWK、raw 字节（Ed25519=32B，P-256=64B
 * 未压缩点 x||y）。`publicKeyObject` 归一为 node:crypto KeyObject 供验签。
 * 私钥仅存在于出站签名器（signer.ts）；本模块不保存、不解析私钥除外的任何 secret。
 */

import { createPrivateKey, createPublicKey, type JsonWebKey, type KeyObject } from "node:crypto";
import type { TrustLevel } from "./trust-policy.js";

/** 本实现支持的签名算法（RFC 9421 alg 名见 RFC9421_ALG_NAMES）。 */
export type SignatureAlgorithm = "ed25519" | "es256";

/** 与密钥绑定的身份档案（身份绑定冲突 → identity_rejected 的比对输入）。 */
export interface KeyProfile {
  /** 该 key 绑定的规范身份（幂等主键 sender 侧）。 */
  identity?: string;
  /** 组织名。 */
  organization?: string;
  /** KNP 角色（buyer|merchant）。 */
  role?: "buyer" | "merchant";
  /** 该密钥对应对端的信任等级。 */
  trustLevel?: TrustLevel;
}

/** 一个签名密钥的验证方视图（只含公钥材料 + 绑定档案）。 */
export interface SigningKey {
  keyid: string;
  algorithm: SignatureAlgorithm;
  /** SPKI PEM 公钥。 */
  publicKeyPem?: string;
  /** raw 公钥：Ed25519=32B；P-256=64B（x||y 未压缩点）。 */
  publicKeyRaw?: Buffer;
  /** JWK 公钥。 */
  jwk?: JsonWebKey;
  /** 本地配置的信任档案。 */
  profile?: KeyProfile;
}

/** keyid → 公钥。返回 undefined 表示未知 keyid（验证方不认识该签名者）。 */
export type KeyResolver = (keyid: string) => SigningKey | undefined;

/** 校验 raw 长度并按算法归一为 JWK。 */
export function publicKeyJwkFromRaw(
  algorithm: SignatureAlgorithm,
  raw: Buffer,
): JsonWebKey {
  if (algorithm === "ed25519") {
    if (raw.length !== 32) {
      throw new Error(`Ed25519 raw public key must be 32 bytes (got ${raw.length})`);
    }
    return { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") };
  }
  if (raw.length !== 64) {
    throw new Error(`P-256 raw public key must be 64 bytes (got ${raw.length})`);
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: raw.subarray(0, 32).toString("base64url"),
    y: raw.subarray(32, 64).toString("base64url"),
  };
}

/** 把 SigningKey 归一为 node:crypto 公钥 KeyObject。 */
export function publicKeyObject(key: SigningKey): KeyObject {
  if (key.publicKeyPem !== undefined) {
    return createPublicKey(key.publicKeyPem);
  }
  if (key.jwk !== undefined) {
    return createPublicKey({ key: key.jwk, format: "jwk" });
  }
  if (key.publicKeyRaw !== undefined) {
    return createPublicKey({
      key: publicKeyJwkFromRaw(key.algorithm, key.publicKeyRaw),
      format: "jwk",
    });
  }
  throw new Error(`SigningKey ${key.keyid} has no public key material`);
}

/**
 * 由 32 字节 Ed25519 seed 构造私钥 KeyObject（PKCS8 DER，固定前缀）。
 * 确定性：同一 seed 恒得同一密钥，供测试与确定性签名器使用。
 */
export function ed25519PrivateKeyFromSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) {
    throw new Error(`Ed25519 private seed must be 32 bytes (got ${seed.length})`);
  }
  const DER_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({
    key: Buffer.concat([DER_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** 由 PEM PKCS8 或 JWK 构造私钥 KeyObject（出站签名用）。 */
export function privateKeyObject(input: string | JsonWebKey): KeyObject {
  if (typeof input === "string") return createPrivateKey(input);
  return createPrivateKey({ key: input, format: "jwk" });
}

/** 从本地 signing_keys 配置构建 resolver（精确 keyid 匹配）。 */
export function resolveFromSigningKeys(keys: SigningKey[]): KeyResolver {
  const byId = new Map<string, SigningKey>();
  for (const key of keys) {
    if (key.keyid.length === 0) {
      throw new Error("resolveFromSigningKeys: keyid must be a non-empty string");
    }
    if (byId.has(key.keyid)) {
      throw new Error(`resolveFromSigningKeys: duplicate keyid "${key.keyid}"`);
    }
    byId.set(key.keyid, key);
  }
  return (keyid: string) => byId.get(keyid);
}

/** 从 JWKS 构造 resolver：kid 匹配，kty/crv 推断算法，未知算法跳过。 */
export function resolveFromJwks(keys: JsonWebKey[]): KeyResolver {
  const byKid = new Map<string, SigningKey>();
  for (const jwk of keys) {
    if (typeof jwk.kid !== "string" || jwk.kid.length === 0) continue;
    const algorithm = algorithmFromJwk(jwk);
    if (algorithm === undefined) continue;
    byKid.set(jwk.kid, { keyid: jwk.kid, algorithm, jwk });
  }
  return (keyid: string) => byKid.get(keyid);
}

/** 由 JWK 推断算法：OKP+Ed25519 → ed25519；EC+P-256 → es256；其余不支持。 */
function algorithmFromJwk(jwk: JsonWebKey): SignatureAlgorithm | undefined {
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") return "ed25519";
  if (jwk.kty === "EC" && jwk.crv === "P-256") return "es256";
  return undefined;
}
