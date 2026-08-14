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
 * A2A 节点签名身份（Issue 16 B / KIWI_A2A_AUTH=signature，RFC 9421）。
 *
 * 设计意图：**任何 kiwi buyer 都能和任何 kiwi merchant 沟通**（无预共享密钥）。
 * 每个 agent 持有自己的 Ed25519 密钥对：
 *   - 出站：`HttpMessageSigner` 用私钥对每请求签名（content-digest / signature-input / signature）；
 *   - 入站：`HttpMessageSignatureVerifier` 用 keyid→公钥（resolver）验签。
 * 默认信任策略**匿名 T0 放行**——签名基建未就绪时匿名仍可磋商；签名请求获更高信任。
 *
 * 密钥持久化在节点数据目录 `<dataDir>/a2a-signing-key.json`（0600）。
 */

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { HttpMessageSigner } from "../trust/identity/index.js";
import type { KeyResolver, SigningKey } from "../trust/identity/index.js";

export const A2A_SIGNING_KEY_FILE = "a2a-signing-key.json";

export interface A2aSigningIdentity {
  keyid: string;
  algorithm: "ed25519";
  /** PKCS8 私钥 PEM（0600 落盘，绝不进 card / transcript）。 */
  privateKeyPem: string;
  /** SPKI 公钥 PEM（可发布进 agent card securitySchemes）。 */
  publicKeyPem: string;
  /** Ed25519 raw 公钥（32B）。 */
  publicKeyRaw: Buffer;
}

/** 生成新的 Ed25519 签名身份（keyid = 调用方指定的稳定身份键）。 */
export function generateA2aSigningIdentity(keyid: string): A2aSigningIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const raw = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return {
    keyid,
    algorithm: "ed25519",
    privateKeyPem,
    publicKeyPem,
    // Ed25519 SPKI DER = 32-byte 前缀(12) + raw(32)。取末 32B。
    publicKeyRaw: Buffer.from(raw.subarray(raw.length - 32)),
  };
}

/** 加载或生成节点签名身份（幂等；已存在则读回，避免重启换钥）。 */
export function loadOrCreateA2aSigningIdentity(
  dataDir: string,
  keyid: string,
): A2aSigningIdentity {
  const file = path.join(dataDir, A2A_SIGNING_KEY_FILE);
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      keyid?: unknown;
      algorithm?: unknown;
      privateKeyPem?: unknown;
      publicKeyPem?: unknown;
      publicKeyRaw?: unknown;
    };
    if (
      typeof parsed.keyid !== "string" ||
      parsed.algorithm !== "ed25519" ||
      typeof parsed.privateKeyPem !== "string" ||
      typeof parsed.publicKeyPem !== "string"
    ) {
      throw new Error(`A2A 签名密钥文件 ${file} 形状非法（fail-closed）`);
    }
    return {
      keyid: parsed.keyid,
      algorithm: "ed25519",
      privateKeyPem: parsed.privateKeyPem,
      publicKeyPem: parsed.publicKeyPem,
      publicKeyRaw: Buffer.from((parsed.publicKeyRaw as string) ?? "", "base64"),
    };
  }
  const identity = generateA2aSigningIdentity(keyid);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    file,
    JSON.stringify(
      {
        keyid: identity.keyid,
        algorithm: identity.algorithm,
        privateKeyPem: identity.privateKeyPem,
        publicKeyPem: identity.publicKeyPem,
        publicKeyRaw: identity.publicKeyRaw.toString("base64"),
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return identity;
}

/** 由节点身份构造出站签名器（HttpMessageSigner 即 A2AOutboundSigner 形状）。 */
export function createA2aOutboundSigner(identity: A2aSigningIdentity): HttpMessageSigner {
  return new HttpMessageSigner({
    keyid: identity.keyid,
    algorithm: identity.algorithm,
    privateKey: identity.privateKeyPem,
  });
}

/** 从签名密钥 JSON 文件加载身份（与 loadOrCreateA2aSigningIdentity 同形状）。 */
export function loadA2aSigningIdentityFromFile(file: string): A2aSigningIdentity {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    keyid?: unknown;
    algorithm?: unknown;
    privateKeyPem?: unknown;
    publicKeyPem?: unknown;
    publicKeyRaw?: unknown;
  };
  if (
    typeof parsed.keyid !== "string" ||
    parsed.algorithm !== "ed25519" ||
    typeof parsed.privateKeyPem !== "string" ||
    typeof parsed.publicKeyPem !== "string"
  ) {
    throw new Error(`A2A 签名密钥文件 ${file} 形状非法（fail-closed）`);
  }
  return {
    keyid: parsed.keyid,
    algorithm: "ed25519",
    privateKeyPem: parsed.privateKeyPem,
    publicKeyPem: parsed.publicKeyPem,
    publicKeyRaw: Buffer.from((parsed.publicKeyRaw as string) ?? "", "base64"),
  };
}

