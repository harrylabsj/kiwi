/**
 * Content-addressed Ledger payload segments.
 *
 * Ledger events keep the minimal audit envelope and a digest/reference for
 * potentially personal正文. Callers must retain the reference for as long as
 * the applicable retention policy requires; deleting a segment is explicit and
 * does not rewrite the append-only Ledger chain.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { canonicalize, sha256Hex } from "../jcs.js";
import { assertNoForbiddenContent } from "./event.js";

export interface LedgerPayloadSegmentRef {
  digest: string;
  bytes: number;
  path: string;
  created_at: string;
}

export interface LedgerPayloadSegmentStoreOptions {
  dir: string;
  now?: () => string;
}

let sequence = 0;

/** Separate, content-addressed storage for personal or large Ledger正文. */
export class LedgerPayloadSegmentStore {
  private readonly dir: string;
  private readonly now: () => string;

  constructor(options: LedgerPayloadSegmentStoreOptions) {
    this.dir = path.resolve(options.dir);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  put(value: unknown): LedgerPayloadSegmentRef {
    assertNoForbiddenContent(value);
    const encoded = canonicalize(value);
    const digest = `sha256:${sha256Hex(encoded)}`;
    const relative = `${digest.slice("sha256:".length)}.json`;
    const target = this.filePath(relative);
    this.ensureDir();
    if (!existsSync(target)) {
      const temporary = `${target}.tmp-${process.pid}-${++sequence}`;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeSync(fd, encoded);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, target);
      chmodSync(target, 0o600);
    }
    return { digest, bytes: Buffer.byteLength(encoded), path: relative, created_at: this.now() };
  }

  get<T = unknown>(ref: LedgerPayloadSegmentRef): T {
    const target = this.filePath(ref.path);
    const encoded = readFileSync(target, "utf8");
    const actual = `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
    if (actual !== ref.digest) throw new Error("Ledger payload segment digest mismatch");
    return JSON.parse(encoded) as T;
  }

  remove(ref: LedgerPayloadSegmentRef): boolean {
    const target = this.filePath(ref.path);
    if (!existsSync(target)) return false;
    unlinkSync(target);
    return true;
  }

  /** Remove unreferenced/expired segments selected by the caller's cutoff. */
  prune(cutoff: string): number {
    const cutoffMs = Date.parse(cutoff);
    if (!Number.isFinite(cutoffMs)) throw new Error("invalid payload segment cutoff");
    this.ensureDir();
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      if (!/^[0-9a-f]{64}\.json$/u.test(name)) continue;
      const full = path.join(this.dir, name);
      if (statSync(full).mtimeMs < cutoffMs) {
        rmSync(full, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  private filePath(relative: string): string {
    if (!/^[0-9a-f]{64}\.json$/u.test(relative)) {
      throw new Error("invalid Ledger payload segment path");
    }
    const resolved = path.resolve(this.dir, relative);
    if (!resolved.startsWith(`${this.dir}${path.sep}`)) throw new Error("payload path escapes store");
    return resolved;
  }
}
