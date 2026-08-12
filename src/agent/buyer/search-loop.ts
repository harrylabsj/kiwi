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
 * Buyer search execution loop (design §13):
 * ready -> searching -> (shortlist_ready -> awaiting_user | tracking).
 *
 * Every run has a run_id; every event carries an idempotency key derived
 * from it, so a retried run never double-writes. Transitions are
 * version-guarded. Connector failures classify: transient => the task
 * moves to `failed` with a retriable note (never silently keeps stale
 * facts, §18.2).
 */

import { createHash } from "node:crypto";
import type { CommerceConnector, ConnectorProduct } from "../connector/types.js";
import { ConnectorError } from "../connector/types.js";
import { hardFilter, scoreCandidate } from "./ranker.js";
import type { BuyerTaskStore } from "./task-store.js";
import type {
  BuyerTask,
  ProductCandidate,
  ProductObservation,
  TaskConstraints,
  TrackingRule,
} from "./types.js";
import { BuyerTaskError } from "./types.js";
import type { KiwiCatalogSource } from "../../discovery/catalog-source/kiwi-source.js";
import type {
  KiwiListingSearchQuery,
  ListingSearchResult,
} from "../../discovery/catalog-source/kiwi-record.js";

export interface SearchCycleDeps {
  store: BuyerTaskStore;
  connector: CommerceConnector;
  /** 配置 catalog 时注入：任务搜索数据面优先走 catalog listings（CD #28）。 */
  catalogSource?: KiwiCatalogSource;
  now: () => string;
}

export interface ShortlistEntry {
  candidate: ProductCandidate;
  observation?: ProductObservation;
}

export interface SearchCycleResult {
  task: BuyerTask;
  /** `retry` = transient connector error, task parked for a scheduled retry. */
  outcome: "shortlist_ready" | "tracking" | "failed" | "retry";
  shortlist: ShortlistEntry[];
  error?: string;
}

/**
 * Content-hash over the assertion-relevant facts (§11.6 dedup). Includes
 * delivery ETA so a changed delivery promise produces a NEW observation
 * instead of being silently deduped away (which would keep `delivery_before`
 * rules and the delivery dimension evaluating stale ETAs).
 */
export function observationHash(product: ConnectorProduct): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: product.title,
        price: product.price,
        fee: product.delivery.fee,
        stock: product.stock,
        eta_minutes: product.delivery.eta_minutes,
        warnings: product.warnings,
      }),
    )
    .digest("hex");
}

function toObservation(
  candidateId: string,
  product: ConnectorProduct,
  now: string,
  ttlSeconds: number,
): Omit<ProductObservation, "observation_id"> {
  return {
    candidate_id: candidateId,
    observed_at: now,
    source_url_or_ref: `shopping-cli:/products/${product.sku}`,
    title: product.title,
    price: { list: product.price, currency: product.currency, delivery_fee: product.delivery.fee },
    promotion: {},
    stock: { quantity: product.stock, observed_at: now },
    delivery: { ...product.delivery },
    after_sales: {},
    merchant: {
      id: product.merchant.id,
      name: product.merchant.name,
      city: product.merchant.city,
      warnings: product.warnings,
    },
    content_hash: observationHash(product),
    fresh_until: new Date(Date.parse(now) + ttlSeconds * 1000).toISOString(),
  };
}

/** Install default tracking rules from constraints when none are active (§13). */
function installDefaultRules(deps: SearchCycleDeps, task: BuyerTask): TrackingRule[] {
  const { store } = deps;
  const active = store.rulesForTask(task.task_id).filter((r) => r.status === "active");
  if (active.length > 0) return active;
  const installed: TrackingRule[] = [];
  const interval = task.tracking_policy.default_interval_seconds;
  const cooldown = task.tracking_policy.default_cooldown_seconds;
  if (task.constraints.max_total_price !== undefined) {
    installed.push(
      store.addTrackingRule({
        task_id: task.task_id,
        rule_type: "price_below",
        condition: { threshold: task.constraints.max_total_price },
        interval_seconds: interval,
        cooldown_seconds: cooldown,
        idempotency_key: `${task.task_id}:default:price_below`,
      }),
    );
  }
  installed.push(
    store.addTrackingRule({
      task_id: task.task_id,
      rule_type: "stock_available",
      condition: {},
      interval_seconds: interval,
      cooldown_seconds: cooldown,
      idempotency_key: `${task.task_id}:default:stock_available`,
    }),
  );
  installed.push(
    store.addTrackingRule({
      task_id: task.task_id,
      rule_type: "periodic_review",
      condition: {},
      interval_seconds: interval,
      cooldown_seconds: cooldown,
      idempotency_key: `${task.task_id}:default:periodic_review`,
    }),
  );
  return installed;
}