/** 出站签名器：显式 signer 优先，否则读 `KIWI_A2A_SIGNING_KEY_FILE` env。 */
export function resolveOutboundSigner(
  explicit?: A2AOutboundSignerLike,
): HttpMessageSigner | undefined {
  if (explicit !== undefined) return explicit as HttpMessageSigner;
  const file = (process.env.KIWI_A2A_SIGNING_KEY_FILE ?? "").trim();
  if (file === "") return undefined;
  return createA2aOutboundSigner(loadA2aSigningIdentityFromFile(file));
}

/** A2AOutboundSigner 的结构形状（避免与 client 类型循环依赖）。 */
export interface A2AOutboundSignerLike {
  readonly keyid: string;
  sign(input: { method: string; url: string; body: Buffer; headers: Record<string, string> }): Record<string, string>;
}

/**
 * 构造入站签名验证用的 keyid→公钥 resolver。
 * 未知 keyid → undefined（匿名请求按 T0 放行，签名请求身份不可解析则拒绝）。
 */
export function resolveA2aSignatureResolver(
  own: A2aSigningIdentity,
  extraKeys: SigningKey[] = [],
): KeyResolver {
  const ownKey: SigningKey = {
    keyid: own.keyid,
    algorithm: own.algorithm,
    publicKeyPem: own.publicKeyPem,
    publicKeyRaw: own.publicKeyRaw,
  };
  const byId = new Map<string, SigningKey>([[own.keyid, ownKey]]);
  for (const key of extraKeys) {
    if (key.keyid === own.keyid) continue;
    byId.set(key.keyid, key);
  }
  return (keyid: string) => byId.get(keyid);
}

/** 从 trusted-keys 文件加载对端公钥列表（keyid → 公钥）。非法行 fail-closed。 */
export function loadA2aTrustedKeys(file: string): SigningKey[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`A2A trusted keys ${file} 必须是数组（fail-closed）`);
  }
  return parsed.map((raw, index) => {
    const row = raw as Record<string, unknown>;
    if (typeof row.keyid !== "string" || typeof row.publicKeyPem !== "string") {
      throw new Error(`A2A trusted keys ${file}[${index}] 缺 keyid/publicKeyPem（fail-closed）`);
    }
    const key: SigningKey = {
      keyid: row.keyid,
      algorithm: row.algorithm === "es256" ? "es256" : "ed25519",
      publicKeyPem: row.publicKeyPem,
    };
    return key;
  });
}

/** Agent Card 的 securitySchemes 条目（对端据此解析本节点公钥）。 */
export function a2aSignatureSecurityScheme(identity: A2aSigningIdentity): Record<string, unknown> {
  return {
    "kiwi-signature": {
      type: "kiwi-http-message-signature",
      keyid: identity.keyid,
      algorithm: "ed25519",
      publicKeyPem: identity.publicKeyPem,
    },
  };
}
