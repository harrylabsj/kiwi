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
 * Supplier pull scheduler（pull-relationship 设计 v0.1 §7.1/§8/§9.1）。
 *
 * tick() 从 supplier_observation_state.next_check_at 派生到期关系（restart-safe，
 * 不依赖进程内 timer），对每个 watched/preferred 关系主动拉取公开只读事实：
 *
 *   1. catalog record / listings（有 catalogSource 时，§7.1 第 3 步）；
 *   2. Agent Card（safe-http 模板：SSRF/DNS 复查、redirect: "manual"、body 上限、
 *      超时覆盖 body 读；parseAgentCard 结构校验 + secret 扫描）；
 *   3. UCP Profile（有 ucp_profile_url 时，仅 GET JSON + 宽松 schema 校验）。
 *
 * 安全不变量（§9.1）：远程内容是不可信输入——只映射到本文件的固定 DTO 快照
 * 字段，绝不拼进任何 prompt，不允许远程内容触发 RFQ/授权/工具调用；对
 * Merchant 直连不发送 X-Buyer-Id 等稳定身份头（§9.2）。
 *
 * Agent Card 指纹变化 → 关系进入 review_required 并停止后续自动拉取（§8 第 5
 * 步：不得静默沿用旧信任）。失败按 transient/permanent 分类指数退避 + jitter。
 */

import {
  assertResolvableTargetUrl,
  assertSafeTargetUrl,
} from "../../a2a/client/url-policy.js";
import { parseAgentCard } from "../../discovery/agent-card/index.js";
import type { AgentCard } from "../../discovery/agent-card/index.js";
import type { KiwiCatalogSource } from "../../discovery/catalog-source/kiwi-source.js";
import { CatalogSourceError } from "../../discovery/catalog-source/errors.js";
import { contentDigest } from "../../negotiation/jcs.js";
import { isRedirectResponse, readJsonBody, SafeHttpError } from "../../net/safe-http.js";
import { computeAgentCardFingerprint } from "../../trust/records/types.js";
import type { TrustRecordStore } from "../../trust/records/store.js";
import type {
  SupplierObservation,
  SupplierObservationKind,
  SupplierRelationship,
  SupplierRelationshipStore,
  SupplierSourceType,
} from "./store.js";
import { assertSupplierEndpointAuthority, SupplierStoreError } from "./store.js";

export interface SupplierSchedulerOptions {
  store: SupplierRelationshipStore;
  catalogSource?: KiwiCatalogSource;
  trustStore?: TrustRecordStore;
  now?: () => string;
  /** 可注入 fake fetch（测试）；缺省 globalThis.fetch。 */
  fetchFn?: typeof fetch;
  /** 本地开发放行字面 loopback（不可信 Card 默认 false）。 */
  allowLoopback?: boolean;
  skipDnsCheck?: boolean;
  resolveIp?: (hostname: string) => Promise<string[]>;
  /** 退避 jitter 随机源（±10%），可注入固定值做确定性测试。 */
  random?: () => number;
  timeoutMs?: number;
}

export interface SupplierTickBudget {
  max_requests?: number;
  max_relationships?: number;
}

export interface SupplierTickNotification {
  relationship_id: string;
  merchant_id: string;
  summary: string;
}

export interface SupplierTickResult {
  checked: number;
  requests_used: number;
  observations: SupplierObservation[];
  notified: SupplierTickNotification[];
  errors: string[];
}

type PullErrorCode =
  | "unsafe_target"
  | "redirect"
  | "http_error"
  | "timeout"
  | "network"
  | "response_too_large"
  | "invalid_json"
  | "schema_invalid";

class SupplierPullError extends Error {
  readonly code: PullErrorCode;
  readonly permanent: boolean;
  constructor(code: PullErrorCode, message: string, permanent: boolean) {
    super(message);
    this.name = "SupplierPullError";
    this.code = code;
    this.permanent = permanent;
  }
}

