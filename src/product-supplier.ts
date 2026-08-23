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
 * 产品层 `kiwi buyer supplier` 命令实现（pull-relationship 设计 v0.1 §11，M1）。
 *
 * 关系是 Buyer Core 本地私有状态：save/watch/prefer 通过 kiwi-catalog 解析
 * Merchant 公开 record（canonical_domain / agent_card_url / ucp_profile_url），
 * 写入本地 supplier_relationships；Merchant 侧无任何写入通道。
 *
 * watched / preferred 默认要求人类明确确认（consent_source = human_explicit）：
 * 非交互环境必须显式传 --yes，否则拒绝。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { agentDataDir, openAgentDatabase } from "./agent/agent-db.js";
import {
  SupplierRelationshipStore,
  type SupplierRelationship,
  type SupplierRelationshipType,
} from "./agent/supplier/store.js";
import { KiwiCatalogSource } from "./discovery/catalog-source/kiwi-source.js";
import { DEFAULT_CATALOG_URL } from "./product-cli.js";

export interface SupplierCommandOptions {
  dataDir?: string;
  agentId?: string;
}

export interface SupplierSummary {
  relationship_id: string;
  merchant_id: string;
  canonical_domain: string;
  relationship_type: SupplierRelationshipType;
  status: string;
  consent_source: string;
  scope: Record<string, unknown>;
  policy: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  expires_at?: string;
}

function openSupplierStore(options: SupplierCommandOptions): {
  db: DatabaseSync;
  store: SupplierRelationshipStore;
  principalId: string;
} {
  const dataDir = options.dataDir ?? agentDataDir(options.agentId ?? "kiwi-assistant");
  const dbPath = path.join(dataDir, "state.sqlite");
  if (!existsSync(dbPath)) {
    throw new Error(
      `没有 Buyer 数据（${dbPath} 不存在）——先运行 \`kiwi buyer start\` 初始化本地 Buyer Core`,
    );
  }
  const db = openAgentDatabase(dbPath);
  try {
    const principal = db
      .prepare("SELECT principal_id FROM principals WHERE role = 'buyer' ORDER BY created_at LIMIT 1")
      .get() as { principal_id: string } | undefined;
    if (principal === undefined) {
      throw new Error("本地 Buyer principal 不存在——先运行 `kiwi buyer start` 完成初始化");
    }
    const store = new SupplierRelationshipStore({ db, principalId: principal.principal_id });
    return { db, store, principalId: principal.principal_id };
  } catch (err) {
    db.close();
    throw err;
  }
}

/** 从 kiwi-catalog 解析 Merchant 公开 record（save/watch/prefer 共用的身份来源）。 */
async function resolveMerchant(catalogUrl: string, merchantId: string): Promise<{
  merchant_id: string;
  catalog_agent_id: string;
  canonical_domain: string;
  agent_card_url: string;
  ucp_profile_url?: string;
}> {
  const source = new KiwiCatalogSource({ baseUrl: catalogUrl });
  const record = await source.getRecord(merchantId);
  if (record.agent_card_url === undefined) {
    throw new Error(`catalog record ${merchantId} 没有 agent_card_url，无法建立供应商关系`);
  }
  return {
    merchant_id: record.merchant_id ?? record.catalog_agent_id,
    catalog_agent_id: record.catalog_agent_id,
    canonical_domain: record.canonical_domain,
    agent_card_url: record.agent_card_url,
    ...(record.ucp_profile_url !== undefined ? { ucp_profile_url: record.ucp_profile_url } : {}),
  };
}

/**
 * watched/preferred 的明确同意门（§11：创建 watched/preferred 默认要求人类
 * 明确确认）。--yes 或交互确认通过才返回；否则抛错拒绝。
 */
async function requireExplicitConsent(options: {
  yes?: boolean;
  confirm?: () => Promise<boolean>;
  action: string;
}): Promise<void> {
  if (options.yes === true) return;
  if (options.confirm !== undefined && (await options.confirm())) return;
  throw new Error(
    `${options.action} 需要人类明确确认：交互终端请确认提示，非交互环境请显式加 --yes`,
  );
}

function summarize(rel: SupplierRelationship): SupplierSummary {
  const out: SupplierSummary = {
    relationship_id: rel.relationship_id,
    merchant_id: rel.merchant_id,
    canonical_domain: rel.canonical_domain,
    relationship_type: rel.relationship_type,
    status: rel.status,
    consent_source: rel.consent_source,
    scope: rel.scope,
    policy: rel.policy,
    created_at: rel.created_at,
    updated_at: rel.updated_at,
  };
  if (rel.expires_at !== undefined) out.expires_at = rel.expires_at;
  return out;
}

