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
 * 经营计划服务（v0.2 §5.1 / FR01–FR04、FR15、FR17）。
 *
 * 不强制的部分（conditions/actions 的具体枚举）留给 M0 冻结；这里先把
 * 不能含糊的约束做死：
 *  - 同商家/来源/账户/SKU 的生效区间不得重叠；
 *  - 已生效计划不能原地改条款，只能原子切版本；
 *  - 暂停不释放区间，恢复必须仍在有效期内且未被撤销；
 *  - 所有写命令支持 idempotency_key（同键同内容重放，异内容冲突）。
 */

import { contentDigest } from "../../negotiation/jcs.js";
import {
  MAX_JSON_BYTES,
  MerchantOperatingPlanRepository,
  newPlanId,
} from "./repository.js";
import {
  OperatingPlanError,
  type OperatingPlan,
  type OperatingPlanAuthorization,
  type OperatingPlanInput,
  type OperatingPlanReadiness,
  type PlanReadinessInput,
  type SwitchPlanVersionInput,
  type UpdateOperatingPlanInput,
} from "./types.js";

export interface OperatingPlanServiceOptions {
  repository: MerchantOperatingPlanRepository;
  now: () => string;
}

export interface CommandOptions {
  idempotency_key?: string;
  /** 实际操作者；缺省用 authorization.owner。 */
  actor?: string;
}

function requireText(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new OperatingPlanError("validation", `${name} 必须是非空字符串（≤${max}）`);
  }
  return value;
}

function requireTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new OperatingPlanError("validation", `${name} 必须是可解析的 RFC 3339 时间`);
  }
  return value;
}

function requireJsonObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatingPlanError("validation", `${name} 必须是对象`);
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES) {
    throw new OperatingPlanError("validation", `${name} 超过 ${MAX_JSON_BYTES} 字节`);
  }
  return value as Record<string, unknown>;
}

function validateAuthorization(value: OperatingPlanAuthorization): OperatingPlanAuthorization {
  requireText(value?.owner, "authorization.owner", 128);
  if (!Array.isArray(value.scopes) || value.scopes.some((scope) => typeof scope !== "string" || scope.trim() === "")) {
    throw new OperatingPlanError("validation", "authorization.scopes 必须是非空字符串数组");
  }
  if (value.expires_at !== undefined) requireTimestamp(value.expires_at, "authorization.expires_at");
  if (value.revoked_at !== undefined) requireTimestamp(value.revoked_at, "authorization.revoked_at");
  return {
    owner: value.owner,
    scopes: [...new Set(value.scopes)],
    ...(value.expires_at !== undefined ? { expires_at: value.expires_at } : {}),
    ...(value.revoked_at !== undefined ? { revoked_at: value.revoked_at } : {}),
  };
}

function validateInput(input: OperatingPlanInput): OperatingPlanInput {
  requireText(input.merchant_id, "merchant_id", 128);
  requireText(input.source, "source", 64);
  requireText(input.source_account_id, "source_account_id", 128);
  requireText(input.sku, "sku", 128);
  if (input.billing_ref !== undefined) requireText(input.billing_ref, "billing_ref", 128);
  if (input.template_id !== undefined) requireText(input.template_id, "template_id", 128);
  if (input.template_revision !== undefined) {
    if (!Number.isSafeInteger(input.template_revision) || input.template_revision < 1) {
      throw new OperatingPlanError("validation", "template_revision 必须是正整数");
    }
  }
  requireTimestamp(input.effective_from, "effective_from");
  if (input.effective_to !== undefined) {
    requireTimestamp(input.effective_to, "effective_to");
    if (Date.parse(input.effective_to) <= Date.parse(input.effective_from)) {
      throw new OperatingPlanError("invalid_interval", "effective_to 必须晚于 effective_from");
    }
  }
  requireJsonObject(input.conditions, "conditions");
  requireJsonObject(input.actions, "actions");
  if (input.private_rules_ref !== undefined) requireText(input.private_rules_ref, "private_rules_ref", 256);
  return {
    ...input,
    authorization: validateAuthorization(input.authorization),
  };
}

