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
 * Buyer-owned supplier relationship store（pull-relationship 设计 v0.1 §6）。
 *
 * Relationship 是跨任务、生命周期更长的 Buyer 私有状态，与一次性商业任务
 * （buyer_tasks）分离：同一 SQLite，独立表。所有调度时间（next_check_at）
 * 落库，重启后只凭数据库恢复，不依赖进程内 timer。
 *
 * supplier_observations 只存规范化事实差异（§6.3）——payload 是 diff 结果，
 * 绝不保存可执行远程内容；远程文本不进入本表之外的任何 prompt 上下文。
 */

import type { DatabaseSync } from "node:sqlite";
import { uuidv7 } from "@earendil-works/pi-ai";

export type SupplierRelationshipType = "saved" | "watched" | "preferred";
export type SupplierRelationshipStatus =
  | "active"
  | "paused"
  | "review_required"
  | "expired"
  | "deleted";
export type SupplierConsentSource = "human_explicit" | "delegated_policy";
export type SupplierSourceType = "catalog_search" | "agent_card" | "ucp_profile" | "ucp_catalog";
export type SupplierObservationKind =
  | "listing_added"
  | "listing_updated"
  | "listing_withdrawn"
  | "capability_changed"
  | "availability_hint_changed"
  | "lead_time_hint_changed"
  | "profile_or_identity_changed"
  | "freshness_changed"
  | "unreachable";

export interface SupplierRelationship {
  relationship_id: string;
  principal_id: string;
  merchant_id: string;
  canonical_domain: string;
  agent_card_url: string;
  ucp_profile_url?: string;
  relationship_type: SupplierRelationshipType;
  scope: Record<string, unknown>;
  policy: Record<string, unknown>;
  consent_source: SupplierConsentSource;
  status: SupplierRelationshipStatus;
  /** M3 receipt 预留（§10）：M1 恒为 'none'，不实现 receipt 收发。 */
  receipt_status: "none" | "attested" | "revoke_pending";
  receipt_expires_at?: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
}

export interface SupplierObservationState {
  relationship_id: string;
  source_type: SupplierSourceType;
  source_url_or_ref?: string;
  etag?: string;
  last_modified?: string;
  source_revision?: string;
  content_digest?: string;
  /** 上一次成功拉取的规范化快照（固定 DTO 字段），供下次 diff。 */
  snapshot?: Record<string, unknown>;
  last_checked_at?: string;
  last_success_at?: string;
  next_check_at?: string;
  failure_count: number;
  backoff_until?: string;
  unchanged_count: number;
  last_verified_fingerprint?: string;
}

export interface SupplierObservation {
  observation_id: string;
  relationship_id: string;
  kind: SupplierObservationKind;
  source_type: SupplierSourceType;
  payload: Record<string, unknown>;
  content_digest: string;
  observed_at: string;
  fresh_until?: string;
  verified: boolean;
}

export type SupplierStoreErrorCode = "validation" | "not_found";

export class SupplierStoreError extends Error {
  readonly code: SupplierStoreErrorCode;
  constructor(code: SupplierStoreErrorCode, message: string) {
    super(message);
    this.name = "SupplierStoreError";
    this.code = code;
  }
}

export interface SupplierRelationshipStoreOptions {
  db: DatabaseSync;
  principalId: string;
  now?: () => string;
}

const RELATIONSHIP_TYPES: readonly SupplierRelationshipType[] = ["saved", "watched", "preferred"];
const RELATIONSHIP_STATUSES: readonly SupplierRelationshipStatus[] = [
  "active",
  "paused",
  "review_required",
  "expired",
  "deleted",
];

function opt(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

function canonicalHostname(value: string): string {
  const raw = value.trim().toLowerCase().replace(/\.$/, "");
  if (raw === "") throw new SupplierStoreError("validation", "canonical_domain is required");
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    throw new SupplierStoreError("validation", `invalid canonical_domain: ${value}`);
  }
}

