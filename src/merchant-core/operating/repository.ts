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
 * 经营计划持久化（v0.2 §5.1 / §16 / §18）。
 *
 * 所有写操作走 `BEGIN IMMEDIATE`：区间重叠检查与写入必须在同一写事务内，
 * 否则并发 upsert 可以各自通过检查后同时落库。SQLite 没有 exclusion
 * constraint，唯一索引只能兜底相同 effective_from，真正的区间不重叠由
 * `findOverlaps()` 在事务内判定。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { contentDigest } from "../../negotiation/jcs.js";
import {
  OperatingPlanError,
  type OperatingPlan,
  type OperatingPlanStatus,
  type OperatingPlanInput,
} from "./types.js";

const MAX_JSON_BYTES = 64 * 1024;

export interface OperatingPlanRepositoryOptions {
  db: DatabaseSync;
  now: () => string;
}

interface PlanRow {
  plan_id: string;
  merchant_id: string;
  source: string;
  source_account_id: string;
  sku: string;
  billing_ref: string | null;
  template_id: string | null;
  template_revision: number | null;
  status: OperatingPlanStatus;
  effective_from: string;
  effective_to: string | null;
  conditions_json: string;
  actions_json: string;
  authorization_json: string;
  private_rules_ref: string | null;
  owner: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

function rowToPlan(row: PlanRow): OperatingPlan {
  return {
    plan_id: row.plan_id,
    merchant_id: row.merchant_id,
    source: row.source,
    source_account_id: row.source_account_id,
    sku: row.sku,
    ...(row.billing_ref !== null ? { billing_ref: row.billing_ref } : {}),
    ...(row.template_id !== null ? { template_id: row.template_id } : {}),
    ...(row.template_revision !== null ? { template_revision: row.template_revision } : {}),
    status: row.status,
    effective_from: row.effective_from,
    ...(row.effective_to !== null ? { effective_to: row.effective_to } : {}),
    conditions: JSON.parse(row.conditions_json) as Record<string, unknown>,
    actions: JSON.parse(row.actions_json) as Record<string, unknown>,
    authorization: JSON.parse(row.authorization_json) as OperatingPlan["authorization"],
    ...(row.private_rules_ref !== null ? { private_rules_ref: row.private_rules_ref } : {}),
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class MerchantOperatingPlanRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private inTx = false;

  constructor(options: OperatingPlanRepositoryOptions) {
    this.db = options.db;
    this.now = options.now;
  }

  /** 写事务；内层调用加入外层事务，异常统一回滚。 */
  transaction<T>(work: () => T): T {
    if (this.inTx) return work();
    this.inTx = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  getById(merchantId: string, planId: string): OperatingPlan | undefined {
    const row = this.db
      .prepare("SELECT * FROM merchant_operating_plans WHERE merchant_id = ? AND plan_id = ?")
      .get(merchantId, planId) as PlanRow | undefined;
    return row === undefined ? undefined : rowToPlan(row);
  }

  /** 同一 key 在 at 时刻最多一份 ACTIVE 计划；0 份返回 undefined。 */
  getEffective(input: {
    merchantId: string;
    source: string;
    sourceAccountId: string;
    sku: string;
    at: string;
  }): OperatingPlan | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM merchant_operating_plans
          WHERE merchant_id = ? AND source = ? AND source_account_id = ? AND sku = ?
            AND status = 'ACTIVE'
            AND effective_from <= ?
            AND (effective_to IS NULL OR ? < effective_to)
          ORDER BY effective_from DESC
          LIMIT 2`,
      )
      .all(
        input.merchantId,
        input.source,
        input.sourceAccountId,
        input.sku,
        input.at,
        input.at,
      ) as unknown as PlanRow[];
    if (rows.length > 1) {
      throw new OperatingPlanError(
        "corrupt_plan_intervals",
        "同一商品在同一时刻存在多份生效计划；拒绝猜测使用哪一份",
      );
    }
    return rows.length === 0 ? undefined : rowToPlan(rows[0]!);
  }

  list(merchantId: string, filter: { source?: string; sourceAccountId?: string; sku?: string; status?: OperatingPlanStatus } = {}): OperatingPlan[] {
    const where = ["merchant_id = ?"];
    const params: Array<string> = [merchantId];
    if (filter.source !== undefined) {
      where.push("source = ?");
      params.push(filter.source);
    }
    if (filter.sourceAccountId !== undefined) {
      where.push("source_account_id = ?");
      params.push(filter.sourceAccountId);
    }
    if (filter.sku !== undefined) {
      where.push("sku = ?");
      params.push(filter.sku);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const rows = this.db
      .prepare(`SELECT * FROM merchant_operating_plans WHERE ${where.join(" AND ")} ORDER BY effective_from DESC`)
      .all(...params) as unknown as PlanRow[];
    return rows.map(rowToPlan);
  }

  /**
   * 返回与 [effectiveFrom, effectiveTo) 重叠、且不属于 excludePlanId 的计划。
   * SQLite 半开区间的标准重叠条件：existing.from < new.to AND existing.to > new.from。
   */
  findOverlaps(input: {
    merchantId: string;
    source: string;
    sourceAccountId: string;
    sku: string;
    effectiveFrom: string;
    effectiveTo?: string;
    excludePlanId?: string;
  }): OperatingPlan[] {
    const conditions = [
      "merchant_id = ?",
      "source = ?",
      "source_account_id = ?",
      "sku = ?",
      "effective_from < ?",
      "(effective_to IS NULL OR effective_to > ?)",
    ];
    const params: Array<string> = [
      input.merchantId,
      input.source,
      input.sourceAccountId,
      input.sku,
      input.effectiveTo ?? "9999-12-31T23:59:59.999Z",
      input.effectiveFrom,
    ];
    if (input.excludePlanId !== undefined) {
      conditions.push("plan_id != ?");
      params.push(input.excludePlanId);
    }
    const rows = this.db
      .prepare(`SELECT * FROM merchant_operating_plans WHERE ${conditions.join(" AND ")}`)
      .all(...params) as unknown as PlanRow[];
    return rows.map(rowToPlan);
  }

  insert(plan: Omit<OperatingPlan, "created_at" | "updated_at">, actor: string): OperatingPlan {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO merchant_operating_plans
          (plan_id, merchant_id, source, source_account_id, sku, billing_ref, template_id,
           template_revision, status, effective_from, effective_to, conditions_json,
           actions_json, authorization_json, private_rules_ref, owner, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.plan_id,
        plan.merchant_id,
        plan.source,
        plan.source_account_id,
        plan.sku,
        plan.billing_ref ?? null,
        plan.template_id ?? null,
        plan.template_revision ?? null,
        plan.status,
        plan.effective_from,
        plan.effective_to ?? null,
        JSON.stringify(plan.conditions),
        JSON.stringify(plan.actions),
        JSON.stringify(plan.authorization),
        plan.private_rules_ref ?? null,
        plan.authorization.owner,
        plan.revision,
        now,
        now,
      );
    this.appendEvent({ planId: plan.plan_id, merchantId: plan.merchant_id, event: "CREATED", revision: plan.revision, actor });
    return this.getById(plan.merchant_id, plan.plan_id)!;
  }

  update(
    input: {
      planId: string;
      merchantId: string;
      expectedRevision: number;
      status?: OperatingPlanStatus;
      effectiveTo?: string | null;
      patch?: Partial<OperatingPlanInput>;
    },
    actor: string,
  ): OperatingPlan {
    const current = this.getById(input.merchantId, input.planId);
    if (current === undefined) {
      throw new OperatingPlanError("not_found", `plan ${input.planId} not found`);
    }
    if (current.revision !== input.expectedRevision) {
      throw new OperatingPlanError("version_conflict", "经营计划已被其他操作修改，请刷新后重试");
    }
    const next: OperatingPlanInput = {
      ...current,
      ...(input.patch ?? {}),
    } as OperatingPlanInput;
    const revision = current.revision + 1;
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE merchant_operating_plans
            SET billing_ref = ?, template_id = ?, template_revision = ?, status = ?,
                effective_from = ?, effective_to = ?, conditions_json = ?, actions_json = ?,
                authorization_json = ?, private_rules_ref = ?, owner = ?, revision = ?, updated_at = ?
          WHERE plan_id = ? AND merchant_id = ? AND revision = ?`,
      )
      .run(
        next.billing_ref ?? null,
        next.template_id ?? null,
        next.template_revision ?? null,
        input.status ?? current.status,
        next.effective_from,
        input.effectiveTo !== undefined ? input.effectiveTo : next.effective_to ?? null,
        JSON.stringify(next.conditions),
        JSON.stringify(next.actions),
        JSON.stringify(next.authorization),
        next.private_rules_ref ?? null,
        next.authorization.owner,
        revision,
        now,
        input.planId,
        input.merchantId,
        input.expectedRevision,
      );
    if (Number(result.changes) !== 1) {
      throw new OperatingPlanError("version_conflict", "经营计划并发更新冲突");
    }
    const nextStatus = input.status ?? current.status;
    const event =
      nextStatus !== current.status
        ? nextStatus === "PAUSED"
          ? "PAUSED"
          : "RESUMED"
        : "UPDATED";
    this.appendEvent({
      planId: input.planId,
      merchantId: input.merchantId,
      event,
      revision,
      actor,
    });
    return this.getById(input.merchantId, input.planId)!;
  }

  /** 原子关闭旧区间：仅当 revision 与 effective_to 仍为空时允许。 */
  closeInterval(input: { planId: string; merchantId: string; expectedRevision: number; effectiveTo: string }, actor: string): OperatingPlan {
    const current = this.getById(input.merchantId, input.planId);
    if (current === undefined) throw new OperatingPlanError("not_found", `plan ${input.planId} not found`);
    if (current.revision !== input.expectedRevision) {
      throw new OperatingPlanError("version_conflict", "经营计划已被其他操作修改，请刷新后重试");
    }
    if (Date.parse(input.effectiveTo) <= Date.parse(current.effective_from)) {
      throw new OperatingPlanError("invalid_interval", "新区间必须晚于当前计划生效时间");
    }
    // 有界计划也允许切版本，但新版本起点必须落在当前区间内（不能把旧
    // 区间反向拉长）。并发由 revision 条件更新兜底。
    if (
      current.effective_to !== undefined &&
      Date.parse(input.effectiveTo) >= Date.parse(current.effective_to)
    ) {
      throw new OperatingPlanError("invalid_interval", "新版本起点必须早于当前计划结束时间");
    }
    const result = this.db
      .prepare(
        `UPDATE merchant_operating_plans
            SET effective_to = ?, revision = ?, updated_at = ?
          WHERE plan_id = ? AND merchant_id = ? AND revision = ?`,
      )
      .run(
        input.effectiveTo,
        current.revision + 1,
        this.now(),
        input.planId,
        input.merchantId,
        input.expectedRevision,
      );
    if (Number(result.changes) !== 1) {
      throw new OperatingPlanError("version_conflict", "经营计划并发更新冲突");
    }
    this.appendEvent({
      planId: input.planId,
      merchantId: input.merchantId,
      event: "INTERVAL_CLOSED",
      revision: current.revision + 1,
      actor,
    });
    return this.getById(input.merchantId, input.planId)!;
  }

  appendEvent(input: {
    planId: string;
    merchantId: string;
    event: string;
    revision: number;
    actor: string;
    detail?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO merchant_operating_plan_events
          (plan_id, merchant_id, event, revision, actor, detail_json, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.planId,
        input.merchantId,
        input.event,
        input.revision,
        input.actor,
        JSON.stringify(input.detail ?? {}),
        this.now(),
      );
  }

  /** 幂等命令：同键同摘要返回原结果，同键异摘要冲突。 */
  readIdempotent(merchantId: string, key: string): { operation: string; requestDigest: string; result: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT operation, request_digest, result_json FROM merchant_command_idempotency WHERE merchant_id = ? AND idempotency_key = ?",
      )
      .get(merchantId, key) as { operation: string; request_digest: string; result_json: string } | undefined;
    return row === undefined
      ? undefined
      : { operation: row.operation, requestDigest: row.request_digest, result: row.result_json };
  }

  saveIdempotent(input: {
    merchantId: string;
    key: string;
    operation: string;
    request: unknown;
    result: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO merchant_command_idempotency
          (merchant_id, idempotency_key, operation, request_digest, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.merchantId,
        input.key,
        input.operation,
        contentDigest({ operation: input.operation, request: input.request }),
        JSON.stringify(input.result),
        this.now(),
      );
  }
}

export function newPlanId(): string {
  return `plan_${randomUUID()}`;
}

export { MAX_JSON_BYTES };