function authorizationActive(
  authorization: OperatingPlanAuthorization,
  at: string,
): { ok: true } | { ok: false; reason: "authorization_revoked" | "plan_expired" } {
  if (authorization.revoked_at !== undefined && Date.parse(authorization.revoked_at) <= Date.parse(at)) {
    return { ok: false, reason: "authorization_revoked" };
  }
  if (authorization.expires_at !== undefined && Date.parse(authorization.expires_at) <= Date.parse(at)) {
    return { ok: false, reason: "plan_expired" };
  }
  return { ok: true };
}

function inWindow(plan: OperatingPlan, at: string): boolean {
  return (
    Date.parse(plan.effective_from) <= Date.parse(at) &&
    (plan.effective_to === undefined || Date.parse(at) < Date.parse(plan.effective_to))
  );
}

export class MerchantOperatingPlanService {
  private readonly repository: MerchantOperatingPlanRepository;
  private readonly now: () => string;

  constructor(options: OperatingPlanServiceOptions) {
    this.repository = options.repository;
    this.now = options.now;
  }

  create(input: OperatingPlanInput, command: CommandOptions = {}): OperatingPlan {
    const normalized = validateInput(input);
    return this.withIdempotency(normalized.merchant_id, "operating_plans.create", input, command, () =>
      this.repository.transaction(() => {
        const overlap = this.repository.findOverlaps({
          merchantId: normalized.merchant_id,
          source: normalized.source,
          sourceAccountId: normalized.source_account_id,
          sku: normalized.sku,
          effectiveFrom: normalized.effective_from,
          ...(normalized.effective_to !== undefined ? { effectiveTo: normalized.effective_to } : {}),
        });
        if (overlap.length > 0) {
          throw new OperatingPlanError("interval_overlap", "同一商品在相同生效区间内已存在经营计划");
        }
        return this.repository.insert(
          {
            ...normalized,
            plan_id: newPlanId(),
            status: "ACTIVE",
            revision: 1,
          },
          command.actor ?? normalized.authorization.owner,
        );
      }),
    );
  }

  update(input: UpdateOperatingPlanInput, command: CommandOptions = {}): OperatingPlan {
    const current = this.repository.getById(input.merchant_id, input.plan_id);
    if (current === undefined) {
      throw new OperatingPlanError("not_found", `plan ${input.plan_id} not found`);
    }
    if (Date.parse(this.now()) >= Date.parse(current.effective_from)) {
      throw new OperatingPlanError(
        "invalid_interval",
        "计划已生效，不能原地修改条款；请用版本切换（switchVersion）",
      );
    }
    return this.withIdempotency(
      current.merchant_id,
      "operating_plans.update",
      input,
      command,
      () =>
        this.repository.transaction(() => {
          const patch = input.patch;
          if (patch.effective_from !== undefined) {
            throw new OperatingPlanError("validation", "effective_from 只能通过版本切换修改");
          }
          if (patch.effective_to !== undefined) {
            requireTimestamp(patch.effective_to, "effective_to");
          }
          const merged = validateInput({ ...current, ...patch, merchant_id: current.merchant_id });
          const overlap = this.repository.findOverlaps({
            merchantId: merged.merchant_id,
            source: merged.source,
            sourceAccountId: merged.source_account_id,
            sku: merged.sku,
            effectiveFrom: merged.effective_from,
            ...(merged.effective_to !== undefined ? { effectiveTo: merged.effective_to } : {}),
            excludePlanId: current.plan_id,
          });
          if (overlap.length > 0) {
            throw new OperatingPlanError("interval_overlap", "修改后的生效区间与其他计划重叠");
          }
          return this.repository.update(
            {
              planId: current.plan_id,
              merchantId: current.merchant_id,
              expectedRevision: input.expected_revision,
              patch: merged,
            },
            command.actor ?? merged.authorization.owner,
          );
        }),
    );
  }

