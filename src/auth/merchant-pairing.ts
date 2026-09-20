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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PAIRING_FILE = "pairing.json";
export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

/** 无歧义字母表（去掉 0/O/1/I/L），便于商家手抄。 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 4;

/**
 * 配对码的**绑定元组**（设计 §6.3：单次消费、短 TTL，绑定
 * merchant_id/intent_id/generation/公钥摘要/回跳目标；重放、过期、跨商家和
 * 另一部署代次均拒绝）。
 */
export interface PairingBinding {
  merchant_id: string;
  /** 开通意图（同一商家的多次开通相互区分）。 */
  intent_id?: string;
  /** 部署代次：换代次后旧配对码失效。 */
  generation: number;
  /** Runtime 公钥指纹：配对必须指向同一把钥匙。 */
  key_thumbprint: string;
  /** 回跳目标（可选）：只作为记录，不参与放行判定。 */
  redirect_target?: string;
}

export interface PairingState {
  expiresAt: string;
  createdAt: string;
  /** 绑定元组（旧格式配对文件没有这个字段——视为未绑定，按旧语义放行）。 */
  binding?: PairingBinding;
}

function digest(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function pairingPath(dir: string): string {
  return path.join(dir, PAIRING_FILE);
}

/** 拒绝采样的接受上限：256 不是字母表长度的整数倍，尾部余数区间必须丢弃。 */
const CODE_ALPHABET_ACCEPT_LIMIT = 256 - (256 % CODE_ALPHABET.length);

/**
 * 生成一组字符（无偏）。
 *
 * `byte % 31` 直接取模会让字母表前 8 个字符的概率高出 1/8（9/256 vs 8/256），
 * 因此丢弃落在不完整区间尾部的字节（约 3% 拒绝率）。
 */
function randomGroup(): string {
  let group = "";
  while (group.length < CODE_GROUP_LEN) {
    for (const byte of randomBytes(CODE_GROUP_LEN - group.length)) {
      if (byte >= CODE_ALPHABET_ACCEPT_LIMIT) continue;
      group += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return group;
}

function generateCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) groups.push(randomGroup());
  return groups.join("-");
}

/**
 * 生成配对码（覆盖旧码）。返回明文码与到期时间——明文只在此处出现一次。
 */
export function createPairingCode(
  dir: string,
  options: { ttlMs?: number; now?: () => Date; binding?: PairingBinding } = {},
): { code: string; expiresAt: string; binding?: PairingBinding } {
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
        ...(options.binding !== undefined ? { binding: options.binding } : {}),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  return {
    code,
    expiresAt: expiresAt.toISOString(),
    ...(options.binding !== undefined ? { binding: options.binding } : {}),
  };
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
  const bindingRaw = (raw as { binding?: unknown }).binding;
  const binding =
    bindingRaw !== null &&
    typeof bindingRaw === "object" &&
    typeof (bindingRaw as PairingBinding).merchant_id === "string" &&
    typeof (bindingRaw as PairingBinding).generation === "number" &&
    typeof (bindingRaw as PairingBinding).key_thumbprint === "string"
      ? (bindingRaw as PairingBinding)
      : undefined;
  return { createdAt, expiresAt, ...(binding !== undefined ? { binding } : {}) };
}

/**
 * 兑换配对码：成功即删除（单次），失败不动状态（仍可重试到过期）。
 *
 * 绑定校验（T025/T027）：调用方给出期望的 merchant/generation/公钥指纹时，
 * 必须与配对码内的绑定元组**逐项一致**——跨商家、异代次、换钥匙一律拒绝。
 * 未给出期望值（旧调用方）时按旧语义放行（向后兼容）。
 */
export type PairingRedeemOutcome =
  | { ok: true; binding?: PairingBinding }
  | {
      ok: false;
      code: "no_code" | "expired" | "invalid_code" | "replayed" | "binding_mismatch";
      reason?: string;
    };

/**
 * 兑换配对码（原子单次消费 + 绑定校验）。成功返回绑定元组；失败给出稳定原因。
 *
 * 原子性：单次消费用 **rename 竞争**实现——并发/重放兑换里只有 rename 成功的那
 * 一个赢家（其余拿到 ENOENT），因此"第二次兑换"必然失败（T026），不依赖
 * 读-删之间的时间窗。
 */
export function redeemPairingCodeBound(
  dir: string,
  code: string,
  options: {
    now?: () => Date;
    expect?: { merchant_id?: string; generation?: number; key_thumbprint?: string };
  } = {},
): PairingRedeemOutcome {
  const file = pairingPath(dir);
  if (!existsSync(file)) return { ok: false, code: "no_code" };
  const state = readPairingState(dir, options);
  if (state === undefined) {
    rmSync(file, { force: true }); // 过期即清理，避免残留
    return { ok: false, code: "expired" };
  }
  let stored: { code_digest?: unknown };
  try {
    stored = JSON.parse(readFileSync(file, "utf8")) as typeof stored;
  } catch {
    return { ok: false, code: "invalid_code" };
  }
  if (typeof stored.code_digest !== "string" || stored.code_digest === "") {
    return { ok: false, code: "invalid_code" };
  }
  // 恒定时间比较：配对码是短码，明文比较会泄漏前缀（审查口径与凭据校验一致）。
  const expected = Buffer.from(stored.code_digest, "hex");
  const presented = Buffer.from(digest(String(code ?? "")), "hex");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return { ok: false, code: "invalid_code" };
  }
  // 绑定校验（T025/T027）：给出期望值时必须逐项一致。
  const binding = state.binding;
  const expect = options.expect;
  if (expect !== undefined && binding !== undefined) {
    if (expect.merchant_id !== undefined && expect.merchant_id !== binding.merchant_id) {
      return { ok: false, code: "binding_mismatch", reason: "merchant_id" };
    }
    if (expect.generation !== undefined && expect.generation !== binding.generation) {
      return { ok: false, code: "binding_mismatch", reason: "generation" };
    }
    if (expect.key_thumbprint !== undefined && expect.key_thumbprint !== binding.key_thumbprint) {
      return { ok: false, code: "binding_mismatch", reason: "key_thumbprint" };
    }
  }
  // 原子单次消费：rename 成功者才是赢家（并发/重放只有一个能成功）。
  const consumed = `${file}.consumed`;
  try {
    renameSync(file, consumed);
  } catch {
    return { ok: false, code: "replayed" };
  }
  rmSync(consumed, { force: true });
  return { ok: true, ...(binding !== undefined ? { binding } : {}) };
}

/**
 * 兼容薄封装（旧调用方）：只回答"兑换是否成功"。
 * 新代码请用 redeemPairingCodeBound 取绑定元组与失败原因。
 */
export function redeemPairingCode(
  dir: string,
  code: string,
  options: { now?: () => Date } = {},
): boolean {
  return redeemPairingCodeBound(dir, code, options).ok;
}
