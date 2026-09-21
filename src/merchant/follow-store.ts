/** Merchant-authoritative follow relationship store (Workbench v0.1.1 §6 / WB-050—051). */

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_follow_relations (
  merchant_id TEXT NOT NULL,
  buyer_principal_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','cancelled')),
  revision INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  consent_version TEXT,
  category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  PRIMARY KEY (merchant_id, buyer_principal_id)
);
CREATE TABLE IF NOT EXISTS merchant_follow_mutation_contexts (
  context_ref TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  buyer_principal_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('follow','unfollow')),
  base_revision INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS merchant_follow_idempotency (
  merchant_id TEXT NOT NULL,
  buyer_principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, buyer_principal_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS merchant_follow_subject_epochs (
  merchant_id TEXT NOT NULL,
  buyer_principal_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, buyer_principal_id)
);
`;

export interface FollowView {
  merchant_id: string;
  following: boolean;
  revision: number;
  epoch: number;
  consent_version: string | null;
  category: string | null;
  updated_at: string | null;
}

export interface FollowReadResult {
  follow: FollowView;
  mutation_contexts: {
    follow: { ref: string; expires_at: string };
    unfollow: { ref: string; expires_at: string };
  };
}

export interface FollowMutationResult {
  follow: FollowView;
  created: boolean;
  replayed: boolean;
}

interface RelationRow {
  merchant_id: string;
  buyer_principal_id: string;
  status: "active" | "cancelled";
  revision: number;
  epoch: number;
  consent_version: string | null;
  category: string | null;
  updated_at: string;
}

interface ContextRow {
  context_ref: string;
  merchant_id: string;
  buyer_principal_id: string;
  action: "follow" | "unfollow";
  base_revision: number;
  epoch: number;
  expires_at: string;
  used_at: string | null;
}

export class MerchantFollowError extends Error {
  readonly code:
    | "invalid_input"
    | "precondition_failed"
    | "idempotency_key_reused"
    | "idempotency_window_expired"
    | "mutation_context_invalid";

  constructor(code: MerchantFollowError["code"], message: string) {
    super(message);
    this.name = "MerchantFollowError";
    this.code = code;
  }
}

export class MerchantFollowStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now?: () => string }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.db.exec("pragma busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  /** Authenticated GET: current state plus short-lived contexts for one explicit next action. */
  read(merchantId: string, buyerPrincipalId: string): FollowReadResult {
    const merchant = requireText(merchantId, "merchantId");
    const buyer = requireText(buyerPrincipalId, "buyerPrincipalId");
    const follow = this.current(merchant, buyer);
    return {
      follow,
      mutation_contexts: {
        follow: this.issueContext(merchant, buyer, "follow", follow.revision, follow.epoch),
        unfollow: this.issueContext(merchant, buyer, "unfollow", follow.revision, follow.epoch),
      },
    };
  }

  mutate(input: {
    merchantId: string;
    buyerPrincipalId: string;
    action: "follow" | "unfollow";
    expectedRevision: number;
    mutationContext: string;
    idempotencyKey: string;
    requestDigest: string;
    consentVersion?: string;
    category?: string;
  }): FollowMutationResult {
    const merchant = requireText(input.merchantId, "merchantId");
    const buyer = requireText(input.buyerPrincipalId, "buyerPrincipalId");
    const key = requireText(input.idempotencyKey, "idempotencyKey");
    const digest = requireDigest(input.requestDigest);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new MerchantFollowError("invalid_input", "expectedRevision must be a non-negative integer");
    }

    this.db.exec("begin immediate");
    try {
      const idempotent = this.db
        .prepare(
          `SELECT action, request_digest, response_json, expires_at
           FROM merchant_follow_idempotency
           WHERE merchant_id=? AND buyer_principal_id=? AND idempotency_key=?`,
        )
        .get(merchant, buyer, key) as
        | { action: string; request_digest: string; response_json: string; expires_at: string }
        | undefined;
      if (idempotent !== undefined) {
        if (idempotent.action !== input.action || idempotent.request_digest !== digest) {
          throw new MerchantFollowError(
            "idempotency_key_reused",
            "idempotency key was reused for a different follow intention",
          );
        }
        if (Date.parse(idempotent.expires_at) <= Date.parse(this.now())) {
          throw new MerchantFollowError(
            "idempotency_window_expired",
            "the original follow intention is outside the replay window",
          );
        }
        const original = JSON.parse(idempotent.response_json) as FollowMutationResult;
        const replay = { ...original, follow: this.current(merchant, buyer), replayed: true };
        this.db.exec("commit");
        return replay;
      }

      const context = this.requireContext(input.mutationContext);
      const current = this.current(merchant, buyer);
      if (Date.parse(context.expires_at) <= Date.parse(this.now())) {
        throw new MerchantFollowError(
          "idempotency_window_expired",
          "the mutation context expired; create a new explicit intention before changing follow state",
        );
      }
      if (
        context.merchant_id !== merchant ||
        context.buyer_principal_id !== buyer ||
        context.action !== input.action ||
        context.base_revision !== input.expectedRevision ||
        context.epoch !== current.epoch ||
        context.used_at !== null
      ) {
        throw new MerchantFollowError(
          "mutation_context_invalid",
          "mutation context is expired, used or bound to another actor/revision/action",
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new MerchantFollowError(
          "precondition_failed",
          `follow revision is ${current.revision}, expected ${input.expectedRevision}`,
        );
      }

      const stamp = this.now();
      const nextRevision = current.revision + 1;
      const following = input.action === "follow";
      this.db
        .prepare(
          `INSERT INTO merchant_follow_relations
           (merchant_id, buyer_principal_id, status, revision, epoch, consent_version,
            category, created_at, updated_at, cancelled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(merchant_id, buyer_principal_id) DO UPDATE SET
             status=excluded.status, revision=excluded.revision, epoch=excluded.epoch,
             consent_version=excluded.consent_version, category=excluded.category,
             updated_at=excluded.updated_at, cancelled_at=excluded.cancelled_at`,
        )
        .run(
          merchant,
          buyer,
          following ? "active" : "cancelled",
          nextRevision,
          current.epoch,
          following ? cleanOptional(input.consentVersion) : current.consent_version,
          following ? cleanOptional(input.category) : current.category,
          current.updated_at ?? stamp,
          stamp,
          following ? null : stamp,
        );
      const consumed = this.db
        .prepare(
          `UPDATE merchant_follow_mutation_contexts SET used_at=?
           WHERE context_ref=? AND used_at IS NULL AND expires_at>?`,
        )
        .run(stamp, context.context_ref, stamp);
      if (consumed.changes !== 1) {
        throw new MerchantFollowError("mutation_context_invalid", "mutation context was consumed concurrently");
      }
      const result: FollowMutationResult = {
        follow: this.current(merchant, buyer),
        created: following && !current.following,
        replayed: false,
      };
      this.db
        .prepare(
          `INSERT INTO merchant_follow_idempotency
           (merchant_id, buyer_principal_id, idempotency_key, action, request_digest,
            response_json, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          merchant,
          buyer,
          key,
          input.action,
          digest,
          JSON.stringify(result),
          new Date(Date.parse(stamp) + SEVEN_DAYS_MS).toISOString(),
          stamp,
        );
      this.db.exec("commit");
      return result;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  /** Privacy deletion/revocation: cancel and advance epoch so in-flight contexts cannot revive. */
  invalidateBuyer(merchantId: string, buyerPrincipalId: string): FollowView {
    const merchant = requireText(merchantId, "merchantId");
    const buyer = requireText(buyerPrincipalId, "buyerPrincipalId");
    const stamp = this.now();
    this.db.exec("begin immediate");
    try {
      const current = this.current(merchant, buyer);
      const nextEpoch = current.epoch + 1;
      this.db
        .prepare(
          `INSERT INTO merchant_follow_subject_epochs
           (merchant_id, buyer_principal_id, epoch, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(merchant_id, buyer_principal_id) DO UPDATE SET
             epoch=excluded.epoch, updated_at=excluded.updated_at`,
        )
        .run(merchant, buyer, nextEpoch, stamp);
      this.db
        .prepare(
          `UPDATE merchant_follow_relations SET status='cancelled', revision=revision+1,
           epoch=?, updated_at=?, cancelled_at=?
           WHERE merchant_id=? AND buyer_principal_id=?`,
        )
        .run(nextEpoch, stamp, stamp, merchant, buyer);
      this.db
        .prepare(
          `UPDATE merchant_follow_mutation_contexts SET used_at=?
           WHERE merchant_id=? AND buyer_principal_id=? AND used_at IS NULL`,
        )
        .run(stamp, merchant, buyer);
      const view = this.current(merchant, buyer);
      this.db.exec("commit");
      return view;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  activeCount(merchantId: string): number {
    const row = this.db
      .prepare("SELECT count(*) count FROM merchant_follow_relations WHERE merchant_id=? AND status='active'")
      .get(merchantId) as { count: number };
    return row.count;
  }

  sweep(): { idempotency: number; contexts: number; tombstones: number } {
    const stamp = this.now();
    const idempotency = this.db
      .prepare("DELETE FROM merchant_follow_idempotency WHERE expires_at<=?")
      .run(stamp).changes;
    // Keep expired context tombstones for 30 days so a delayed old intention receives
    // IDEMPOTENCY_WINDOW_EXPIRED instead of being mistaken for a new/unknown request.
    const contextCutoff = new Date(Date.parse(stamp) - THIRTY_DAYS_MS).toISOString();
    const contexts = this.db
      .prepare("DELETE FROM merchant_follow_mutation_contexts WHERE expires_at<=?")
      .run(contextCutoff).changes;
    const tombstoneCutoff = new Date(Date.parse(stamp) - THIRTY_DAYS_MS).toISOString();
    const tombstones = this.db
      .prepare(
        `DELETE FROM merchant_follow_relations
         WHERE status='cancelled' AND cancelled_at IS NOT NULL AND cancelled_at<=?`,
      )
      .run(tombstoneCutoff).changes;
    return {
      idempotency: Number(idempotency),
      contexts: Number(contexts),
      tombstones: Number(tombstones),
    };
  }

  private current(merchantId: string, buyerPrincipalId: string): FollowView {
    const relation = this.db
      .prepare(
        `SELECT * FROM merchant_follow_relations
         WHERE merchant_id=? AND buyer_principal_id=?`,
      )
      .get(merchantId, buyerPrincipalId) as unknown as RelationRow | undefined;
    const epochRow = this.db
      .prepare(
        `SELECT epoch FROM merchant_follow_subject_epochs
         WHERE merchant_id=? AND buyer_principal_id=?`,
      )
      .get(merchantId, buyerPrincipalId) as { epoch: number } | undefined;
    const epoch = Math.max(relation?.epoch ?? 0, epochRow?.epoch ?? 0);
    if (relation === undefined) {
      return {
        merchant_id: merchantId,
        following: false,
        revision: 0,
        epoch,
        consent_version: null,
        category: null,
        updated_at: null,
      };
    }
    return {
      merchant_id: merchantId,
      following: relation.status === "active",
      revision: relation.revision,
      epoch,
      consent_version: relation.consent_version,
      category: relation.category,
      updated_at: relation.updated_at,
    };
  }

  private issueContext(
    merchantId: string,
    buyerPrincipalId: string,
    action: "follow" | "unfollow",
    baseRevision: number,
    epoch: number,
  ): { ref: string; expires_at: string } {
    const stamp = this.now();
    const ref = `fmc_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.parse(stamp) + FIVE_MINUTES_MS).toISOString();
    this.db
      .prepare(
        `INSERT INTO merchant_follow_mutation_contexts
         (context_ref, merchant_id, buyer_principal_id, action, base_revision, epoch,
          expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ref, merchantId, buyerPrincipalId, action, baseRevision, epoch, expiresAt, stamp);
    return { ref, expires_at: expiresAt };
  }

  private requireContext(ref: string): ContextRow {
    const row = this.db
      .prepare("SELECT * FROM merchant_follow_mutation_contexts WHERE context_ref=?")
      .get(requireText(ref, "mutationContext")) as unknown as ContextRow | undefined;
    if (row === undefined) {
      throw new MerchantFollowError("mutation_context_invalid", "unknown mutation context");
    }
    return row;
  }
}

export function followRequestDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function requireText(value: string, field: string): string {
  const text = String(value ?? "").trim();
  if (text === "") throw new MerchantFollowError("invalid_input", `${field} must be non-empty`);
  return text;
}

function requireDigest(value: string): string {
  const digest = requireText(value, "requestDigest");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new MerchantFollowError("invalid_input", "requestDigest must be sha256:<64 lowercase hex>");
  }
  return digest;
}

function cleanOptional(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.trim();
  return text === "" ? null : text;
}