/** 身份端点默认 HTTPS、且必须与 canonical_domain 同 authority；仅字面 loopback 可用 HTTP。 */
export function assertSupplierEndpointAuthority(canonicalDomain: string, endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new SupplierStoreError("validation", `invalid supplier endpoint URL: ${endpoint}`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new SupplierStoreError("validation", `supplier endpoint must use HTTPS: ${endpoint}`);
  }
  if (host !== canonicalHostname(canonicalDomain)) {
    throw new SupplierStoreError(
      "validation",
      `supplier endpoint authority ${host} does not match canonical_domain ${canonicalDomain}`,
    );
  }
}

export class SupplierRelationshipStore {
  private readonly db: DatabaseSync;
  private readonly principalId: string;
  private readonly now: () => string;

  constructor(options: SupplierRelationshipStoreOptions) {
    this.db = options.db;
    this.principalId = options.principalId;
    // Normalize to UTC ISO: SQLite compares timestamps lexicographically.
    const clock = options.now ?? (() => new Date().toISOString());
    this.now = () => new Date(Date.parse(clock())).toISOString();
  }

  // ---- relationships ---------------------------------------------------------

  saveRelationship(input: {
    merchant_id: string;
    canonical_domain: string;
    agent_card_url: string;
    ucp_profile_url?: string;
    relationship_type: SupplierRelationshipType;
    scope?: Record<string, unknown>;
    policy?: Record<string, unknown>;
    consent_source?: SupplierConsentSource;
    expires_at?: string;
  }): SupplierRelationship {
    if (!RELATIONSHIP_TYPES.includes(input.relationship_type)) {
      throw new SupplierStoreError(
        "validation",
        `relationship_type must be one of ${RELATIONSHIP_TYPES.join("/")}`,
      );
    }
    if (input.merchant_id.trim() === "" || input.canonical_domain.trim() === "") {
      throw new SupplierStoreError("validation", "merchant_id and canonical_domain are required");
    }
    assertSupplierEndpointAuthority(input.canonical_domain, input.agent_card_url);
    if (input.ucp_profile_url !== undefined) {
      assertSupplierEndpointAuthority(input.canonical_domain, input.ucp_profile_url);
    }
    let expiresAt: string | null = null;
    if (input.expires_at !== undefined) {
      const t = Date.parse(input.expires_at);
      if (Number.isNaN(t)) {
        throw new SupplierStoreError("validation", "expires_at must be an RFC3339 timestamp");
      }
      expiresAt = new Date(t).toISOString();
    }
    const now = this.now();
    const id = `rel_${uuidv7()}`;
    this.db
      .prepare(
        `INSERT INTO supplier_relationships
           (relationship_id, principal_id, merchant_id, canonical_domain, agent_card_url,
            ucp_profile_url, relationship_type, scope_json, policy_json, consent_source,
            status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        this.principalId,
        input.merchant_id,
        input.canonical_domain,
        input.agent_card_url,
        input.ucp_profile_url ?? null,
        input.relationship_type,
        JSON.stringify(input.scope ?? {}),
        JSON.stringify(input.policy ?? {}),
        input.consent_source ?? "human_explicit",
        now,
        now,
        expiresAt,
      );
    return this.getRelationship(id) as SupplierRelationship;
  }

  getRelationship(relationshipId: string): SupplierRelationship | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM supplier_relationships WHERE relationship_id = ? AND principal_id = ?",
      )
      .get(relationshipId, this.principalId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.rowToRelationship(row);
  }

  listRelationships(
    filter: { statuses?: SupplierRelationshipStatus[]; includeDeleted?: boolean } = {},
  ): SupplierRelationship[] {
    const statuses =
      filter.statuses ??
      (filter.includeDeleted === true
        ? [...RELATIONSHIP_STATUSES]
        : RELATIONSHIP_STATUSES.filter((s) => s !== "deleted"));
    const rows = this.db
      .prepare(
        `SELECT * FROM supplier_relationships
         WHERE principal_id = ? AND (${statuses.map(() => "status = ?").join(" OR ")})
         ORDER BY created_at, relationship_id`,
      )
      .all(this.principalId, ...statuses) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRelationship(r));
  }

  /**
   * 状态流转。'deleted' 是软删：立即停止后续拉取（清除所有来源的
   * next_check_at），历史 observation 与审计记录保留（§11）。
   */
  updateStatus(relationshipId: string, status: SupplierRelationshipStatus): SupplierRelationship {
    if (!RELATIONSHIP_STATUSES.includes(status)) {
      throw new SupplierStoreError("validation", `illegal status ${status}`);
    }
    const existing = this.getRelationship(relationshipId);
    if (existing === undefined) {
      throw new SupplierStoreError("not_found", `no relationship ${relationshipId}`);
    }
    const now = this.now();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE supplier_relationships SET status = ?, updated_at = ? WHERE relationship_id = ?",
        )
        .run(status, now, relationshipId);
      if (status === "deleted") {
        this.db
          .prepare(
            "UPDATE supplier_observation_state SET next_check_at = NULL, backoff_until = NULL WHERE relationship_id = ?",
          )
          .run(relationshipId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getRelationship(relationshipId) as SupplierRelationship;
  }

  updatePolicy(
    relationshipId: string,
    patch: {
      scope?: Record<string, unknown>;
      policy?: Record<string, unknown>;
      expires_at?: string | null;
    },
  ): SupplierRelationship {
    const existing = this.getRelationship(relationshipId);
    if (existing === undefined) {
      throw new SupplierStoreError("not_found", `no relationship ${relationshipId}`);
    }
    let expiresAt: string | null | undefined;
    if (patch.expires_at === null) {
      expiresAt = null;
    } else if (patch.expires_at !== undefined) {
      const t = Date.parse(patch.expires_at);
      if (Number.isNaN(t)) {
        throw new SupplierStoreError("validation", "expires_at must be an RFC3339 timestamp");
      }
      expiresAt = new Date(t).toISOString();
    }
    this.db
      .prepare(
        `UPDATE supplier_relationships
         SET scope_json = ?, policy_json = ?, expires_at = ?, updated_at = ?
         WHERE relationship_id = ?`,
      )
      .run(
        JSON.stringify(patch.scope ?? existing.scope),
        JSON.stringify(patch.policy ?? existing.policy),
        expiresAt === undefined ? (existing.expires_at ?? null) : expiresAt,
        this.now(),
        relationshipId,
      );
    return this.getRelationship(relationshipId) as SupplierRelationship;
  }

  /**
   * Scheduler 输入：到期关系（§8）。只轮询 watched/preferred；saved 不拉取。
   * 关系无任何观察状态行（从未检查）视为立即到期；有状态行时要求至少一个
   * 来源 next_check_at <= now 且不在退避窗口内。已过期（expires_at）与
   * paused/review_required/deleted 关系不出现在轮询队列。
   */
  dueRelationships(now: string, limit: number): SupplierRelationship[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM supplier_relationships r
         WHERE r.principal_id = ? AND r.status = 'active'
           AND r.relationship_type IN ('watched','preferred')
           AND (r.expires_at IS NULL OR r.expires_at > ?)
           AND (
             NOT EXISTS (
               SELECT 1 FROM supplier_observation_state s
               WHERE s.relationship_id = r.relationship_id AND s.source_type = 'agent_card'
             )
             OR (
               r.ucp_profile_url IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM supplier_observation_state s
                 WHERE s.relationship_id = r.relationship_id AND s.source_type = 'ucp_profile'
               )
             )
             OR
             NOT EXISTS (
               SELECT 1 FROM supplier_observation_state s
               WHERE s.relationship_id = r.relationship_id
             )
             OR EXISTS (
               SELECT 1 FROM supplier_observation_state s
               WHERE s.relationship_id = r.relationship_id
                 AND s.next_check_at IS NOT NULL AND s.next_check_at <= ?
                 AND (s.backoff_until IS NULL OR s.backoff_until <= ?)
             )
           )
         ORDER BY r.created_at, r.relationship_id LIMIT ?`,
      )
      .all(this.principalId, now, now, now, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRelationship(r));
  }

