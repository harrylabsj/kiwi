/** Copyright 2026 harrylabsj; SPDX-License-Identifier: Apache-2.0 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentDigest } from "../../negotiation/jcs.js";

const REF = /^qa_[0-9a-f]{32}$/u;
const TTL_MS = 7 * 86_400_000;
const MAX_PENDING = 200;
const MAX_PER_BUYER = 12;
type Status = "pending" | "in_progress" | "answered" | "closed_without_answer";
type Change = { kind: "claim" | "close" } | { kind: "answer"; answer: string };
const bounded = (value: string, max = 240): boolean => value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);

export class BuyerFollowupError extends Error {
  constructor(readonly code: "invalid_input" | "not_found" | "conflict" | "unavailable") { super(code); }
}
interface Row {
  ref: string; buyer: string; negotiation: string; sku: string; topic: string; quantity: number | null;
  digest: string; version: number; status: Status; answer: string | null; expires_at: number; created_at: number;
}
export interface CreateBuyerFollowup {
  buyer: string; negotiation: string; message: string; index: number; sku: string; topic: string; quantity?: number; wireDigest: string;
}

/** 已验证 A2A 主体与商家明确确认之间的持久回执；不执行任何主动外发。 */
export class BuyerFollowups {
  constructor(private readonly directory: string, private readonly merchant: string, private readonly now: () => string) {}