  switchVersion(input: SwitchPlanVersionInput, command: CommandOptions = {}): { previous: OperatingPlan; next: OperatingPlan } {
    const current = this.repository.getById(input.merchant_id, input.plan_id);
    if (current === undefined) {
      throw new OperatingPlanError("not_found", `plan ${input.plan_id} not found`);
    }
    requireTimestamp(input.effective_from, "effective_from");
    if (Date.parse(input.effective_from) <= Date.parse(this.now())) {
      throw new OperatingPlanError("invalid_interval", "新版本必须从现在之后生效，不能回写历史");
    }
    if (Date.parse(input.effective_from) <= Date.parse(current.effective_from)) {
      throw new OperatingPlanError("invalid_interval", "新版本生效时间必须晚于当前版本");
    }
    if (current.effective_to !== undefined && Date.parse(input.effective_from) >= Date.parse(current.effective_to)) {
      throw new OperatingPlanError("invalid_interval", "新版本生效时间必须落在当前计划区间内");
    }
    return this.withIdempotency(
      current.merchant_id,
      "operating_plans.switch",
      input,
      command,
      () =>
        this.repository.transaction(() => {
          const merged = validateInput({
            ...current,
            ...input.patch,
            merchant_id: current.merchant_id,
            source: current.source,
            source_account_id: current.source_account_id,
            sku: current.sku,
            effective_from: input.effective_from,
            ...(input.patch.effective_to !== undefined
              ? { effective_to: input.patch.effective_to }
              : current.effective_to !== undefined
                ? { effective_to: current.effective_to }
                : {}),
          });
          const overlap = this.repository.findOverlaps({
            merchantId: merged.merchant_id,
            source: merged.source,
            sourceAccountId: merged.source_account_id,
            sku: merged.sku,
            effectiveFrom: merged.effective_from,
            ...(merged.effective_to !== undefined ? { effectiveTo: merged.effective_to } : {}),
            excludePlanId: current.plan_id,
          });
          if (overlap.length > 0) {
            throw new OperatingPlanError("interval_overlap", "新版本生效区间与其他计划重叠");
          }
          const previous = this.repository.closeInterval(
            {
              planId: current.plan_id,
              merchantId: current.merchant_id,
              expectedRevision: input.expected_revision,
              effectiveTo: input.effective_from,
            },
            command.actor ?? merged.authorization.owner,
          );
          const next = this.repository.insert(
            { ...merged, plan_id: newPlanId(), status: "ACTIVE", revision: 1 },
            command.actor ?? merged.authorization.owner,
          );
          return { previous, next };
        }),
    );
  }

  pause(input: { merchant_id: string; plan_id: string; expected_revision: number; actor?: string }, command: CommandOptions = {}): OperatingPlan {
    const current = this.repository.getById(input.merchant_id, input.plan_id);
    if (current === undefined) throw new OperatingPlanError("not_found", `plan ${input.plan_id} not found`);
    if (current.status === "PAUSED") return current;
    return this.withIdempotency(current.merchant_id, "operating_plans.pause", input, command, () =>
      this.repository.transaction(() =>
        this.repository.update(
          {
            planId: current.plan_id,
            merchantId: current.merchant_id,
            expectedRevision: input.expected_revision,
            status: "PAUSED",
          },
          input.actor ?? command.actor ?? current.authorization.owner,
        ),
      ),
    );
  }

  resume(input: { merchant_id: string; plan_id: string; expected_revision: number; actor?: string }, command: CommandOptions = {}): OperatingPlan {
    const current = this.repository.getById(input.merchant_id, input.plan_id);
    if (current === undefined) throw new OperatingPlanError("not_found", `plan ${input.plan_id} not found`);
    if (current.status === "ACTIVE") return current;
    const at = this.now();
    if (!inWindow(current, at)) {
      throw new OperatingPlanError("plan_expired", "计划已过有效期，不能恢复");
    }
    const authorization = authorizationActive(current.authorization, at);
    if (!authorization.ok) {
      throw new OperatingPlanError(authorization.reason, "授权已撤销或到期，不能恢复计划");
    }
    return this.withIdempotency(current.merchant_id, "operating_plans.resume", input, command, () =>
      this.repository.transaction(() =>
        this.repository.update(
          {
            planId: current.plan_id,
            merchantId: current.merchant_id,
            expectedRevision: input.expected_revision,
            status: "ACTIVE",
          },
          input.actor ?? command.actor ?? current.authorization.owner,
        ),
      ),
    );
  }