  /** active 且 expires_at 已过的关系（scheduler 惰性过期清扫用）。 */
  expirableRelationships(now: string): SupplierRelationship[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM supplier_relationships
         WHERE principal_id = ? AND status = 'active'
           AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .all(this.principalId, now) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRelationship(r));
  }

  // ---- observation state -------------------------------------------------------

  getState(
    relationshipId: string,
    sourceType: SupplierSourceType,
  ): SupplierObservationState | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM supplier_observation_state WHERE relationship_id = ? AND source_type = ?",
      )
      .get(relationshipId, sourceType) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.rowToState(row);
  }

  statesFor(relationshipId: string): SupplierObservationState[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM supplier_observation_state WHERE relationship_id = ? ORDER BY source_type",
      )
      .all(relationshipId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToState(r));
  }

  /**
   * 记录一次成功拉取的来源状态：digest / snapshot / 指纹 / 调度时间。
   * unchanged=true 时递增 unchanged_count（无变化逐步放慢，§8），否则清零。
   */
  recordSourceSuccess(
    relationshipId: string,
    sourceType: SupplierSourceType,
    input: {
      checked_at: string;
      next_check_at: string;
      source_url_or_ref?: string;
      etag?: string;
      last_modified?: string;
      source_revision?: string;
      content_digest?: string;
      snapshot?: Record<string, unknown>;
      last_verified_fingerprint?: string;
      unchanged: boolean;
    },
  ): void {
    const previous = this.getState(relationshipId, sourceType);
    const unchangedCount = input.unchanged ? (previous?.unchanged_count ?? 0) + 1 : 0;
    this.db
      .prepare(
        `INSERT INTO supplier_observation_state
           (relationship_id, source_type, source_url_or_ref, etag, last_modified, source_revision,
            content_digest, snapshot_json, last_checked_at, last_success_at, next_check_at,
            failure_count, backoff_until, unchanged_count, last_verified_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
         ON CONFLICT (relationship_id, source_type) DO UPDATE SET
           source_url_or_ref = excluded.source_url_or_ref,
           etag = excluded.etag,
           last_modified = excluded.last_modified,
           source_revision = excluded.source_revision,
           content_digest = excluded.content_digest,
           snapshot_json = excluded.snapshot_json,
           last_checked_at = excluded.last_checked_at,
           last_success_at = excluded.last_success_at,
           next_check_at = excluded.next_check_at,
           failure_count = 0,
           backoff_until = NULL,
           unchanged_count = excluded.unchanged_count,
           last_verified_fingerprint = COALESCE(
             excluded.last_verified_fingerprint,
             supplier_observation_state.last_verified_fingerprint
           )`,
      )
      .run(
        relationshipId,
        sourceType,
        input.source_url_or_ref ?? previous?.source_url_or_ref ?? null,
        input.etag ?? null,
        input.last_modified ?? null,
        input.source_revision ?? null,
        input.content_digest ?? null,
        input.snapshot !== undefined ? JSON.stringify(input.snapshot) : null,
        input.checked_at,
        input.checked_at,
        input.next_check_at,
        unchangedCount,
        input.last_verified_fingerprint ?? null,
      );
  }

  /** 失败退避：failure_count++，下次检查推迟到 backoffAt（含 jitter，由调用方算）。 */
  recordSourceFailure(
    relationshipId: string,
    sourceType: SupplierSourceType,
    input: { checked_at: string; backoff_at: string },
  ): void {
    this.db
      .prepare(
        `INSERT INTO supplier_observation_state
           (relationship_id, source_type, last_checked_at, next_check_at, failure_count,
            backoff_until, unchanged_count)
         VALUES (?, ?, ?, ?, 1, ?, 0)
         ON CONFLICT (relationship_id, source_type) DO UPDATE SET
           last_checked_at = excluded.last_checked_at,
           next_check_at = excluded.next_check_at,
           failure_count = supplier_observation_state.failure_count + 1,
           backoff_until = excluded.backoff_until,
           unchanged_count = 0`,
      )
      .run(relationshipId, sourceType, input.checked_at, input.backoff_at, input.backoff_at);
  }

  // ---- observations ---------------------------------------------------------

  /** content_digest 去重（§6.3）：同一变化重复观察到时不重复落账。 */
  addObservation(input: {
    relationship_id: string;
    kind: SupplierObservationKind;
    source_type: SupplierSourceType;
    payload: Record<string, unknown>;
    content_digest: string;
    observed_at: string;
    fresh_until?: string;
    verified?: boolean;
  }): { added: boolean; observation_id: string } {
    const existing = this.db
      .prepare(
        `SELECT observation_id FROM supplier_observations
         WHERE relationship_id = ? AND kind = ? AND content_digest = ?`,
      )
      .get(input.relationship_id, input.kind, input.content_digest) as
      | { observation_id: string }
      | undefined;
    if (existing !== undefined) {
      return { added: false, observation_id: existing.observation_id };
    }
    const observationId = `sobs_${uuidv7()}`;
    this.db
      .prepare(
        `INSERT INTO supplier_observations
           (observation_id, relationship_id, kind, source_type, payload_json, content_digest,
            observed_at, fresh_until, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        observationId,
        input.relationship_id,
        input.kind,
        input.source_type,
        JSON.stringify(input.payload),
        input.content_digest,
        input.observed_at,
        input.fresh_until ?? null,
        input.verified === true ? 1 : 0,
      );
    return { added: true, observation_id: observationId };
  }

  listObservations(relationshipId: string, limit = 50): SupplierObservation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM supplier_observations
         WHERE relationship_id = ? ORDER BY observed_at DESC, observation_id DESC LIMIT ?`,
      )
      .all(relationshipId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToObservation(r));
  }

  // ---- row mapping ------------------------------------------------------------

  private rowToRelationship(row: Record<string, unknown>): SupplierRelationship {
    const rel: SupplierRelationship = {
      relationship_id: row.relationship_id as string,
      principal_id: row.principal_id as string,
      merchant_id: row.merchant_id as string,
      canonical_domain: row.canonical_domain as string,
      agent_card_url: row.agent_card_url as string,
      relationship_type: row.relationship_type as SupplierRelationshipType,
      scope: JSON.parse(row.scope_json as string) as Record<string, unknown>,
      policy: JSON.parse(row.policy_json as string) as Record<string, unknown>,
      consent_source: row.consent_source as SupplierConsentSource,
      status: row.status as SupplierRelationshipStatus,
      receipt_status: row.receipt_status as SupplierRelationship["receipt_status"],
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
    const ucp = opt(row.ucp_profile_url as string | null);
    if (ucp !== undefined) rel.ucp_profile_url = ucp;
    const receiptExpires = opt(row.receipt_expires_at as string | null);
    if (receiptExpires !== undefined) rel.receipt_expires_at = receiptExpires;
    const expires = opt(row.expires_at as string | null);
    if (expires !== undefined) rel.expires_at = expires;
    return rel;
  }

  private rowToState(row: Record<string, unknown>): SupplierObservationState {
    const state: SupplierObservationState = {
      relationship_id: row.relationship_id as string,
      source_type: row.source_type as SupplierSourceType,
      failure_count: row.failure_count as number,
      unchanged_count: row.unchanged_count as number,
    };
    const assign = (key: keyof SupplierObservationState, column: string): void => {
      const value = opt(row[column] as string | null);
      if (value !== undefined) {
        (state as unknown as Record<string, unknown>)[key] = value;
      }
    };
    assign("source_url_or_ref", "source_url_or_ref");
    assign("etag", "etag");
    assign("last_modified", "last_modified");
    assign("source_revision", "source_revision");
    assign("content_digest", "content_digest");
    assign("last_checked_at", "last_checked_at");
    assign("last_success_at", "last_success_at");
    assign("next_check_at", "next_check_at");
    assign("backoff_until", "backoff_until");
    assign("last_verified_fingerprint", "last_verified_fingerprint");
    const snapshot = opt(row.snapshot_json as string | null);
    if (snapshot !== undefined) {
      state.snapshot = JSON.parse(snapshot) as Record<string, unknown>;
    }
    return state;
  }

  private rowToObservation(row: Record<string, unknown>): SupplierObservation {
    const obs: SupplierObservation = {
      observation_id: row.observation_id as string,
      relationship_id: row.relationship_id as string,
      kind: row.kind as SupplierObservationKind,
      source_type: row.source_type as SupplierSourceType,
      payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
      content_digest: row.content_digest as string,
      observed_at: row.observed_at as string,
      verified: row.verified === 1,
    };
    const freshUntil = opt(row.fresh_until as string | null);
    if (freshUntil !== undefined) obs.fresh_until = freshUntil;
    return obs;
  }
}
