/**
 * Content-addressed Ledger payload segments.
 *
 * Ledger events keep the minimal audit envelope and a digest/reference for
 * potentially personal正文. Callers must retain the reference for as long as
 * the applicable retention policy requires; deleting a segment is explicit and
 * does not rewrite the append-only Ledger chain.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
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

export interface LedgerPayloadRedactionReceipt {
  receiptId: string;
  redactedAt: string;
  alreadyRedacted: boolean;
}

export class LedgerPayloadRedactedError extends Error {
  readonly code = "ledger_payload_redacted";
  readonly receiptId?: string;

  constructor(receiptId?: string) {
    super("Ledger payload was removed by a privacy request");
    this.name = "LedgerPayloadRedactedError";
    if (receiptId !== undefined) this.receiptId = receiptId;
  }
}

interface RedactionMarker {
  schema_version: 1;
  digest: string;
  redaction_id: string;
  receipt_id: string;
  redacted_at: string;
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
    if (existsSync(this.redactionPath(relative))) throw new LedgerPayloadRedactedError();
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

  /** Internal preflight helpers used to clean up failed segmented appends. */
  relativePathFor(value: unknown): string {
    const encoded = canonicalize(value);
    return `${sha256Hex(encoded)}.json`;
  }

  hasPath(relative: string): boolean {
    return existsSync(this.filePath(relative));
  }

  get<T = unknown>(ref: LedgerPayloadSegmentRef): T {
    const target = this.filePath(ref.path);
    const redaction = this.readRedaction(ref);
    if (redaction !== undefined) throw new LedgerPayloadRedactedError(redaction.receipt_id);
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

  /**
   * Permanently redact one verified content-addressed payload. The tombstone is
   * committed before unlinking bytes, so crashes fail closed and retries finish
   * the unlink. A later identical put is rejected to prevent resurrection.
   */
  redact(
    ref: LedgerPayloadSegmentRef,
    input: { redactionId: string; redactedAt?: string },
  ): LedgerPayloadRedactionReceipt {
    const target = this.filePath(ref.path);
    const redactionId = requireText(input.redactionId, "redactionId");
    const redactedAt = input.redactedAt ?? this.now();
    if (!Number.isFinite(Date.parse(redactedAt))) throw new Error("redactedAt must be an RFC 3339 timestamp");
    if (ref.digest !== `sha256:${ref.path.slice(0, -".json".length)}`) {
      throw new Error("Ledger payload reference digest/path mismatch");
    }
    const existing = this.readRedaction(ref);
    if (existing !== undefined) {
      this.removeVerifiedTarget(target, ref.digest);
      return { receiptId: existing.receipt_id, redactedAt: existing.redacted_at, alreadyRedacted: true };
    }
    if (!existsSync(target)) throw new Error("cannot redact a missing Ledger payload without a tombstone");
    this.assertDigest(target, ref.digest);
    this.ensureRedactionsDir();
    const marker: RedactionMarker = {
      schema_version: 1,
      digest: ref.digest,
      redaction_id: redactionId,
      receipt_id: `lpr_${randomBytes(18).toString("base64url")}`,
      redacted_at: redactedAt,
    };
    const wrote = this.writeRedactionMarker(ref, marker);
    const committed = this.readRedaction(ref);
    if (committed === undefined) throw new Error("Ledger payload redaction marker was not committed");
    this.removeVerifiedTarget(target, ref.digest);
    return {
      receiptId: committed.receipt_id,
      redactedAt: committed.redacted_at,
      alreadyRedacted: !wrote,
    };
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

  private ensureRedactionsDir(): string {
    const redactions = path.join(this.dir, ".redactions");
    mkdirSync(redactions, { recursive: true, mode: 0o700 });
    const redactionsStat = lstatSync(redactions);
    if (!redactionsStat.isDirectory() || redactionsStat.isSymbolicLink()) {
      throw new Error("Ledger payload redaction directory is not a real directory");
    }
    chmodSync(redactions, 0o700);
    return redactions;
  }

  private redactionPath(relative: string): string {
    if (!/^[0-9a-f]{64}\.json$/u.test(relative)) throw new Error("invalid Ledger payload segment path");
    return path.join(this.dir, ".redactions", relative.slice(0, -".json".length) + ".json");
  }

  private readRedaction(ref: LedgerPayloadSegmentRef): RedactionMarker | undefined {
    const markerPath = this.redactionPath(ref.path);
    const redactionsDir = path.dirname(markerPath);
    if (existsSync(redactionsDir)) {
      const directoryStat = lstatSync(redactionsDir);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error("Ledger payload redaction directory is not a real directory");
      }
    }
    if (!existsSync(markerPath)) return undefined;
    const stat = lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Ledger payload redaction marker is not a regular file");
    }
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<RedactionMarker>;
    if (
      parsed.schema_version !== 1 ||
      parsed.digest !== ref.digest ||
      typeof parsed.redaction_id !== "string" ||
      parsed.redaction_id.trim() === "" ||
      typeof parsed.receipt_id !== "string" ||
      parsed.receipt_id.trim() === "" ||
      typeof parsed.redacted_at !== "string" ||
      !Number.isFinite(Date.parse(parsed.redacted_at))
    ) {
      throw new Error("Ledger payload redaction marker is invalid");
    }
    return parsed as RedactionMarker;
  }

  private writeRedactionMarker(ref: LedgerPayloadSegmentRef, marker: RedactionMarker): boolean {
    const markerPath = this.redactionPath(ref.path);
    const temporary = `${markerPath}.tmp-${process.pid}-${sequence++}`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(marker));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // A hard-link publish is atomic and exclusive: concurrent requests share
      // the first opaque receipt instead of overwriting each other's marker.
      linkSync(temporary, markerPath);
      unlinkSync(temporary);
      chmodSync(markerPath, 0o600);
      return true;
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* best-effort temp cleanup */ }
      if ((error as { code?: string }).code === "EEXIST") return false;
      throw error;
    }
  }

  private removeVerifiedTarget(target: string, digest: string): void {
    if (!existsSync(target)) return;
    this.assertDigest(target, digest);
    unlinkSync(target);
    if (existsSync(target)) throw new Error("Ledger payload bytes remain after redaction");
  }

  private assertDigest(target: string, digest: string): void {
    const encoded = readFileSync(target, "utf8");
    const actual = `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
    if (actual !== digest) throw new Error("Ledger payload segment digest mismatch");
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

function requireText(value: string, field: string): string {
  const text = String(value ?? "").trim();
  if (text.length === 0 || text.length > 256) throw new Error(`${field} must contain 1..256 characters`);
  return text;
}
