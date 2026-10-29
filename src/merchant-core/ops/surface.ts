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
 * 工作台经营 API 的薄适配层（v0.2 §17）。
 *
 * 只做请求体 → 服务输入的字段搬运与最小必需字段校验；业务规则在服务层。
 * 商家身份由门面注入，HTTP 层只传认证后的 actor。
 */

import { ManagementError } from "../../merchant/application/service.js";
import type { MerchantOperationsFacade } from "./facade.js";
import type { OperatingPlanInput } from "../operating/types.js";
import type { CreateOpportunityInput } from "../opportunity/service.js";
import type { OpportunityEvent } from "../opportunity/types.js";
import type { PrepareProposalSetInput } from "../proposal/types.js";
import type { ScheduleFollowUpInput } from "../followup/service.js";

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagementError("invalid_input", "request body must be an object");
  }
  return value as Record<string, unknown>;
}

function text(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ManagementError("invalid_input", `${name} must be a non-empty string`);
  }
  return value;
}

function integer(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ManagementError("invalid_input", `${name} must be an integer`);
  }
  return value;
}

function optionalText(body: Record<string, unknown>, name: string): string | undefined {
  return body[name] === undefined ? undefined : text(body, name);
}

function optionalInteger(body: Record<string, unknown>, name: string): number | undefined {
  return body[name] === undefined ? undefined : integer(body, name);
}

export class MerchantOperationsSurface {
  private readonly facade: MerchantOperationsFacade;
  private readonly now: () => string;

