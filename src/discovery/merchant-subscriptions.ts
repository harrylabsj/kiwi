/** Buyer-side client for merchant-follow/1 + merchant-feed/1 with local preference/cursor authority. */

import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  BuyerFollowRecord,
  BuyerFollowUpdateGroup,
  MerchantPublicEvent,
} from "./catalog-source/buyer-follows.js";
import type { BuyerFollowsClient } from "../buyer-core/service.js";

export interface MerchantSubscriptionEndpoint {
  /** Verified Merchant origin from a trusted Card/binding, no path/query/credentials. */
  origin: string;
  /** Resource-bound Buyer credential for /buyer/v1/follow only. Never sent to public Feed. */
  bearerToken: string;
}

export interface MerchantSubscriptionResolver {
  resolve(merchantId: string): Promise<MerchantSubscriptionEndpoint>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS buyer_merchant_subscriptions (
  merchant_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('active','cancelled')),
  category TEXT,
  consent_version TEXT,
  feed_cursor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS buyer_merchant_feed_events (
  merchant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  publication_id TEXT,
  version INTEGER,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, event_id)
);
`;

export class MerchantSubscriptionClient implements BuyerFollowsClient {
  private readonly db: DatabaseSync;
  private readonly resolver: MerchantSubscriptionResolver;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;

  constructor(options: {
    dbPath: string;
    resolver: MerchantSubscriptionResolver;
    fetchImpl?: typeof fetch;
    now?: () => string;
  }) {
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec("pragma busy_timeout=5000");
    this.db.exec(SCHEMA);
    this.resolver = options.resolver;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async follow(
    merchantId: string,
    opts?: { category?: string; consent_version?: string },
  ): Promise<{ follow: BuyerFollowRecord; created: boolean }> {
    const endpoint = await this.endpoint(merchantId);
    const state = await this.followState(endpoint);
    const response = await this.request(endpoint, "/buyer/v1/follow", {
      method: "PUT",
      authenticated: true,
      headers: {
        "if-match": state.etag,
        "idempotency-key": `bf_${randomBytes(16).toString("base64url")}`,
        "x-mutation-context": state.followContext,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...(opts?.category !== undefined ? { category: opts.category } : {}),
        ...(opts?.consent_version !== undefined ? { consent_version: opts.consent_version } : {}),
      }),
    });
    const body = requireObject(response.body, "follow response");
    const follow = requireFollow(body["follow"], merchantId);
    const created = body["created"] === true;
    this.savePreference(merchantId, "active", opts?.category, opts?.consent_version);
    return { follow, created };
  }

  async unfollow(merchantId: string): Promise<{ merchant_id: string; following: false }> {
    const endpoint = await this.endpoint(merchantId);
    const state = await this.followState(endpoint);
    await this.request(endpoint, "/buyer/v1/follow", {
      method: "DELETE",
      authenticated: true,
      headers: {
        "if-match": state.etag,
        "idempotency-key": `bu_${randomBytes(16).toString("base64url")}`,
        "x-mutation-context": state.unfollowContext,
      },
    });
    this.savePreference(merchantId, "cancelled");
    return { merchant_id: merchantId, following: false };
  }

  async listFollows(): Promise<BuyerFollowRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT merchant_id, category, consent_version, created_at, updated_at
         FROM buyer_merchant_subscriptions WHERE status='active' ORDER BY created_at, merchant_id`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      merchant_id: String(row["merchant_id"]),
      status: "active",
      ...(row["category"] === null ? {} : { category: String(row["category"]) }),
      ...(row["consent_version"] === null
        ? {}
        : { consent_version: String(row["consent_version"]) }),
      created_at: String(row["created_at"]),
      last_seen_at: String(row["updated_at"]),
    }));
  }

  async getUpdates(): Promise<BuyerFollowUpdateGroup[]> {
    const subscriptions = this.db
      .prepare(
        `SELECT merchant_id, feed_cursor FROM buyer_merchant_subscriptions
         WHERE status='active' ORDER BY merchant_id`,
      )
      .all() as Array<{ merchant_id: string; feed_cursor: string | null }>;
    const groups: BuyerFollowUpdateGroup[] = [];
    for (const subscription of subscriptions) {
      const endpoint = await this.endpoint(subscription.merchant_id);
      let page = await this.feedPage(endpoint, subscription.feed_cursor);
      if (page.resetRequired) {
        await this.applySnapshot(endpoint, subscription.merchant_id);
        const row = this.db
          .prepare("SELECT feed_cursor FROM buyer_merchant_subscriptions WHERE merchant_id=?")
          .get(subscription.merchant_id) as { feed_cursor: string | null };
        page = await this.feedPage(endpoint, row.feed_cursor);
      }
      const events = page.events.map(toLegacyEvent);
      this.applyEventsAndCursor(subscription.merchant_id, events, page.nextCursor);
      groups.push({
        merchant_id: subscription.merchant_id,
        events,
        last_seen_at: this.now(),
      });
    }
    return groups;
  }

  close(): void {
    this.db.close();
  }

  private async followState(endpoint: MerchantSubscriptionEndpoint): Promise<{
    etag: string;
    followContext: string;
    unfollowContext: string;
  }> {
    const response = await this.request(endpoint, "/buyer/v1/follow", {
      method: "GET",
      authenticated: true,
    });
    const body = requireObject(response.body, "follow state");
    const contexts = requireObject(body["mutation_contexts"], "mutation contexts");
    const follow = requireObject(contexts["follow"], "follow context");
    const unfollow = requireObject(contexts["unfollow"], "unfollow context");
    const etag = response.headers.get("etag");
    if (etag === null || typeof follow["ref"] !== "string" || typeof unfollow["ref"] !== "string") {
      throw new Error("merchant follow response is missing ETag or mutation contexts");
    }
    return { etag, followContext: follow["ref"], unfollowContext: unfollow["ref"] };
  }

  private async feedPage(
    endpoint: MerchantSubscriptionEndpoint,
    cursor: string | null,
  ): Promise<{ resetRequired: boolean; events: DirectFeedEvent[]; nextCursor: string }> {
    const path = `/public/v1/updates${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`;
    const response = await this.request(endpoint, path, {
      method: "GET",
      authenticated: false,
      allowProblem: true,
    });
    const body = requireObject(response.body, "Feed response");
    if (response.status === 409 && body["code"] === "FEED_RESET_REQUIRED") {
      return { resetRequired: true, events: [], nextCursor: "" };
    }
    if (response.status !== 200 || !Array.isArray(body["events"]) || typeof body["next_cursor"] !== "string") {
      throw new Error("merchant Feed response is invalid");
    }
    return {
      resetRequired: false,
      events: body["events"].map(requireDirectFeedEvent),
      nextCursor: body["next_cursor"],
    };
  }

  private async applySnapshot(endpoint: MerchantSubscriptionEndpoint, merchantId: string): Promise<void> {
    const created = await this.request(endpoint, "/public/v1/updates/snapshot", {
      method: "GET",
      authenticated: false,
    });
    const descriptor = requireObject(created.body, "snapshot descriptor");
    if (typeof descriptor["snapshot_id"] !== "string" || typeof descriptor["high_water_cursor"] !== "string") {
      throw new Error("snapshot descriptor is invalid");
    }
    let offset = 0;
    const active: Array<Record<string, unknown>> = [];
    while (true) {
      const page = await this.request(
        endpoint,
        `/public/v1/updates/snapshots/${encodeURIComponent(descriptor["snapshot_id"])}?offset=${offset}&limit=50`,
        { method: "GET", authenticated: false },
      );
      const body = requireObject(page.body, "snapshot page");
      if (!Array.isArray(body["items"])) throw new Error("snapshot page items are invalid");
      active.push(...body["items"].map((item) => requireObject(item, "snapshot item")));
      if (body["next_offset"] === null) break;
      if (typeof body["next_offset"] !== "number") throw new Error("snapshot next_offset is invalid");
      offset = body["next_offset"];
    }
    this.db.exec("begin immediate");
    try {
      this.db.prepare("DELETE FROM buyer_merchant_feed_events WHERE merchant_id=?").run(merchantId);
      for (const item of active) {
        const broadcastId = String(item["broadcast_id"] ?? "");
        if (broadcastId === "") throw new Error("snapshot broadcast_id is missing");
        this.db
          .prepare(
            `INSERT INTO buyer_merchant_feed_events
             (merchant_id, event_id, event_type, publication_id, version, payload_json, created_at)
             VALUES (?, ?, 'snapshot', ?, ?, ?, ?)`,
          )
          .run(
            merchantId,
            `snapshot:${broadcastId}`,
            broadcastId,
            Number(item["revision"] ?? 0),
            JSON.stringify(item),
            this.now(),
          );
      }
      this.db
        .prepare("UPDATE buyer_merchant_subscriptions SET feed_cursor=?, updated_at=? WHERE merchant_id=?")
        .run(descriptor["high_water_cursor"], this.now(), merchantId);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private applyEventsAndCursor(
    merchantId: string,
    events: MerchantPublicEvent[],
    cursor: string,
  ): void {
    this.db.exec("begin immediate");
    try {
      for (const event of events) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO buyer_merchant_feed_events
             (merchant_id, event_id, event_type, publication_id, version, payload_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            merchantId,
            event.event_id,
            event.event_type,
            event.publication_id ?? null,
            event.version ?? null,
            JSON.stringify(event.payload),
            event.created_at,
          );
      }
      // Cursor advances in the same local transaction as event application.
      this.db
        .prepare("UPDATE buyer_merchant_subscriptions SET feed_cursor=?, updated_at=? WHERE merchant_id=?")
        .run(cursor, this.now(), merchantId);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private savePreference(
    merchantId: string,
    status: "active" | "cancelled",
    category?: string,
    consentVersion?: string,
  ): void {
    const stamp = this.now();
    this.db
      .prepare(
        `INSERT INTO buyer_merchant_subscriptions
         (merchant_id, status, category, consent_version, feed_cursor, created_at, updated_at)
         VALUES (?, ?, ?, ?, null, ?, ?)
         ON CONFLICT(merchant_id) DO UPDATE SET status=excluded.status,
           category=coalesce(excluded.category, category),
           consent_version=coalesce(excluded.consent_version, consent_version),
           updated_at=excluded.updated_at`,
      )
      .run(merchantId, status, category ?? null, consentVersion ?? null, stamp, stamp);
  }

  private async endpoint(merchantId: string): Promise<MerchantSubscriptionEndpoint> {
    if (typeof merchantId !== "string" || merchantId.trim() === "") throw new Error("merchantId is required");
    const endpoint = await this.resolver.resolve(merchantId);
    return { ...endpoint, origin: validateOrigin(endpoint.origin), bearerToken: requireToken(endpoint.bearerToken) };
  }

  private async request(
    endpoint: MerchantSubscriptionEndpoint,
    path: string,
    options: {
      method: string;
      authenticated: boolean;
      headers?: Record<string, string>;
      body?: string;
      allowProblem?: boolean;
    },
  ): Promise<{ status: number; headers: Headers; body: unknown }> {
    const response = await this.fetchImpl(`${endpoint.origin}${path}`, {
      method: options.method,
      redirect: "manual",
      headers: {
        accept: "application/json",
        ...(options.authenticated ? { authorization: `Bearer ${endpoint.bearerToken}` } : {}),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("merchant endpoint redirect refused");
    const text = await response.text();
    let body: unknown = {};
    if (text !== "") body = JSON.parse(text) as unknown;
    if (!response.ok && options.allowProblem !== true) {
      const problem = requireObject(body, "merchant problem");
      throw new Error(`merchant request failed (${response.status} ${String(problem["code"] ?? "")})`);
    }
    return { status: response.status, headers: response.headers, body };
  }
}

interface DirectFeedEvent {
  event_id: string;
  event_type: string;
  broadcast_id: string;
  revision: number;
  payload: Record<string, unknown>;
  created_at: string;
}

function requireDirectFeedEvent(value: unknown): DirectFeedEvent {
  const row = requireObject(value, "Feed event");
  for (const field of ["event_id", "event_type", "broadcast_id", "created_at"]) {
    if (typeof row[field] !== "string" || row[field] === "") throw new Error(`Feed event ${field} is invalid`);
  }
  const revision = row["revision"];
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new Error("Feed event revision is invalid");
  }
  return {
    event_id: row["event_id"] as string,
    event_type: row["event_type"] as string,
    broadcast_id: row["broadcast_id"] as string,
    revision,
    payload: requireObject(row["payload"], "Feed event payload"),
    created_at: row["created_at"] as string,
  };
}

function toLegacyEvent(event: DirectFeedEvent): MerchantPublicEvent {
  return {
    event_id: event.event_id,
    event_type: event.event_type,
    publication_id: event.broadcast_id,
    version: event.revision,
    payload: event.payload,
    created_at: event.created_at,
  };
}

function requireFollow(value: unknown, merchantId: string): BuyerFollowRecord {
  const row = requireObject(value, "follow");
  if (row["merchant_id"] !== merchantId || typeof row["following"] !== "boolean") {
    throw new Error("merchant follow response identity/state mismatch");
  }
  return {
    merchant_id: merchantId,
    status: row["following"] ? "active" : "cancelled",
    ...(typeof row["category"] === "string" ? { category: row["category"] } : {}),
    ...(typeof row["consent_version"] === "string"
      ? { consent_version: row["consent_version"] }
      : {}),
    ...(typeof row["updated_at"] === "string" ? { last_seen_at: row["updated_at"] } : {}),
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username !== "" || url.password !== "") {
    throw new Error("merchant subscription origin must be an exact credential-free HTTPS origin");
  }
  return url.origin;
}

function requireToken(value: string): string {
  const token = String(value ?? "").trim();
  if (token === "") throw new Error("merchant Buyer credential is missing");
  return token;
}