function parseExpiresDays(value: string): string {
  const match = /^(\d+)d$/.exec(value);
  if (match === null) {
    throw new Error("--expires 只支持 <N>d 形式（如 90d）");
  }
  const days = Number(match[1]);
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error("--expires 天数必须是正整数");
  }
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
}

export interface SupplierSaveOptions extends SupplierCommandOptions {
  merchantId: string;
  catalogUrl?: string;
}

/** `kiwi buyer supplier save <merchant-id>`：保存身份，不轮询（§2.1）。 */
export async function supplierSave(options: SupplierSaveOptions): Promise<SupplierSummary> {
  const resolved = await resolveMerchant(options.catalogUrl ?? DEFAULT_CATALOG_URL, options.merchantId);
  const { db, store } = openSupplierStore(options);
  try {
    return summarize(
      store.saveRelationship({
        merchant_id: resolved.merchant_id,
        canonical_domain: resolved.canonical_domain,
        agent_card_url: resolved.agent_card_url,
        ...(resolved.ucp_profile_url !== undefined
          ? { ucp_profile_url: resolved.ucp_profile_url }
          : {}),
        relationship_type: "saved",
        scope: { catalog_agent_id: resolved.catalog_agent_id },
        consent_source: "human_explicit",
      }),
    );
  } finally {
    db.close();
  }
}

export interface SupplierWatchOptions extends SupplierCommandOptions {
  merchantId: string;
  catalogUrl?: string;
  query?: string;
  region?: string;
  /** 轮询间隔（秒）；缺省 6h，下限 1h（§8：不做分钟级轮询）。 */
  intervalSeconds?: number;
  yes?: boolean;
  confirm?: () => Promise<boolean>;
}

/** `kiwi buyer supplier watch <merchant-id>`：建立主动观察规则（§2.2）。 */
export async function supplierWatch(options: SupplierWatchOptions): Promise<SupplierSummary> {
  await requireExplicitConsent({ yes: options.yes, confirm: options.confirm, action: "watch" });
  if (
    options.intervalSeconds !== undefined &&
    (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 3600)
  ) {
    throw new Error("--interval 必须是 ≥3600 的整数秒（供应商观察不做分钟级轮询）");
  }
  const resolved = await resolveMerchant(options.catalogUrl ?? DEFAULT_CATALOG_URL, options.merchantId);
  const { db, store } = openSupplierStore(options);
  try {
    return summarize(
      store.saveRelationship({
        merchant_id: resolved.merchant_id,
        canonical_domain: resolved.canonical_domain,
        agent_card_url: resolved.agent_card_url,
        ...(resolved.ucp_profile_url !== undefined
          ? { ucp_profile_url: resolved.ucp_profile_url }
          : {}),
        relationship_type: "watched",
        scope: {
          catalog_agent_id: resolved.catalog_agent_id,
          ...(options.query !== undefined ? { query: options.query } : {}),
          ...(options.region !== undefined ? { region: options.region } : {}),
        },
        policy:
          options.intervalSeconds !== undefined
            ? { interval_seconds: options.intervalSeconds }
            : {},
        consent_source: "human_explicit",
      }),
    );
  } finally {
    db.close();
  }
}

export interface SupplierPreferOptions extends SupplierCommandOptions {
  merchantId: string;
  catalogUrl?: string;
  scope?: string;
  /** 如 "90d"（§11 CLI 形式）。 */
  expires?: string;
  yes?: boolean;
  confirm?: () => Promise<boolean>;
}

/** `kiwi buyer supplier prefer <merchant-id>`：采购范围内的软偏好（§2.3）。 */
export async function supplierPrefer(options: SupplierPreferOptions): Promise<SupplierSummary> {
  await requireExplicitConsent({ yes: options.yes, confirm: options.confirm, action: "prefer" });
  const resolved = await resolveMerchant(options.catalogUrl ?? DEFAULT_CATALOG_URL, options.merchantId);
  const { db, store } = openSupplierStore(options);
  try {
    return summarize(
      store.saveRelationship({
        merchant_id: resolved.merchant_id,
        canonical_domain: resolved.canonical_domain,
        agent_card_url: resolved.agent_card_url,
        ...(resolved.ucp_profile_url !== undefined
          ? { ucp_profile_url: resolved.ucp_profile_url }
          : {}),
        relationship_type: "preferred",
        scope: {
          catalog_agent_id: resolved.catalog_agent_id,
          ...(options.scope !== undefined ? { procurement_scope: options.scope } : {}),
        },
        ...(options.expires !== undefined
          ? { expires_at: parseExpiresDays(options.expires) }
          : {}),
        consent_source: "human_explicit",
      }),
    );
  } finally {
    db.close();
  }
}

