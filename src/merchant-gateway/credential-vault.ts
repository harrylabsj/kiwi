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
 * 商家连接器入口的凭据保管（AES-256-GCM，密钥来自部署环境）。
 *
 * 入口在商家确认连接时兑换到**目录商家作用域凭据**（`cmt_…`），它需要长期
 * 持有（入口重启后仍要代表该商家读写公开资料）。与既有做法一致，明文不落库：
 * 这里用 `KIWI_GATEWAY_CREDENTIAL_KEY` 派生的 32 字节密钥做 AES-256-GCM
 * 加密后存储，密钥缺失时 fail-closed（入口无法保管凭据 → 商家工具不可用，
 * 而不是退回明文）。
 *
 * 存储位置：入口自己的 oauth.sqlite（0600），表 `gateway_merchant_credentials`。
 * 每个商家一行（merchant_id 主键）；重新连接覆盖旧凭据。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const CREDENTIAL_KEY_ENV = "KIWI_GATEWAY_CREDENTIAL_KEY";

const VAULT_SCHEMA = `
CREATE TABLE IF NOT EXISTS gateway_merchant_credentials (
  merchant_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export interface StoredMerchantCredential {
  token: string;
  expiresAt: string;
}

/** 入口需要的凭据保管能力（测试可注入内存实现）。 */
export interface MerchantCredentialStore {
  put(merchantId: string, token: string, expiresAt: string): void;
  get(merchantId: string): StoredMerchantCredential | undefined;
  delete(merchantId: string): void;
}

/** 从环境读取保管密钥；未配置返回 undefined（调用方据此 fail-closed）。 */
export function credentialKeyFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = (env[CREDENTIAL_KEY_ENV] ?? "").trim();
  return raw === "" ? undefined : raw;
}

/** 任意长度的部署密钥 → 32 字节 AES 密钥（sha256 派生）。 */
function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export class GatewayCredentialVault implements MerchantCredentialStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; secret: string; now?: () => string }) {
    if (typeof options.secret !== "string" || options.secret.trim() === "") {
      throw new Error("GatewayCredentialVault requires a non-empty credential secret");
    }
    this.db = options.db;
    this.key = deriveKey(options.secret);
    this.now = options.now ?? (() => new Date().toISOString());
    this.db.exec(VAULT_SCHEMA);
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString("base64");
  }

  private decrypt(payload: string): string {
    const raw = Buffer.from(payload, "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  put(merchantId: string, token: string, expiresAt: string): void {
    if (merchantId === "" || token === "") {
      throw new Error("credential vault requires merchant_id and token");
    }
    this.db
      .prepare(
        `INSERT INTO gateway_merchant_credentials(merchant_id, ciphertext, expires_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(merchant_id) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(merchantId, this.encrypt(token), expiresAt, this.now());
  }

  get(merchantId: string): StoredMerchantCredential | undefined {
    const row = this.db
      .prepare(
        "SELECT ciphertext, expires_at FROM gateway_merchant_credentials WHERE merchant_id = ?",
      )
      .get(merchantId) as { ciphertext: string; expires_at: string } | undefined;
    if (row === undefined) return undefined;
    if (row.expires_at <= this.now()) return undefined;
    try {
      return { token: this.decrypt(row.ciphertext), expiresAt: row.expires_at };
    } catch {
      // 密钥轮换/数据损坏：当作没有凭据（工具报「需要重新连接」），绝不返回噪音。
      return undefined;
    }
  }

  delete(merchantId: string): void {
    this.db
      .prepare("DELETE FROM gateway_merchant_credentials WHERE merchant_id = ?")
      .run(merchantId);
  }
}