export async function runSearchCycle(
  deps: SearchCycleDeps,
  taskId: string,
  runId: string,
): Promise<SearchCycleResult> {
  const { store, connector } = deps;
  // Normalize to UTC ISO (lexicographic timestamp comparisons downstream).
  const now = () => new Date(Date.parse(deps.now())).toISOString();
  let task = store.getTask(taskId);
  if (task === undefined) throw new BuyerTaskError("not_found", `no task ${taskId}`);
  if (!["ready", "searching", "tracking"].includes(task.status)) {
    throw new BuyerTaskError(
      "illegal_transition",
      `task ${taskId} is ${task.status}; search requires ready/searching/tracking`,
    );
  }

  // A private budget may be vaulted (max_total_price_vault_ref); resolve it
  // here so filtering and default rules never see the plaintext value and
  // never skip the constraint when it lives in the Vault (§11.2).
  const budget = store.resolveBudget(task.constraints);
  const effectiveConstraints: TaskConstraints =
    budget !== undefined ? { ...task.constraints, max_total_price: budget } : task.constraints;

  const startedAt = now();

  // ready/tracking -> searching (idempotent; already-searching = crash resume).
  if (task.status !== "searching") {
    task = store.transitionTask({
      task_id: taskId,
      to: "searching",
      expected_version: task.version,
      event_type: "search_started",
      origin: "scheduler",
      idempotency_key: `${runId}:search_started`,
      // 崩溃恢复 + 防并发重复执行（评审项 H4）：新激活任务的 next_run_at 为
      // NULL（createTask 时置空、激活 ready 不设置）——searching 转移若保留
      // NULL，崩溃后 dueTasks（要求 NOT NULL）永不选中该任务，永久卡死且
      // 无恢复路径（"already-searching = crash resume" 注释此前不成立）。
      // 置为未来锁定期：正常完成由 tracking/shortlist 转移覆盖该值；崩溃
      // 后到期即被 dueTasks 重新选中恢复；锁定期内下一 tick 不会重复选中
      // 同一任务（防并发搜索）。
      next_run_at: new Date(
        Date.parse(startedAt) +
          Math.max(task.tracking_policy.default_interval_seconds, 60) * 1000,
      ).toISOString(),
    });
  }

  // catalog-first（CD #28）：配置 catalog 时，任务搜索数据面优先查询 catalog
  // listings。listings 是 discovery projection——报价/库存必须联系 owner Agent
  // 确认（requires_direct_confirmation），不做价格/库存硬过滤；候选带
  // owner_agent_id 供 negotiate_buyer_task 走 A2A 磋商。catalog 无命中时回退
  // legacy marketplace connector 路径（search_products 语义不变）；catalog
  // 查询失败视为瞬时错误 → tracking 退避重试。
  if (deps.catalogSource !== undefined) {
    const catalogOutcome = await runCatalogSearchCycle(deps, task, startedAt, runId);
    if (catalogOutcome !== undefined) return catalogOutcome;
  }

  let products: ConnectorProduct[];
  try {
    products = await connector.searchProducts({
      ...(task.intent.query_text !== undefined ? { query: task.intent.query_text } : {}),
      ...(task.intent.city !== undefined ? { city: task.intent.city } : {}),
      ...(task.intent.area !== undefined ? { area: task.intent.area } : {}),
      include_out_of_stock: task.constraints.exclude_out_of_stock === false,
      limit: task.search_budget.max_candidates,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retriable = err instanceof ConnectorError && err.kind === "transient";
    if (retriable) {
      // §18.1/§13: a transient connector error must not kill the task. Park it
      // in `tracking` with a scheduled retry (exponential backoff, capped); the
      // scheduler's dueTasks re-runs it when next_run_at is due.
      const attempts =
        store.taskEvents(taskId).filter((e) => e.type === "connector_retry").length + 1;
      const backoffMs = Math.min(
        task.tracking_policy.default_interval_seconds * 1000 * 2 ** Math.min(attempts - 1, 5),
        6 * 3600 * 1000,
      );
      const nextRunAt = new Date(Date.parse(startedAt) + backoffMs).toISOString();
      task = store.transitionTask({
        task_id: taskId,
        to: "tracking",
        expected_version: task.version,
        event_type: "connector_retry",
        payload: { error: message, retriable: true, attempts, next_run_at: nextRunAt },
        origin: "connector",
        idempotency_key: `${runId}:retry`,
        next_run_at: nextRunAt,
      });
      return { task, outcome: "retry", shortlist: [], error: message };
    }
    task = store.transitionTask({
      task_id: taskId,
      to: "failed",
      expected_version: task.version,
      event_type: "failed",
      payload: { error: message, retriable: false },
      origin: "connector",
      idempotency_key: `${runId}:failed`,
    });
    return { task, outcome: "failed", shortlist: [], error: message };
  }

  const observations = new Map<string, ProductObservation | undefined>();
  const eligible: { candidate: ProductCandidate; product: ConnectorProduct }[] = [];

  for (const product of products.slice(0, task.search_budget.max_candidates)) {
    const candidate = store.upsertCandidate({
      task_id: taskId,
      connector_id: connector.connector_id,
      platform: connector.platform,
      external_product_id: product.sku,
      sku: product.sku,
      merchant_id: product.merchant_id,
    });
    const obs = store.addObservation(
      toObservation(candidate.candidate_id, product, startedAt, task.tracking_policy.observation_ttl_seconds),
    );
    const filter = hardFilter(product, effectiveConstraints, startedAt);
    const observation = store.latestObservation(candidate.candidate_id);
    observations.set(product.sku, observation);
    if (filter.eligible === "ineligible") {
      store.updateCandidate(candidate.candidate_id, {
        eligibility: "ineligible",
        candidate_status: "rejected",
        rejection_reasons: filter.reasons,
        ...(obs.added ? { latest_observation_id: obs.observation_id } : {}),
      });
      continue;
    }
    const { score, explanation } = scoreCandidate(product, {
      intent: task.intent,
      policy: task.ranking_policy,
      now: startedAt,
      observations,
    });
    if (filter.unknowns.length > 0) explanation.stale_facts.push(...filter.unknowns);
    const updated = store.updateCandidate(candidate.candidate_id, {
      eligibility: filter.eligible,
      candidate_status: "tracked",
      score,
      score_explanation: explanation,
      ...(obs.added ? { latest_observation_id: obs.observation_id } : {}),
    });
    eligible.push({ candidate: updated, product });
  }

  store.appendEvent(
    taskId,
    "observation_added",
    { products: products.length, eligible: eligible.length },
    "connector",
    `${runId}:observations`,
  );

  eligible.sort((a, b) => (b.candidate.score ?? 0) - (a.candidate.score ?? 0));

  if (eligible.length > 0) {
    const top = eligible.slice(0, 3);
    for (const { candidate } of top) {
      store.updateCandidate(candidate.candidate_id, { candidate_status: "shortlisted" });
    }
    task = store.transitionTask({
      task_id: taskId,
      to: "shortlist_ready",
      expected_version: task.version,
      event_type: "shortlisted",
      payload: {
        candidates: top.map(({ candidate }) => ({
          candidate_id: candidate.candidate_id,
          sku: candidate.sku,
          score: candidate.score,
        })),
      },
      origin: "scheduler",
      idempotency_key: `${runId}:shortlisted`,
    });
    task = store.transitionTask({
      task_id: taskId,
      to: "awaiting_user",
      expected_version: task.version,
      event_type: "status_changed",
      origin: "scheduler",
      idempotency_key: `${runId}:awaiting_user`,
    });
    return {
      task,
      outcome: "shortlist_ready",
      shortlist: top.map(({ candidate }) => ({
        candidate,
        observation: observations.get(candidate.sku ?? ""),
      })),
    };
  }

  // Nothing eligible yet: install tracking rules and wait for wakeups.
  const rules = installDefaultRules(deps, { ...task, constraints: effectiveConstraints });
  const nextRun = new Date(
    Date.parse(startedAt) + task.tracking_policy.default_interval_seconds * 1000,
  ).toISOString();
  task = store.transitionTask({
    task_id: taskId,
    to: "tracking",
    expected_version: task.version,
    event_type: "tracking_installed",
    payload: { rule_ids: rules.map((r) => r.rule_id) },
    origin: "scheduler",
    idempotency_key: `${runId}:tracking`,
    next_run_at: nextRun,
  });
  return { task, outcome: "tracking", shortlist: [] };
}

/**
 * catalog-first 搜索循环（CD #28）：把 catalog listings 作为任务搜索数据面。
 *
 * listings 是 discovery projection（报价/库存须联系 owner Agent 确认），因此
 * 不做价格/库存硬过滤、也不打分（候选 score 留空，模型看到的是 listing 的
 * commercial_hints）；候选经 shortlist → awaiting_user 交给操作者/模型选择，
 * owner_agent_id 与 handoff_destination_* 写入候选事件，供 negotiate_buyer_task
 * / handoff_agreement 使用。无命中返回 undefined → 回退 marketplace connector
 * 路径；catalog 查询失败视为瞬时错误 → tracking + 指数退避重试（与 marketplace
 * transient 一致）。
 */
async function runCatalogSearchCycle(
  deps: SearchCycleDeps,
  task: BuyerTask,
  startedAt: string,
  runId: string,
): Promise<SearchCycleResult | undefined> {
  const { store, catalogSource } = deps;
  const source = catalogSource;
  if (source === undefined) {
    throw new BuyerTaskError("validation", "catalogSource 未配置（runCatalogSearchCycle 不应被调用）");
  }
  // 自由文本意图只走 q（LIKE title/category/brand/summary）模糊匹配——
  // intent.category 是模型从用户语言抽的自由文本（如"手机"/"iPhone 17"），
  // 当精确 filter 几乎必空（listing.category 是结构化值），会 0 命中后回退
  // marketplace 死端口 → 误报网络故障。用 query_text ?? category 作 q。
  const query: KiwiListingSearchQuery = {
    ...((task.intent.query_text ?? task.intent.category) !== undefined &&
    (task.intent.query_text ?? task.intent.category) !== ""
      ? { q: task.intent.query_text ?? task.intent.category }
      : {}),
    ...(task.intent.city !== undefined ? { region: task.intent.city } : {}),
    limit: task.search_budget.max_candidates,
  };
  let results: ListingSearchResult[];
  try {
    results = await source.searchListings(query);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts =
      store.taskEvents(task.task_id).filter((e) => e.type === "connector_retry").length + 1;
    const backoffMs = Math.min(
      task.tracking_policy.default_interval_seconds * 1000 * 2 ** Math.min(attempts - 1, 5),
      6 * 3600 * 1000,
    );
    const nextRunAt = new Date(Date.parse(startedAt) + backoffMs).toISOString();
    const parked = store.transitionTask({
      task_id: task.task_id,
      to: "tracking",
      expected_version: task.version,
      event_type: "connector_retry",
      payload: {
        source: "kiwi-catalog",
        error: message,
        retriable: true,
        attempts,
        next_run_at: nextRunAt,
      },
      origin: "connector",
      idempotency_key: `${runId}:catalog-retry`,
      next_run_at: nextRunAt,
    });
    return { task: parked, outcome: "retry", shortlist: [], error: message };
  }

  // 与 marketplace 一致：缺省排除 out_of_stock（仅显式 exclude=false 时包含）。
  const includeOutOfStock = task.constraints.exclude_out_of_stock === false;
  const shortlist: ShortlistEntry[] = [];
  for (const r of results) {
    const listing = r.listing;
    if (!includeOutOfStock && listing.commercial_hints?.availability_hint === "out_of_stock") {
      continue;
    }
    const candidate = store.upsertCandidate({
      task_id: task.task_id,
      connector_id: "kiwi-catalog",
      platform: "kiwi-catalog",
      external_product_id: listing.listing_id,
      sku: listing.source_product_ref ?? listing.listing_id,
      merchant_id: listing.merchant_id,
      // owner Agent：Direct A2A 磋商（negotiate_buyer_task）的 catalogAgentId 输入。
      owner_agent_id: listing.owner_agent_id,
      // 商家显示名：沟通用名字而非 catalog_agent_id。
      merchant_name: r.merchant.display_name,
    });
    store.updateCandidate(candidate.candidate_id, {
      candidate_status: "shortlisted",
      eligibility: "eligible",
    });
    store.appendEvent(
      task.task_id,
      "candidate_shortlisted",
      {
        candidate_id: candidate.candidate_id,
        listing_id: listing.listing_id,
        owner_agent_id: listing.owner_agent_id,
        listing_title: listing.title,
        source: "kiwi-catalog",
        handoff_destination_types: listing.handoff_destination_types ?? null,
        handoff_destination_ref: listing.handoff_destination_ref ?? null,
      },
      "model",
      `shortlist:${task.task_id}:${listing.listing_id}:${runId}`,
    );
    shortlist.push({ candidate });
  }

  if (shortlist.length > 0) {
    store.appendEvent(
      task.task_id,
      "observation_added",
      { source: "kiwi-catalog", listings: shortlist.length },
      "connector",
      `${runId}:catalog-observations`,
    );
    let current = store.transitionTask({
      task_id: task.task_id,
      to: "shortlist_ready",
      expected_version: task.version,
      event_type: "shortlisted",
      payload: {
        source: "kiwi-catalog",
        candidates: shortlist.map(({ candidate }) => ({
          candidate_id: candidate.candidate_id,
          sku: candidate.sku,
          score: candidate.score ?? null,
        })),
      },
      origin: "scheduler",
      idempotency_key: `${runId}:shortlisted`,
    });
    current = store.transitionTask({
      task_id: task.task_id,
      to: "awaiting_user",
      expected_version: current.version,
      event_type: "status_changed",
      origin: "scheduler",
      idempotency_key: `${runId}:awaiting_user`,
    });
    return { task: current, outcome: "shortlist_ready", shortlist };
  }

  // 无命中：回退 marketplace connector 路径（catalog 是优先源，不是唯一源）。
  return undefined;
}
