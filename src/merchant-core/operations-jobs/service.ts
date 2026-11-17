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
 * TOP3 经营任务（设计 v1.1 §13–§16 / M4）。
 *
 * - EventInbox：同 ID 同摘要幂等、异摘要冲突；旧版本不覆盖新状态。
 * - prepareRule 双模式只返回候选（requires_confirmation=true）；activate 才
 *   创建不可变规则版本；暂停递增 enable_epoch 并取消未提交任务。
 * - 调度：next_due_at 是唯一到期依据；内存 timer 只唤醒。评估 no_change
 *   不调用模型；eligible 在同一事务内写评估 + 创建任务；预算不足保持
 *   PENDING/记录 budget_exhausted。
 * - 执行：CAS 领取（READY→RUNNING + fencing/attempt），commitInternalResult
 *   在同一事务写唯一产物、结束 attempt、更新任务、保存 receipt；旧 worker
 *   或失效快照不能提交。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { contentDigest } from "../../negotiation/jcs.js";
import { BackgroundBudgetStore, BackgroundBudgetError } from "../budget/background-budget.js";
import { inImmediateTransaction } from "../storage/transaction.js";

export type OperationsJobsErrorCode =
  | "validation"
  | "not_found"
  | "conflict"
  | "version_conflict"
  | "invalid_transition"
  | "budget_exhausted"
  | "idempotency_conflict";

export class OperationsJobsError extends Error {
  readonly code: OperationsJobsErrorCode;
  readonly reason: string;

  constructor(code: OperationsJobsErrorCode, reason: string, message: string) {
    super(message);
    this.name = "OperationsJobsError";
    this.code = code;
    this.reason = reason;
  }
}

export const RULE_TEMPLATES = [
  "unfinished_inquiry_digest",
  "missing_info_draft",
  "quote_expiry_review",
  "data_availability_check",
] as const;
export type RuleTemplate = (typeof RULE_TEMPLATES)[number];

export const RULE_ACTION_TYPES = [
  "internal_summary",
  "internal_draft",
  "merchant_todo",
] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];

export type RuleState = "ACTIVE" | "PAUSED";

export interface RuleTriggerSpec {
  readonly kind: "daily_local";
  readonly local_time: string;
  readonly timezone: string;
}

export interface RuleScopeSpec {
  readonly sku?: string;
  readonly status?: string;
  readonly window: "previous_local_day" | "last_7_days";
}

export interface RulePredicateSpec {
  readonly kind: "fixed_template";
  readonly template: RuleTemplate;
  readonly threshold?: number;
}

export interface RuleBudgetSpec {
  readonly max_runs_per_day: number;
}

export interface AutomationRule {
  readonly rule_id: string;
  readonly merchant_id: string;
  readonly version: number;
  readonly template: RuleTemplate;
  readonly trigger_spec: RuleTriggerSpec;
  readonly timezone: string;
  readonly scope: RuleScopeSpec;
  readonly predicate_spec: RulePredicateSpec;
  readonly action_type: RuleActionType;
  readonly budget: RuleBudgetSpec;
  readonly authorization_ref: string | null;
  readonly effective_at: string;
  readonly expires_at: string;
  readonly content_hash: string;
  readonly state: RuleState;
  readonly enable_epoch: number;
  readonly next_due_at: string | null;
  readonly missed_count: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RuleCandidate {
  readonly candidate_ref: string;
  readonly merchant_id: string;
  readonly mode: "template" | "goal";
  readonly template: RuleTemplate;
  readonly trigger_spec: RuleTriggerSpec;
  readonly timezone: string;
  readonly scope: RuleScopeSpec;
  readonly predicate_spec: RulePredicateSpec;
  readonly action_type: RuleActionType;
  readonly budget: RuleBudgetSpec;
  readonly goal_text: string | null;
  readonly content_hash: string;
  readonly requires_confirmation: true;
  readonly created_at: string;
}

export type EvaluationOutcome =
  | "no_change"
  | "blocked"
  | "eligible"
  | "superseded"
  | "data_incomplete";

export interface PrefilterResult {
  readonly result: EvaluationOutcome;
  readonly reason_code?: string;
  readonly window_start?: string;
  readonly window_end?: string;
  readonly detail?: Record<string, unknown>;
}

export interface RuleEvaluation {
  readonly evaluation_id: string;
  readonly merchant_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly trigger_key: string;
  readonly result: EvaluationOutcome;
  readonly reason_code: string | null;
  readonly window_start: string | null;
  readonly window_end: string | null;
  readonly detail: Record<string, unknown>;
  readonly evaluated_at: string;
}

export interface ClaimedTask {
  readonly task_id: string;
  readonly merchant_id: string;
  readonly rule_id: string | null;
  readonly rule_version: number | null;
  readonly status: string;
  readonly due_at: string | null;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly fencing_token: number;
  readonly revision: number;
  readonly cancel_epoch: number;
  readonly deadline_at: string | null;
  readonly snapshot_digest: string | null;
  readonly payload: Record<string, unknown>;
}

export interface InternalResultCommit {
  readonly receipt_ref: string;
  readonly artifact_id: string;
  readonly task_id: string;
  readonly result_kind: string;
  readonly content_digest: string;
}

const MAX_EVENT_DIGEST_CHARS = 128;
const DEFAULT_RUN_DEADLINE_MS = 30_000;

function text(value: string, field: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new OperationsJobsError("validation", `${field}_invalid`, `${field} 必须是 1..${max} 字符`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new OperationsJobsError("validation", `${field}_invalid`, `${field} 含控制字符`);
  }
  return value;
}

function nowUtc(now: () => string): string {
  const ms = Date.parse(now());
  if (!Number.isFinite(ms)) {
    throw new OperationsJobsError("validation", "now_invalid", "时钟输出必须是可解析的 RFC3339 时间");
  }
  return new Date(ms).toISOString();
}

function localParts(ms: number, timezone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(ms));
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: pick("year"), month: pick("month"), day: pick("day") };
}