const DEFAULT_BUDGET: Required<SupplierTickBudget> = { max_requests: 20, max_relationships: 20 };
/** §8：普通 watch 最短间隔以小时计——默认 6h，下限 1h，无变化逐步放慢封顶 24h。 */
const DEFAULT_INTERVAL_SECONDS = 6 * 3600;
const MIN_INTERVAL_SECONDS = 3600;
const MAX_INTERVAL_SECONDS = 24 * 3600;
const PERMANENT_BACKOFF_SECONDS = 24 * 3600;
const DEFAULT_TIMEOUT_MS = 15_000;

/** catalog listing 快照条目（固定 DTO 字段；title/summary 等自由文本不进快照）。 */
interface ListingSnapshotEntry {
  listing_id: string;
  listing_digest: string;
  publication_state: string;
  availability_hint?: string;
  lead_time_hint?: string;
  source_revision?: string;
  updated_at: string;
}

interface CatalogSnapshot {
  record: {
    freshness_state: string;
    verification_level: string;
    administrative_state: string;
    updated_at: string;
  };
  listings: ListingSnapshotEntry[];
}

export class SupplierScheduler {
  private readonly store: SupplierRelationshipStore;
  private readonly catalogSource?: KiwiCatalogSource;
  private readonly trustStore?: TrustRecordStore;
  private readonly now: () => string;
  private readonly fetchFn: typeof fetch;
  private readonly allowLoopback: boolean;
  private readonly skipDnsCheck?: boolean;
  private readonly resolveIp?: (hostname: string) => Promise<string[]>;
  private readonly random: () => number;
  private readonly timeoutMs: number;

