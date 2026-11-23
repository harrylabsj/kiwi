/** Durable replay protection for signed A2A and open-inquiry requests. */
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NonceStore, NonceWriteResult } from "../trust/identity/nonce.js";

export type NonceStoreUnavailable = "capacity" | "storage";
const TABLES = {
  legacy: "inquiry_nonces",
  signed: "signed_nonces",
  open_inquiry: "open_session_nonces",
} as const;
export type NonceScope = keyof typeof TABLES;

/** No active nonce is evicted to make space: a full store fails closed. */
export class InquiryNonceStore implements NonceStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly onUnavailable?: (reason: NonceStoreUnavailable, scope: NonceScope) => void;

  constructor(dataDir: string, options: {
    now?: () => number;
    maxEntries?: number;
    ttlMs?: number;
    onUnavailable?: (reason: NonceStoreUnavailable, scope: NonceScope) => void;
  } = {}) {
    this.onUnavailable = options.onUnavailable;
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
    try {
      this.db.exec("PRAGMA busy_timeout=2500; PRAGMA journal_mode=WAL");
      for (const table of Object.values(TABLES)) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (nonce_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL); ` +
          `CREATE INDEX IF NOT EXISTS ${table}_expiry ON ${table}(expires_at)`);
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  checkAndSet(key: string): boolean { return this.record(key) === "fresh"; }

  record(key: string, scope: NonceScope = "legacy"): NonceWriteResult {
    const now = this.now();
    if (typeof key !== "string" || key.length === 0 || key.length > 1024 || !Number.isSafeInteger(now + this.ttlMs)) {
      return "unavailable";
    }
    const hash = createHash("sha256").update(key).digest("hex");
    const table = TABLES[scope];
    let result: NonceWriteResult;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(now);
      // Existing cloud deployments wrote both scopes to the legacy table. Keep checking
      // active entries through expiry, without charging them against either new quota.
      if (scope !== "legacy") this.db.prepare("DELETE FROM inquiry_nonces WHERE expires_at <= ?").run(now);
      if (this.db.prepare(`SELECT 1 FROM ${table} WHERE nonce_hash = ?`).get(hash) !== undefined ||
          (scope !== "legacy" && this.db.prepare("SELECT 1 FROM inquiry_nonces WHERE nonce_hash = ?").get(hash) !== undefined)) {
        result = "duplicate";
      } else {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        if (row.n >= this.maxEntries) {
          result = "unavailable";
        } else {
          this.db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run(hash, now + this.ttlMs);
          result = "fresh";
        }
      }
      this.db.exec("COMMIT");
    } catch {
      try { this.db.exec("ROLLBACK"); } catch { /* No active transaction. */ }
      this.onUnavailable?.("storage", scope);
      return "unavailable";
    }
    if (result === "unavailable") this.onUnavailable?.("capacity", scope);
    return result;
  }

  close(): void { this.db.close(); }
}
