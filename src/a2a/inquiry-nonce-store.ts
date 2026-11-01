/** Durable replay protection for automatic open-inquiry session signatures. */
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NonceStore } from "../trust/identity/nonce.js";

/** No active nonce is evicted to make space: a full store fails closed. */
export class InquiryNonceStore implements NonceStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(dataDir: string, options: { now?: () => number; maxEntries?: number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 100_000;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 ||
        !Number.isSafeInteger(this.ttlMs) || this.ttlMs < 30 * 60_000)
      throw new Error("invalid inquiry nonce store limits");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, "open-inquiry-nonces.sqlite");
    if (existsSync(file)) {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid inquiry nonce store file");
    } else {
      closeSync(openSync(file, "wx", 0o600));
    }
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2500; " +
      "CREATE TABLE IF NOT EXISTS inquiry_nonces (nonce_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL); " +
      "CREATE INDEX IF NOT EXISTS inquiry_nonces_expiry ON inquiry_nonces(expires_at)");
  }

  checkAndSet(key: string): boolean {
    if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
    const now = this.now();
    if (!Number.isSafeInteger(now)) return false;
    const hash = createHash("sha256").update(key).digest("hex");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.prepare("DELETE FROM inquiry_nonces WHERE expires_at <= ?").run(now);
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM inquiry_nonces").get() as { n: number };
      if (row.n >= this.maxEntries) { this.db.exec("ROLLBACK"); return false; }
      const inserted = this.db.prepare("INSERT OR IGNORE INTO inquiry_nonces VALUES (?, ?)").run(hash, now + this.ttlMs);
      this.db.exec("COMMIT");
      return Number(inserted.changes) === 1;
    } catch {
      try { this.db.exec("ROLLBACK"); } catch { /* No active transaction. */ }
      return false;
    }
  }

  close(): void { this.db.close(); }
}