/** `kiwi buyer supplier list`。 */
export async function supplierList(options: SupplierCommandOptions): Promise<SupplierSummary[]> {
  const { db, store } = openSupplierStore(options);
  try {
    return store.listRelationships().map(summarize);
  } finally {
    db.close();
  }
}

export interface SupplierIdOptions extends SupplierCommandOptions {
  relationshipId: string;
}

/** `kiwi buyer supplier pause <relationship-id>`。 */
export async function supplierPause(options: SupplierIdOptions): Promise<SupplierSummary> {
  const { db, store } = openSupplierStore(options);
  try {
    return summarize(store.updateStatus(options.relationshipId, "paused"));
  } finally {
    db.close();
  }
}

/**
 * `kiwi buyer supplier remove <relationship-id>`：软删——立即停止后续拉取并
 * 清除未来调度（§11）。M3 之前 receipt_status 恒为 none，无需远端 revoke；
 * 若将来存在有效 receipt，先 best-effort revoke 但远端不可达不阻塞本地删除。
 */
export async function supplierRemove(options: SupplierIdOptions): Promise<SupplierSummary> {
  const { db, store } = openSupplierStore(options);
  try {
    const rel = store.getRelationship(options.relationshipId);
    if (rel === undefined) {
      throw new Error(`没有供应商关系 ${options.relationshipId}`);
    }
    if (rel.receipt_status !== "none") {
      // M3 预留：当前版本不会进入该分支（无 receipt 发送面）。
      throw new Error(
        `关系 ${options.relationshipId} 存在有效 relationship receipt（${rel.receipt_status}），` +
          "当前版本请先等待 receipt 过期后再删除",
      );
    }
    return summarize(store.updateStatus(options.relationshipId, "deleted"));
  } finally {
    db.close();
  }
}

// ---- M0 指标（pull-relationship 设计 v0.1 §13/§14） ------------------------------

const DAY_MS = 24 * 3600 * 1000;

export interface SupplierMetricsOptions extends SupplierCommandOptions {
  /** 测试注入时钟；缺省真实时间。 */
  now?: () => string;
}

/** 比率指标：永远给出分子/分母；分母为 0 时 value=null（不虚报 0 或 1）。 */
export interface RatioMetric {
  value: number | null;
  numerator: number;
  denominator: number;
  note?: string;
}

export interface SupplierMetricsReport {
  generated_at: string;
  principal_id: string;
  /** Qualified RFQ 的可计算代理口径（仓库内无更严格定义）。 */
  qualified_rfq_definition: string;
  successful_rfqs: number;
  failed_rfqs: number;
  /** §14 save-after-RFQ conversion：7 天内同 merchant 建立关系的建议占比。 */
  save_after_rfq: RatioMetric;
  /** §14 active watched/preferred relationships + 全量 type×status 分布。 */
  relationships_by_type_status: {
    total: number;
    active_watched_preferred: number;
    buckets: { relationship_type: string; status: string; count: number }[];
  };
  /** §14 7/30 天关系复用率（分母=建立已满窗口的关系，避免新关系虚低）。 */
  reuse_7d: RatioMetric;
  reuse_30d: RatioMetric;
  /** §14 relationship-assisted Qualified RFQ。 */
  relationship_assisted_rfq: RatioMetric;
  /** §14 重复 Merchant / Buyer（单 principal 本地视角，buyer 恒为 1）。 */
  repeat_merchants: {
    merchants_with_successful_rfq: number;
    merchants_with_repeat_rfq: number;
    successful_rfqs: number;
    unidentified_merchant_rfqs: number;
  };
  observations: {
    total: number;
    by_kind: Record<string, number>;
    /** 可计算代理：observation 对应关系当前仍是 active watched 的占比。 */
    on_active_watched: RatioMetric;
    /** 严格通知命中率本地无记录，恒 null。 */
    notification_hit_rate: { value: null; note: string };
  };
  /** §14 暂停率和删除率（占全部关系，含 deleted）。 */
  lifecycle: { paused: RatioMetric; deleted: RatioMetric };
  /** §14 identity-change review 与 stale/unreachable 代理。 */
  health: { review_required: RatioMetric; degraded_sources: RatioMetric };
}

function ratio(numerator: number, denominator: number, note?: string): RatioMetric {
  const m: RatioMetric = {
    value: denominator === 0 ? null : numerator / denominator,
    numerator,
    denominator,
  };
  if (note !== undefined) m.note = note;
  return m;
}

interface RfqEvent {
  created_at: string;
  payload: Record<string, unknown>;
}

