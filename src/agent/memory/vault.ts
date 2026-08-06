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
 * Private Vault (design §6.3, §9.5): AEAD-encrypted storage for Restricted
 * values — precise addresses, contacts, buyer private budgets, merchant
 * costs and floor prices.
 *
 * Key resolution (design: OS secure storage preferred; dev may configure
 * KIWI_DATA_KEY explicitly):
 * - v0.3.0-A ships the EnvKeyProvider only (KIWI_DATA_KEY, 64-hex or any
 *   passphrase stretched with scrypt).
 * - No key => Restricted writes FAIL CLOSED (VaultKeyError). There is no
 *   plaintext downgrade path.
 *
 * value_fingerprint is a keyed HMAC for dedup; it cannot be reversed
 * without the data key.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export const VAULT_KEY_VERSION = 1;
const NONCE_BYTES = 12;
const SCRYPT_SALT = "kiwi-vault-v1";

export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultKeyError";
  }
}

export interface VaultKeyProvider {
  /** Returns the 32-byte data key for a version, or undefined when absent. */
  getKey(keyVersion: number): Buffer | undefined;
}

/** Development key provider: KIWI_DATA_KEY (64-hex, or passphrase via scrypt). */
export class EnvKeyProvider implements VaultKeyProvider {
  private readonly key: Buffer | undefined;

  constructor(envValue: string | undefined = process.env.KIWI_DATA_KEY) {
    if (envValue === undefined || envValue === "") {
      this.key = undefined;
      return;
    }
    if (/^[0-9a-fA-F]{64}$/.test(envValue)) {
      this.key = Buffer.from(envValue, "hex");
    } else if (envValue.length >= 16) {
      this.key = scryptSync(envValue, SCRYPT_SALT, 32);
    } else {
      // A short "key" is a configuration mistake, not a key: fail closed.
      throw new VaultKeyError(
        "KIWI_DATA_KEY must be 64 hex chars or a passphrase of at least 16 characters",
      );
    }
  }

  getKey(keyVersion: number): Buffer | undefined {
    return keyVersion === VAULT_KEY_VERSION ? this.key : undefined;
  }
}

export interface VaultSealResult {
  ciphertext: Buffer;
  nonce: Buffer;
  key_version: number;
  value_fingerprint: string;
}

export class PrivateVault {
  private readonly keys: VaultKeyProvider;

  constructor(keys: VaultKeyProvider = new EnvKeyProvider()) {
    this.keys = keys;
  }

  /** True when Restricted writes are possible (a data key is configured). */
  get available(): boolean {
    return this.keys.getKey(VAULT_KEY_VERSION) !== undefined;
  }

  /** Keyed dedup fingerprint; computable only with the data key. */
  fingerprint(kind: string, plaintext: string): string {
    const key = this.keys.getKey(VAULT_KEY_VERSION);
    if (key === undefined) {
      throw new VaultKeyError("no data key configured (KIWI_DATA_KEY); refusing Restricted write");
    }
    return createHmac("sha256", key).update(`fingerprint:${kind}:${plaintext}`).digest("hex");
  }

  /** Encrypt a Restricted value. Fails closed without a data key. */
  seal(kind: string, plaintext: string): VaultSealResult {
    const key = this.keys.getKey(VAULT_KEY_VERSION);
    if (key === undefined) {
      throw new VaultKeyError("no data key configured (KIWI_DATA_KEY); refusing Restricted write");
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([ciphertext, tag]),
      nonce,
      key_version: VAULT_KEY_VERSION,
      value_fingerprint: this.fingerprint(kind, plaintext),
    };
  }

  /** Decrypt a Vault value. Throws VaultKeyError on tamper or wrong key. */
  open(keyVersion: number, nonce: Buffer, ciphertext: Buffer): string {
    const key = this.keys.getKey(keyVersion);
    if (key === undefined) {
      throw new VaultKeyError(`no data key for vault key_version ${keyVersion}`);
    }
    if (ciphertext.length < 16) {
      throw new VaultKeyError("vault ciphertext is truncated");
    }
    const body = ciphertext.subarray(0, ciphertext.length - 16);
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch {
      throw new VaultKeyError("vault ciphertext failed authentication (tampered or wrong key)");
    }
  }

  /** Constant-time fingerprint comparison for dedup checks. */
  fingerprintEquals(a: string, b: string): boolean {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }
}
