// Copyright 2026 harrylabsj
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * 商家侧可信买家公钥登记（B-05 的运维闭环）。
 *
 * 受保护操作（`GetTask` / `ListTasks` / `CancelTask` / `GetExtendedAgentCard`）
 * 需要已验证身份；买家配了 `a2aSigningKeyDir` 就会用自持 Ed25519 密钥签名，
 * 但商家得先认识这把钥匙——条目写进运行时数据目录下的
 * `a2a-trusted-keys.json`（运行时**每次请求重新读**，登记后立即生效）。
 *
 * 本模块只做"校验 + 原子写入"，不联网、不猜：
 *   - 公钥必须是可解析的 Ed25519 SPKI PEM；
 *   - keyid 不能与已有条目冲突（冲突即拒绝，不覆盖）；
 *   - 文件必须是数组（运行时 fail-closed，这里同样不让它变坏）。
 */

import { createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../fs/atomic-write.js";

export const TRUSTED_KEYS_FILE = "a2a-trusted-keys.json";

export interface TrustedBuyerKey {
  keyid: string;
  /** PEM 文本（SPKI，Ed25519）。 */
  publicKeyPem: string;
  profile?: {
    identity?: string;
    organization?: string;
    role?: "buyer" | "merchant";
    trustLevel?: "T0" | "T1" | "T2" | "T3";
  };
}

export class TrustedKeysError extends Error {
  readonly code:
    | "INVALID_PEM"
    | "INVALID_KEYID"
    | "DUPLICATE_KEYID"
    | "MALFORMED_FILE"
    | "NOT_ED25519";

  constructor(code: TrustedKeysError["code"], message: string) {
    super(message);
    this.name = "TrustedKeysError";
    this.code = code;
  }
}

const KEYID_RE = /^[A-Za-z0-9._:@/-]{1,255}$/;

/** 校验公钥 PEM：必须是 Ed25519。返回规范化后的 PEM。 */
export function normalizeEd25519Pem(pem: string): string {
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new TrustedKeysError("INVALID_PEM", "公钥不是可解析的 PEM");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new TrustedKeysError("NOT_ED25519", "只接受 Ed25519 公钥（RFC 9421 出站签名用）");
  }
  return key.export({ type: "spki", format: "pem" }).toString();
}

export function trustedKeysPath(dataDir: string): string {
  return path.join(dataDir, TRUSTED_KEYS_FILE);
}

/** 读取现有条目；文件不存在视为空列表，格式不对抛错（不改写坏文件）。 */
export function readTrustedKeys(file: string): TrustedBuyerKey[] {
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new TrustedKeysError("MALFORMED_FILE", "a2a-trusted-keys.json 不是合法 JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new TrustedKeysError("MALFORMED_FILE", "a2a-trusted-keys.json 必须是数组");
  }
  return parsed as TrustedBuyerKey[];
}

/**
 * 追加一条可信买家公钥并原子写入。返回是否新增（重复 keyid 直接拒绝，
 * 不静默覆盖——运营要改就用 `--replace`）。
 */
export function addTrustedBuyerKey(
  file: string,
  entry: TrustedBuyerKey,
  options: { replace?: boolean } = {},
): { added: boolean; path: string } {
  const keyid = String(entry.keyid ?? "").trim();
  if (!KEYID_RE.test(keyid)) {
    throw new TrustedKeysError("INVALID_KEYID", "keyid 非法（1–255 个字母数字或 ._:@/-）");
  }
  const publicKeyPem = normalizeEd25519Pem(String(entry.publicKeyPem ?? ""));
  const existing = readTrustedKeys(file);
  const index = existing.findIndex((item) => item.keyid === keyid);
  if (index >= 0 && options.replace !== true) {
    throw new TrustedKeysError("DUPLICATE_KEYID", `keyid 已存在：${keyid}（如需更换请显式 --replace）`);
  }
  const next: TrustedBuyerKey = {
    keyid,
    publicKeyPem,
    ...(entry.profile !== undefined ? { profile: entry.profile } : {}),
  };
  const merged = index >= 0 ? existing.map((item, i) => (i === index ? next : item)) : [...existing, next];
  writeFileAtomic(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return { added: index < 0, path: file };
}
