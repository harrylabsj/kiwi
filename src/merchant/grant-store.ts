/** Workbench scoped Operator grants (design §14.2 / WB-055). */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { assertVerifiedActor, type VerifiedActorContext } from "./application/actor.js";

export const GRANT_ACTIONS = [
  "product.read",
  "product.draft",
  "product.decide",
  "product.create",
  "broadcast.draft",
  "broadcast.decide",
  "runtime.safety_stop",
] as const;
export type GrantAction = (typeof GRANT_ACTIONS)[number];
export type GrantResourceType = "merchant" | "product";

export interface MerchantGrantProjection {
  grant_id: string;
  subject_id: string;
  merchant_id: string;
  action: GrantAction;
  resource_type: GrantResourceType;
  resource_selector: { kind: "merchant" | "all_products" | "sku_ids"; sku_ids?: string[] };
  expires_at: string;
  grant_version: number;
  granted_by: string;
  created_at: string;
  revoked_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_operator_grants (
  grant_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('merchant','product')),
  resource_selector_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  grant_version INTEGER NOT NULL,
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_merchant_operator_grants_subject
  ON merchant_operator_grants(merchant_id, subject_id, action, resource_type);
CREATE TABLE IF NOT EXISTS merchant_grant_generations (
  merchant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, subject_id)
);
`;

export class MerchantGrantError extends Error {
  readonly code: "invalid_input" | "forbidden" | "not_found";
  constructor(code: MerchantGrantError["code"], message: string) {
    super(message);
    this.name = "MerchantGrantError";
    this.code = code;
  }
}

export class MerchantGrantStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now?: () => string }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.db.exec("pragma busy_timeout=5000");
    this.db.exec(SCHEMA);
  }

  createGrant(
    owner: VerifiedActorContext,
    input: {
      subjectId: string;
      action: GrantAction;
      resourceType: GrantResourceType;
      resourceSelector: "all_products" | readonly string[] | "merchant";
      expiresAt: string;
    },
  ): { grant_id: string; grant_version: number; authorization_generation: number } {
    const actor = assertVerifiedActor(owner);
    if (actor.role !== "owner" || !actor.permissions.has("grants:manage")) {
      throw new MerchantGrantError("forbidden", "only owner can create grants");
    }
    const subject = requireText(input.subjectId, "subjectId");
    if (!GRANT_ACTIONS.includes(input.action)) {
      throw new MerchantGrantError("invalid_input", "unknown grant action");
    }
    const selector = normalizeSelector(input.resourceType, input.resourceSelector);
    if (
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) <= Date.parse(this.now())
    ) {
      throw new MerchantGrantError("invalid_input", "grant expiry must be in the future");
    }
    const stamp = this.now();
    this.db.exec("begin immediate");
    try {
      const generation = this.bumpGeneration(actor.merchantId, subject, stamp);
      const row = this.db
        .prepare(
          `SELECT max(grant_version) value FROM merchant_operator_grants
           WHERE merchant_id=? AND subject_id=?`,
        )
        .get(actor.merchantId, subject) as { value: number | null };
      const version = (row.value ?? 0) + 1;
      const grantId = `mgr_${randomBytes(16).toString("base64url")}`;
      this.db
        .prepare(
          `INSERT INTO merchant_operator_grants
           (grant_id, subject_id, merchant_id, action, resource_type,
            resource_selector_json, expires_at, grant_version, granted_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          grantId,
          subject,
          actor.merchantId,
          input.action,
          input.resourceType,
          JSON.stringify(selector),
          input.expiresAt,
          version,
          actor.actorId,
          stamp,
        );
      this.db.exec("commit");
      return { grant_id: grantId, grant_version: version, authorization_generation: generation };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  revokeGrant(owner: VerifiedActorContext, grantId: string): number {
    const actor = assertVerifiedActor(owner);
    if (actor.role !== "owner" || !actor.permissions.has("grants:manage")) {
      throw new MerchantGrantError("forbidden", "only owner can revoke grants");
    }
    this.db.exec("begin immediate");
    try {
      const row = this.db
        .prepare(
          `SELECT subject_id FROM merchant_operator_grants
           WHERE grant_id=? AND merchant_id=? AND revoked_at IS NULL`,
        )
        .get(grantId, actor.merchantId) as { subject_id: string } | undefined;
      if (row === undefined) throw new MerchantGrantError("not_found", "unknown active grant");
      const stamp = this.now();
      this.db
        .prepare(
          "UPDATE merchant_operator_grants SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL",
        )
        .run(stamp, grantId);
      const generation = this.bumpGeneration(actor.merchantId, row.subject_id, stamp);
      this.db.exec("commit");
      return generation;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  authorizationGeneration(merchantId: string, subjectId: string): number {
    const row = this.db
      .prepare(
        `SELECT generation FROM merchant_grant_generations
         WHERE merchant_id=? AND subject_id=?`,
      )
      .get(merchantId, subjectId) as { generation: number } | undefined;
    return row?.generation ?? 0;
  }

  getGrant(merchantId: string, grantId: string): MerchantGrantProjection | undefined {
    const row = this.db
      .prepare("SELECT * FROM merchant_operator_grants WHERE merchant_id=? AND grant_id=?")
      .get(merchantId, grantId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : grantProjection(row);
  }

  listGrants(
    merchantId: string,
    options: { cursor?: string; limit?: number } = {},
  ): { items: MerchantGrantProjection[]; next_cursor: string | null } {
    const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new MerchantGrantError("invalid_input", "grant cursor is invalid");
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const rows = this.db
      .prepare(
        `SELECT * FROM merchant_operator_grants WHERE merchant_id=?
         ORDER BY created_at DESC, grant_id LIMIT ? OFFSET ?`,
      )
      .all(merchantId, limit + 1, offset) as Array<Record<string, unknown>>;
    return {
      items: rows.slice(0, limit).map(grantProjection),
      next_cursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  authorize(
    context: VerifiedActorContext,
    input: {
      action: GrantAction;
      resourceType: GrantResourceType;
      resourceIds?: readonly string[];
    },
  ): { authorized: boolean; generation: number; grantIds: string[] } {
    const actor = assertVerifiedActor(context);
    const generation = this.authorizationGeneration(actor.merchantId, actor.actorId);
    if (actor.role === "owner") return { authorized: true, generation, grantIds: [] };
    if (actor.role !== "operator") return { authorized: false, generation, grantIds: [] };
    return this.authorizeSubject(actor.merchantId, actor.actorId, input);
  }

  /** Internal execution-time recheck for a previously authenticated Operator actor. */
  authorizeSubject(
    merchantId: string,
    subjectId: string,
    input: {
      action: GrantAction;
      resourceType: GrantResourceType;
      resourceIds?: readonly string[];
    },
  ): { authorized: boolean; generation: number; grantIds: string[] } {
    const generation = this.authorizationGeneration(merchantId, subjectId);
    const rows = this.db
      .prepare(
        `SELECT grant_id, resource_selector_json FROM merchant_operator_grants
         WHERE merchant_id=? AND subject_id=? AND action=? AND resource_type=?
           AND revoked_at IS NULL AND expires_at>?`,
      )
      .all(merchantId, subjectId, input.action, input.resourceType, this.now()) as Array<{
      grant_id: string;
      resource_selector_json: string;
    }>;
    const resources = [...new Set(input.resourceIds ?? [])];
    const matched: string[] = [];
    const covered = new Set<string>();
    let all = false;
    for (const row of rows) {
      const selector = JSON.parse(row.resource_selector_json) as {
        kind: string;
        sku_ids?: string[];
      };
      if (input.resourceType === "merchant" && selector.kind === "merchant") {
        matched.push(row.grant_id);
        all = true;
      }
      if (input.resourceType === "product") {
        if (selector.kind === "all_products") all = true;
        for (const sku of selector.sku_ids ?? []) covered.add(sku);
        matched.push(row.grant_id);
      }
    }
    const authorized =
      all || (resources.length > 0 && resources.every((resource) => covered.has(resource)));
    return { authorized, generation, grantIds: authorized ? matched : [] };
  }

  private bumpGeneration(merchantId: string, subjectId: string, stamp: string): number {
    this.db
      .prepare(
        `INSERT INTO merchant_grant_generations(merchant_id, subject_id, generation, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(merchant_id, subject_id) DO UPDATE SET
           generation=generation+1, updated_at=excluded.updated_at`,
      )
      .run(merchantId, subjectId, stamp);
    return this.authorizationGeneration(merchantId, subjectId);
  }
}

export function isCurrentGrantAuthorization(
  store: MerchantGrantStore,
  input: {
    merchantId: string;
    actorId: string;
    action: GrantAction;
    resourceType?: GrantResourceType;
    resourceIds?: readonly string[];
    snapshot: Readonly<Record<string, unknown>>;
  },
): boolean {
  if (input.snapshot["actor_id"] !== input.actorId || input.snapshot["action"] !== input.action) {
    return false;
  }
  if (input.snapshot["actor_role"] === "owner") return true;
  if (input.snapshot["actor_role"] !== "operator") return false;
  const expectedGeneration = input.snapshot["authorization_generation"];
  if (!Number.isInteger(expectedGeneration)) return false;
  const current = store.authorizeSubject(input.merchantId, input.actorId, {
    action: input.action,
    resourceType: input.resourceType ?? "merchant",
    ...(input.resourceIds !== undefined ? { resourceIds: input.resourceIds } : {}),
  });
  return current.authorized && current.generation === expectedGeneration;
}

function normalizeSelector(
  resourceType: GrantResourceType,
  selector: "all_products" | readonly string[] | "merchant",
): { kind: "merchant" | "all_products" | "sku_ids"; sku_ids?: string[] } {
  if (resourceType === "merchant") {
    if (selector !== "merchant") {
      throw new MerchantGrantError("invalid_input", "merchant action requires merchant selector");
    }
    return { kind: "merchant" };
  }
  if (selector === "all_products") return { kind: "all_products" };
  if (!Array.isArray(selector) || selector.length === 0) {
    throw new MerchantGrantError(
      "invalid_input",
      "product selector requires all_products or SKU ids",
    );
  }
  const skuIds = [...new Set(selector.map((value) => requireText(String(value), "sku")))].sort();
  return { kind: "sku_ids", sku_ids: skuIds };
}

function requireText(value: string, field: string): string {
  const text = String(value ?? "").trim();
  if (text === "") throw new MerchantGrantError("invalid_input", `${field} must be non-empty`);
  return text;
}

function grantProjection(row: Record<string, unknown>): MerchantGrantProjection {
  return {
    grant_id: String(row["grant_id"]),
    subject_id: String(row["subject_id"]),
    merchant_id: String(row["merchant_id"]),
    action: String(row["action"]) as GrantAction,
    resource_type: String(row["resource_type"]) as GrantResourceType,
    resource_selector: JSON.parse(
      String(row["resource_selector_json"]),
    ) as MerchantGrantProjection["resource_selector"],
    expires_at: String(row["expires_at"]),
    grant_version: Number(row["grant_version"]),
    granted_by: String(row["granted_by"]),
    created_at: String(row["created_at"]),
    revoked_at: row["revoked_at"] === null ? null : String(row["revoked_at"]),
  };
}
