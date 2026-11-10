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
 * 崩溃残留锁的统一接管判定（review P1-4/P1-8）。
 *
 * 只接管**可证明已死**的持有者：同一 host、记录带 pid，且 boot_id 证明是上一次
 * 启动（或 pid 已不存在）。不同 host / 无法证明时保持 fail-closed，交给显式
 * 恢复；绝不按 mtime 盲删。
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export interface LockOwnerRecord {
  token: string;
  pid: number;
  host: string;
  boot_id?: string;
}

export function currentBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function lockOwnerRecord(token: string): LockOwnerRecord {
  const boot = currentBootId();
  return {
    token,
    pid: process.pid,
    host: hostname(),
    ...(boot === undefined ? {} : { boot_id: boot }),
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但属于其他用户 → 视为存活（不可接管）。
    return (error as { code?: string }).code !== "ESRCH";
  }
}

export interface LockTakeoverOptions {
  currentHost?: string;
  currentBootId?: () => string | undefined;
  isAlive?: (pid: number) => boolean;
}

/** 解析并判定残留锁是否可由当前进程接管；任何不确定字段一律 false。 */
export function canTakeOverStaleLock(
  raw: string,
  options: LockTakeoverOptions = {},
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  const record = parsed as Record<string, unknown>;
  if (typeof record.token !== "string" || record.token === "") return false;
  if (typeof record.host !== "string" || record.host !== (options.currentHost ?? hostname())) return false;
  if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
  // 上电周期不同 → 旧进程必然已死（pid 可能被复用），接管安全。
  const boot = (options.currentBootId ?? currentBootId)();
  if (typeof record.boot_id === "string" && boot !== undefined && record.boot_id !== boot) return true;
  return !(options.isAlive ?? isProcessAlive)(record.pid);
}
