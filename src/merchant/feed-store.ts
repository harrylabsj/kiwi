/** Merchant public Feed authority (Workbench v0.1.1 §7 / WB-041,052—054). */

import { createHash, createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const FORBIDDEN_BIDI = /[\u202A-\u202E\u2066-\u2069]/u;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_feed_state (
  merchant_id TEXT PRIMARY KEY,
  feed_id TEXT UNIQUE NOT NULL,
  epoch INTEGER NOT NULL,
  next_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS merchant_broadcasts (
  merchant_id TEXT NOT NULL,
  broadcast_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sku_refs_json TEXT NOT NULL,
  promotion_ref TEXT,
  published_at TEXT NOT NULL,
  effective_until TEXT,
  audience TEXT NOT NULL CHECK(audience='public'),
  status TEXT NOT NULL CHECK(status IN ('published','withdrawn')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, broadcast_id)
);
CREATE TABLE IF NOT EXISTS merchant_broadcast_revisions (
  merchant_id TEXT NOT NULL,
  broadcast_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, broadcast_id, revision)
);
CREATE TABLE IF NOT EXISTS merchant_feed_events (
  merchant_id TEXT NOT NULL,
  feed_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('published','revised','withdrawn')),
  broadcast_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, epoch, seq)
);
CREATE TABLE IF NOT EXISTS merchant_feed_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  high_water_seq INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export interface BroadcastInput {
  kind: string;
  title: string;
  body: string;
  skuRefs?: readonly string[];
  promotionRef?: string;
  effectiveUntil?: string;
  audience: "public";
}

export interface FeedEvent {
  feed_id: string;
  epoch: number;
  seq: number;
  event_id: string;
  event_type: "published" | "revised" | "withdrawn";
  broadcast_id: string;
  revision: number;
  created_at: string;
  payload: Record<string, unknown>;
}

export type FeedReadResult =
  | { kind: "not_modified"; etag: string }
  | {
      kind: "events";
      feed_id: string;
      epoch: number;
      events: FeedEvent[];
      next_cursor: string;
      has_more: boolean;
      etag: string;
    };

interface FeedStateRow {
  feed_id: string;
  epoch: number;
  next_seq: number;
}

interface EventRow {
  feed_id: string;
  epoch: number;
  seq: number;
  event_id: string;
  event_type: FeedEvent["event_type"];
  broadcast_id: string;
  revision: number;
  payload_json: string;
  created_at: string;
}

export class MerchantFeedError extends Error {
  readonly code:
    | "validation_error"
    | "not_found"
    | "version_conflict"
    | "feed_cursor_invalid"
    | "feed_reset_required"
    | "snapshot_expired";

  constructor(code: MerchantFeedError["code"], message: string) {
    super(message);
    this.name = "MerchantFeedError";
    this.code = code;
  }
}

