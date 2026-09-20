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
 * 公钥指纹约定（设计 v0.1.2 §11.4）。
 *
 * `key_thumbprint` 的约定是**规范化公钥 JWK 的 sha256 十六进制**，形如
 * `sha256:<64 hex>`（runtime-binding-claims Schema 的 pattern）。
 *
 * 规范化按 RFC 7638 的必需成员子集、成员名字典序拼 JSON（不做通用 JCS 排序
 * 魔法，避免"看起来像 JCS"的近似实现）：
 *   - OKP（Ed25519）：`{"crv":…,"kty":"OKP","x":…}`
 *   - EC（P-256）：`{"crv":…,"kty":"EC","x":…,"y":…}`
 *
 * 跨语言一致性由测试锁定：同一 JWK 在 TypeScript 与 Python 侧必须得到同一
 * 摘要（M3 的 Catalog 实现按本文件口径对齐）。
 */

import { createHash, createPublicKey } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { JsonWebKey } from "../../trust/identity/jwk.js";
import type { SigningKey } from "../../trust/identity/keys.js";

export class ThumbprintError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ThumbprintError";
    this.code = code;
  }
}

/** RFC 7638 必需成员（按成员名字典序）拼出的规范化 JSON。 */
export function canonicalJwkForThumbprint(jwk: JsonWebKey): string {
  const kty = jwk.kty;
  if (kty === "OKP") {
    if (jwk.crv !== "Ed25519") {
      throw new ThumbprintError("UNSUPPORTED_KEY", `OKP 仅支持 Ed25519（收到 crv=${String(jwk.crv)}）`);
    }
    if (typeof jwk.x !== "string" || jwk.x === "") {
      throw new ThumbprintError("INVALID_KEY", "OKP JWK 缺少 x");
    }
    return JSON.stringify({ crv: jwk.crv, kty, x: jwk.x });
  }
  if (kty === "EC") {
    if (jwk.crv !== "P-256") {
      throw new ThumbprintError("UNSUPPORTED_KEY", `EC 仅支持 P-256（收到 crv=${String(jwk.crv)}）`);
    }
    if (typeof jwk.x !== "string" || typeof jwk.y !== "string" || jwk.x === "" || jwk.y === "") {
      throw new ThumbprintError("INVALID_KEY", "EC JWK 缺少 x/y");
    }
    return JSON.stringify({ crv: jwk.crv, kty, x: jwk.x, y: jwk.y });
  }
  throw new ThumbprintError("UNSUPPORTED_KEY", `不支持的 kty=${String(kty)}（仅 OKP/Ed25519 与 EC/P-256）`);
}

/** 由规范化 JWK 计算 `sha256:<hex>` 指纹。 */
export function jwkThumbprint(jwk: JsonWebKey): string {
  const canonical = canonicalJwkForThumbprint(jwk);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** 由公钥对象（PEM/KeyObject）计算同一口径的指纹。 */
export function publicKeyThumbprint(key: KeyObject | string): string {
  const keyObject = typeof key === "string" ? createPublicKey(key) : key;
  const jwk = keyObject.export({ format: "jwk" }) as JsonWebKey;
  return jwkThumbprint(jwk);
}

/**
 * 由验签视图（SigningKey）计算指纹：优先用其 JWK，否则用 SPKI PEM 现导。
 * 两者都没有时明确失败（不返回"空指纹"让上层误判）。
 */
export function signingKeyThumbprint(key: SigningKey): string {
  if (key.jwk !== undefined) return jwkThumbprint(key.jwk);
  if (key.publicKeyPem !== undefined) return publicKeyThumbprint(key.publicKeyPem);
  throw new ThumbprintError("INVALID_KEY", `密钥 ${key.keyid} 既无 jwk 也无 publicKeyPem，无法计算指纹`);
}

/** 指纹形状校验（Schema 口径）：`sha256:` + 64 位小写十六进制。 */
export function isThumbprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
