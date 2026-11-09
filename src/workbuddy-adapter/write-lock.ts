/**
 * 适配器本机数据目录的跨进程写互斥。
 *
 * - 锁文件只保存 PID/时间/随机 nonce，不保存 token、分享码或密钥；
 * - 有界等待；超时 fail-closed，不按 TTL 删除可能仍活动的锁；
 * - 崩溃遗留锁不会被自动清理，后续写操作 fail-closed，需人工处理；
 * - release 仅在 nonce 匹配时 unlink，不删除被其他进程替换的锁。
 * - refresh 的读/判过期/有界网络刷新/保存可在锁内完成；浏览器授权等待绝不持锁。
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export const ADAPTER_STATE_LOCK_FILE = ".state-write.lock";
// Must exceed the OAuth HTTP timeout (12s) so a waiter can observe the
// refreshed token instead of racing it; still strictly bounded.
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 25;

export class AdapterStateLockError extends Error {
  readonly code = "state_write_lock_busy";
  constructor(message = "adapter state write lock busy") {
    super(message);
    this.name = "AdapterStateLockError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 在 dataDir 级写锁内执行 fn；网络 refresh 可在锁内，但浏览器等待不得在锁内。 */
export async function withAdapterStateLock<T>(
  dataDir: string,
  fn: () => Promise<T> | T,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, ADAPTER_STATE_LOCK_FILE);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let fd: number;
    try {
      // Existing locks are never TTL-deleted: a crashed owner leaves a lock that
      // requires explicit operator cleanup, so active locks can never be stolen.
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        if (Date.now() >= deadline) throw new AdapterStateLockError();
        await sleep(pollMs);
        continue;
      }
      throw error;
    }
    const nonce = randomBytes(16).toString("base64url");
    try {
      writeSync(
        fd,
        `${JSON.stringify({
          pid: process.pid,
          created_at: new Date().toISOString(),
          nonce,
        })}\n`,
      );
      fsyncSync(fd);
    } catch (error) {
      // We exclusively created this file and have not run fn; remove our own
      // incomplete lock so metadata-write failure does not strand the data dir.
      try {
        unlinkSync(lockPath);
      } catch {
        // fail-closed if cleanup itself fails
      }
      throw error;
    } finally {
      closeSync(fd);
    }
    try {
      return await fn();
    } finally {
      try {
        const raw = readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { nonce?: unknown };
        if (parsed.nonce === nonce) unlinkSync(lockPath);
      } catch {
        // A lock we cannot prove we own is left in place; fail-closed on next write.
      }
    }
  }
}