  private use<T>(fn: (db: DatabaseSync, now: number) => T): T {
    const now = Date.parse(this.now());
    if (!Number.isFinite(now)) throw new BuyerFollowupError("unavailable");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(this.directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new BuyerFollowupError("unavailable");
    const file = path.join(this.directory, "buyer-followups.sqlite");
    const fd = openSync(file, constants.O_CREAT | constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new BuyerFollowupError("unavailable");
    } finally { closeSync(fd); }
    const db = new DatabaseSync(file);
    try {
      db.exec(`PRAGMA busy_timeout=200;
        CREATE TABLE IF NOT EXISTS buyer_followup_case (
          merchant TEXT NOT NULL, ref TEXT NOT NULL, buyer TEXT NOT NULL, negotiation TEXT NOT NULL,
          message TEXT NOT NULL, idx INTEGER NOT NULL, sku TEXT NOT NULL, topic TEXT NOT NULL,
          quantity INTEGER, digest TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
          answer TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          PRIMARY KEY (merchant, ref), UNIQUE (merchant, buyer, negotiation, message, idx, topic));
        CREATE TABLE IF NOT EXISTS buyer_followup_event (
          merchant TEXT NOT NULL, ref TEXT NOT NULL, version INTEGER NOT NULL, actor TEXT NOT NULL,
          event TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (merchant, ref, version));
      `);
      return fn(db, now);
    } finally { db.close(); }
  }

  private transaction<T>(db: DatabaseSync, fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  create(input: CreateBuyerFollowup): { case_ref: string; status: Status } | undefined {
    if (![input.buyer, input.negotiation, input.message, input.sku, input.topic, input.wireDigest].every((part) => bounded(part)) ||
        !Number.isSafeInteger(input.index) || input.index < 0 || input.index > 15 ||
        (input.quantity !== undefined && (!Number.isSafeInteger(input.quantity) || input.quantity < 1))) return undefined;
    return this.use((db, now) => this.transaction(db, () => {
      const digest = contentDigest({ ...input });
      const prior = db.prepare(`SELECT * FROM buyer_followup_case WHERE merchant=? AND buyer=? AND negotiation=? AND message=? AND idx=? AND topic=?`)
        .get(this.merchant, input.buyer, input.negotiation, input.message, input.index, input.topic) as unknown as Row | undefined;
      if (prior !== undefined) {
        if (prior.digest !== digest) throw new BuyerFollowupError("conflict");
        return prior.expires_at > now ? { case_ref: prior.ref, status: prior.status } : undefined;
      }
      // Tombstones outlive the A2A idempotency window. Keep the durable tables bounded.
      const cutoff = now - 30 * 86_400_000;
      db.prepare(`DELETE FROM buyer_followup_event WHERE merchant=? AND ref IN (SELECT ref FROM buyer_followup_case WHERE merchant=? AND expires_at<=?)`)
        .run(this.merchant, this.merchant, cutoff);
      db.prepare(`DELETE FROM buyer_followup_case WHERE merchant=? AND expires_at<=?`).run(this.merchant, cutoff);
      const counts = db.prepare(`SELECT count(*) AS total, count(CASE WHEN expires_at>? AND status IN ('pending','in_progress') THEN 1 END) AS pending,
          count(CASE WHEN buyer=? AND expires_at>? THEN 1 END) AS buyer_count FROM buyer_followup_case WHERE merchant=?`)
        .get(now, input.buyer, now, this.merchant);
      if (!counts || Number(counts.total) >= 10_000 || Number(counts.pending) >= MAX_PENDING || Number(counts.buyer_count) >= MAX_PER_BUYER) return undefined;
      const ref = `qa_${randomBytes(16).toString("hex")}`;
      db.prepare(`INSERT INTO buyer_followup_case VALUES (?,?,?,?,?,?,?,?,?,?,'pending',1,NULL,?,?)`).run(
        this.merchant, ref, input.buyer, input.negotiation, input.message, input.index, input.sku, input.topic,
        input.quantity ?? null, digest, now, now + TTL_MS);
      db.prepare(`INSERT INTO buyer_followup_event VALUES (?,?,1,'system','created',?)`).run(this.merchant, ref, now);
      return { case_ref: ref, status: "pending" };
    }));
  }

  readBuyer(buyer: string, negotiation: string, ref: string) {
    if (!REF.test(ref)) return undefined;
    return this.use((db, now) => {
      const row = db.prepare(`SELECT * FROM buyer_followup_case WHERE merchant=? AND ref=? AND buyer=? AND negotiation=?`)
        .get(this.merchant, ref, buyer, negotiation) as unknown as Row | undefined;
      if (!row) return undefined;
      return { case_ref: row.ref, sku: row.sku, topic: row.topic,
        status: row.expires_at <= now ? "expired" as const : row.status,
        ...(row.expires_at > now && row.status === "answered" && row.answer !== null ? { answer: row.answer } : {}),
        as_of: new Date(now).toISOString() };
    });
  }

  listOwner() {
    return this.use((db, now) => (db.prepare(`SELECT * FROM buyer_followup_case WHERE merchant=? AND expires_at>? ORDER BY
      CASE WHEN status IN ('pending','in_progress') THEN 0 ELSE 1 END, created_at DESC LIMIT 200`).all(this.merchant, now) as unknown as Row[])
      .map((row) => ({ case_ref: row.ref, negotiation_id: row.negotiation, sku: row.sku, topic: row.topic, quantity: row.quantity, version: row.version, status: row.status })));
  }

  changeOwner(actor: string, ref: string, version: number, change: Change): void {
    if (!bounded(actor) || !REF.test(ref) || !Number.isSafeInteger(version) || version < 1 ||
        (change.kind === "answer" && !bounded(change.answer.trim(), 600))) throw new BuyerFollowupError("invalid_input");
    this.use((db, now) => this.transaction(db, () => {
      const row = db.prepare(`SELECT * FROM buyer_followup_case WHERE merchant=? AND ref=?`).get(this.merchant, ref) as unknown as Row | undefined;
      if (!row) throw new BuyerFollowupError("not_found");
      if (row.version !== version || row.expires_at <= now ||
          (change.kind === "claim" ? row.status !== "pending" : row.status !== "in_progress" && !(change.kind === "close" && (row.status === "pending" || row.status === "answered")))) {
        throw new BuyerFollowupError("conflict");
      }
      const status = change.kind === "claim" ? "in_progress" : change.kind === "answer" ? "answered" : "closed_without_answer";
      db.prepare(`UPDATE buyer_followup_case SET status=?, version=version+1, answer=? WHERE merchant=? AND ref=?`)
        .run(status, change.kind === "answer" ? change.answer.trim() : null, this.merchant, ref);
      db.prepare(`INSERT INTO buyer_followup_event VALUES (?,?,?,?,?,?)`).run(this.merchant, ref, version + 1, actor, status, now);
    }));
  }
}

export function hasBuyerFollowupQuery(subject: unknown): boolean {
  return subject !== null && typeof subject === "object" && Object.hasOwn(subject, "kiwi_buyer_followup");
}

export function buyerFollowupQuery(subject: unknown): { case_ref: string; negotiation_id: string } | undefined {
  if (!hasBuyerFollowupQuery(subject)) return undefined;
  const q = (subject as { kiwi_buyer_followup: unknown }).kiwi_buyer_followup;
  if (q === null || typeof q !== "object" || Array.isArray(q)) return undefined;
  const input = q as Record<string, unknown>;
  return input.version === 1 && Object.keys(input).length === 3 && typeof input.case_ref === "string" && REF.test(input.case_ref) &&
    typeof input.negotiation_id === "string" && bounded(input.negotiation_id) ? { case_ref: input.case_ref, negotiation_id: input.negotiation_id } : undefined;
}
