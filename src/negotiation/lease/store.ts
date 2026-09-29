/** Append-only, cross-process file lease with persistent monotonic fencing tokens. */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export interface FileLeaseHandle {
  key: string;
  owner: string;
  fencingToken: number;
  expiresAt: number;
}

interface ClaimRecord {
  owner: string;
  expires_at: number;
}

interface LeaseSnapshot extends FileLeaseHandle {
  released: boolean;
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._:-]/g, "_");
}

export class FileLeaseStore {
  private readonly nowMs: () => number;

  constructor(
    private readonly dir: string,
    options: { nowMs?: () => number } = {},
  ) {
    this.nowMs = options.nowMs ?? Date.now;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  acquire(key: string, owner: string, ttlMs: number): FileLeaseHandle | undefined {
    requireLeaseInput(key, owner, ttlMs);
    const journal = this.journal(key);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = this.snapshot(key, journal);
      const now = this.nowMs();
      if (current !== undefined && !current.released && current.expiresAt >= now) {
        return undefined;
      }
      const fencingToken = (current?.fencingToken ?? 0) + 1;
      const expiresAt = now + ttlMs;
      try {
        writeExclusive(
          join(journal, `claim-${fencingToken}.json`),
          JSON.stringify({ owner, expires_at: expiresAt }),
        );
        return { key, owner, fencingToken, expiresAt };
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") return undefined;
      }
    }
    return undefined;
  }

  renew(lease: FileLeaseHandle, ttlMs: number): FileLeaseHandle | undefined {
    requireLeaseInput(lease.key, lease.owner, ttlMs);
    const journal = this.journal(lease.key);
    if (!this.matchesCurrent(lease, journal)) return undefined;
    const expiresAt = this.nowMs() + ttlMs;
    try {
      writeExclusive(
        join(journal, `renew-${lease.fencingToken}-${randomUUID()}.json`),
        JSON.stringify({ owner: lease.owner, expires_at: expiresAt }),
      );
    } catch {
      return undefined;
    }
    const renewed = { ...lease, expiresAt };
    return this.matchesCurrent(renewed, journal) ? renewed : undefined;
  }

  release(lease: FileLeaseHandle): boolean {
    const journal = this.journal(lease.key);
    const current = this.snapshot(lease.key, journal);
    if (
      current === undefined ||
      current.fencingToken !== lease.fencingToken ||
      current.owner !== lease.owner
    ) {
      return false;
    }
    const marker = join(journal, `release-${lease.fencingToken}.json`);
    if (existsSync(marker)) return true;
    try {
      writeExclusive(marker, JSON.stringify({ owner: lease.owner, released_at: this.nowMs() }));
      return true;
    } catch (error) {
      return (error as { code?: string }).code === "EEXIST";
    }
  }

  isCurrent(lease: FileLeaseHandle): boolean {
    return this.matchesCurrent(lease, this.journal(lease.key));
  }

  private matchesCurrent(lease: FileLeaseHandle, journal: string): boolean {
    const current = this.snapshot(lease.key, journal);
    return (
      current !== undefined &&
      !current.released &&
      current.fencingToken === lease.fencingToken &&
      current.owner === lease.owner &&
      current.expiresAt >= this.nowMs()
    );
  }

  private journal(key: string): string {
    const safe = safeKey(key);
    const journal = join(this.dir, `lease-${safe}`);
    mkdirSync(journal, { recursive: true, mode: 0o700 });
    const legacy = join(this.dir, `lease-${safe}.json`);
    const firstClaim = join(journal, "claim-1.json");
    if (existsSync(legacy) && !existsSync(firstClaim)) {
      try {
        renameSync(legacy, firstClaim);
      } catch {
        // Another process migrated or replaced the legacy lease; rescan below.
      }
    }
    return journal;
  }

  private snapshot(key: string, journal: string): LeaseSnapshot | undefined {
    const files = readdirSync(journal);
    let token = 0;
    for (const file of files) {
      const match = /^claim-(\d+)\.json$/.exec(file);
      if (match !== null) token = Math.max(token, Number(match[1]));
    }
    if (token === 0) return undefined;
    const claim = readRecord(join(journal, `claim-${token}.json`));
    const owner = claim?.owner ?? "";
    let expiresAt = claim?.expires_at ?? Number.NEGATIVE_INFINITY;
    for (const file of files) {
      if (!file.startsWith(`renew-${token}-`) || !file.endsWith(".json")) continue;
      const renewal = readRecord(join(journal, file));
      if (renewal?.owner === owner) expiresAt = Math.max(expiresAt, renewal.expires_at);
    }
    return {
      key,
      owner,
      fencingToken: token,
      expiresAt,
      released: existsSync(join(journal, `release-${token}.json`)),
    };
  }
}

function readRecord(file: string): ClaimRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<ClaimRecord>;
    return typeof value.owner === "string" && Number.isFinite(value.expires_at)
      ? { owner: value.owner, expires_at: Number(value.expires_at) }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 独占写：读者要么看不到文件，要么看到完整内容。
 *
 * 实现为「同目录临时文件写穿 + fsync + linkSync 原子发布」：
 * link(2) 创建硬链接是原子操作，目标已存在时抛 EEXIST——等价于
 * open(wx) 的「仅当不存在」语义，但发布时内容必然已完整落盘。
 * 直接用 open(wx) 写最终名会留下「文件已创建、内容未写完」的撕裂窗口，
 * 并发 acquire 的对方读到空文件后会把一条**仍在写入的** claim 误判为
 * 可接管对象，发出第二个 fencing token（单 owner 语义被破坏）。
 * 崩溃残留只会留下无人引用的 tmp 文件（只按 claim-N.json 名识别，
 * 不参与判定），过期清理可安全忽略。
 */
function writeExclusive(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function requireLeaseInput(key: string, owner: string, ttlMs: number): void {
  if (key.trim() === "" || owner.trim() === "") throw new Error("lease key and owner are required");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("lease ttlMs must be a positive integer");
  }
}
