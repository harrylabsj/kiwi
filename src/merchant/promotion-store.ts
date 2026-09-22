/** Versioned promotion authority with exact money and server-time validity. */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { parseExactMoney, type ExactMoney } from "./application/money.js";
import { ClockSafetyError, type ClockSafetyStore } from "./clock-safety.js";
import {
  parsePromotionBoundary,
  promotionIsActive,
  type PromotionBoundary,
} from "./promotion-time.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchant_promotions (
  merchant_id TEXT NOT NULL,
  promotion_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  sku_refs_json TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  audience TEXT NOT NULL CHECK(audience='public'),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  starts_input TEXT NOT NULL,
  ends_input TEXT NOT NULL,
  starts_offset TEXT NOT NULL,
  ends_offset TEXT NOT NULL,
  time_rule_version TEXT NOT NULL,
  stackable INTEGER NOT NULL CHECK(stackable IN (0,1)),
  priority INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','published','withdrawn')),
  published_by TEXT,
  approval_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, promotion_id)
);
CREATE TABLE IF NOT EXISTS merchant_promotion_revisions (
  merchant_id TEXT NOT NULL,
  promotion_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, promotion_id, revision)
);
`;

export type PromotionRule =
  | { kind: "limited_price"; unit_price: ExactMoney }
  | {
      kind: "quantity_tiers";
      tiers: Array<{ min_quantity: number; unit_price: ExactMoney }>;
    };

export interface PromotionProjection {
  promotion_id: string;
  revision: number;
  sku_refs: string[];
  rule: PromotionRule;
  audience: "public";
  starts_at: string;
  ends_at: string;
  timezone: string;
  starts_input: string;
  ends_input: string;
  starts_offset: string;
  ends_offset: string;
  time_rule_version: string;
  stackable: boolean;
  priority: number;
  status: "draft" | "published" | "withdrawn";
  effective_state: "draft" | "scheduled" | "active" | "ended" | "withdrawn";
  published_by: string | null;
  approval_ref: string | null;
}

export class MerchantPromotionError extends Error {
  readonly code: "validation_error" | "not_found" | "version_conflict" | "clock_skew";
  constructor(code: MerchantPromotionError["code"], message: string) {
    super(message);
    this.name = "MerchantPromotionError";
    this.code = code;
  }
}

export class MerchantPromotionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly clockSafety?: Pick<ClockSafetyStore, "assertTimeSensitiveWritesAllowed">;

  constructor(options: {
    db: DatabaseSync;
    now?: () => string;
    clockSafety?: Pick<ClockSafetyStore, "assertTimeSensitiveWritesAllowed">;
  }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.clockSafety = options.clockSafety;
    this.db.exec("pragma busy_timeout=5000");
    this.db.exec(SCHEMA);
  }

  createDraft(
    merchantId: string,
    input: {
      skuRefs: readonly string[];
      rule: unknown;
      audience: "public";
      starts: string;
      ends: string;
      timezone: string;
      endsDateInclusive?: boolean;
      stackable?: boolean;
      priority?: number;
    },
  ): { promotion_id: string; revision: number } {
    this.assertClockSafe(merchantId);
    if (input.audience !== "public") {
      throw new MerchantPromotionError("validation_error", "promotion audience must be public");
    }
    const skuRefs = normalizeSkus(input.skuRefs);
    const rule = normalizeRule(input.rule);
    let starts: PromotionBoundary;
    let ends: PromotionBoundary;
    try {
      starts = parsePromotionBoundary({ value: input.starts, timezone: input.timezone });
      ends = parsePromotionBoundary({
        value: input.ends,
        timezone: input.timezone,
        ...(input.endsDateInclusive === true ? { dateEndInclusive: true } : {}),
      });
    } catch (error) {
      throw new MerchantPromotionError(
        "validation_error",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (Date.parse(starts.instant) >= Date.parse(ends.instant)) {
      throw new MerchantPromotionError(
        "validation_error",
        "promotion starts_at must precede ends_at",
      );
    }
    const priority = input.priority ?? 0;
    if (!Number.isSafeInteger(priority)) {
      throw new MerchantPromotionError("validation_error", "promotion priority must be an integer");
    }
    const promotionId = `prm_${randomBytes(16).toString("base64url")}`;
    const stamp = this.now();
    this.db.exec("begin immediate");
    try {
      this.db
        .prepare(
          `INSERT INTO merchant_promotions
         (merchant_id, promotion_id, revision, sku_refs_json, rule_json, audience,
          starts_at, ends_at, timezone, starts_input, ends_input, starts_offset, ends_offset,
          time_rule_version, stackable, priority, status, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, 'public', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        )
        .run(
          requireText(merchantId, "merchantId"),
          promotionId,
          JSON.stringify(skuRefs),
          JSON.stringify(rule),
          starts.instant,
          ends.instant,
          starts.timezone,
          starts.input,
          ends.input,
          starts.offset,
          ends.offset,
          starts.rule_version,
          input.stackable === true ? 1 : 0,
          priority,
          stamp,
          stamp,
        );
      this.writeRevision(merchantId, promotionId, 1);
      this.db.exec("commit");
      return { promotion_id: promotionId, revision: 1 };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  publish(
    merchantId: string,
    promotionId: string,
    expectedRevision: number,
    input: { publishedBy: string; approvalRef: string },
  ): { promotion_id: string; revision: number } {
    this.assertClockSafe(merchantId);
    return this.transition(merchantId, promotionId, expectedRevision, "draft", "published", input);
  }

  withdraw(
    merchantId: string,
    promotionId: string,
    expectedRevision: number,
    input: { publishedBy: string; approvalRef: string },
  ): { promotion_id: string; revision: number } {
    return this.transition(
      merchantId,
      promotionId,
      expectedRevision,
      "published",
      "withdrawn",
      input,
    );
  }

  /**
   * 对账查询：按商家隔离，用 approval_ref（= committed decision 的 operationId）
   * 反查本次状态迁移落的那一行。
   *
   * 促销与广播不同，不建独立回执表：publish/withdraw 在 `begin immediate` 里把
   * approval_ref 与状态迁移写进**同一个 UPDATE**，「查到引用 ⟺ 效果已提交」。
   * 代价是每行只保留**最近一次**操作的引用——若本次操作之后又有新操作覆盖了
   * approval_ref，这里返回 undefined，对账得 unknown（保守升级为人工，不会误判）。
   */
  getOperation(merchantId: string, operationId: string): PromotionProjection | undefined {
    const row = this.db
      .prepare("SELECT * FROM merchant_promotions WHERE merchant_id=? AND approval_ref=?")
      .get(merchantId, operationId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.project(row);
  }

  getPromotion(merchantId: string, promotionId: string): PromotionProjection | undefined {
    const row = this.db
      .prepare("SELECT * FROM merchant_promotions WHERE merchant_id=? AND promotion_id=?")
      .get(merchantId, promotionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.project(row);
  }

  listPromotions(
    merchantId: string,
    options: { cursor?: string; limit?: number } = {},
  ): { items: PromotionProjection[]; next_cursor: string | null } {
    const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new MerchantPromotionError("validation_error", "promotion cursor is invalid");
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const rows = this.db
      .prepare(
        `SELECT * FROM merchant_promotions WHERE merchant_id=?
         ORDER BY updated_at DESC, promotion_id LIMIT ? OFFSET ?`,
      )
      .all(merchantId, limit + 1, offset) as Array<Record<string, unknown>>;
    return {
      items: rows.slice(0, limit).map((row) => this.project(row)),
      next_cursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  summary(merchantId: string): {
    total: number;
    draft: number;
    scheduled: number;
    active: number;
    ended: number;
    withdrawn: number;
  } {
    const rows = this.db
      .prepare("SELECT * FROM merchant_promotions WHERE merchant_id=?")
      .all(merchantId) as Array<Record<string, unknown>>;
    const result = {
      total: rows.length,
      draft: 0,
      scheduled: 0,
      active: 0,
      ended: 0,
      withdrawn: 0,
    };
    for (const row of rows) result[this.project(row).effective_state] += 1;
    return result;
  }

  activeForSku(
    merchantId: string,
    sku: string,
    quantity: number,
  ): Array<{
    promotion_id: string;
    revision: number;
    unit_price: ExactMoney;
    ends_at: string;
    priority: number;
  }> {
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new MerchantPromotionError("validation_error", "quantity must be a positive integer");
    }
    const now = this.now();
    const rows = this.db
      .prepare("SELECT * FROM merchant_promotions WHERE merchant_id=? AND status='published'")
      .all(merchantId) as Array<Record<string, unknown>>;
    if (rows.length > 0) this.assertClockSafe(merchantId);
    return rows
      .map((row) => this.project(row))
      .filter(
        (item) =>
          item.status === "published" &&
          item.sku_refs.includes(sku) &&
          promotionIsActive(item.starts_at, item.ends_at, now),
      )
      .map((item) => ({
        promotion_id: item.promotion_id,
        revision: item.revision,
        unit_price: priceForQuantity(item.rule, quantity),
        ends_at: item.ends_at,
        priority: item.priority,
      }))
      .sort(
        (left, right) =>
          right.priority - left.priority || left.promotion_id.localeCompare(right.promotion_id),
      );
  }

  private assertClockSafe(merchantId: string): void {
    try {
      this.clockSafety?.assertTimeSensitiveWritesAllowed(merchantId);
    } catch (error) {
      if (error instanceof ClockSafetyError) {
        throw new MerchantPromotionError("clock_skew", error.message);
      }
      throw error;
    }
  }

  private transition(
    merchantId: string,
    promotionId: string,
    expectedRevision: number,
    expectedStatus: "draft" | "published",
    nextStatus: "published" | "withdrawn",
    input: { publishedBy: string; approvalRef: string },
  ): { promotion_id: string; revision: number } {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new MerchantPromotionError("validation_error", "expected revision is invalid");
    }
    const stamp = this.now();
    const revision = expectedRevision + 1;
    this.db.exec("begin immediate");
    try {
      const changed = this.db
        .prepare(
          `UPDATE merchant_promotions SET revision=?, status=?, published_by=?, approval_ref=?, updated_at=?
         WHERE merchant_id=? AND promotion_id=? AND revision=? AND status=?`,
        )
        .run(
          revision,
          nextStatus,
          requireText(input.publishedBy, "publishedBy"),
          requireText(input.approvalRef, "approvalRef"),
          stamp,
          merchantId,
          promotionId,
          expectedRevision,
          expectedStatus,
        );
      if (changed.changes !== 1) {
        const existing = this.getPromotion(merchantId, promotionId);
        if (existing === undefined)
          throw new MerchantPromotionError("not_found", "unknown promotion");
        throw new MerchantPromotionError("version_conflict", "promotion revision/status changed");
      }
      this.writeRevision(merchantId, promotionId, revision);
      this.db.exec("commit");
      return { promotion_id: promotionId, revision };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private writeRevision(merchantId: string, promotionId: string, revision: number): void {
    const projection = this.getPromotion(merchantId, promotionId);
    if (projection === undefined) throw new Error("promotion disappeared during revision write");
    this.db
      .prepare(
        `INSERT INTO merchant_promotion_revisions
         (merchant_id, promotion_id, revision, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(merchantId, promotionId, revision, JSON.stringify(projection), this.now());
  }

  private project(row: Record<string, unknown>): PromotionProjection {
    const status = String(row["status"]) as PromotionProjection["status"];
    const nowMs = Date.parse(this.now());
    const effectiveState: PromotionProjection["effective_state"] =
      status === "draft"
        ? "draft"
        : status === "withdrawn"
          ? "withdrawn"
          : nowMs < Date.parse(String(row["starts_at"]))
            ? "scheduled"
            : nowMs >= Date.parse(String(row["ends_at"]))
              ? "ended"
              : "active";
    return {
      promotion_id: String(row["promotion_id"]),
      revision: Number(row["revision"]),
      sku_refs: JSON.parse(String(row["sku_refs_json"])) as string[],
      rule: JSON.parse(String(row["rule_json"])) as PromotionRule,
      audience: "public",
      starts_at: String(row["starts_at"]),
      ends_at: String(row["ends_at"]),
      timezone: String(row["timezone"]),
      starts_input: String(row["starts_input"]),
      ends_input: String(row["ends_input"]),
      starts_offset: String(row["starts_offset"]),
      ends_offset: String(row["ends_offset"]),
      time_rule_version: String(row["time_rule_version"]),
      stackable: Number(row["stackable"]) === 1,
      priority: Number(row["priority"]),
      status,
      effective_state: effectiveState,
      published_by: row["published_by"] === null ? null : String(row["published_by"]),
      approval_ref: row["approval_ref"] === null ? null : String(row["approval_ref"]),
    };
  }
}

function normalizeSkus(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) {
    throw new MerchantPromotionError("validation_error", "promotion requires 1 to 50 SKU refs");
  }
  return [...new Set(input.map((sku) => requireText(sku, "sku")))].sort();
}

function normalizeRule(value: unknown): PromotionRule {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MerchantPromotionError("validation_error", "promotion rule must be an object");
  }
  const row = value as Record<string, unknown>;
  if (row["kind"] === "limited_price") {
    return { kind: "limited_price", unit_price: parseMoney(row["unit_price"]) };
  }
  if (
    row["kind"] !== "quantity_tiers" ||
    !Array.isArray(row["tiers"]) ||
    row["tiers"].length === 0
  ) {
    throw new MerchantPromotionError("validation_error", "promotion rule kind is invalid");
  }
  const tiers = row["tiers"].map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new MerchantPromotionError("validation_error", "promotion tier must be an object");
    }
    const tier = value as Record<string, unknown>;
    if (!Number.isSafeInteger(tier["min_quantity"]) || Number(tier["min_quantity"]) < 1) {
      throw new MerchantPromotionError("validation_error", "tier min_quantity must be positive");
    }
    return {
      min_quantity: Number(tier["min_quantity"]),
      unit_price: parseMoney(tier["unit_price"]),
    };
  });
  tiers.sort((left, right) => left.min_quantity - right.min_quantity);
  if (
    tiers.some((tier, index) => index > 0 && tier.min_quantity === tiers[index - 1]!.min_quantity)
  ) {
    throw new MerchantPromotionError(
      "validation_error",
      "promotion tier thresholds must be unique",
    );
  }
  const currency = tiers[0]!.unit_price.currency;
  if (tiers.some((tier) => tier.unit_price.currency !== currency)) {
    throw new MerchantPromotionError("validation_error", "promotion tiers must use one currency");
  }
  return { kind: "quantity_tiers", tiers };
}

function parseMoney(value: unknown): ExactMoney {
  try {
    return parseExactMoney(value, { requireOperatingSupport: true });
  } catch (error) {
    throw new MerchantPromotionError(
      "validation_error",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function priceForQuantity(rule: PromotionRule, quantity: number): ExactMoney {
  if (rule.kind === "limited_price") return rule.unit_price;
  const matched = rule.tiers.filter((tier) => tier.min_quantity <= quantity).at(-1);
  if (matched === undefined) {
    throw new MerchantPromotionError("not_found", "no promotion tier applies to this quantity");
  }
  return matched.unit_price;
}

function requireText(value: string, field: string): string {
  const text = String(value ?? "").trim();
  if (text === "") throw new MerchantPromotionError("validation_error", `${field} is required`);
  return text;
}