  constructor(options: { facade: MerchantOperationsFacade; now?: () => string }) {
    this.facade = options.facade;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  // ── 经营计划 ──────────────────────────────────────────────────────────

  listPlans(): unknown[] {
    return this.facade.listPlans();
  }

  getPlan(planId: string): unknown {
    const plan = this.facade.listPlans().find((candidate) => candidate.plan_id === planId);
    if (plan === undefined) throw new ManagementError("not_found", `plan ${planId} not found`);
    return plan;
  }

  createPlan(value: unknown, actor: string, idempotencyKey?: string): unknown {
    const body = objectBody(value);
    const input: Omit<OperatingPlanInput, "merchant_id"> = {
      source: text(body, "source"),
      source_account_id: text(body, "source_account_id"),
      sku: text(body, "sku"),
      ...(optionalText(body, "billing_ref") !== undefined ? { billing_ref: optionalText(body, "billing_ref") } : {}),
      ...(optionalText(body, "template_id") !== undefined ? { template_id: optionalText(body, "template_id") } : {}),
      ...(optionalInteger(body, "template_revision") !== undefined
        ? { template_revision: optionalInteger(body, "template_revision") }
        : {}),
      effective_from: text(body, "effective_from"),
      ...(optionalText(body, "effective_to") !== undefined ? { effective_to: optionalText(body, "effective_to") } : {}),
      conditions: objectBody(body.conditions),
      actions: objectBody(body.actions),
      authorization: objectBody(body.authorization) as unknown as OperatingPlanInput["authorization"],
      ...(optionalText(body, "private_rules_ref") !== undefined
        ? { private_rules_ref: optionalText(body, "private_rules_ref") }
        : {}),
    };
    return this.facade.createPlan(input, {
      ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
      actor,
    });
  }

  pausePlan(planId: string, value: unknown, actor: string): unknown {
    const body = objectBody(value);
    return this.facade.pausePlan(planId, integer(body, "expected_revision"), actor);
  }

  resumePlan(planId: string, value: unknown, actor: string): unknown {
    const body = objectBody(value);
    return this.facade.resumePlan(planId, integer(body, "expected_revision"), actor);
  }

  // ── 机会与需求 ────────────────────────────────────────────────────────

  listOpportunities(): unknown[] {
    return this.facade.listOpportunities();
  }

  getOpportunity(opportunityId: string): unknown {
    const opportunity = this.facade.getOpportunity(opportunityId);
    if (opportunity === undefined) {
      throw new ManagementError("not_found", `opportunity ${opportunityId} not found`);
    }
    return opportunity;
  }

  createOpportunity(value: unknown, actor: string, idempotencyKey?: string): unknown {
    const body = objectBody(value);
    const input: Omit<CreateOpportunityInput, "merchant_id"> = {
      source_id: text(body, "source_id"),
      owner: text(body, "owner"),
      operator: optionalText(body, "operator") ?? actor,
      next_action: text(body, "next_action"),
      ...(optionalText(body, "next_action_due_at") !== undefined
        ? { next_action_due_at: optionalText(body, "next_action_due_at") }
        : {}),
      ...(optionalText(body, "rfq_case_id") !== undefined ? { rfq_case_id: optionalText(body, "rfq_case_id") } : {}),
      required_fields: Array.isArray(body.required_fields) ? (body.required_fields as string[]) : [],
      requirement_fields: Array.isArray(body.requirement_fields)
        ? (body.requirement_fields as CreateOpportunityInput["requirement_fields"])
        : [],
      basis: text(body, "basis"),
    };
    return this.facade.createOpportunity(input, {
      ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
      actor,
    });
  }

  recordRequirement(opportunityId: string, value: unknown, actor: string, idempotencyKey?: string): unknown {
    const body = objectBody(value);
    return this.facade.recordRequirement(
      {
        opportunity_id: opportunityId,
        expected_revision: integer(body, "expected_revision"),
        fields: (Array.isArray(body.fields) ? body.fields : []) as never,
        required_fields: Array.isArray(body.required_fields) ? (body.required_fields as string[]) : [],
        created_by: optionalText(body, "created_by") ?? actor,
        actor,
      },
      { ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}) },
    );
  }

  advanceOpportunity(opportunityId: string, value: unknown, actor: string, idempotencyKey?: string): unknown {
    const body = objectBody(value);
    const event = objectBody(body.event) as unknown as OpportunityEvent;
    return this.facade.advanceOpportunity(
      {
        opportunity_id: opportunityId,
        expected_revision: integer(body, "expected_revision"),
        event,
        actor,
        ...(body.next_action !== undefined ? { next_action: body.next_action as string | null } : {}),
        ...(body.next_action_due_at !== undefined
          ? { next_action_due_at: body.next_action_due_at as string | null }
          : {}),
        ...(body.waiting_reason !== undefined ? { waiting_reason: body.waiting_reason as string | null } : {}),
      },
      { ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}) },
    );
  }

  // ── 方案 ──────────────────────────────────────────────────────────────

  listProposals(opportunityId: string): unknown[] {
    return this.facade.listProposals(opportunityId);
  }

  prepareProposal(value: unknown, idempotencyKey?: string): unknown {
    const body = objectBody(value);
    const input: Omit<PrepareProposalSetInput, "merchant_id"> = {
      opportunity_id: text(body, "opportunity_id"),
      requirement_revision: integer(body, "requirement_revision"),
      facts_digest: text(body, "facts_digest"),
      policy_version: text(body, "policy_version"),
      options: (Array.isArray(body.options) ? body.options : []) as never,
      now: optionalText(body, "now") ?? this.now(),
    };
    return this.facade.prepareProposal(input, {
      ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
    });
  }

  selectProposal(value: unknown, actor: string, idempotencyKey?: string): unknown {
    const body = objectBody(value);
    return this.facade.selectProposal(
      {
        set_id: text(body, "set_id"),
        option_id: text(body, "option_id"),
        selected_by: optionalText(body, "selected_by") ?? actor,
        requirement_revision: integer(body, "requirement_revision"),
        publish_reference: objectBody(body.publish_reference) as never,
        now: optionalText(body, "now") ?? this.now(),
      },
      { ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}) },
    );
  }

  approveProposal(value: unknown, idempotencyKey?: string): unknown {
    const body = objectBody(value);
    return this.facade.approveProposal(
      {
        set_id: text(body, "set_id"),
        option_id: text(body, "option_id"),
        policy_version: text(body, "policy_version"),
        expires_at: text(body, "expires_at"),
        now: optionalText(body, "now") ?? this.now(),
      },
      { ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}) },
    );
  }

  // ── 跟进 ──────────────────────────────────────────────────────────────

  listFollowUps(): unknown[] {
    return this.facade.listFollowUps();
  }

  scheduleFollowUp(value: unknown): unknown {
    const body = objectBody(value);
    const input: Omit<ScheduleFollowUpInput, "merchant_id"> = {
      ...(optionalText(body, "opportunity_id") !== undefined
        ? { opportunity_id: optionalText(body, "opportunity_id") }
        : {}),
      trigger_event: text(body, "trigger_event"),
      action_type: text(body, "action_type"),
      ...(optionalText(body, "target_version") !== undefined
        ? { target_version: optionalText(body, "target_version") }
        : {}),
      ...(optionalText(body, "due_at") !== undefined ? { due_at: optionalText(body, "due_at") } : {}),
      max_attempts: integer(body, "max_attempts"),
      ...(optionalText(body, "idempotency_key") !== undefined
        ? { idempotency_key: optionalText(body, "idempotency_key") }
        : {}),
      payload: body.payload !== undefined ? objectBody(body.payload) : {},
    };
    return this.facade.scheduleFollowUp(input);
  }

  claimFollowUp(taskId: string, value: unknown): unknown {
    const body = objectBody(value);
    return this.facade.claimFollowUp(
      taskId,
      text(body, "worker_id"),
      integer(body, "lease_ms"),
    );
  }

  finishFollowUp(taskId: string, value: unknown): unknown {
    const body = objectBody(value);
    const outcome = text(body, "outcome");
    if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "unknown") {
      throw new ManagementError("invalid_input", "outcome must be succeeded/failed/unknown");
    }
    return this.facade.finishFollowUp({
      task_id: taskId,
      fencing_token: integer(body, "fencing_token"),
      outcome,
      ...(body.receipt !== undefined ? { receipt: objectBody(body.receipt) } : {}),
      ...(optionalText(body, "error_code") !== undefined ? { error_code: optionalText(body, "error_code") } : {}),
    });
  }

  stopFollowUp(taskId: string, value: unknown): unknown {
    const body = objectBody(value);
    return this.facade.stopFollowUp(taskId, body.in_flight === true);
  }
  // ── 订单与贡献 ────────────────────────────────────────────────────────

  listOrders(): unknown[] {
    return this.facade.listOrders();
  }

  recordOrderReport(value: unknown, actor: string): unknown {
    const body = objectBody(value);
    return this.facade.recordManualOrder({
      source_namespace: text(body, "source_namespace"),
      source_account_id: text(body, "source_account_id"),
      external_order_id: text(body, "external_order_id"),
      lines: (Array.isArray(body.lines) ? body.lines : []) as never,
      ...(optionalText(body, "currency") !== undefined ? { currency: optionalText(body, "currency") } : {}),
      ...(optionalInteger(body, "total_minor") !== undefined ? { total_minor: optionalInteger(body, "total_minor") } : {}),
      ...(optionalText(body, "payment_status") !== undefined
        ? { payment_status: optionalText(body, "payment_status") }
        : {}),
      ...(optionalText(body, "fulfillment_status") !== undefined
        ? { fulfillment_status: optionalText(body, "fulfillment_status") }
        : {}),
      observed_at: text(body, "observed_at"),
      reported_by: optionalText(body, "reported_by") ?? actor,
      ...(optionalText(body, "evidence_ref") !== undefined
        ? { evidence_ref: optionalText(body, "evidence_ref") }
        : {}),
    });
  }

  verifyOrder(recordId: string, value: unknown): unknown {
    const body = objectBody(value);
    return this.facade.verifyOrder(recordId, {
      verified: body.verified === true,
      source_version: text(body, "source_version"),
      verified_at: text(body, "verified_at"),
    });
  }

  attributeOrder(recordId: string, value: unknown): unknown {
    const body = objectBody(value);
    return this.facade.attributeOrder(
      recordId,
      (Array.isArray(body.allocations) ? body.allocations : []) as never,
    );
  }

  recordOrderRefund(recordId: string, value: unknown): unknown {
    const body = objectBody(value);
    const order = this.facade.getOrder(recordId);
    if (order === undefined) throw new ManagementError("not_found", `order ${recordId} not found`);
    return this.facade.recordOrderRefund(recordId, {
      identity: {
        merchant_id: order.merchant_id,
        source_namespace: order.source_namespace,
        source_account_id: order.source_account_id,
        external_order_id: order.external_order_id,
        external_refund_id: text(body, "external_refund_id"),
      },
      amount_minor: integer(body, "amount_minor"),
      version: integer(body, "version"),
      status: body.status === "reversed" ? "reversed" : "active",
    });
  }

  assessOrderContribution(recordId: string, value: unknown): unknown {
    const body = objectBody(value);
    return this.facade.assessOrderContribution(
      recordId,
      body as never,
      optionalText(body, "cost_snapshot_id"),
    );
  }

}
