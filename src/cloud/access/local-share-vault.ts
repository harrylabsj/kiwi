/** Encrypted, owner-authorized WorkBuddy gate credential for connection recovery. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../fs/atomic-write.js";

export class LocalShareVault {
  private readonly file: string;
  private readonly key: Buffer;
  private readonly aad: Buffer;

  constructor(dataDir: string, privateKeyPem: string, origin: string) {
    this.file = path.join(dataDir, "workbuddy-access-vault.json");
    this.key = createHash("sha256").update("kiwi-workbuddy-local-access-v1\0").update(privateKeyPem).digest();
    this.aad = Buffer.from(`kiwi-workbuddy-local-access-v1\0${origin}`);
  }

  put(secret: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    writeFileAtomic(this.file, JSON.stringify({ version: 1, iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }), { mode: 0o600 });
  }

  get(): string | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      const record = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      if (record.version !== 1 || typeof record.iv !== "string" || typeof record.tag !== "string" ||
          typeof record.ciphertext !== "string") throw new Error("invalid record");
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv, "base64"));
      decipher.setAAD(this.aad);
      decipher.setAuthTag(Buffer.from(record.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("WorkBuddy 分享链接暂存数据无法解密，请重新配置或联系支持");
    }
  }
}