function zoneOffsetMs(ms: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(ms));
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    pick("year"),
    pick("month") - 1,
    pick("day"),
    pick("hour"),
    pick("minute"),
    pick("second"),
  );
  return asUtc - ms;
}

/** 下一次本地 daily 时间（60 秒粒度）；夏令时/时区变更靠重算 offset 收敛。 */
export function nextDailyDueAt(input: {
  now: string;
  local_time: string;
  timezone: string;
}): string {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input.local_time);
  if (match === null) {
    throw new OperationsJobsError("validation", "local_time_invalid", "local_time 必须是 HH:MM");
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: input.timezone }).format(new Date());
  } catch {
    throw new OperationsJobsError("validation", "timezone_invalid", "无法识别的时区");
  }
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) {
    throw new OperationsJobsError("validation", "now_invalid", "now 必须是 RFC3339");
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const local = localParts(nowMs + dayOffset * 24 * 60 * 60 * 1000, input.timezone);
    let guess = Date.UTC(local.year, local.month - 1, local.day, hour, minute, 0);
    // 两次校正覆盖 offset 在目标时刻与 guess 时刻不同的边界。
    for (let attempt = 0; attempt < 2; attempt++) {
      const offset = zoneOffsetMs(guess, input.timezone);
      guess = Date.UTC(local.year, local.month - 1, local.day, hour, minute, 0) - offset;
    }
    if (guess > nowMs) return new Date(guess).toISOString();
  }
  throw new OperationsJobsError("validation", "next_due_unresolved", "无法计算下一次到期时间");
}

export interface OperationsJobsServiceOptions {
  db: DatabaseSync;
  now: () => string;
  budgetStore?: BackgroundBudgetStore;
}

export class OperationsJobsService {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly budgetStore?: BackgroundBudgetStore;

  constructor(options: OperationsJobsServiceOptions) {
    this.db = options.db;
    this.now = options.now;
    this.budgetStore = options.budgetStore;
  }

