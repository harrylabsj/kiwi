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
 * Buyer task scheduler (design §11.7, §13, §18.3).
 *
 * tick() is the deterministic core: it derives all wakeups from the
 * database (next_run_at / next_check_at), so a process restart rebuilds
 * the queue by simply ticking. Budgets bound connector requests per tick;
 * multiple rules hitting one candidate merge into ONE observation and ONE
 * user notification; connector errors classify and reschedule without
 * crashing the tick.
 */

import type { CommerceConnector } from "../connector/types.js";
import { ConnectorError } from "../connector/types.js";
import { observationHash, runSearchCycle } from "./search-loop.js";
import type { BuyerTaskStore } from "./task-store.js";
import type { BuyerTask, ProductObservation, TrackingRule } from "./types.js";
import { BuyerTaskError } from "./types.js";

export interface SchedulerOptions {
  store: BuyerTaskStore;
  connectors: CommerceConnector[];
  now?: () => string;
}

export interface TickBudget {
  max_requests?: number;
  max_rules?: number;
  max_tasks?: number;
}

export interface TickNotification {
  task_id: string;
  candidate_id?: string;
  summary: string;
  rule_ids: string[];
}

export interface TickResult {
  checked_rules: number;
  notifications: TickNotification[];
  tasks_searched: string[];
  tasks_expired: string[];
  errors: string[];
}

const DEFAULT_BUDGET: Required<TickBudget> = { max_requests: 20, max_rules: 50, max_tasks: 5 };

