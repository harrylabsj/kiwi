/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 企业一次委托与已发报价历史（买家识别与交易回执 · K2，设计 §2.3/§2.4）。
 *
 * 委托：买方经请求体签名覆盖的 A2A message metadata 附上声明（本店、用途、
 * 版本、期限）。商家校验后在 `quote_history_delegations` 保存版本与状态，
 * 并经既有 `DataUseGrantStore` 建立/续期 `history_recall` grant——授权本体
 * 复用既有授权词表与 epoch 机制，撤销版本持久保存：旧版本重放、撤销后
 * 重放一律拒绝。
 *
 * 报价历史：报价正式发布时把（本店客户、SKU、可溯源规格快照、价格、有效期）
 * 索引到 `published_offers`；回访查询只读本表，读前复核绑定与授权，
 * 返回前复核撤销版本。SKU 单独无法证明规格——spec_json 引用报价当时的
 * 来源快照；找不到来源的字段留空，草稿不进入（只索引 message_sent 落账后的
 * 正式报价）。
 */

import type { DatabaseSync } from "node:sqlite";

import { DataUseGrantStore } from "../context-governance/data-use-grant.js";
import { inImmediateTransaction } from "../storage/transaction.js";
import { CustomerMemoryError } from "./types.js";

export const QUOTE_HISTORY_PURPOSE = "quote_history" as const;
export const DELEGATION_TYPE = "kiwi.quote-history-delegation" as const;
export const DELEGATION_VERSION = 1;

/** 买方随已签名 A2A message metadata 附带的委托声明。 */
export interface QuoteHistoryDelegation {
  type: typeof DELEGATION_TYPE;
  version: number;
  merchant_id: string;
  purpose: typeof QUOTE_HISTORY_PURPOSE;
  delegation_id: string;
  issued_at: string;
  expires_at: string;
  buyer_agent_id?: string;
}

export type DelegationOutcome =
  | { status: "active"; grant_id: string; grant_epoch: number; subject_id: string }
  /** 版本落后于已保存/已撤销版本：旧委托重放，拒绝（按未委托处理）。 */
  | { status: "stale" }
  | { status: "rejected"; reason: string };

export interface QuoteHistoryHit {
  negotiation_id: string;
  offer_id: string;
  offer_version: number;
  sku: string;
  quantity: number;
  unit: string;
  currency: string;
  unit_price_minor: number;
  terms_digest: string;
  spec: Record<string, unknown>;
  valid_until?: string;
  quoted_at: string;
}

function requireText(value: unknown, field: string, max = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new CustomerMemoryError("validation", `${field}_invalid`, `${field} 必须是 1..${max} 字符`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new CustomerMemoryError("validation", `${field}_invalid`, `${field} 含控制字符`);
  }
  return value;
}

function isoOf(value: unknown, field: string): string {
  const text = requireText(value, field, 64);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new CustomerMemoryError("validation", `${field}_invalid`, `${field} 必须是 RFC3339 时间`);
  }
  return new Date(parsed).toISOString();
}

/** 校验买方委托声明（形状 + 商家绑定 + 期限）。失败返回 rejected 原因。 */
export function validateDelegationShape(
  raw: unknown,
  merchantId: string,
  now: string,
): { ok: true; delegation: QuoteHistoryDelegation } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "delegation_missing" };
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate["type"] !== DELEGATION_TYPE) return { ok: false, reason: "delegation_type_unknown" };
  const version = candidate["version"];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    return { ok: false, reason: "delegation_version_invalid" };
  }
  if (candidate["purpose"] !== QUOTE_HISTORY_PURPOSE) return { ok: false, reason: "delegation_purpose_unknown" };
  if (candidate["merchant_id"] !== merchantId) return { ok: false, reason: "delegation_merchant_mismatch" };
  let delegation: QuoteHistoryDelegation;
  try {
    delegation = {
      type: DELEGATION_TYPE,
      version,
      merchant_id: merchantId,
      purpose: QUOTE_HISTORY_PURPOSE,
      delegation_id: requireText(candidate["delegation_id"], "delegation_id"),
      issued_at: isoOf(candidate["issued_at"], "issued_at"),
      expires_at: isoOf(candidate["expires_at"], "expires_at"),
      ...(typeof candidate["buyer_agent_id"] === "string" && candidate["buyer_agent_id"] !== ""
        ? { buyer_agent_id: requireText(candidate["buyer_agent_id"], "buyer_agent_id", 256) }
        : {}),
    };
  } catch {
    return { ok: false, reason: "delegation_fields_invalid" };
  }
  if (Date.parse(delegation.expires_at) <= Date.parse(now)) {
    return { ok: false, reason: "delegation_expired" };
  }
  const issuedAt = Date.parse(delegation.issued_at);
  const expiresAt = Date.parse(delegation.expires_at);
  if (issuedAt > Date.parse(now) + 5 * 60_000 || expiresAt - issuedAt > 90 * 86_400_000 || issuedAt >= expiresAt) {
    return { ok: false, reason: "delegation_window_invalid" };
  }
  return { ok: true, delegation };
}