  ingestTrustedEvent(input: {
    merchant_id: string;
    source_scope: string;
    external_event_id: string;
    payload_digest: string;
    entity_ref: string;
    source_version?: string;
    occurred_at: string;
    received_at?: string;
    evidence_ref?: string;
  }): { status: "accepted" | "duplicate" | "superseded"; inbox_id: string } {
    const merchantId = text(input.merchant_id, "merchant_id");
    const sourceScope = text(input.source_scope, "source_scope", 64);
    const externalId = text(input.external_event_id, "external_event_id", 128);
    const digest = text(input.payload_digest, "payload_digest", MAX_EVENT_DIGEST_CHARS);
    const entityRef = text(input.entity_ref, "entity_ref");
    const occurredAt = text(input.occurred_at, "occurred_at", 64);
    const receivedAt = input.received_at ?? nowUtc(this.now);
    return inImmediateTransaction(this.db, () => {
      const existing = this.db
        .prepare(
          `SELECT inbox_id, payload_digest, source_version FROM event_inbox
            WHERE merchant_id = ? AND source_scope = ? AND external_event_id = ?`,
        )
        .get(merchantId, sourceScope, externalId) as
        | { inbox_id: string; payload_digest: string; source_version: string | null }
        | undefined;
      if (existing !== undefined) {
        if (existing.payload_digest !== digest) {
          throw new OperationsJobsError(
            "conflict",
            "event_payload_conflict",
            "同一来源事件 ID 的摘要不同；保留原记录等待核验",
          );
        }
        return { status: "duplicate", inbox_id: existing.inbox_id };
      }
      const inboxId = `evt_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO event_inbox
            (inbox_id, merchant_id, source_scope, external_event_id, payload_digest,
             entity_ref, source_version, occurred_at, received_at, evidence_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          inboxId,
          merchantId,
          sourceScope,
          externalId,
          digest,
          entityRef,
          input.source_version ?? null,
          occurredAt,
          receivedAt,
          input.evidence_ref ?? null,
          receivedAt,
        );
      return { status: "accepted", inbox_id: inboxId };
    });
  }

  prepareRule(input: {
    merchant_id: string;
    mode: "template" | "goal";
    template: RuleTemplate;
    trigger_spec: RuleTriggerSpec;
    scope: RuleScopeSpec;
    predicate_spec: RulePredicateSpec;
    action_type: RuleActionType;
    budget: RuleBudgetSpec;
    goal_text?: string;
  }): RuleCandidate {
    const merchantId = text(input.merchant_id, "merchant_id");
    if (!(RULE_TEMPLATES as readonly string[]).includes(input.template)) {
      throw new OperationsJobsError("validation", "template_invalid", "未知规则模板");
    }
    if (!(RULE_ACTION_TYPES as readonly string[]).includes(input.action_type)) {
      throw new OperationsJobsError("validation", "action_type_invalid", "未知动作类型");
    }
    if (input.mode !== "template" && input.mode !== "goal") {
      throw new OperationsJobsError("validation", "mode_invalid", "mode 只能是 template/goal");
    }
    if (input.trigger_spec.kind !== "daily_local") {
      throw new OperationsJobsError("validation", "trigger_invalid", "P0 只支持 daily_local");
    }
    nextDailyDueAt({
      now: nowUtc(this.now),
      local_time: input.trigger_spec.local_time,
      timezone: input.trigger_spec.timezone,
    });
    if (input.scope.window !== "previous_local_day" && input.scope.window !== "last_7_days") {
      throw new OperationsJobsError("validation", "scope_invalid", "未知窗口");
    }
    if (input.predicate_spec.kind !== "fixed_template") {
      throw new OperationsJobsError("validation", "predicate_invalid", "只允许固定模板 predicate");
    }
    if (
      !Number.isSafeInteger(input.budget.max_runs_per_day) ||
      input.budget.max_runs_per_day < 1 ||
      input.budget.max_runs_per_day > 20
    ) {
      throw new OperationsJobsError("validation", "budget_invalid", "max_runs_per_day 必须在 1..20");
    }
    const goalText =
      input.goal_text === undefined ? null : text(input.goal_text, "goal_text", 500);
    const stamp = nowUtc(this.now);
    const contentHash = contentDigest({
      kind: "automation.rule",
      mode: input.mode,
      template: input.template,
      trigger: input.trigger_spec,
      scope: input.scope,
      predicate: input.predicate_spec,
      action_type: input.action_type,
      budget: input.budget,
      goal_text: goalText,
    });
    const candidateRef = `rulec_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO automation_rule_candidates
          (candidate_ref, merchant_id, mode, template, trigger_spec_json, timezone,
           scope_json, predicate_spec_json, action_type, budget_json, goal_text,
           content_hash, requires_confirmation, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)`,
      )
      .run(
        candidateRef,
        merchantId,
        input.mode,
        input.template,
        JSON.stringify(input.trigger_spec),
        input.trigger_spec.timezone,
        JSON.stringify(input.scope),
        JSON.stringify(input.predicate_spec),
        input.action_type,
        JSON.stringify(input.budget),
        goalText,
        contentHash,
        stamp,
      );
    return {
      candidate_ref: candidateRef,
      merchant_id: merchantId,
      mode: input.mode,
      template: input.template,
      trigger_spec: input.trigger_spec,
      timezone: input.trigger_spec.timezone,
      scope: input.scope,
      predicate_spec: input.predicate_spec,
      action_type: input.action_type,
      budget: input.budget,
      goal_text: goalText,
      content_hash: contentHash,
      requires_confirmation: true,
      created_at: stamp,
    };
  }

  activateRule(input: {
    merchant_id: string;
    candidate_ref: string;
    expected_generation?: number;
  }): AutomationRule {
    const merchantId = text(input.merchant_id, "merchant_id");
    const candidateRef = text(input.candidate_ref, "candidate_ref");
    return inImmediateTransaction(this.db, () => {
      const candidate = this.db
        .prepare(
          "SELECT * FROM automation_rule_candidates WHERE merchant_id = ? AND candidate_ref = ?",
        )
        .get(merchantId, candidateRef) as
        | {
            template: RuleTemplate;
            trigger_spec_json: string;
            timezone: string;
            scope_json: string;
            predicate_spec_json: string;
            action_type: RuleActionType;
            budget_json: string;
            content_hash: string;
            consumed_at: string | null;
          }
        | undefined;
      if (candidate === undefined) {
        throw new OperationsJobsError("not_found", "candidate_not_found", "规则候选不存在或不可见");
      }
      if (candidate.consumed_at !== null) {
        throw new OperationsJobsError("conflict", "candidate_consumed", "规则候选已启用");
      }
      const stamp = nowUtc(this.now);
      const trigger = JSON.parse(candidate.trigger_spec_json) as RuleTriggerSpec;
      const nextDue = nextDailyDueAt({
        now: stamp,
        local_time: trigger.local_time,
        timezone: trigger.timezone,
      });
      const rule: AutomationRule = {
        rule_id: `rule_${randomUUID()}`,
        merchant_id: merchantId,
        version: 1,
        template: candidate.template,
        trigger_spec: trigger,
        timezone: candidate.timezone,
        scope: JSON.parse(candidate.scope_json) as RuleScopeSpec,
        predicate_spec: JSON.parse(candidate.predicate_spec_json) as RulePredicateSpec,
        action_type: candidate.action_type,
        budget: JSON.parse(candidate.budget_json) as RuleBudgetSpec,
        authorization_ref: null,
        effective_at: stamp,
        expires_at: new Date(Date.parse(stamp) + 365 * 24 * 60 * 60 * 1000).toISOString(),
        content_hash: candidate.content_hash,
        state: "ACTIVE",
        enable_epoch: 1,
        next_due_at: nextDue,
        missed_count: 0,
        created_at: stamp,
        updated_at: stamp,
      };
      this.db
        .prepare(
          `INSERT INTO automation_rules
            (rule_id, merchant_id, version, template, trigger_spec_json, timezone,
             scope_json, predicate_spec_json, action_type, budget_json, authorization_ref,
             effective_at, expires_at, content_hash, state, enable_epoch, next_due_at,
             missed_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'ACTIVE', 1, ?, 0, ?, ?)`,
        )
        .run(
          rule.rule_id,
          merchantId,
          rule.version,
          rule.template,
          JSON.stringify(rule.trigger_spec),
          rule.timezone,
          JSON.stringify(rule.scope),
          JSON.stringify(rule.predicate_spec),
          rule.action_type,
          JSON.stringify(rule.budget),
          rule.effective_at,
          rule.expires_at,
          rule.content_hash,
          rule.next_due_at,
          stamp,
          stamp,
        );
      this.db
        .prepare(
          "UPDATE automation_rule_candidates SET consumed_at = ? WHERE merchant_id = ? AND candidate_ref = ?",
        )
        .run(stamp, merchantId, candidateRef);
      return rule;
    });
  }

  pauseRule(input: {
    merchant_id: string;
    rule_id: string;
    expected_version: number;
    reason: string;
  }): AutomationRule {
    const merchantId = text(input.merchant_id, "merchant_id");
    const ruleId = text(input.rule_id, "rule_id");
    return inImmediateTransaction(this.db, () => {
      const stamp = nowUtc(this.now);
      const rule = this.requireRule(merchantId, ruleId);
      if (rule.version !== input.expected_version) {
        throw new OperationsJobsError("version_conflict", "rule_version_mismatch", "规则版本已变化");
      }
      if (rule.state !== "PAUSED") {
        this.db
          .prepare(
            `UPDATE automation_rules SET state = 'PAUSED', enable_epoch = enable_epoch + 1,
                    next_due_at = NULL, updated_at = ?
              WHERE merchant_id = ? AND rule_id = ?`,
          )
          .run(stamp, merchantId, ruleId);
        this.db
          .prepare(
            `UPDATE followup_tasks SET status = 'CANCELLED', cancel_epoch = cancel_epoch + 1,
                    revision = revision + 1, lease_owner = NULL, lease_expires_at = NULL,
                    updated_at = ?
              WHERE merchant_id = ? AND rule_id = ? AND status IN ('PENDING','READY')`,
          )
          .run(stamp, merchantId, ruleId);
      }
      return this.requireRule(merchantId, ruleId);
    });
  }

  listRules(merchantId: string): AutomationRule[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM automation_rules WHERE merchant_id = ? ORDER BY created_at DESC",
        )
        .all(text(merchantId, "merchant_id")) as unknown as RuleRow[]
    ).map(toRule);
  }

  getRule(merchantId: string, ruleId: string): AutomationRule | undefined {
    const row = this.db
      .prepare("SELECT * FROM automation_rules WHERE merchant_id = ? AND rule_id = ?")
      .get(text(merchantId, "merchant_id"), text(ruleId, "rule_id")) as unknown as
      | RuleRow
      | undefined;
    return row === undefined ? undefined : toRule(row);
  }

  /**
   * 评估到期规则。prefilter 缺失时记为 data_incomplete（不伪造 no_change）。
   * eligible 在同事务写评估 + 创建 READY 任务；预算不足只记 blocked。
   */
  evaluateDue(input: {
    merchant_id: string;
    prefilter?: (rule: AutomationRule) => PrefilterResult;
    now?: string;
  }): RuleEvaluation[] {
    const merchantId = text(input.merchant_id, "merchant_id");
    const stamp = input.now ?? nowUtc(this.now);
    const due = this.db
      .prepare(
        `SELECT * FROM automation_rules
          WHERE merchant_id = ? AND state = 'ACTIVE' AND next_due_at IS NOT NULL
            AND next_due_at <= ?`,
      )
      .all(merchantId, stamp) as unknown as RuleRow[];
    const evaluations: RuleEvaluation[] = [];
    for (const row of due) {
      const rule = toRule(row);
      const triggerKey = `${rule.rule_id}:${rule.version}:${rule.next_due_at}`;
      const existing = this.db
        .prepare(
          `SELECT * FROM rule_evaluations
            WHERE merchant_id = ? AND rule_id = ? AND rule_version = ? AND trigger_key = ?`,
        )
        .get(merchantId, rule.rule_id, rule.version, triggerKey) as unknown as
        | EvaluationRow
        | undefined;
      if (existing !== undefined) {
        this.advanceRule(rule, stamp);
        evaluations.push(toEvaluation(existing));
        continue;
      }
      const evaluated =
        input.prefilter === undefined
          ? {
              result: "data_incomplete" as const,
              reason_code: "prefilter_unavailable",
              detail: { missing: "projection" },
            }
          : input.prefilter(rule);
      const evaluation = inImmediateTransaction(this.db, () => {
        const evaluationId = `reval_${randomUUID()}`;
        const detail = {
          ...(evaluated.detail ?? {}),
          content_hash: rule.content_hash,
          next_due_at: rule.next_due_at,
        };
        let finalResult = evaluated.result;
        let finalReason = evaluated.reason_code ?? null;
        if (evaluated.result === "eligible" || evaluated.result === "data_incomplete") {
          try {
            this.enqueueEligibleTask(rule, triggerKey, detail, stamp);
          } catch (err) {
            if (err instanceof OperationsJobsError && err.code === "budget_exhausted") {
              finalResult = "blocked";
              finalReason = err.reason;
            } else {
              throw err;
            }
          }
        }
        this.db
          .prepare(
            `INSERT INTO rule_evaluations
              (evaluation_id, merchant_id, rule_id, rule_version, trigger_key, result,
               reason_code, window_start, window_end, detail_json, evaluated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            evaluationId,
            merchantId,
            rule.rule_id,
            rule.version,
            triggerKey,
            finalResult,
            finalReason,
            evaluated.window_start ?? null,
            evaluated.window_end ?? null,
            JSON.stringify(detail),
            stamp,
          );
        this.advanceRule(rule, stamp);
        return toEvaluation({
          evaluation_id: evaluationId,
          merchant_id: merchantId,
          rule_id: rule.rule_id,
          rule_version: rule.version,
          trigger_key: triggerKey,
          result: finalResult,
          reason_code: finalReason,
          window_start: evaluated.window_start ?? null,
          window_end: evaluated.window_end ?? null,
          detail_json: JSON.stringify(detail),
          evaluated_at: stamp,
        });
      });
      evaluations.push(evaluation);
    }
    return evaluations;
  }

  /** CAS 领取一个到期 READY 任务；创建 RUNNING attempt 并记录 worker/fencing。 */
  claimDue(input: {
    merchant_id: string;
    worker_id: string;
    lease_ms?: number;
    now?: string;
  }): ClaimedTask | undefined {
    const merchantId = text(input.merchant_id, "merchant_id");
    const workerId = text(input.worker_id, "worker_id");
    const leaseMs = input.lease_ms ?? 60_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new OperationsJobsError("validation", "lease_invalid", "lease_ms 必须是正整数");
    }
    return inImmediateTransaction(this.db, () => {
      const stamp = input.now ?? nowUtc(this.now);
      // 退避后的 PENDING 到期即提升为 READY（next_due_at/due_at 是唯一依据）。
      this.db
        .prepare(
          `UPDATE followup_tasks SET status = 'READY', updated_at = ?
            WHERE merchant_id = ? AND status = 'PENDING'
              AND due_at IS NOT NULL AND due_at <= ?`,
        )
        .run(stamp, merchantId, stamp);
      const task = this.db
        .prepare(
          `SELECT * FROM followup_tasks
            WHERE merchant_id = ? AND status = 'READY'
              AND (due_at IS NULL OR due_at <= ?)
              AND (deadline_at IS NULL OR deadline_at > ?)
            ORDER BY due_at ASC, created_at ASC LIMIT 1`,
        )
        .get(merchantId, stamp, stamp) as unknown as TaskRow | undefined;
      if (task === undefined) return undefined;
      const expires = new Date(Date.parse(stamp) + leaseMs).toISOString();
      const updated = this.db
        .prepare(
          `UPDATE followup_tasks
              SET status = 'RUNNING', lease_owner = ?, lease_expires_at = ?,
                  fencing_token = fencing_token + 1, attempts = attempts + 1, updated_at = ?
            WHERE merchant_id = ? AND task_id = ? AND status = 'READY'`,
        )
        .run(workerId, expires, stamp, merchantId, task.task_id);
      if (Number(updated.changes) !== 1) return undefined;
      const fresh = this.db
        .prepare("SELECT * FROM followup_tasks WHERE merchant_id = ? AND task_id = ?")
        .get(merchantId, task.task_id) as unknown as TaskRow;
      this.db
        .prepare(
          `INSERT INTO followup_attempts
            (attempt_id, task_id, merchant_id, attempt_no, status, started_at, worker_id,
             fencing, input_snapshot_digest)
           VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?)`,
        )
        .run(
          `att_${randomUUID()}`,
          task.task_id,
          merchantId,
          fresh.attempts,
          stamp,
          workerId,
          fresh.fencing_token,
          fresh.snapshot_digest,
        );
      return toClaimed(fresh);
    });
  }

  /**
   * 原子提交内部结果：校验 owner/fencing/revision/cancel_epoch/租约/截止/规则；
   * 唯一产物 + attempt 回执 + 任务 SUCCEEDED 同事务；重复提交返回原回执。
   */
  commitInternalResult(input: {
    merchant_id: string;
    task_id: string;
    worker_id: string;
    fencing: number;
    expected_revision: number;
    expected_cancel_epoch: number;
    result_kind: string;
    payload: Record<string, unknown>;
    usage?: { input: number; output: number };
    now?: string;
  }): InternalResultCommit {
    const merchantId = text(input.merchant_id, "merchant_id");
    const taskId = text(input.task_id, "task_id");
    const workerId = text(input.worker_id, "worker_id");
    const resultKind = text(input.result_kind, "result_kind", 64);
    return inImmediateTransaction(this.db, () => {
      const stamp = input.now ?? nowUtc(this.now);
      const existing = this.db
        .prepare(
          `SELECT receipt_ref, artifact_id, content_digest FROM operation_artifacts
            WHERE merchant_id = ? AND task_id = ? AND result_kind = ?`,
        )
        .get(merchantId, taskId, resultKind) as
        | { receipt_ref: string; artifact_id: string; content_digest: string }
        | undefined;
      const digest = contentDigest({ result_kind: resultKind, payload: input.payload });
      if (existing !== undefined) {
        if (existing.content_digest !== digest) {
          throw new OperationsJobsError(
            "idempotency_conflict",
            "artifact_digest_conflict",
            "同一结果类型已提交不同内容",
          );
        }
        return {
          receipt_ref: existing.receipt_ref,
          artifact_id: existing.artifact_id,
          task_id: taskId,
          result_kind: resultKind,
          content_digest: digest,
        };
      }
      const task = this.db
        .prepare("SELECT * FROM followup_tasks WHERE merchant_id = ? AND task_id = ?")
        .get(merchantId, taskId) as unknown as TaskRow | undefined;
      if (task === undefined) {
        throw new OperationsJobsError("not_found", "task_not_found", "任务不存在或不可见");
      }
      if (
        task.status !== "RUNNING" ||
        task.lease_owner !== workerId ||
        task.fencing_token !== input.fencing ||
        task.revision !== input.expected_revision ||
        task.cancel_epoch !== input.expected_cancel_epoch ||
        task.stop_requested === 1
      ) {
        throw new OperationsJobsError(
          "invalid_transition",
          "commit_guard_failed",
          "提交者、fencing、revision 或取消标记已变化",
        );
      }
      if (task.lease_expires_at === null || task.lease_expires_at <= stamp) {
        throw new OperationsJobsError("invalid_transition", "lease_expired", "租约已过期");
      }
      if (task.deadline_at !== null && task.deadline_at <= stamp) {
        throw new OperationsJobsError("invalid_transition", "deadline_exceeded", "已超过运行截止");
      }
      if (task.rule_id !== null) {
        const rule = this.db
          .prepare("SELECT state, version FROM automation_rules WHERE merchant_id = ? AND rule_id = ?")
          .get(merchantId, task.rule_id) as { state: string; version: number } | undefined;
        if (
          rule === undefined ||
          rule.state !== "ACTIVE" ||
          (task.rule_version !== null && rule.version !== task.rule_version)
        ) {
          throw new OperationsJobsError(
            "invalid_transition",
            "rule_changed",
            "规则已暂停或版本变化",
          );
        }
      }
      const artifactId = `art_${randomUUID()}`;
      const receiptRef = `rcpt_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO operation_artifacts
            (artifact_id, merchant_id, task_id, result_kind, content_digest,
             payload_json, receipt_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifactId,
          merchantId,
          taskId,
          resultKind,
          digest,
          JSON.stringify(input.payload),
          receiptRef,
          stamp,
        );
      this.db
        .prepare(
          `INSERT INTO operation_receipts
            (receipt_ref, merchant_id, task_id, result_kind, content_digest, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(receiptRef, merchantId, taskId, resultKind, digest, stamp);
      this.db
        .prepare(
          `UPDATE followup_tasks
              SET status = 'SUCCEEDED', revision = revision + 1, lease_owner = NULL,
                  lease_expires_at = NULL, updated_at = ?
            WHERE merchant_id = ? AND task_id = ?`,
        )
        .run(stamp, merchantId, taskId);
      this.db
        .prepare(
          `UPDATE followup_attempts
              SET status = 'SUCCEEDED', ended_at = ?, receipt_json = ?, outcome_evidence_json = ?
            WHERE merchant_id = ? AND task_id = ? AND attempt_no = ?`,
        )
        .run(
          stamp,
          JSON.stringify({ receipt_ref: receiptRef, artifact_id: artifactId }),
          JSON.stringify(input.payload.evidence ?? {}),
          merchantId,
          taskId,
          task.attempts,
        );
      if (task.operation_ref !== null && this.budgetStore !== undefined) {
        try {
          this.budgetStore.settleRun({
            merchant_id: merchantId,
            run_id: task.operation_ref,
            input_tokens: input.usage?.input ?? 0,
            output_tokens: input.usage?.output ?? 0,
            usage_state: input.usage === undefined ? "unknown" : "known",
          });
        } catch {
          // 预算对账失败不回滚已提交的业务结果；运行记录保留可重试。
        }
      }
      return {
        receipt_ref: receiptRef,
        artifact_id: artifactId,
        task_id: taskId,
        result_kind: resultKind,
        content_digest: digest,
      };
    });
  }

  /** FAILED 且仍可重试：持久化退避后的 due_at，回到 PENDING。 */
  retryTask(input: {
    merchant_id: string;
    task_id: string;
    backoff_ms?: number;
    now?: string;
  }): void {
    const merchantId = text(input.merchant_id, "merchant_id");
    const taskId = text(input.task_id, "task_id");
    const backoffMs = input.backoff_ms ?? 15_000;
    const stamp = input.now ?? nowUtc(this.now);
    const dueAt = new Date(Date.parse(stamp) + backoffMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE followup_tasks
            SET status = 'PENDING', due_at = ?, revision = revision + 1,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE merchant_id = ? AND task_id = ? AND status = 'FAILED'
            AND attempts < max_attempts`,
      )
      .run(dueAt, stamp, merchantId, taskId);
    if (Number(result.changes) !== 1) {
      throw new OperationsJobsError(
        "invalid_transition",
        "retry_not_allowed",
        "任务状态或重试次数不允许重试",
      );
    }
  }

  listArtifacts(merchantId: string, taskId?: string): Array<{
    artifact_id: string;
    task_id: string;
    result_kind: string;
    content_digest: string;
    receipt_ref: string;
    created_at: string;
    payload: Record<string, unknown>;
  }> {
    const rows = (
      taskId === undefined
        ? this.db
            .prepare(
              "SELECT * FROM operation_artifacts WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 200",
            )
            .all(text(merchantId, "merchant_id"))
        : this.db
            .prepare(
              "SELECT * FROM operation_artifacts WHERE merchant_id = ? AND task_id = ? ORDER BY created_at DESC",
            )
            .all(text(merchantId, "merchant_id"), text(taskId, "task_id"))
    ) as unknown as Array<{
      artifact_id: string;
      task_id: string;
      result_kind: string;
      content_digest: string;
      receipt_ref: string;
      created_at: string;
      payload_json: string;
    }>;
    return rows.map((row) => ({
      artifact_id: row.artifact_id,
      task_id: row.task_id,
      result_kind: row.result_kind,
      content_digest: row.content_digest,
      receipt_ref: row.receipt_ref,
      created_at: row.created_at,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  }

  private requireRule(merchantId: string, ruleId: string): AutomationRule {
    const rule = this.getRule(merchantId, ruleId);
    if (rule === undefined) {
      throw new OperationsJobsError("not_found", "rule_not_found", "规则不存在或不可见");
    }
    return rule;
  }

  private enqueueEligibleTask(
    rule: AutomationRule,
    triggerKey: string,
    detail: Record<string, unknown>,
    stamp: string,
  ): void {
    const taskId = `fu_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    if (this.budgetStore !== undefined) {
      try {
        this.budgetStore.reserveRun({
          merchant_id: rule.merchant_id,
          run_id: runId,
          day_key: stamp.slice(0, 10),
          template: rule.template,
        });
      } catch (err) {
        if (err instanceof BackgroundBudgetError) {
          throw new OperationsJobsError(
            "budget_exhausted",
            `budget:${err.reason}`,
            "后台预算不足；任务保持待处理",
          );
        }
        throw err;
      }
    }
    const deadlineAt = new Date(Date.parse(stamp) + DEFAULT_RUN_DEADLINE_MS).toISOString();
    this.db
      .prepare(
        `INSERT INTO followup_tasks
          (task_id, merchant_id, opportunity_id, trigger_event, action_type, target_version,
           status, due_at, attempts, max_attempts, fencing_token, external_call_started,
           stop_requested, idempotency_key, payload_json, rule_id, rule_version, revision,
           cancel_epoch, deadline_at, snapshot_digest, candidate_ref, operation_ref,
           created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, NULL, 'READY', ?, 0, 3, 0, 0, 0, ?, ?, ?, ?, 1, 0, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        taskId,
        rule.merchant_id,
        `automation:${rule.template}`,
        rule.action_type,
        stamp,
        `rule:${triggerKey}`,
        JSON.stringify({ rule_id: rule.rule_id, rule_version: rule.version, ...detail }),
        rule.rule_id,
        rule.version,
        deadlineAt,
        contentDigest(detail),
        runId,
        stamp,
        stamp,
      );
  }

  private advanceRule(rule: AutomationRule, stamp: string): void {
    const next = nextDailyDueAt({
      now: stamp,
      local_time: rule.trigger_spec.local_time,
      timezone: rule.trigger_spec.timezone,
    });
    const missed =
      rule.next_due_at !== null &&
      Date.parse(stamp) - Date.parse(rule.next_due_at) > 24 * 60 * 60 * 1000
        ? rule.missed_count + 1
        : rule.missed_count;
    this.db
      .prepare(
        `UPDATE automation_rules SET next_due_at = ?, missed_count = ?, updated_at = ?
          WHERE merchant_id = ? AND rule_id = ?`,
      )
      .run(next, missed, stamp, rule.merchant_id, rule.rule_id);
  }
}

interface RuleRow {
  rule_id: string;
  merchant_id: string;
  version: number;
  template: RuleTemplate;
  trigger_spec_json: string;
  timezone: string;
  scope_json: string;
  predicate_spec_json: string;
  action_type: RuleActionType;
  budget_json: string;
  authorization_ref: string | null;
  effective_at: string;
  expires_at: string;
  content_hash: string;
  state: RuleState;
  enable_epoch: number;
  next_due_at: string | null;
  missed_count: number;
  created_at: string;
  updated_at: string;
}

function toRule(row: RuleRow): AutomationRule {
  return {
    rule_id: row.rule_id,
    merchant_id: row.merchant_id,
    version: row.version,
    template: row.template,
    trigger_spec: JSON.parse(row.trigger_spec_json) as RuleTriggerSpec,
    timezone: row.timezone,
    scope: JSON.parse(row.scope_json) as RuleScopeSpec,
    predicate_spec: JSON.parse(row.predicate_spec_json) as RulePredicateSpec,
    action_type: row.action_type,
    budget: JSON.parse(row.budget_json) as RuleBudgetSpec,
    authorization_ref: row.authorization_ref,
    effective_at: row.effective_at,
    expires_at: row.expires_at,
    content_hash: row.content_hash,
    state: row.state,
    enable_epoch: row.enable_epoch,
    next_due_at: row.next_due_at,
    missed_count: row.missed_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface EvaluationRow {
  evaluation_id: string;
  merchant_id: string;
  rule_id: string;
  rule_version: number;
  trigger_key: string;
  result: EvaluationOutcome;
  reason_code: string | null;
  window_start: string | null;
  window_end: string | null;
  detail_json: string;
  evaluated_at: string;
}

function toEvaluation(row: EvaluationRow): RuleEvaluation {
  return {
    evaluation_id: row.evaluation_id,
    merchant_id: row.merchant_id,
    rule_id: row.rule_id,
    rule_version: row.rule_version,
    trigger_key: row.trigger_key,
    result: row.result,
    reason_code: row.reason_code,
    window_start: row.window_start,
    window_end: row.window_end,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    evaluated_at: row.evaluated_at,
  };
}

interface TaskRow {
  task_id: string;
  merchant_id: string;
  rule_id: string | null;
  rule_version: number | null;
  status: string;
  due_at: string | null;
  attempts: number;
  max_attempts: number;
  fencing_token: number;
  revision: number;
  cancel_epoch: number;
  deadline_at: string | null;
  snapshot_digest: string | null;
  operation_ref: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  stop_requested: number;
  payload_json: string;
}

function toClaimed(row: TaskRow): ClaimedTask {
  return {
    task_id: row.task_id,
    merchant_id: row.merchant_id,
    rule_id: row.rule_id,
    rule_version: row.rule_version,
    status: row.status,
    due_at: row.due_at,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    fencing_token: row.fencing_token,
    revision: row.revision,
    cancel_epoch: row.cancel_epoch,
    deadline_at: row.deadline_at,
    snapshot_digest: row.snapshot_digest,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}