  getEffective(input: {
    merchantId: string;
    source: string;
    sourceAccountId: string;
    sku: string;
    at?: string;
  }): OperatingPlan | undefined {
    return this.repository.getEffective({
      merchantId: input.merchantId,
      source: input.source,
      sourceAccountId: input.sourceAccountId,
      sku: input.sku,
      at: input.at ?? this.now(),
    });
  }

  list(
    merchantId: string,
    filter: Parameters<MerchantOperatingPlanRepository["list"]>[1] = {},
  ): OperatingPlan[] {
    return this.repository.list(merchantId, filter);
  }

  /**
   * 三级就绪检查（FR03）。缺订单源/成本时如实阻断对应级别，不用默认值
   * 伪装成“已具备”。
   */
  readiness(plan: OperatingPlan, input: PlanReadinessInput): OperatingPlanReadiness {
    const at = input.at;
    if (!Number.isFinite(Date.parse(at))) {
      throw new OperatingPlanError("validation", "at 必须是可解析的 RFC 3339 时间");
    }
    const blocked = (blocker: string): { ok: false; blockers: string[] } => ({ ok: false, blockers: [blocker] });

    const receive: string[] = [];
    if (!inWindow(plan, at)) receive.push("outside_effective_window");
    const authorization = authorizationActive(plan.authorization, at);
    if (!authorization.ok) {
      receive.push(
        authorization.reason === "authorization_revoked"
          ? "authorization_revoked"
          : "authorization_expired",
      );
    }
    // 缺数量范围/单位不阻断接收（FR03：仍可接收并补问），只阻断正式报价。

    const quote: string[] = [];
    if (plan.status !== "ACTIVE") quote.push("plan_paused");
    if (receive.length > 0) quote.push(...receive);
    if (plan.conditions.quantity_range === undefined && plan.conditions.quantity_min === undefined) {
      quote.push("missing_quantity_range");
    }
    if (plan.conditions.allowed_units === undefined) quote.push("missing_allowed_units");
    if (input.contribution_gate_enabled === true && input.cost_complete !== true) {
      quote.push(input.cost_complete === false ? "missing_cost" : "contribution_unknown");
    }

    const orders: string[] = [];
    if (input.order_source_ready !== true) orders.push("order_source_unavailable");

    return {
      can_receive_demand: receive.length === 0 ? { ok: true, blockers: [] } : { ok: false, blockers: receive },
      can_publish_quote: quote.length === 0 ? { ok: true, blockers: [] } : { ok: false, blockers: quote },
      can_verify_orders: orders.length === 0 ? { ok: true, blockers: [] } : blocked("order_source_unavailable"),
    };
  }

  private withIdempotency<T>(
    merchantId: string,
    operation: string,
    request: unknown,
    command: CommandOptions,
    work: () => T,
  ): T {
    const key = command.idempotency_key;
    if (key === undefined) return work();
    requireText(key, "idempotency_key", 128);
    const digest = contentDigest({ operation, request });
    const existing = this.repository.readIdempotent(merchantId, key);
    if (existing !== undefined) {
      if (existing.operation !== operation || existing.requestDigest !== digest) {
        throw new OperatingPlanError("idempotency_conflict", "同一幂等键已用于不同内容");
      }
      return JSON.parse(existing.result) as T;
    }
    return this.repository.transaction(() => {
      const result = work();
      this.repository.saveIdempotent({ merchantId, key, operation, request, result });
      return result;
    });
  }
}