export class QuoteHistoryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: { db: DatabaseSync; now: () => string }) {
    this.db = options.db;
    this.now = options.now;
  }

  /**
   * 建立或续期本店委托：版本单调（保存撤销版本）；新版本过期时间生效前
   * 旧版本仍然按已保存水位拒绝。同一版本幂等重入返回原结果。
   */
  applyDelegation(input: {
    merchant_id: string;
    buyer_actor: string;
    subject_id: string;
    delegation: QuoteHistoryDelegation;
  }): DelegationOutcome {
    try {
      const merchantId = requireText(input.merchant_id, "merchant_id");
      const buyerActor = requireText(input.buyer_actor, "buyer_actor", 256);
      const subjectId = requireText(input.subject_id, "subject_id");
      const stamp = this.now();
      return inImmediateTransaction(this.db, () => {
        const existing = this.db
          .prepare(
            "SELECT version, status, grant_id, grant_epoch, subject_id FROM quote_history_delegations WHERE merchant_id = ? AND buyer_actor = ?",
          )
          .get(merchantId, buyerActor) as
          | { version: number; status: string; grant_id: string; grant_epoch: number; subject_id: string }
          | undefined;
        if (
          existing !== undefined &&
          input.delegation.version < existing.version
        ) {
          return { status: "stale" as const };
        }
        if (
          existing !== undefined &&
          input.delegation.version === existing.version &&
          existing.status === "REVOKED"
        ) {
          // 撤销版本水位：同版本重放（撤销后的重发/重放）不得恢复授权；
          // 只有买方以新版本声明（新 consent，随新签名请求到达）才重新建立。
          return { status: "stale" as const };
        }
        if (
          existing !== undefined &&
          input.delegation.version === existing.version &&
          existing.status === "ACTIVE" &&
          existing.grant_id !== ""
        ) {
          return {
            status: "active" as const,
            grant_id: existing.grant_id,
            grant_epoch: existing.grant_epoch,
            subject_id: existing.subject_id,
          };
        }

        // 委托生效 = 建立/续期 history_recall grant（复用既有授权本体）。
        const grants = new DataUseGrantStore({ db: this.db, now: this.now });
        if (existing?.grant_id) this.revokeUnderlyingGrant(merchantId, existing.grant_id);
        this.db
          .prepare(
            `INSERT INTO data_scopes
              (merchant_id, erase_scope_id, data_epoch, state, sealed_at, updated_at)
             VALUES (?, ?, 1, 'ACTIVE', NULL, ?)
             ON CONFLICT(merchant_id, erase_scope_id) DO NOTHING`,
          )
          .run(merchantId, `quote-history:${subjectId}`, stamp);
        const grant = grants.createGrant({
          merchant_id: merchantId,
          subject_id: subjectId,
          purpose: "history_recall",
          resource_scope_id: `quote-history:${subjectId}`,
          expires_at: input.delegation.expires_at,
        });
        this.db
          .prepare(
            `INSERT INTO quote_history_delegations
              (merchant_id, buyer_actor, subject_id, delegation_id, version, purpose,
               grant_id, grant_epoch, issued_at, expires_at, status, source_ref,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
             ON CONFLICT(merchant_id, buyer_actor) DO UPDATE SET
               subject_id = excluded.subject_id,
               delegation_id = excluded.delegation_id,
               version = excluded.version,
               grant_id = excluded.grant_id,
               grant_epoch = excluded.grant_epoch,
               issued_at = excluded.issued_at,
               expires_at = excluded.expires_at,
               status = 'ACTIVE',
               source_ref = excluded.source_ref,
               updated_at = excluded.updated_at`,
          )
          .run(
            merchantId,
            buyerActor,
            subjectId,
            input.delegation.delegation_id,
            input.delegation.version,
            QUOTE_HISTORY_PURPOSE,
            grant.grant_id,
            grant.grant_epoch,
            input.delegation.issued_at,
            input.delegation.expires_at,
            `delegation:${input.delegation.delegation_id}`,
            stamp,
            stamp,
          );
        return {
          status: "active" as const,
          grant_id: grant.grant_id,
          grant_epoch: grant.grant_epoch,
          subject_id: subjectId,
        };
      });
    } catch (err) {
      return {
        status: "rejected" as const,
        reason: err instanceof CustomerMemoryError ? err.reason : "delegation_store_error",
      };
    }
  }

  /** Sweep quote snapshots and grants left active by pre-fix delegation versions. */
  pruneForMerchant(merchantId: string): void {
    inImmediateTransaction(this.db, () => {
      const now = this.now();
      this.db.prepare(
        "DELETE FROM published_offers WHERE merchant_id = ? AND julianday(quoted_at) <= julianday(?) - 90",
      ).run(merchantId, now);
      this.db.prepare(
        `UPDATE quote_history_delegations SET status = 'REVOKED', updated_at = ?
          WHERE merchant_id = ? AND status = 'ACTIVE'
            AND julianday(issued_at) <= julianday(?) - 90
            AND julianday(expires_at) > julianday(issued_at) + 90`,
      ).run(now, merchantId, now);
      const abandoned = this.db.prepare(
        `SELECT g.grant_id FROM data_grants g
           WHERE g.merchant_id = ? AND g.purpose = 'history_recall' AND g.status = 'ACTIVE'
             AND g.resource_scope_id = 'quote-history:' || g.subject_id
             AND EXISTS (SELECT 1 FROM quote_history_delegations d
               WHERE d.merchant_id = g.merchant_id AND d.subject_id = g.subject_id)
             AND NOT EXISTS (SELECT 1 FROM quote_history_delegations d
               WHERE d.merchant_id = g.merchant_id AND d.grant_id = g.grant_id AND d.status = 'ACTIVE')
             AND (
               EXISTS (SELECT 1 FROM quote_history_delegations d
                 WHERE d.merchant_id = g.merchant_id AND d.grant_id = g.grant_id AND d.status = 'REVOKED')
               OR NOT EXISTS (SELECT 1 FROM grant_requests r
                 WHERE r.merchant_id = g.merchant_id AND r.subject_id = g.subject_id
                   AND r.resource_scope_id = g.resource_scope_id AND r.purpose = g.purpose
                   AND r.consumed_at IS NOT NULL)
             )
           ORDER BY g.created_at, g.grant_id LIMIT 128`,
      ).all(merchantId) as { grant_id: string }[];
      for (const grant of abandoned) this.revokeUnderlyingGrant(merchantId, grant.grant_id);
    });
  }

  /** 撤销当前委托（版本水位保留——旧委托重放不得恢复）。 */
  revokeDelegation(input: { merchant_id: string; buyer_actor: string }): boolean {
    const merchantId = requireText(input.merchant_id, "merchant_id");
    const buyerActor = requireText(input.buyer_actor, "buyer_actor", 256);
    return inImmediateTransaction(this.db, () => {
      const row = this.db.prepare(
        "SELECT grant_id FROM quote_history_delegations WHERE merchant_id = ? AND buyer_actor = ? AND status = 'ACTIVE'",
      ).get(merchantId, buyerActor) as { grant_id: string } | undefined;
      if (row === undefined) return false;
      this.revokeUnderlyingGrant(merchantId, row.grant_id);
      this.db.prepare(
        "UPDATE quote_history_delegations SET status = 'REVOKED', updated_at = ? WHERE merchant_id = ? AND buyer_actor = ?",
      ).run(this.now(), merchantId, buyerActor);
      return true;
    });
  }

  private revokeUnderlyingGrant(merchantId: string, grantId: string): void {
    const grant = this.db.prepare(
      "SELECT grant_epoch FROM data_grants WHERE merchant_id = ? AND grant_id = ? AND status = 'ACTIVE'",
    ).get(merchantId, grantId) as { grant_epoch: number } | undefined;
    if (grant !== undefined) {
      new DataUseGrantStore({ db: this.db, now: this.now }).revokeGrant({
        merchant_id: merchantId, grant_id: grantId, expected_epoch: grant.grant_epoch,
      });
    }
  }

  /**
   * 读取前授权复核：委托 ACTIVE 且未过期、对应 history_recall grant 仍
   * ACTIVE 且未过期。返回 subject_id（绑定关系随行），否则 undefined。
   */
  checkActive(input: { merchant_id: string; buyer_actor: string }): { subject_id: string } | undefined {
    try {
      const merchantId = requireText(input.merchant_id, "merchant_id");
      const buyerActor = requireText(input.buyer_actor, "buyer_actor", 256);
      const stamp = this.now();
      const row = this.db
        .prepare(
          `SELECT subject_id, issued_at, expires_at, grant_id, status FROM quote_history_delegations
            WHERE merchant_id = ? AND buyer_actor = ?`,
        )
        .get(merchantId, buyerActor) as
        | { subject_id: string; issued_at: string; expires_at: string; grant_id: string; status: string }
        | undefined;
      if (row === undefined || row.status !== "ACTIVE" || row.expires_at <= stamp ||
          !(Date.parse(stamp) < Date.parse(row.issued_at) + 90 * 86_400_000)) return undefined;
      const grant = this.db
        .prepare(
          `SELECT g.status, g.expires_at
             FROM data_grants g JOIN data_scopes scope
               ON scope.merchant_id = g.merchant_id AND scope.erase_scope_id = g.resource_scope_id
             JOIN customer_subjects s ON s.merchant_id = g.merchant_id AND s.subject_id = g.subject_id
            WHERE g.grant_id = ? AND g.merchant_id = ? AND g.subject_id = ?
              AND g.purpose = 'history_recall' AND g.resource_scope_id = ?
              AND scope.state = 'ACTIVE' AND s.status = 'ACTIVE'
              AND EXISTS (
                SELECT 1 FROM verified_customer_identities v JOIN subject_bindings b
                  ON b.merchant_id = v.merchant_id AND b.actor_id = v.verified_actor
                  AND b.subject_id = v.subject_id AND b.binding_epoch = v.binding_epoch
                WHERE v.merchant_id = g.merchant_id AND v.subject_id = g.subject_id
                  AND v.verified_actor = ? AND b.status = 'ACTIVE' AND b.expires_at > ?
              )`,
        )
        .get(row.grant_id, merchantId, row.subject_id, `quote-history:${row.subject_id}`, buyerActor, stamp) as
        | { status: string; expires_at: string }
        | undefined;
      if (grant === undefined || grant.status !== "ACTIVE" || grant.expires_at <= stamp) return undefined;
      return { subject_id: row.subject_id };
    } catch {
      return undefined;
    }
  }

  /** 报价正式发布后的索引写入（message_sent 落账之后调用；幂等按 offer_id）。 */
  indexOffer(input: {
    merchant_id: string;
    subject_id: string;
    negotiation_id: string;
    offer_id: string;
    message_id: string;
    sku: string;
    quantity: number;
    unit: string;
    currency: string;
    unit_price_minor: number;
    terms_digest: string;
    spec: Record<string, unknown>;
    valid_until?: string;
    quoted_at: string;
  }): { ok: boolean } {
    try {
      const stamp = this.now();
      const versionRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(offer_version), 0) AS v FROM published_offers
            WHERE merchant_id = ? AND negotiation_id = ?`,
        )
        .get(requireText(input.merchant_id, "merchant_id"), requireText(input.negotiation_id, "negotiation_id")) as {
        v: number;
      };
      this.db
        .prepare(
          `INSERT INTO published_offers
            (merchant_id, subject_id, negotiation_id, offer_id, message_id, sku, quantity, unit,
             currency, unit_price_minor, terms_digest, spec_json, offer_version, valid_until,
             quoted_at, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM data_scopes
              WHERE merchant_id = ? AND erase_scope_id = ? AND state <> 'ACTIVE'
           )
           ON CONFLICT(merchant_id, negotiation_id, offer_id) DO NOTHING`,
        )
        .run(
          input.merchant_id,
          requireText(input.subject_id, "subject_id"),
          input.negotiation_id,
          requireText(input.offer_id, "offer_id"),
          requireText(input.message_id, "message_id"),
          requireText(input.sku, "sku"),
          input.quantity,
          requireText(input.unit, "unit", 64),
          requireText(input.currency, "currency", 16),
          input.unit_price_minor,
          requireText(input.terms_digest, "terms_digest"),
          JSON.stringify(input.spec ?? {}),
          Number(versionRow.v) + 1,
          input.valid_until !== undefined ? isoOf(input.valid_until, "valid_until") : null,
          isoOf(input.quoted_at, "quoted_at"),
          stamp,
          input.merchant_id,
          `quote-history:${input.subject_id}`,
        );
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /**
   * 历史查询（读前已复核 checkActive；本函数只做数据投影）。
   * 只返回正式发布过的报价；spec_json 是报价当时的来源快照。
   */
  queryHistory(input: {
    merchant_id: string;
    subject_id: string;
    skus?: string[];
    limit?: number;
  }): QuoteHistoryHit[] {
    try {
      const merchantId = requireText(input.merchant_id, "merchant_id");
      const subjectId = requireText(input.subject_id, "subject_id");
      const limit = input.limit === undefined ? 5 : Math.max(1, Math.min(Math.floor(input.limit), 20));
      const skus = (input.skus ?? []).filter(
        (sku) => typeof sku === "string" && sku.trim() !== "",
      );
      const skuFilter = skus.length === 0 ? "" : ` AND sku IN (${skus.map(() => "?").join(",")})`;
      const rows = this.db.prepare(
        `WITH latest AS (
           SELECT *, row_number() OVER (PARTITION BY sku ORDER BY quoted_at DESC, offer_version DESC, offer_id DESC) AS rank
           FROM published_offers WHERE merchant_id = ? AND subject_id = ? AND julianday(quoted_at) > julianday(?) - 90${skuFilter}
         )
         SELECT * FROM latest WHERE rank = 1 ORDER BY quoted_at DESC, sku LIMIT ?`,
      ).all(merchantId, subjectId, this.now(), ...skus, limit) as unknown as Array<{
        negotiation_id: string;
        offer_id: string;
        offer_version: number;
        sku: string;
        quantity: number;
        unit: string;
        currency: string;
        unit_price_minor: number;
        terms_digest: string;
        spec_json: string;
        valid_until: string | null;
        quoted_at: string;
      }>;
      return rows.map((row) => ({
        negotiation_id: row.negotiation_id,
        offer_id: row.offer_id,
        offer_version: Number(row.offer_version),
        sku: row.sku,
        quantity: Number(row.quantity),
        unit: row.unit,
        currency: row.currency,
        unit_price_minor: Number(row.unit_price_minor),
        terms_digest: row.terms_digest,
        spec: safeParseObject(row.spec_json),
        ...(row.valid_until !== null ? { valid_until: row.valid_until } : {}),
        quoted_at: row.quoted_at,
      }));
    } catch {
      return [];
    }
  }
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 从 A2A message metadata 提取委托声明（未配置/形状不符返回 undefined）。 */
export function delegationFromMetadata(metadata: unknown): unknown {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const candidate = (metadata as Record<string, unknown>)["kiwi_delegation"];
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  return candidate;
}

/** KNP inquiry subject 内的历史查询扩展（双方显式支持的版本化扩展）。 */
export interface QuoteHistoryQueryExtension {
  version: number;
  skus?: string[];
  limit?: number;
}

export function parseHistoryQueryExtension(subject: unknown): QuoteHistoryQueryExtension | undefined {
  if (subject === null || typeof subject !== "object" || Array.isArray(subject)) return undefined;
  const raw = (subject as Record<string, unknown>)["kiwi_history_query"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (candidate["version"] !== 1) return undefined;
  const extension: QuoteHistoryQueryExtension = { version: 1 };
  if (Array.isArray(candidate["skus"])) {
    const skus = candidate["skus"].filter(
      (sku): sku is string => typeof sku === "string" && sku.trim() !== "",
    );
    if (skus.length > 0) extension.skus = skus.slice(0, 20);
  }
  if (typeof candidate["limit"] === "number" && Number.isSafeInteger(candidate["limit"]) && candidate["limit"] > 0) {
    extension.limit = Math.min(candidate["limit"], 20);
  }
  return extension;
}


export function isQuoteHistoryRecall(text: string): boolean {
  return /上次|之前那款|上回|last (?:quote|order|item)|same as last/i.test(text);
}

export function quoteHistoryNote(
  store: Pick<QuoteHistoryStore, "checkActive" | "queryHistory">,
  input: { merchantId: string; actor: string; sku?: string },
): string {
  const actor = { merchant_id: input.merchantId, buyer_actor: input.actor };
  const active = store.checkActive(actor);
  if (active === undefined) return "";
  const hits = store.queryHistory({
    merchant_id: input.merchantId, subject_id: active.subject_id,
    ...(input.sku !== undefined ? { skus: [input.sku] } : {}),
    limit: 2,
  });
  if (store.checkActive(actor)?.subject_id !== active.subject_id) return "";
  if (hits.length > 1) return " 有多款历史商品，请指明要沿用的 SKU。";
  const hit = hits[0];
  if (hit === undefined) return "";
  const expiry = hit.valid_until === undefined ? "" : `，有效期至 ${hit.valid_until}`;
  return ` 上次报价 ${hit.sku}，数量 ${hit.quantity} ${hit.unit}，单价 ${(hit.unit_price_minor / 100).toFixed(2)} ${hit.currency}（${hit.quoted_at}${expiry}）。本次价格以正式 RFQ 为准。`;
}
