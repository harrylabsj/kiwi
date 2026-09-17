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
 * 商家实例的一次性配对码（设计 §8.4 第二期）。
 *
 * 目的：商家把实例接入网关时**不必把长期内部令牌贴进任何表单**——在实例所在
 * 机器上执行 `kiwi merchant mcp pair` 生成一个短时、单次、可读性好的配对码，
 * 把它填进网关的绑定页即可；网关用该码向实例兑换内部凭据。
 *
 * 语义（fail-closed）：
 *   - 一次性：兑换成功即从盘上删除，重复兑换一律失败；
 *   - 短 TTL：缺省 10 分钟，过期即失效（`readPairingState` 也按 TTL 判定）；
 *   - 只存摘要：`pairing.json` 里只有 sha256 摘要与到期时间（0600），
 *     明文只在生成时打印一次；
 *   - 重新生成即覆盖（旧码立即失效）。
 *
 * 范围限制：配对码只解决「谁在实例这台机器上」——网关仍要求商家先完成
 * OAuth 目录连接（merchant_id 来自已验证会话），两者缺一不可。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PAIRING_FILE = "pairing.json";
export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

/** 无歧义字母表（去掉 0/O/1/I/L），便于商家手抄。 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 4;

export interface PairingState {
  expiresAt: string;
  createdAt: string;
}

function digest(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function pairingPath(dir: string): string {
  return path.join(dir, PAIRING_FILE);
}

function generateCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    const bytes = randomBytes(CODE_GROUP_LEN);
    let group = "";
    for (const byte of bytes) {
      group += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/**
 * 生成配对码（覆盖旧码）。返回明文码与到期时间——明文只在此处出现一次。
 */
export function createPairingCode(
  dir: string,
  options: { ttlMs?: number; now?: () => Date } = {},
): { code: string; expiresAt: string } {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + ttlMs);
  const code = generateCode();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = pairingPath(dir);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        code_digest: digest(code),
        created_at: createdAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  return { code, expiresAt: expiresAt.toISOString() };
}

// ── 配对凭据（最小授权：由实例侧签发并持有，网关只拿到调用凭据）────────────

export const PAIRED_CREDENTIAL_FILE = "paired-credential.json";

function pairedCredentialPath(dir: string): string {
  return path.join(dir, PAIRED_CREDENTIAL_FILE);
}

/**
 * 为一次配对签发**新的**实例凭据（单槽：重配对即轮换，旧凭据立即失效）。
 *
 * 与静态 `KIWI_MERCHANT_MCP_TOKEN` 并存：静态令牌仍是运维自己的入口，
 * 配对凭据是给网关用的、可随时轮换的那一份。明文返回一次，落盘只存摘要。
 */
export function issuePairedCredential(
  dir: string,
  options: { now?: () => Date } = {},
): { credential: string; issuedAt: string } {
  const now = (options.now ?? (() => new Date()))();
  const credential = `pair_${randomBytes(24).toString("base64url")}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = pairedCredentialPath(dir);
  writeFileSync(
    file,
    `${JSON.stringify(
      { credential_digest: digest(credential), issued_at: now.toISOString() },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  return { credential, issuedAt: now.toISOString() };
}

/** 已签发的配对凭据摘要（无则 undefined）；供校验器逐请求比对。 */
export function readPairedCredentialDigest(dir: string): string | undefined {
  const file = pairedCredentialPath(dir);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { credential_digest?: unknown };
    return typeof raw.credential_digest === "string" && raw.credential_digest !== ""
      ? raw.credential_digest
      : undefined;
  } catch {
    return undefined;
  }
}

/** 校验一个候选凭据是否等于已签发的配对凭据（恒定时间比较）。 */
export function matchesPairedCredential(
  dir: string,
  candidate: string,
  deps: { compare?: (a: string, b: string) => boolean } = {},
): boolean {
  const expected = readPairedCredentialDigest(dir);
  if (expected === undefined) return false;
  const presented = digest(String(candidate ?? ""));
  const compare = deps.compare ?? ((a, b) => a.length === b.length && timingSafeEqualHex(a, b));
  return compare(presented, expected);
}

/** 吊销配对凭据（网关侧随后会因 401 而路由失败，直到重新配对）。 */
export function revokePairedCredential(dir: string): boolean {
  const file = pairedCredentialPath(dir);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 当前配对码状态（不含明文）；无码或已过期返回 undefined。 */
export function readPairingState(
  dir: string,
  options: { now?: () => Date } = {},
): PairingState | undefined {
  const file = pairingPath(dir);
  if (!existsSync(file)) return undefined;
  let raw: { created_at?: unknown; expires_at?: unknown };
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as typeof raw;
  } catch {
    return undefined;
  }
  const expiresAt = typeof raw.expires_at === "string" ? raw.expires_at : "";
  const createdAt = typeof raw.created_at === "string" ? raw.created_at : "";
  if (expiresAt === "") return undefined;
  const now = (options.now ?? (() => new Date()))();
  if (expiresAt <= now.toISOString()) return undefined;
  return { createdAt, expiresAt };
}

/**
 * 兑换配对码：成功即删除（单次），失败不动状态（仍可重试到过期）。
 */
export function redeemPairingCode(
  dir: string,
  code: string,
  options: { now?: () => Date } = {},
): boolean {
  const file = pairingPath(dir);
  if (!existsSync(file)) return false;
  const state = readPairingState(dir, options);
  if (state === undefined) {
    // 已过期：清理掉，避免残留
    rmSync(file, { force: true });
    return false;
  }
  let stored: { code_digest?: unknown };
  try {
    stored = JSON.parse(readFileSync(file, "utf8")) as typeof stored;
  } catch {
    return false;
  }
  if (typeof stored.code_digest !== "string" || stored.code_digest === "") return false;
  if (stored.code_digest !== digest(String(code ?? ""))) return false;
  rmSync(file, { force: true });
  return true;
}
