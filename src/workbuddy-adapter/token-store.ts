/**
 * 本机适配器 token 存储：AES-256-GCM 加密文件，0600。
 *
 * 只保存固定实例绑定的 OAuth token 与门禁续期所需分享码；不保存 PKCE
 * verifier 或日志。密钥可由调用方显式提供（环境变量辅助方法），CLI 使用本机
 * 0600 key 文件；缺失即 fail-closed，不回退明文。
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type FixedInstanceBinding, bindingFingerprint } from "./binding.js";

export const ADAPTER_TOKEN_SECRET_ENV = "WORKBUDDY_ADAPTER_TOKEN_SECRET";

export interface StoredAdapterToken {
  access_token: string;
  refresh_token?: string;
  expires_at: string;
  scope: string[];
  /** 门禁分享凭据（只用于 X-Share-Code；不是 OAuth 身份）。加密保存。 */
  share_code?: string;
}

interface Envelope {
  version: 1;
  binding: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function deriveKey(secret: string): Buffer {
  if (secret.trim() === "") throw new Error("token store secret 不能为空");
  return scryptSync(secret, "kiwi-workbuddy-adapter-token-v1", 32);
}

function validateToken(value: unknown): StoredAdapterToken {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("token store 内容非法");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.access_token !== "string" || record.access_token === "") {
    throw new Error("token store 缺 access_token");
  }
  if (typeof record.expires_at !== "string" || Number.isNaN(Date.parse(record.expires_at))) {
    throw new Error("token store 缺合法 expires_at");
  }
  if (
    !Array.isArray(record.scope) ||
    record.scope.some((scope) => typeof scope !== "string" || scope === "")
  ) {
    throw new Error("token store 缺合法 scope");
  }
  return {
    access_token: record.access_token,
    ...(typeof record.refresh_token === "string" && record.refresh_token !== ""
      ? { refresh_token: record.refresh_token }
      : {}),
    ...(typeof record.share_code === "string" && record.share_code !== ""
      ? { share_code: record.share_code }
      : {}),
    expires_at: record.expires_at,
    scope: [...record.scope] as string[],
  };
}

export class AdapterTokenStore {
  private readonly file: string;
  private readonly binding: FixedInstanceBinding;
  private readonly key: Buffer;
  private readonly now: () => number;

  constructor(options: {
    file: string;
    binding: FixedInstanceBinding;
    secret: string;
    now?: () => number;
  }) {
    this.file = options.file;
    this.binding = options.binding;
    this.key = deriveKey(options.secret);
    this.now = options.now ?? Date.now;
  }

  static secretFromEnv(env: Record<string, string | undefined> = process.env): string {
    const secret = (env[ADAPTER_TOKEN_SECRET_ENV] ?? "").trim();
    if (secret === "") {
      throw new Error(`${ADAPTER_TOKEN_SECRET_ENV} 未配置：拒绝明文保存 token`);
    }
    return secret;
  }

  save(token: StoredAdapterToken): void {
    const validated = validateToken(token);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const aad = Buffer.from(bindingFingerprint(this.binding), "utf8");
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(validated), "utf8"),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      version: 1,
      binding: bindingFingerprint(this.binding),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
      // chmod before rename: after a successful rename we must not throw and
      // leave callers thinking the write failed.
      chmodSync(temp, 0o600);
      renameSync(temp, this.file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  load(): StoredAdapterToken | undefined {
    if (!existsSync(this.file)) return undefined;
    let envelope: Envelope;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      envelope = parsed as Envelope;
    } catch {
      throw new Error("token store 无法解析");
    }
    if (
      envelope.version !== 1 ||
      envelope.binding !== bindingFingerprint(this.binding) ||
      typeof envelope.iv !== "string" ||
      typeof envelope.tag !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      throw new Error("token store 绑定不匹配或格式非法");
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(envelope.binding, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return validateToken(JSON.parse(plaintext));
    } catch {
      throw new Error("token store 解密失败（密钥错误或文件被篡改）");
    }
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }

  /** access token 是否已过期（含 30s 提前量）。 */
  isExpired(token: StoredAdapterToken): boolean {
    return Date.parse(token.expires_at) <= this.now() + 30_000;
  }
}