export class TaskScheduler {
  private readonly store: BuyerTaskStore;
  private readonly connectors: Map<string, CommerceConnector>;
  private readonly now: () => string;

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.connectors = new Map(options.connectors.map((c) => [c.connector_id, c]));
    const clock = options.now ?? (() => new Date().toISOString());
    this.now = () => new Date(Date.parse(clock())).toISOString();
  }

  private connectorFor(candidateConnectorId: string): CommerceConnector | undefined {
    return this.connectors.get(candidateConnectorId);
  }

  async tick(budget: TickBudget = {}): Promise<TickResult> {
    const b = { ...DEFAULT_BUDGET, ...budget };
    const now = this.now();
    const result: TickResult = {
      checked_rules: 0,
      notifications: [],
      tasks_searched: [],
      tasks_expired: [],
      errors: [],
    };
    let requests = 0;

    // 1. Expire tracking tasks past their deadline (§11.3: tracking -> expired).
    for (const task of this.store.expirableTasks(now)) {
      try {
        this.store.transitionTask({
          task_id: task.task_id,
          to: "expired",
          expected_version: task.version,
          event_type: "expired",
          origin: "scheduler",
          idempotency_key: `expire:${task.task_id}:${task.expires_at ?? now}`,
        });
        result.tasks_expired.push(task.task_id);
      } catch (err) {
        result.errors.push(`expire ${task.task_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. Due tracking rules, grouped by candidate (merged observe+notify).
    const due = this.store.dueRules(now, b.max_rules);
    const byCandidate = new Map<string, TrackingRule[]>();
    const taskLevel: TrackingRule[] = [];
    for (const rule of due) {
      if (rule.candidate_id === undefined) taskLevel.push(rule);
      else {
        const group = byCandidate.get(rule.candidate_id) ?? [];
        group.push(rule);
        byCandidate.set(rule.candidate_id, group);
      }
    }

    for (const [candidateId, rules] of byCandidate) {
      if (requests >= b.max_requests) break;
      const candidate = this.store.getCandidate(candidateId);
      if (candidate === undefined || candidate.sku === undefined) {
        for (const rule of rules) this.store.markRuleChecked(rule.rule_id, false, now);
        continue;
      }
      const connector = this.connectorFor(candidate.connector_id);
      if (connector === undefined) {
        result.errors.push(`no connector ${candidate.connector_id} for candidate ${candidateId}`);
        continue;
      }
      let observation: ProductObservation | undefined;
      requests += 1;
      // §11.7: observation freshness TTL comes from the task's tracking
      // policy, not a hardcoded 30 minutes.
      const task = this.store.getTask(candidate.task_id);
      const ttlSeconds = task?.tracking_policy.observation_ttl_seconds ?? 1800;
      try {
        const product = await connector.getProduct(candidate.sku);
        const added = this.store.addObservation({
          candidate_id: candidateId,
          observed_at: now,
          source_url_or_ref: `shopping-cli:/products/${product.sku}`,
          title: product.title,
          price: {
            list: product.price,
            currency: product.currency,
            delivery_fee: product.delivery.fee,
          },
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
        });
        if (added.added) {
          this.store.updateCandidate(candidateId, { latest_observation_id: added.observation_id });
        }
        observation = this.store.latestObservation(candidateId);
      } catch (err) {
        // §18.2: a failed read never reuses stale facts; reschedule and report.
        result.errors.push(
          `observe ${candidateId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        for (const rule of rules) this.store.markRuleChecked(rule.rule_id, false, now);
        continue;
      }
      if (observation === undefined) continue;

      const previous = this.store.observations(candidateId, 2)[1];
      const triggered: { rule: TrackingRule; reason: string }[] = [];
      for (const rule of rules) {
        result.checked_rules += 1;
        const inCooldown =
          rule.cooldown_seconds > 0 &&
          rule.last_triggered_at !== undefined &&
          Date.parse(rule.last_triggered_at) + rule.cooldown_seconds * 1000 > Date.parse(now);
        const reason = inCooldown ? undefined : evaluateRule(rule, observation, previous, now);
        if (reason !== undefined) {
          triggered.push({ rule, reason });
          this.store.markRuleChecked(rule.rule_id, true, now);
        } else {
          this.store.markRuleChecked(rule.rule_id, false, now);
        }
      }
      if (triggered.length > 0) {
        // Merged: one notification per candidate per observation (§11.7). The
        // event is keyed by observation_id, so an unchanged fact re-triggering
        // after cooldown does NOT surface a duplicate notification.
        const summary = triggered.map((t) => t.reason).join("；");
        const inserted = this.store.appendEvent(
          rules[0]?.task_id ?? "",
          "notification",
          {
            candidate_id: candidateId,
            rule_ids: triggered.map((t) => t.rule.rule_id),
            summary,
          },
          "scheduler",
          `notify:${candidateId}:${observation.observation_id}`,
        );
        if (inserted) {
          result.notifications.push({
            task_id: rules[0]?.task_id ?? "",
            candidate_id: candidateId,
            summary,
            rule_ids: triggered.map((t) => t.rule.rule_id),
          });
        }
      }
    }

    // 3. Task-level rules (periodic_review / price_below / stock_available)
    //    queue a re-search. 求值在重搜索之后（第 5 步）——任务级规则针对的是
    //    "任务任一候选满足条件"（如默认 price_below 阈值），必须基于本 tick
    //    重搜索产生的新鲜观察，否则条件形同虚设（评审项 H5：此前只
    //    markRuleChecked，条件从未被求值，承诺的"降价/到货通知"静默失效）。
    const searchQueue = new Map<string, BuyerTask>();
    for (const rule of taskLevel) {
      const task = this.store.getTask(rule.task_id);
      if (task !== undefined && task.status === "tracking") {
        searchQueue.set(task.task_id, task);
      } else {
        // 不重搜的任务：仅推进检查时间，避免每 tick 重复入队。
        result.checked_rules += 1;
        this.store.markRuleChecked(rule.rule_id, true, now);
      }
    }

    // 4. Due task wakeups (restart recovery: everything comes from the DB).
    for (const task of this.store.dueTasks(now, b.max_tasks)) {
      searchQueue.set(task.task_id, task);
    }

    let searched = 0;
    for (const task of searchQueue.values()) {
      if (searched >= b.max_tasks) break;
      const connector = this.connectorFor(task.connector_scope.connectors[0] ?? "shopping-cli");
      if (connector === undefined) {
        result.errors.push(`no connector for task ${task.task_id}`);
        continue;
      }
      searched += 1;
      try {
        const before = new Set(
          this.store.listCandidates(task.task_id).map((c) => c.canonical_key),
        );
        const cycle = await runSearchCycle(
          { store: this.store, connector, now: this.now },
          task.task_id,
          `tick:${task.task_id}:${now}`,
        );
        result.tasks_searched.push(task.task_id);
        if (cycle.outcome === "retry" && cycle.error !== undefined) {
          // §18.1 transient failure: runSearchCycle parked the task with a
          // scheduled retry but did NOT throw. Surface it in tick errors so
          // the chat/model can see the task is retrying — otherwise a
          // persistently down gateway looks like a silently stalled task.
          result.errors.push(
            `search ${task.task_id}: ${cycle.error}（已安排自动重试）`,
          );
        }
        const newOnes = this.store
          .listCandidates(task.task_id)
          .filter((c) => !before.has(c.canonical_key));
        if (newOnes.length > 0) {
          const inserted = this.store.appendEvent(
            task.task_id,
            "notification",
            {
              summary: `发现 ${newOnes.length} 个新候选`,
              new_candidates: newOnes.map((c) => c.candidate_id),
            },
            "scheduler",
            `notify:${task.task_id}:new:${now}`,
          );
          if (inserted) {
            result.notifications.push({
              task_id: task.task_id,
              summary: `发现 ${newOnes.length} 个新候选`,
              rule_ids: [],
            });
          }
        }
        void cycle;
      } catch (err) {
        if (err instanceof BuyerTaskError || err instanceof ConnectorError) {
          result.errors.push(`search ${task.task_id}: ${err.message}`);
        } else {
          result.errors.push(
            `search ${task.task_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // 5. Task-level rules evaluated against this tick's fresh observations
    //    （评审项 H5 修复）：只对本 tick 实际重搜过的任务求值——重搜写入了
    //    新观察，规则看到的是当前事实。任一候选满足条件即触发（任务级
    //    price_below 的阈值是全任务预算；stock_available 同理）。通知按
    //    (task_id, rule_id, 触发观察) 去重——观察未变时不重复打扰用户。
    const searchedTasks = new Set(result.tasks_searched);
    for (const rule of taskLevel) {
      if (!searchedTasks.has(rule.task_id)) continue;
      const task = this.store.getTask(rule.task_id);
      if (task === undefined) continue;
      result.checked_rules += 1;
      let triggeredReason: string | undefined;
      let triggerObservationId: string | undefined;
      for (const candidate of this.store.listCandidates(rule.task_id)) {
        if (candidate.sku === undefined) continue;
        const observation = this.store.latestObservation(candidate.candidate_id);
        if (observation === undefined) continue;
        const previous = this.store.observations(candidate.candidate_id, 2)[1];
        const inCooldown =
          rule.cooldown_seconds > 0 &&
          rule.last_triggered_at !== undefined &&
          Date.parse(rule.last_triggered_at) + rule.cooldown_seconds * 1000 > Date.parse(now);
        const reason = inCooldown ? undefined : evaluateRule(rule, observation, previous, now);
        if (reason !== undefined) {
          triggeredReason = reason;
          triggerObservationId = observation.observation_id;
          break;
        }
      }
      if (triggeredReason === undefined || triggerObservationId === undefined) {
        this.store.markRuleChecked(rule.rule_id, false, now);
        continue;
      }
      this.store.markRuleChecked(rule.rule_id, true, now);
      const inserted = this.store.appendEvent(
        rule.task_id,
        "notification",
        {
          rule_ids: [rule.rule_id],
          summary: triggeredReason,
        },
        "scheduler",
        `notify:${rule.task_id}:${rule.rule_id}:${triggerObservationId}`,
      );
      if (inserted) {
        result.notifications.push({
          task_id: rule.task_id,
          summary: triggeredReason,
          rule_ids: [rule.rule_id],
        });
      }
    }

    return result;
  }
}

/** Evaluate one rule against the latest facts. Returns a reason when triggered. */
function evaluateRule(
  rule: TrackingRule,
  latest: ProductObservation,
  previous: ProductObservation | undefined,
  now: string,
): string | undefined {
  switch (rule.rule_type) {
    case "price_below": {
      const threshold = Number(rule.condition.threshold);
      if (!Number.isFinite(threshold)) return undefined;
      const total = latest.price.list + latest.price.delivery_fee;
      return total <= threshold
        ? `到手价 ${total} ${latest.price.currency} 已低于 ${threshold}`
        : undefined;
    }
    case "stock_available":
      return latest.stock.quantity > 0 ? `已到货（库存 ${latest.stock.quantity}）` : undefined;
    case "delivery_before": {
      const before = typeof rule.condition.eta_before === "string" ? rule.condition.eta_before : "";
      if (before === "") return undefined;
      const etaMinutes = Number((latest.delivery as { eta_minutes?: number }).eta_minutes ?? 0);
      return Date.parse(now) + etaMinutes * 60_000 <= Date.parse(before)
        ? `可在 ${before} 前送达`
        : undefined;
    }
    default:
      return undefined;
  }
}
