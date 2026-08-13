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
 * 文件租约（审查 BUG-07）：按 key 的独占 ownership/lease，覆盖
 * `check → 网络副作用 → ledger → commit` 全临界区——同进程与共享持久目录
 * 的跨进程执行使用同一语义（exclusive create + TTL + 崩溃接管 + fencing）。
 *
 * - acquire：exclusive create；已存在且未过期 → 失败（另一 owner 在跑）；
 *   已存在且过期（崩溃残留）→ 接管；
 * - renew：长操作心跳续租（仅 owner）；
 * - release：仅 owner 可释放（fencing——旧 owner 的迟到释放不得删除新
 *   owner 的租约）。
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

interface LeaseRecord {
  owner: string;
  expires_at: number;
}

function leasePath(dir: string, key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._:-]/g, "_");
  return join(dir, `lease-${safe}.json`);
}

export class FileLeaseStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 获取独占租约；被占且未过期 → false；崩溃残留（过期）→ 接管重试。 */
  acquire(key: string, owner: string, ttlMs: number): boolean {
    const path = leasePath(this.dir, key);
    const now = Date.now();
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ owner, expires_at: now + ttlMs }));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") return false;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as LeaseRecord;
        if (parsed.expires_at !== undefined && parsed.expires_at < now) {
          unlinkSync(path); // 崩溃残留：接管
          return this.acquire(key, owner, ttlMs);
        }
        return false; // 有效租约：另一 owner 在执行
      } catch {
        // 读/解析失败（半写残留）：视为可接管
        try {
          unlinkSync(path);
        } catch {
          // 并发接管竞争：失败即返回 false（保守）
        }
        return this.acquire(key, owner, ttlMs);
      }
    }
  }

  /** 续租（长操作心跳）；仅 owner 可续。 */
  renew(key: string, owner: string, ttlMs: number): boolean {
    const path = leasePath(this.dir, key);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as LeaseRecord;
      if (parsed.owner !== owner) return false; // fencing：不是我的租约
      // 审查 K-L6：截断重写（open "w"）非原子且无 fsync——崩溃留半写文件、
      // 旧 owner 截断写可覆盖新租约。改 tmp + fsync + rename 原子写（对齐
      // acquire 的 wx 模式与 supervisor/manifest.ts 约定）。
      const tmp = `${path}.tmp-${process.pid}`;
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ owner, expires_at: Date.now() + ttlMs }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
      return true;
    } catch {
      return false;
    }
  }

  /** 释放；仅 owner 可释放（fencing——旧 owner 迟到释放不得删新 owner）。 */
  release(key: string, owner: string): void {
    const path = leasePath(this.dir, key);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as LeaseRecord;
      if (parsed.owner !== owner) return;
      unlinkSync(path);
    } catch {
      // 已不存在/解析失败：忽略
    }
  }
}
