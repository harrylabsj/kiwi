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
 * 微信通道凭证与同步游标持久化——0600、原子写、损坏 fail-closed。
 *
 * - `weixin-credentials.json`：bot 凭证（token/base_url/user_id/saved_at）；
 * - `weixin-sync-buf.json`：getupdates 游标 + 去重指纹（重启零丢失）。
 * 写文件用 tmp + renameSync 原子替换（防崩溃半写）；损坏/缺字段一律
 * WeixinError（fail-closed，拒绝静默重扫）。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { WeixinError } from "./types.js";
import type { BotCredentials } from "./types.js";

/** 凭证文件内容（wire 形状）。 */
interface StoredCredentials {
  ilink_bot_id: string;
  bot_token: string;
  base_url: string;
  ilink_user_id: string;
  saved_at: string;
}

/** 同步游标 + 去重指纹（seen = MD5 指纹 LRU，cap 由调用方裁剪）。 */
export interface StoredSyncState {
  get_updates_buf: string;
  seen: string[];
}

/** 保存凭证（0600 + 原子写）。 */
export function saveCredentials(pathName: string, creds: BotCredentials): void {
  const payload: StoredCredentials = {
    ilink_bot_id: creds.ilink_bot_id,
    bot_token: creds.bot_token,
    base_url: creds.base_url,
    ilink_user_id: creds.ilink_user_id,
    saved_at: creds.saved_at,
  };
  atomicWrite(pathName, JSON.stringify(payload));
}

/** 加载凭证；缺失 → not_configured；损坏/缺字段 → validation（fail-closed）。 */
export function loadCredentials(pathName: string): BotCredentials {
  if (!existsSync(pathName)) {
    throw new WeixinError("not_configured", `微信凭证不存在：${pathName}（请先 kiwi weixin 扫码登录）`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(pathName, "utf-8"));
  } catch {
    throw new WeixinError("validation", `微信凭证文件损坏：${pathName}`);
  }
  if (!isRecord(raw)) throw new WeixinError("validation", `微信凭证文件格式错误：${pathName}`);
  for (const key of ["ilink_bot_id", "bot_token", "base_url", "ilink_user_id", "saved_at"] as const) {
    if (typeof raw[key] !== "string") {
      throw new WeixinError("validation", `微信凭证缺少字段 ${key}：${pathName}`);
    }
  }
  return {
    ilink_bot_id: raw.ilink_bot_id as string,
    bot_token: raw.bot_token as string,
    base_url: raw.base_url as string,
    ilink_user_id: raw.ilink_user_id as string,
    saved_at: raw.saved_at as string,
  };
}

/** 保存同步游标 + 去重指纹（0600 + 原子写）。 */
export function saveSyncState(pathName: string, state: StoredSyncState): void {
  atomicWrite(pathName, JSON.stringify(state));
}

/** 加载同步游标；缺失 → 默认（空游标）；损坏 → validation（fail-closed）。 */
export function loadSyncState(pathName: string): StoredSyncState {
  if (!existsSync(pathName)) {
    return { get_updates_buf: "", seen: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(pathName, "utf-8"));
  } catch {
    throw new WeixinError("validation", `微信同步状态文件损坏：${pathName}`);
  }
  if (!isRecord(raw)) throw new WeixinError("validation", `微信同步状态文件格式错误：${pathName}`);
  const buf = raw.get_updates_buf;
  const seen = raw.seen;
  if (typeof buf !== "string" || !Array.isArray(seen) || !seen.every((s) => typeof s === "string")) {
    throw new WeixinError("validation", `微信同步状态字段错误：${pathName}`);
  }
  return { get_updates_buf: buf, seen: seen as string[] };
}

// ── 内部：原子写（tmp + fsync + rename，0600）───────────────────────────

let _atomicWriteSeq = 0;

function atomicWrite(pathName: string, content: string): void {
  // 审查 K-L12：固定 tmp 名并发写互相覆盖 + rename ENOENT + 无 fsync。改
  // 唯一 tmp 名（pid + 序号，同进程并发也唯一）+ 独占 open("wx") + fsync +
  // rename（对齐 supervisor/manifest.ts 的原子写模式）。
  const tmp = `${pathName}.tmp-${process.pid}-${_atomicWriteSeq++}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, pathName);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 便捷：凭证文件路径（dataDir 下）。 */
export function credentialsPathFor(dataDir: string): string {
  return path.join(dataDir, "weixin-credentials.json");
}

/** 便捷：同步状态文件路径（dataDir 下）。 */
export function syncStatePathFor(dataDir: string): string {
  return path.join(dataDir, "weixin-sync-buf.json");
}