export class MerchantFeedStore {
  private readonly db: DatabaseSync;
  private readonly cursorKey: Buffer;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; cursorKey: Buffer; now?: () => string }) {
    if (options.cursorKey.length < 32) throw new Error("cursorKey must contain at least 32 bytes");
    this.db = options.db;
    this.cursorKey = Buffer.from(options.cursorKey);
    this.now = options.now ?? (() => new Date().toISOString());
    this.db.exec("pragma busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  publish(merchantId: string, input: BroadcastInput): { broadcast_id: string; revision: number } {
    const broadcastId = `bct_${randomBytes(16).toString("base64url")}`;
    return this.publishWithId(merchantId, broadcastId, input);
  }

  publishWithId(
    merchantId: string,
    broadcastId: string,
    input: BroadcastInput,
  ): { broadcast_id: string; revision: number } {
    if (!/^bct_[A-Za-z0-9_-]{16,128}$/.test(broadcastId)) {
      throw new MerchantFeedError("validation_error", "broadcast_id shape is invalid");
    }
    return this.writeBroadcast(merchantId, broadcastId, 0, "published", input);
  }

  getBroadcast(
    merchantId: string,
    broadcastId: string,
  ): (BroadcastInput & { broadcast_id: string; revision: number; status: "published" | "withdrawn" }) | undefined {
    const row = this.db
      .prepare("SELECT * FROM merchant_broadcasts WHERE merchant_id=? AND broadcast_id=?")
      .get(merchantId, broadcastId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      broadcast_id: String(row["broadcast_id"]),
      revision: Number(row["revision"]),
      status: String(row["status"]) as "published" | "withdrawn",
      kind: String(row["kind"]),
      title: String(row["title"]),
      body: String(row["body"]),
      skuRefs: JSON.parse(String(row["sku_refs_json"])) as string[],
      ...(row["promotion_ref"] === null ? {} : { promotionRef: String(row["promotion_ref"]) }),
      ...(row["effective_until"] === null
        ? {}
        : { effectiveUntil: String(row["effective_until"]) }),
      audience: "public",
    };
  }

  listBroadcasts(
    merchantId: string,
    options: { cursor?: string; limit?: number } = {},
  ): {
    items: Array<
      BroadcastInput & {
        broadcast_id: string;
        revision: number;
        status: "published" | "withdrawn";
      }
    >;
    next_cursor: string | null;
  } {
    const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new MerchantFeedError("validation_error", "broadcast cursor is invalid");
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const rows = this.db
      .prepare(
        `SELECT broadcast_id FROM merchant_broadcasts
         WHERE merchant_id=? ORDER BY updated_at DESC, broadcast_id LIMIT ? OFFSET ?`,
      )
      .all(merchantId, limit + 1, offset) as Array<{ broadcast_id: string }>;
    const items = rows
      .slice(0, limit)
      .map((row) => this.getBroadcast(merchantId, row.broadcast_id))
      .filter((item): item is NonNullable<typeof item> => item !== undefined);
    return {
      items,
      next_cursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  revise(
    merchantId: string,
    broadcastId: string,
    expectedRevision: number,
    input: BroadcastInput,
  ): { broadcast_id: string; revision: number } {
    return this.writeBroadcast(merchantId, broadcastId, expectedRevision, "revised", input);
  }

  withdraw(
    merchantId: string,
    broadcastId: string,
    expectedRevision: number,
  ): { broadcast_id: string; revision: number } {
    const stamp = this.now();
    this.db.exec("begin immediate");
    try {
      const current = this.broadcastRow(merchantId, broadcastId);
      if (current === undefined) throw new MerchantFeedError("not_found", "unknown broadcast");
      if (current.revision !== expectedRevision || current.status !== "published") {
        throw new MerchantFeedError("version_conflict", "broadcast revision/status changed");
      }
      const revision = current.revision + 1;
      this.db
        .prepare(
          `UPDATE merchant_broadcasts SET revision=?, status='withdrawn', updated_at=?
           WHERE merchant_id=? AND broadcast_id=? AND revision=? AND status='published'`,
        )
        .run(revision, stamp, merchantId, broadcastId, expectedRevision);
      this.appendEvent(merchantId, "withdrawn", broadcastId, revision, {
        broadcast_id: broadcastId,
        revision,
        status: "withdrawn",
      });
      this.db.exec("commit");
      return { broadcast_id: broadcastId, revision };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  read(
    merchantId: string,
    options: { cursor?: string; limit?: number; ifNoneMatch?: string } = {},
  ): FeedReadResult {
    const state = this.state(merchantId);
    const afterSeq = options.cursor === undefined ? 0 : this.decodeCursor(merchantId, state, options.cursor);
    const min = this.minRetainedSeq(merchantId, state.epoch);
    if (afterSeq > 0 && min !== undefined && afterSeq < min - 1) {
      throw new MerchantFeedError("feed_reset_required", "cursor predates the retained Feed window");
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 50);
    const rows = this.db
      .prepare(
        `SELECT * FROM merchant_feed_events
         WHERE merchant_id=? AND epoch=? AND seq>? ORDER BY seq LIMIT ?`,
      )
      .all(merchantId, state.epoch, afterSeq, limit + 1) as unknown as EventRow[];
    const selected: FeedEvent[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const event = toEvent(row);
      const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (selected.length > 0 && bytes + eventBytes > MAX_RESPONSE_BYTES) break;
      bytes += eventBytes;
      selected.push(event);
    }
    const coveredSeq = selected.at(-1)?.seq ?? afterSeq;
    const hasMore = rows.some((row) => row.seq > coveredSeq);
    const nextCursor = this.encodeCursor(merchantId, state, coveredSeq);
    const representation = {
      feed_id: state.feed_id,
      epoch: state.epoch,
      events: selected,
      next_cursor: nextCursor,
      has_more: hasMore,
    };
    const etag = `"${createHash("sha256").update(JSON.stringify({ afterSeq, limit, representation })).digest("base64url")}"`;
    // Cursor validity/reset was checked before ETag, so 304 can never hide a required reset.
    if (options.ifNoneMatch === etag) return { kind: "not_modified", etag };
    return { kind: "events", ...representation, etag };
  }

  createSnapshot(merchantId: string): { snapshot_id: string; high_water_cursor: string; expires_at: string } {
    const state = this.state(merchantId);
    const rows = this.db
      .prepare(
        `SELECT broadcast_id, revision, kind, title, body, sku_refs_json, promotion_ref,
                published_at, effective_until, audience, status
         FROM merchant_broadcasts WHERE merchant_id=? AND status='published'
         ORDER BY broadcast_id`,
      )
      .all(merchantId) as Array<Record<string, unknown>>;
    const content = rows.map((row) => ({
      ...row,
      sku_refs: JSON.parse(String(row["sku_refs_json"])) as string[],
      sku_refs_json: undefined,
    }));
    const snapshotId = `fsn_${randomBytes(18).toString("base64url")}`;
    const stamp = this.now();
    const expiresAt = new Date(Date.parse(stamp) + SNAPSHOT_TTL_MS).toISOString();
    const highWater = Math.max(0, state.next_seq - 1);
    this.db
      .prepare(
        `INSERT INTO merchant_feed_snapshots
         (snapshot_id, merchant_id, epoch, high_water_seq, content_json, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(snapshotId, merchantId, state.epoch, highWater, JSON.stringify(content), expiresAt, stamp);
    return {
      snapshot_id: snapshotId,
      high_water_cursor: this.encodeCursor(merchantId, state, highWater),
      expires_at: expiresAt,
    };
  }

  readSnapshotPage(
    merchantId: string,
    snapshotId: string,
    offset = 0,
    limit = 50,
  ): { items: unknown[]; next_offset: number | null } {
    const row = this.db
      .prepare(
        `SELECT content_json, expires_at FROM merchant_feed_snapshots
         WHERE snapshot_id=? AND merchant_id=?`,
      )
      .get(snapshotId, merchantId) as { content_json: string; expires_at: string } | undefined;
    if (row === undefined) throw new MerchantFeedError("not_found", "unknown snapshot");
    if (Date.parse(row.expires_at) <= Date.parse(this.now())) {
      throw new MerchantFeedError("snapshot_expired", "Feed snapshot expired");
    }
    const all = JSON.parse(row.content_json) as unknown[];
    const safeOffset = Math.max(0, offset);
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const items = all.slice(safeOffset, safeOffset + safeLimit);
    const next = safeOffset + items.length < all.length ? safeOffset + items.length : null;
    return { items, next_offset: next };
  }

  sweep(): { events: number; snapshots: number } {
    const stamp = this.now();
    const cutoff = new Date(Date.parse(stamp) - RETENTION_MS).toISOString();
    const events = Number(
      this.db.prepare("DELETE FROM merchant_feed_events WHERE created_at<?").run(cutoff).changes,
    );
    const snapshots = Number(
      this.db.prepare("DELETE FROM merchant_feed_snapshots WHERE expires_at<=?").run(stamp).changes,
    );
    return { events, snapshots };
  }

  private writeBroadcast(
    merchantId: string,
    broadcastId: string,
    expectedRevision: number,
    eventType: "published" | "revised",
    input: BroadcastInput,
  ): { broadcast_id: string; revision: number } {
    const content = normalizeBroadcast(input);
    const stamp = this.now();
    this.db.exec("begin immediate");
    try {
      const existing = this.broadcastRow(merchantId, broadcastId);
      if (eventType === "published" && existing !== undefined) {
        throw new MerchantFeedError("version_conflict", "broadcast already exists");
      }
      if (
        eventType === "revised" &&
        (existing === undefined || existing.revision !== expectedRevision || existing.status !== "published")
      ) {
        throw new MerchantFeedError("version_conflict", "broadcast revision/status changed");
      }
      const revision = eventType === "published" ? 1 : expectedRevision + 1;
      this.db
        .prepare(
          `INSERT INTO merchant_broadcasts
           (merchant_id, broadcast_id, revision, kind, title, body, sku_refs_json,
            promotion_ref, published_at, effective_until, audience, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', 'published', ?)
           ON CONFLICT(merchant_id, broadcast_id) DO UPDATE SET
             revision=excluded.revision, kind=excluded.kind, title=excluded.title,
             body=excluded.body, sku_refs_json=excluded.sku_refs_json,
             promotion_ref=excluded.promotion_ref, effective_until=excluded.effective_until,
             status='published', updated_at=excluded.updated_at`,
        )
        .run(
          merchantId,
          broadcastId,
          revision,
          content.kind,
          content.title,
          content.body,
          JSON.stringify(content.sku_refs),
          content.promotion_ref,
          existing?.published_at ?? stamp,
          content.effective_until,
          stamp,
        );
      const payload = {
        broadcast_id: broadcastId,
        revision,
        ...content,
        audience: "public",
        status: "published",
      };
      this.db
        .prepare(
          `INSERT INTO merchant_broadcast_revisions
           (merchant_id, broadcast_id, revision, content_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(merchantId, broadcastId, revision, JSON.stringify(payload), stamp);
      this.appendEvent(merchantId, eventType, broadcastId, revision, payload);
      this.db.exec("commit");
      return { broadcast_id: broadcastId, revision };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private appendEvent(
    merchantId: string,
    eventType: FeedEvent["event_type"],
    broadcastId: string,
    revision: number,
    payload: Record<string, unknown>,
  ): void {
    const state = this.state(merchantId);
    const seq = state.next_seq;
    const stamp = this.now();
    this.db
      .prepare(
        `INSERT INTO merchant_feed_events
         (merchant_id, feed_id, epoch, seq, event_id, event_type, broadcast_id,
          revision, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merchantId,
        state.feed_id,
        state.epoch,
        seq,
        `fev_${randomBytes(16).toString("base64url")}`,
        eventType,
        broadcastId,
        revision,
        JSON.stringify(payload),
        stamp,
      );
    this.db
      .prepare("UPDATE merchant_feed_state SET next_seq=?, updated_at=? WHERE merchant_id=?")
      .run(seq + 1, stamp, merchantId);
  }

  private state(merchantId: string): FeedStateRow {
    let row = this.db
      .prepare("SELECT feed_id, epoch, next_seq FROM merchant_feed_state WHERE merchant_id=?")
      .get(merchantId) as FeedStateRow | undefined;
    if (row === undefined) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO merchant_feed_state
           (merchant_id, feed_id, epoch, next_seq, updated_at) VALUES (?, ?, 1, 1, ?)`,
        )
        .run(merchantId, `feed_${randomBytes(16).toString("base64url")}`, this.now());
      row = this.db
        .prepare("SELECT feed_id, epoch, next_seq FROM merchant_feed_state WHERE merchant_id=?")
        .get(merchantId) as unknown as FeedStateRow;
    }
    return row;
  }

  private broadcastRow(
    merchantId: string,
    broadcastId: string,
  ): { revision: number; status: string; published_at: string } | undefined {
    return this.db
      .prepare(
        `SELECT revision, status, published_at FROM merchant_broadcasts
         WHERE merchant_id=? AND broadcast_id=?`,
      )
      .get(merchantId, broadcastId) as
      | { revision: number; status: string; published_at: string }
      | undefined;
  }

  private minRetainedSeq(merchantId: string, epoch: number): number | undefined {
    const row = this.db
      .prepare("SELECT min(seq) value FROM merchant_feed_events WHERE merchant_id=? AND epoch=?")
      .get(merchantId, epoch) as { value: number | null };
    return row.value ?? undefined;
  }

  private encodeCursor(merchantId: string, state: FeedStateRow, seq: number): string {
    const payload = Buffer.from(
      JSON.stringify({ merchant: merchantId, feed: state.feed_id, epoch: state.epoch, seq }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", this.cursorKey).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private decodeCursor(merchantId: string, state: FeedStateRow, cursor: string): number {
    const [payload, signature, extra] = cursor.split(".");
    if (payload === undefined || signature === undefined || extra !== undefined) {
      throw new MerchantFeedError("feed_cursor_invalid", "malformed Feed cursor");
    }
    const expected = createHmac("sha256", this.cursorKey).update(payload).digest("base64url");
    if (signature !== expected) throw new MerchantFeedError("feed_cursor_invalid", "Feed cursor signature mismatch");
    let parsed: { merchant?: unknown; feed?: unknown; epoch?: unknown; seq?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof parsed;
    } catch {
      throw new MerchantFeedError("feed_cursor_invalid", "Feed cursor payload is invalid");
    }
    if (
      parsed.merchant !== merchantId ||
      parsed.feed !== state.feed_id ||
      parsed.epoch !== state.epoch ||
      typeof parsed.seq !== "number" ||
      !Number.isInteger(parsed.seq) ||
      parsed.seq < 0 ||
      parsed.seq >= state.next_seq
    ) {
      throw new MerchantFeedError("feed_cursor_invalid", "Feed cursor does not match this feed/epoch");
    }
    return parsed.seq;
  }
}

function normalizeBroadcast(input: BroadcastInput): {
  kind: string;
  title: string;
  body: string;
  sku_refs: string[];
  promotion_ref: string | null;
  effective_until: string | null;
} {
  if (input.audience !== "public") {
    throw new MerchantFeedError("validation_error", "Workbench v1 audience must be public");
  }
  const kind = normalizeText(input.kind, "kind", 1, 64);
  const title = normalizeText(input.title, "title", 1, 120);
  const body = normalizeText(input.body.replaceAll("\r\n", "\n").replaceAll("\r", "\n"), "body", 1, 4000);
  if (Buffer.byteLength(body, "utf8") > 16 * 1024) {
    throw new MerchantFeedError("validation_error", "body exceeds 16 KiB UTF-8 limit");
  }
  const skuRefs = [...new Set(input.skuRefs ?? [])].map((sku) => normalizeText(sku, "sku_ref", 1, 160));
  if (skuRefs.length > 50) throw new MerchantFeedError("validation_error", "sku_refs exceeds 50 entries");
  const promotionRef = input.promotionRef === undefined ? null : normalizeText(input.promotionRef, "promotion_ref", 1, 160);
  const effectiveUntil = input.effectiveUntil ?? null;
  if (effectiveUntil !== null && !Number.isFinite(Date.parse(effectiveUntil))) {
    throw new MerchantFeedError("validation_error", "effective_until must be an ISO timestamp");
  }
  const normalized = { kind, title, body, sku_refs: skuRefs, promotion_ref: promotionRef, effective_until: effectiveUntil };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 24 * 1024) {
    throw new MerchantFeedError("validation_error", "normalized broadcast exceeds 24 KiB");
  }
  return normalized;
}

function normalizeText(value: string, field: string, min: number, max: number): string {
  const normalized = String(value ?? "").normalize("NFC");
  const length = [...normalized].length;
  const forbiddenControl = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
  });
  if (length < min || length > max || forbiddenControl || FORBIDDEN_BIDI.test(normalized)) {
    throw new MerchantFeedError("validation_error", `${field} length/content is invalid`);
  }
  return normalized;
}

function toEvent(row: EventRow): FeedEvent {
  return {
    feed_id: row.feed_id,
    epoch: row.epoch,
    seq: row.seq,
    event_id: row.event_id,
    event_type: row.event_type,
    broadcast_id: row.broadcast_id,
    revision: row.revision,
    created_at: row.created_at,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}