  constructor(options: SupplierSchedulerOptions) {
    this.store = options.store;
    this.catalogSource = options.catalogSource;
    this.trustStore = options.trustStore;
    const clock = options.now ?? (() => new Date().toISOString());
    this.now = () => new Date(Date.parse(clock())).toISOString();
    this.fetchFn = options.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
    this.allowLoopback = options.allowLoopback === true;
    this.skipDnsCheck = options.skipDnsCheck;
    this.resolveIp = options.resolveIp;
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async tick(budget: SupplierTickBudget = {}): Promise<SupplierTickResult> {
    const b = { ...DEFAULT_BUDGET, ...budget };
    const now = this.now();
    const result: SupplierTickResult = {
      checked: 0,
      requests_used: 0,
      observations: [],
      notified: [],
      errors: [],
    };
    let requests = 0;

    // 惰性过期清扫（§8：关系和规则必须有 expiry）。
    for (const rel of this.store.expirableRelationships(now)) {
      try {
        this.store.updateStatus(rel.relationship_id, "expired");
      } catch (err) {
        result.errors.push(
          `expire ${rel.relationship_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    for (const rel of this.store.dueRelationships(now, b.max_relationships)) {
      if (requests >= b.max_requests) break;
      result.checked += 1;
      const before = new Set(
        this.store.listObservations(rel.relationship_id).map((o) => o.observation_id),
      );
      const halted = await this.checkRelationship(rel, now, result, () => {
        if (requests >= b.max_requests) return false;
        requests += 1;
        result.requests_used = requests;
        return true;
      });
      if (halted) break;
      const fresh = this.store
        .listObservations(rel.relationship_id)
        .filter((o) => !before.has(o.observation_id));
      result.observations.push(...fresh);
      if (fresh.length > 0) {
        // §8 第 8 步：同一关系的多条变化合并成一次本地通知（通知本身只是
        // tick 返回 + observation 落账，不引入新通知系统）。
        result.notified.push({
          relationship_id: rel.relationship_id,
          merchant_id: rel.merchant_id,
          summary: fresh.map((o) => summarize(o)).join("；"),
        });
      }
    }
    return result;
  }

  /**
   * 拉取一个关系的所有配置来源。返回 true 表示预算耗尽应中断整个 tick。
   * Agent Card 指纹变化 → review_required 并跳过后续来源（§8 第 5 步）。
   */
  private async checkRelationship(
    rel: SupplierRelationship,
    now: string,
    result: SupplierTickResult,
    spend: () => boolean,
  ): Promise<boolean> {
    try {
      assertSupplierEndpointAuthority(rel.canonical_domain, rel.agent_card_url);
      if (rel.ucp_profile_url !== undefined) {
        assertSupplierEndpointAuthority(rel.canonical_domain, rel.ucp_profile_url);
      }
    } catch (err) {
      this.requireReview(
        rel,
        now,
        err instanceof Error ? err.message : String(err),
        {},
        "agent_card",
      );
      return false;
    }
    const sources: SupplierSourceType[] = [];
    if (this.catalogSource !== undefined && typeof rel.scope.catalog_agent_id === "string") {
      sources.push("catalog_search");
    }
    sources.push("agent_card");
    if (rel.ucp_profile_url !== undefined) sources.push("ucp_profile");

    for (const source of sources) {
      const state = this.store.getState(rel.relationship_id, source);
      if (
        (state?.backoff_until !== undefined &&
          Date.parse(state.backoff_until) > Date.parse(now)) ||
        (state?.next_check_at !== undefined &&
          Date.parse(state.next_check_at) > Date.parse(now))
      ) {
        continue;
      }
      if (source === "catalog_search") {
        if (!(await this.checkCatalog(rel, now, result, spend))) return true;
        if (this.store.getRelationship(rel.relationship_id)?.status === "review_required") {
          return false;
        }
      } else if (source === "agent_card") {
        if (!spend()) return true;
        const fingerprintOk = await this.checkAgentCard(rel, now, result);
        if (!fingerprintOk) return false; // review_required：停止该关系后续自动拉取
      } else {
        if (!spend()) return true;
        await this.checkUcpProfile(rel, now, result);
      }
    }
    return false;
  }

  // ---- catalog_search（§7.1 第 3 步：重跑限定 Merchant 的 catalog query）-----

  private async checkCatalog(
    rel: SupplierRelationship,
    now: string,
    result: SupplierTickResult,
    spend: () => boolean,
  ): Promise<boolean> {
    const source = this.catalogSource as KiwiCatalogSource;
    const catalogAgentId = rel.scope.catalog_agent_id as string;
    const previous = this.store.getState(rel.relationship_id, "catalog_search");
    let snapshot: CatalogSnapshot;
    try {
      if (!spend()) return false;
      const record = await source.getRecord(catalogAgentId);
      const identityChanged =
        record.canonical_domain !== rel.canonical_domain ||
        record.agent_card_url !== rel.agent_card_url ||
        (record.ucp_profile_url ?? undefined) !== rel.ucp_profile_url ||
        (record.merchant_id ?? record.catalog_agent_id) !== rel.merchant_id;
      if (identityChanged) {
        this.requireReview(rel, now, "catalog identity-bearing fields changed", {
          catalog_agent_id: catalogAgentId,
        });
        return true;
      }
      assertSupplierEndpointAuthority(record.canonical_domain, record.agent_card_url as string);
      if (record.ucp_profile_url !== undefined) {
        assertSupplierEndpointAuthority(record.canonical_domain, record.ucp_profile_url);
      }
      if (
        record.administrative_state !== "active" ||
        record.freshness_state === "unreachable" ||
        record.verification_level === "discovered"
      ) {
        this.requireReview(rel, now, "catalog governance no longer permits automatic pull", {
          administrative_state: record.administrative_state,
          freshness_state: record.freshness_state,
          verification_level: record.verification_level,
        });
        return true;
      }
      const query =
        typeof rel.scope.query === "string" && rel.scope.query !== ""
          ? rel.scope.query
          : undefined;
      const region =
        typeof rel.scope.region === "string" && rel.scope.region !== ""
          ? rel.scope.region
          : undefined;
      if (!spend()) return false;
      const hits = await source.searchListings({
        owner_agent_id: catalogAgentId,
        ...(query !== undefined ? { q: query } : {}),
        ...(region !== undefined ? { region } : {}),
      });
      // 只保留该 Merchant 的 listing，且只映射固定 DTO 字段（远程自由文本
      // title/summary 不进快照、不进 observation payload、不进 prompt）。
      const listings: ListingSnapshotEntry[] = hits
        .filter((h) => h.listing.owner_agent_id === catalogAgentId)
        .map((h) => {
          const entry: ListingSnapshotEntry = {
            listing_id: h.listing.listing_id,
            listing_digest: h.listing.listing_digest,
            publication_state: h.listing.publication_state,
            updated_at: h.listing.updated_at,
          };
          if (h.listing.commercial_hints?.availability_hint !== undefined) {
            entry.availability_hint = h.listing.commercial_hints.availability_hint;
          }
          if (h.listing.commercial_hints?.lead_time_hint !== undefined) {
            entry.lead_time_hint = h.listing.commercial_hints.lead_time_hint;
          }
          if (h.listing.source_revision !== undefined) {
            entry.source_revision = h.listing.source_revision;
          }
          return entry;
        })
        .sort((a, b) => (a.listing_id < b.listing_id ? -1 : 1));
      snapshot = {
        record: {
          freshness_state: record.freshness_state,
          verification_level: record.verification_level,
          administrative_state: record.administrative_state,
          updated_at: record.updated_at,
        },
        listings,
      };
    } catch (err) {
      if (err instanceof SupplierStoreError) {
        this.requireReview(rel, now, err.message, { catalog_agent_id: catalogAgentId });
        return true;
      }
      const isRedirectReject =
        err instanceof CatalogSourceError && err.message.includes("redirect");
      const permanent =
        err instanceof CatalogSourceError &&
        (err.code === "response_invalid" || isRedirectReject);
      this.recordFailure(
        rel,
        "catalog_search",
        previous,
        now,
        err,
        permanent,
        result,
        !isRedirectReject,
      );
      return true;
    }

    const digest = contentDigest(snapshot);
    const unchanged = previous?.content_digest === digest;
    if (!unchanged && previous?.snapshot !== undefined) {
      this.diffCatalogSnapshot(rel, previous.snapshot as unknown as CatalogSnapshot, snapshot, now);
    }
    const next = this.scheduleAfterSuccess(rel, previous, now, unchanged);
    this.store.recordSourceSuccess(rel.relationship_id, "catalog_search", {
      checked_at: now,
      next_check_at: next,
      source_url_or_ref: `catalog:${catalogAgentId}`,
      content_digest: digest,
      snapshot: snapshot as unknown as Record<string, unknown>,
      unchanged,
    });
    return true;
  }

  private requireReview(
    rel: SupplierRelationship,
    now: string,
    reason: string,
    details: Record<string, unknown>,
    source: SupplierSourceType = "catalog_search",
  ): void {
    this.store.addObservation({
      relationship_id: rel.relationship_id,
      kind: "profile_or_identity_changed",
      source_type: source,
      payload: { reason, ...details },
      content_digest: contentDigest({ kind: "profile_or_identity_changed", reason, ...details }),
      observed_at: now,
      fresh_until: now,
      verified: true,
    });
    this.store.updateStatus(rel.relationship_id, "review_required");
  }

  private diffCatalogSnapshot(
    rel: SupplierRelationship,
    oldSnap: CatalogSnapshot,
    newSnap: CatalogSnapshot,
    now: string,
  ): void {
    const oldListings = new Map(oldSnap.listings.map((l) => [l.listing_id, l]));
    const newListings = new Map(newSnap.listings.map((l) => [l.listing_id, l]));
    const emit = (kind: SupplierObservationKind, payload: Record<string, unknown>): void => {
      // content_digest 去重：同一变化重复观察到时静默，不重复落账（§6.3）。
      this.store.addObservation({
        relationship_id: rel.relationship_id,
        kind,
        source_type: "catalog_search",
        payload,
        content_digest: contentDigest({ kind, ...payload }),
        observed_at: now,
        fresh_until: now,
        verified: true,
      });
    };
    for (const [id, entry] of newListings) {
      const old = oldListings.get(id);
      if (old === undefined) {
        emit("listing_added", { listing_id: id });
        continue;
      }
      if (old.availability_hint !== entry.availability_hint) {
        emit("availability_hint_changed", {
          listing_id: id,
          from: old.availability_hint ?? null,
          to: entry.availability_hint ?? null,
        });
      }
      if (old.lead_time_hint !== entry.lead_time_hint) {
        emit("lead_time_hint_changed", {
          listing_id: id,
          from: old.lead_time_hint ?? null,
          to: entry.lead_time_hint ?? null,
        });
      }
      if (old.listing_digest !== entry.listing_digest) {
        emit("listing_updated", { listing_id: id });
      }
    }
    for (const id of oldListings.keys()) {
      if (!newListings.has(id)) {
        emit("listing_withdrawn", { listing_id: id });
      }
    }
    if (oldSnap.record.freshness_state !== newSnap.record.freshness_state) {
      emit("freshness_changed", {
        from: oldSnap.record.freshness_state,
        to: newSnap.record.freshness_state,
      });
    }
  }

  // ---- agent_card ----------------------------------------------------------

  /** 返回 false 表示指纹变化已置 review_required，调用方停止该关系后续拉取。 */
  private async checkAgentCard(
    rel: SupplierRelationship,
    now: string,
    result: SupplierTickResult,
  ): Promise<boolean> {
    const previous = this.store.getState(rel.relationship_id, "agent_card");
    let card: AgentCard;
    try {
      const raw = await this.getJson(rel.agent_card_url);
      try {
        card = parseAgentCard(raw);
      } catch (err) {
        throw new SupplierPullError(
          "schema_invalid",
          `Agent Card rejected: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    } catch (err) {
      const permanent = err instanceof SupplierPullError && err.permanent;
      const localRejection =
        err instanceof SupplierPullError &&
        (err.code === "unsafe_target" || err.code === "redirect");
      this.recordFailure(rel, "agent_card", previous, now, err, permanent, result, !localRejection);
      return true;
    }

    const fingerprint = computeAgentCardFingerprint(card);
    const priorFingerprint = previous?.last_verified_fingerprint;
    if (priorFingerprint !== undefined && priorFingerprint !== fingerprint) {
      // §8 第 5 步：身份承载字段变化不得静默沿用旧信任——关系进
      // review_required，停止后续自动拉取，写 profile_or_identity_changed。
      this.store.addObservation({
        relationship_id: rel.relationship_id,
        kind: "profile_or_identity_changed",
        source_type: "agent_card",
        payload: { from: priorFingerprint, to: fingerprint },
        content_digest: contentDigest({ kind: "profile_or_identity_changed", to: fingerprint }),
        observed_at: now,
        fresh_until: now,
        verified: true,
      });
      this.store.updateStatus(rel.relationship_id, "review_required");
      return false;
    }

    // 只有身份指纹仍一致时，才把本次拉取记为成功交换；变化不能覆盖旧信任。
    try {
      this.trustStore?.observe({
        counterparty_identity: rel.canonical_domain,
        kind: "exchange_success",
        observed_at: now,
        domain: rel.canonical_domain,
        agent_card_fingerprint: fingerprint,
      });
    } catch (err) {
      result.errors.push(
        `trust observe ${rel.relationship_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 指纹之外的卡片快照（固定字段；description 等自由文本不进快照）。
    const snapshot = {
      fingerprint,
      version: card.version,
      capabilities: (card.capabilities as unknown) ?? null,
      skills: (card.skills ?? []).map((s) => s.id).sort(),
      interfaces: card.supportedInterfaces.map((i) => i.url).sort(),
    };
    const digest = contentDigest(snapshot);
    const unchanged = previous?.content_digest === digest;
    if (!unchanged && previous?.content_digest !== undefined) {
      this.store.addObservation({
        relationship_id: rel.relationship_id,
        kind: "capability_changed",
        source_type: "agent_card",
        payload: { from: previous.content_digest, to: digest },
        content_digest: contentDigest({ kind: "capability_changed", source: "agent_card", to: digest }),
        observed_at: now,
        fresh_until: now,
        verified: true,
      });
    }
    const next = this.scheduleAfterSuccess(rel, previous, now, unchanged);
    this.store.recordSourceSuccess(rel.relationship_id, "agent_card", {
      checked_at: now,
      next_check_at: next,
      source_url_or_ref: rel.agent_card_url,
      content_digest: digest,
      snapshot,
      last_verified_fingerprint: fingerprint,
      unchanged,
    });
    return true;
  }

  // ---- ucp_profile -----------------------------------------------------------

  private async checkUcpProfile(
    rel: SupplierRelationship,
    now: string,
    result: SupplierTickResult,
  ): Promise<void> {
    const url = rel.ucp_profile_url as string;
    const previous = this.store.getState(rel.relationship_id, "ucp_profile");
    let profile: Record<string, unknown>;
    try {
      const raw = await this.getJson(url);
      // 宽松 schema 校验：必须是 JSON object（§7.1：仅 GET JSON + 宽松校验）。
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new SupplierPullError("schema_invalid", "UCP profile must be a JSON object", true);
      }
      profile = raw as Record<string, unknown>;
    } catch (err) {
      const permanent = err instanceof SupplierPullError && err.permanent;
      const localRejection =
        err instanceof SupplierPullError &&
        (err.code === "unsafe_target" || err.code === "redirect");
      this.recordFailure(rel, "ucp_profile", previous, now, err, permanent, result, !localRejection);
      return;
    }
    const digest = contentDigest(profile);
    const unchanged = previous?.content_digest === digest;
    if (!unchanged && previous?.content_digest !== undefined) {
      this.store.addObservation({
        relationship_id: rel.relationship_id,
        kind: "capability_changed",
        source_type: "ucp_profile",
        payload: { from: previous.content_digest, to: digest },
        content_digest: contentDigest({ kind: "capability_changed", source: "ucp_profile", to: digest }),
        observed_at: now,
        fresh_until: now,
        verified: true,
      });
    }
    const next = this.scheduleAfterSuccess(rel, previous, now, unchanged);
    this.store.recordSourceSuccess(rel.relationship_id, "ucp_profile", {
      checked_at: now,
      next_check_at: next,
      source_url_or_ref: url,
      content_digest: digest,
      snapshot: profile,
      unchanged,
    });
  }

  // ---- 调度与退避 ------------------------------------------------------------

  private intervalSeconds(rel: SupplierRelationship): number {
    const raw = Number(rel.policy.interval_seconds ?? DEFAULT_INTERVAL_SECONDS);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_SECONDS;
    return Math.max(Math.floor(raw), MIN_INTERVAL_SECONDS);
  }

  /** 成功后下次检查：连续无变化 interval×1.5 逐步放慢，封顶 24h（§8）。 */
  private scheduleAfterSuccess(
    rel: SupplierRelationship,
    previous: { unchanged_count: number } | undefined,
    now: string,
    unchanged: boolean,
  ): string {
    const base = this.intervalSeconds(rel);
    const streak = unchanged ? (previous?.unchanged_count ?? 0) + 1 : 0;
    const seconds = Math.min(base * 1.5 ** streak, MAX_INTERVAL_SECONDS);
    return new Date(Date.parse(now) + seconds * 1000).toISOString();
  }

  /**
   * 失败退避（§8 第 9 步）：transient 指数退避 2^min(n-1,5)×interval 封顶
   * 24h + ±10% jitter；permanent（4xx/SSRF 拒绝/schema 拒绝）直接 24h。
   * 同时写 unreachable observation（content_digest 去重，持续失败不刷屏）。
   * 例外：本地安全策略拒绝（SSRF/redirect，observeUnreachable=false）不是
   * 远程事实，只退避、不写 observation。
   */
  private recordFailure(
    rel: SupplierRelationship,
    sourceType: SupplierSourceType,
    previous: { failure_count: number } | undefined,
    now: string,
    err: unknown,
    permanent: boolean,
    result: SupplierTickResult,
    observeUnreachable = true,
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof SupplierPullError ? err.code : "network";
    const attempts = (previous?.failure_count ?? 0) + 1;
    const base = this.intervalSeconds(rel);
    let seconds: number;
    if (permanent) {
      seconds = PERMANENT_BACKOFF_SECONDS;
    } else {
      const backoff = Math.min(base * 2 ** Math.min(attempts - 1, 5), MAX_INTERVAL_SECONDS);
      seconds = backoff * (1 + (this.random() - 0.5) * 0.2);
    }
    const backoffAt = new Date(Date.parse(now) + Math.floor(seconds) * 1000).toISOString();
    this.store.recordSourceFailure(rel.relationship_id, sourceType, {
      checked_at: now,
      backoff_at: backoffAt,
    });
    if (observeUnreachable) {
      this.store.addObservation({
        relationship_id: rel.relationship_id,
        kind: "unreachable",
        source_type: sourceType,
        payload: { error: message, permanent },
        content_digest: contentDigest({ kind: "unreachable", source: sourceType, code }),
        observed_at: now,
        fresh_until: backoffAt,
        verified: false,
      });
    }
    result.errors.push(`${sourceType} ${rel.relationship_id}: ${message}`);
  }

  // ---- safe-http 拉取模板（SSRF/DNS/redirect/body 上限/超时，§9.1）-----------

  private async getJson(url: string): Promise<unknown> {
    let safeUrl: URL;
    try {
      safeUrl = assertSafeTargetUrl(url, { allowLoopback: this.allowLoopback });
      await assertResolvableTargetUrl(safeUrl, {
        ...(this.skipDnsCheck !== undefined ? { skipDnsCheck: this.skipDnsCheck } : {}),
        ...(this.resolveIp !== undefined ? { resolveIp: this.resolveIp } : {}),
      });
    } catch (err) {
      throw new SupplierPullError(
        "unsafe_target",
        `URL rejected by safety policy: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchFn(safeUrl.href, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            // §9.2：不向 Merchant 直连发送稳定 X-Buyer-Id 等身份头。
            "user-agent": "kiwi-buyer",
          },
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        throw new SupplierPullError(
          name === "AbortError" ? "timeout" : "network",
          `fetch failed: ${url} (${err instanceof Error ? err.message : String(err)})`,
          false,
        );
      }
      if (isRedirectResponse(response)) {
        throw new SupplierPullError(
          "redirect",
          `must not follow redirects (HTTP ${response.status} from ${url})`,
          true,
        );
      }
      if (!response.ok) {
        throw new SupplierPullError(
          "http_error",
          `HTTP ${response.status} from ${url}`,
          response.status >= 400 && response.status < 500,
        );
      }
      try {
        return await readJsonBody(response, { signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new SupplierPullError("timeout", `timed out reading response: ${url}`, false);
        }
        if (err instanceof SafeHttpError) {
          throw new SupplierPullError(err.code, `${url}: ${err.message}`, true);
        }
        throw new SupplierPullError(
          "invalid_json",
          `${url}: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

function summarize(obs: SupplierObservation): string {
  const id = typeof obs.payload.listing_id === "string" ? ` ${obs.payload.listing_id}` : "";
  switch (obs.kind) {
    case "listing_added":
      return `新上架 listing${id}`;
    case "listing_updated":
      return `listing${id} 有更新`;
    case "listing_withdrawn":
      return `listing${id} 已下架`;
    case "capability_changed":
      return `供应商能力声明发生变化（${obs.source_type}）`;
    case "availability_hint_changed":
      return `listing${id} 可用性提示变化`;
    case "lead_time_hint_changed":
      return `listing${id} 交期提示变化`;
    case "profile_or_identity_changed":
      return "供应商身份指纹变化，关系已进入 review_required";
    case "freshness_changed":
      return `catalog 新鲜度变化：${String(obs.payload.from)} → ${String(obs.payload.to)}`;
    case "unreachable":
      return `来源不可达（${obs.source_type}）`;
  }
}