/**
 * a2a_negotiated 事件没有 merchant_id 字段——用 catalog_agent_id（对
 * relationship.merchant_id 或 scope.catalog_agent_id）或 agent_card_url 匹配
 * merchant（代理口径，§14 注明）。
 */
function rfqMatchesRelationship(
  payload: Record<string, unknown>,
  rel: SupplierRelationship,
): boolean {
  const caid = payload.catalog_agent_id;
  if (
    typeof caid === "string" &&
    caid !== "" &&
    (rel.merchant_id === caid || rel.scope.catalog_agent_id === caid)
  ) {
    return true;
  }
  const cardUrl = payload.agent_card_url;
  return typeof cardUrl === "string" && cardUrl !== "" && rel.agent_card_url === cardUrl;
}

/**
 * `kiwi buyer supplier metrics`（§13 M0 / §14）：Buyer 本地只读指标。全部数据
 * 来自本机 state.sqlite（supplier_relationships / supplier_observations /
 * supplier_observation_state / task_events），单 principal 视角。算不出来的
 * 指标如实给 null + 原因，不编造。
 */
export async function supplierMetrics(
  options: SupplierMetricsOptions = {},
): Promise<SupplierMetricsReport> {
  const { db, store, principalId } = openSupplierStore(options);
  try {
    const now = new Date(
      Date.parse(options.now !== undefined ? options.now() : new Date().toISOString()),
    ).toISOString();
    const nowMs = Date.parse(now);

    const relationships = store.listRelationships({ includeDeleted: true });

    const eventRows = db
      .prepare(
        `SELECT e.type AS type, e.payload_json AS payload_json, e.created_at AS created_at
         FROM task_events e JOIN buyer_tasks t ON t.task_id = e.task_id
         WHERE t.principal_id = ? AND e.type IN ('a2a_negotiated', 'supplier_save_suggested')
         ORDER BY e.created_at, e.event_id`,
      )
      .all(principalId) as { type: string; payload_json: string; created_at: string }[];
    const successfulRfqs: RfqEvent[] = [];
    let failedRfqs = 0;
    const suggestions: RfqEvent[] = [];
    for (const row of eventRows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (row.type === "supplier_save_suggested") {
        suggestions.push({ created_at: row.created_at, payload });
      } else if (payload.ok === true) {
        successfulRfqs.push({ created_at: row.created_at, payload });
      } else {
        failedRfqs += 1;
      }
    }

    // a. save-after-RFQ conversion：建议后 7 天内同 merchant 建立关系（含已删除，
    //    转化是历史事实；created_at 严格晚于建议时间）。
    let converted = 0;
    for (const s of suggestions) {
      const merchant = s.payload.merchant_id;
      if (typeof merchant !== "string") continue;
      const t = Date.parse(s.created_at);
      const hit = relationships.some(
        (r) =>
          r.merchant_id === merchant &&
          Date.parse(r.created_at) > t &&
          Date.parse(r.created_at) <= t + 7 * DAY_MS,
      );
      if (hit) converted += 1;
    }
    const saveAfterRfq = ratio(converted, suggestions.length, "窗口=建议事件后 7 天");

    // b. type × status 分布。
    const bucketMap = new Map<string, number>();
    let activeWatchedPreferred = 0;
    for (const r of relationships) {
      const key = `${r.relationship_type}/${r.status}`;
      bucketMap.set(key, (bucketMap.get(key) ?? 0) + 1);
      if (
        r.status === "active" &&
        (r.relationship_type === "watched" || r.relationship_type === "preferred")
      ) {
        activeWatchedPreferred += 1;
      }
    }
    const buckets = [...bucketMap.entries()]
      .map(([key, count]) => {
        const [relationship_type, status] = key.split("/") as [string, string];
        return { relationship_type, status, count };
      })
      .sort((a, b) =>
        `${a.relationship_type}/${a.status}`.localeCompare(`${b.relationship_type}/${b.status}`),
      );

    // c. 7/30 天复用：分母=建立已满窗口的关系（含非 active，复用是历史事实）。
    const reuse = (days: number): RatioMetric => {
      const eligible = relationships.filter(
        (r) => Date.parse(r.created_at) + days * DAY_MS <= nowMs,
      );
      let reused = 0;
      for (const r of eligible) {
        const t0 = Date.parse(r.created_at);
        const hit = successfulRfqs.some((e) => {
          const t = Date.parse(e.created_at);
          return t >= t0 && t <= t0 + days * DAY_MS && rfqMatchesRelationship(e.payload, r);
        });
        if (hit) reused += 1;
      }
      return ratio(
        reused,
        eligible.length,
        "merchant 经 catalog_agent_id/agent_card_url 匹配（a2a_negotiated 无 merchant_id，代理口径）",
      );
    };

    // d. relationship-assisted：RFQ 发生前已建立且当前仍 active 的同 merchant 关系。
    //    历史状态不可重建，用当前 status='active' 代理（口径文档注明）。
    let assisted = 0;
    for (const e of successfulRfqs) {
      const t = Date.parse(e.created_at);
      const hit = relationships.some(
        (r) =>
          r.status === "active" &&
          Date.parse(r.created_at) <= t &&
          rfqMatchesRelationship(e.payload, r),
      );
      if (hit) assisted += 1;
    }
    const assistedMetric = ratio(
      assisted,
      successfulRfqs.length,
      "active 取当前状态（历史状态不可重建，代理口径）",
    );

    // e. 重复 Merchant：按 catalog_agent_id（缺省 agent_card_url）分组成功 RFQ。
    const byMerchant = new Map<string, number>();
    let unidentified = 0;
    for (const e of successfulRfqs) {
      const id = e.payload.catalog_agent_id ?? e.payload.agent_card_url;
      if (typeof id === "string" && id !== "") {
        byMerchant.set(id, (byMerchant.get(id) ?? 0) + 1);
      } else {
        unidentified += 1;
      }
    }
    let repeatMerchants = 0;
    for (const n of byMerchant.values()) {
      if (n >= 2) repeatMerchants += 1;
    }

    // f. observation 面。
    const obsRows = db
      .prepare(
        `SELECT o.kind AS kind, r.relationship_type AS relationship_type, r.status AS status
         FROM supplier_observations o
         JOIN supplier_relationships r ON r.relationship_id = o.relationship_id
         WHERE r.principal_id = ?`,
      )
      .all(principalId) as { kind: string; relationship_type: string; status: string }[];
    const byKind: Record<string, number> = {};
    let onActiveWatched = 0;
    for (const o of obsRows) {
      byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
      if (o.status === "active" && o.relationship_type === "watched") onActiveWatched += 1;
    }

    // g. lifecycle（分母含 deleted）。
    const total = relationships.length;
    const paused = relationships.filter((r) => r.status === "paused").length;
    const deleted = relationships.filter((r) => r.status === "deleted").length;

    // h. health。
    const reviewRequired = relationships.filter((r) => r.status === "review_required").length;
    const stateRows = db
      .prepare(
        `SELECT s.failure_count AS failure_count, s.backoff_until AS backoff_until
         FROM supplier_observation_state s
         JOIN supplier_relationships r ON r.relationship_id = s.relationship_id
         WHERE r.principal_id = ?`,
      )
      .all(principalId) as { failure_count: number; backoff_until: string | null }[];
    const degraded = stateRows.filter(
      (s) =>
        s.failure_count > 0 ||
        (s.backoff_until !== null && Date.parse(s.backoff_until) > nowMs),
    ).length;

    return {
      generated_at: now,
      principal_id: principalId,
      qualified_rfq_definition:
        "代理口径：task_events 中 type='a2a_negotiated' 且 payload.ok=true 的成功终态事件" +
        "（仓库内无更严格的 Qualified RFQ 定义）",
      successful_rfqs: successfulRfqs.length,
      failed_rfqs: failedRfqs,
      save_after_rfq: saveAfterRfq,
      relationships_by_type_status: {
        total,
        active_watched_preferred: activeWatchedPreferred,
        buckets,
      },
      reuse_7d: reuse(7),
      reuse_30d: reuse(30),
      relationship_assisted_rfq: assistedMetric,
      repeat_merchants: {
        merchants_with_successful_rfq: byMerchant.size,
        merchants_with_repeat_rfq: repeatMerchants,
        successful_rfqs: successfulRfqs.length,
        unidentified_merchant_rfqs: unidentified,
      },
      observations: {
        total: obsRows.length,
        by_kind: byKind,
        on_active_watched: ratio(
          onActiveWatched,
          obsRows.length,
          "代理口径：observation 对应关系当前仍是 active watched 的占比",
        ),
        notification_hit_rate: {
          value: null,
          note: "严格命中率不可计算：本地不记录通知是否触达/被用户采纳",
        },
      },
      lifecycle: {
        paused: ratio(paused, total),
        deleted: ratio(deleted, total),
      },
      health: {
        review_required: ratio(reviewRequired, total),
        degraded_sources: ratio(
          degraded,
          stateRows.length,
          "stale/unreachable 代理：failure_count>0 或 backoff_until>now",
        ),
      },
    };
  } finally {
    db.close();
  }
}
