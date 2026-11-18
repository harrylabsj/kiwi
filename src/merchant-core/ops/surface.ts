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
import {
  createActorContext,
  type ActorContext,
} from "../context-governance/actor-context.js";
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

function stringArray(body: Record<string, unknown>, name: string): string[] {
  const value = body[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ManagementError("invalid_input", `${name} must be a string array`);
  }
  return value as string[];
}

/**
 * 管理面已认证主体 → 治理 ActorContext。merchant/actor 来自会话，权限来自
 * 角色映射；模型与请求正文不能注入这些值。只映射学习写入所需能力，避免
 * 把管理面的其他权限带入治理域。
 */
export interface ManagementActorInput {
  readonly actor_id: string;
  readonly merchant_id: string;
  readonly auth_method: "admin-session" | "merchant-session" | "service-identity";
  readonly permissions: readonly string[];
}

function governanceActor(input: ManagementActorInput): ActorContext {
  const capabilities = ["learning:manage", "learning:review", "learning:publish"].filter(
    (capability) => input.permissions.includes(capability),
  );
  return createActorContext({
    merchant_id: input.merchant_id,
    actor_id: input.actor_id,
    auth_strength: input.auth_method === "merchant-session" ? "session" : "verified",
    subject_binding: "organization",
    capabilities,
  });
}

export class MerchantOperationsSurface {
  private readonly facade: MerchantOperationsFacade;
  private readonly now: () => string;

  constructor(options: { facade: MerchantOperationsFacade; now?: () => string }) {
    this.facade = options.facade;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getEvaluationRecovery(evaluationId: string, actor: ManagementActorInput): unknown {
    return this.facade.learning.getPendingEvaluation({ merchant_id: this.facade.merchantId, actor: governanceActor(actor), evaluation_id: evaluationId });
  }

  resolveEvaluationRecovery(evaluationId: string, value: unknown, actor: ManagementActorInput): Promise<unknown> {
    const body = objectBody(value);
    if (Object.keys(body).some((key) => !["evidence_ref", "expected_dispatch_id", "command_id"].includes(key))) {
      throw new ManagementError("invalid_input", "unexpected recovery field");
    }
    return this.facade.learning.resolvePendingEvaluation({ merchant_id: this.facade.merchantId, actor: governanceActor(actor), evaluation_id: evaluationId,
      evidence_ref: text(body, "evidence_ref"), expected_dispatch_id: text(body, "expected_dispatch_id"), command_id: text(body, "command_id") });
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

  recordCsvOrderReport(value: unknown, actor: string): unknown {
    const body = objectBody(value);
    return this.facade.recordCsvOrderReport({
      csv: text(body, "csv"),
      reportedBy: optionalText(body, "reported_by") ?? actor,
      observedAtFallback: text(body, "observed_at"),
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

  // ── TOP1 经验学习：纠正与案例（M2）────────────────────────────────────

  listCorrections(): unknown[] {
    return this.facade.learning.listCorrections(this.facade.merchantId);
  }

  getCorrection(correctionId: string): unknown {
    const correction = this.facade.learning.getCorrection(this.facade.merchantId, correctionId);
    if (correction === undefined) {
      throw new ManagementError("not_found", `correction ${correctionId} not found`);
    }
    return correction;
  }

  submitCorrection(
    value: unknown,
    actor: ManagementActorInput,
    idempotencyKey?: string,
  ): unknown {
    const body = objectBody(value);
    return this.facade.learning.submitCorrection(
      {
        merchant_id: this.facade.merchantId,
        actor: governanceActor(actor),
        correction_text: text(body, "correction_text"),
        ...(body.issue_tags !== undefined
          ? { issue_tags: stringArray(body, "issue_tags") }
          : {}),
        ...(body.case_refs !== undefined ? { case_refs: stringArray(body, "case_refs") } : {}),
        ...(optionalText(body, "base_release_id") !== undefined
          ? { base_release_id: optionalText(body, "base_release_id") }
          : {}),
        ...(optionalText(body, "correction_id") !== undefined
          ? { correction_id: optionalText(body, "correction_id") }
          : {}),
        ...(optionalInteger(body, "expected_revision") !== undefined
          ? { expected_revision: optionalInteger(body, "expected_revision") }
          : {}),
      },
      idempotencyKey !== undefined ? { command_id: idempotencyKey } : {},
    );
  }

  promoteCorrection(
    correctionId: string,
    value: unknown,
    actor: ManagementActorInput,
    idempotencyKey?: string,
  ): unknown {
    const body = objectBody(value);
    return this.facade.learning.promoteCorrection(
      {
        merchant_id: this.facade.merchantId,
        actor: governanceActor(actor),
        correction_id: correctionId,
        expected_revision: integer(body, "expected_revision"),
      },
      idempotencyKey !== undefined ? { command_id: idempotencyKey } : {},
    );
  }

  listCandidates(): unknown[] {
    return this.facade.learning.listCandidates(this.facade.merchantId);
  }

  getCandidate(candidateId: string): unknown {
    const candidate = this.facade.learning.getCandidate(this.facade.merchantId, candidateId);
    if (candidate === undefined) {
      throw new ManagementError("not_found", `candidate ${candidateId} not found`);
    }
    return candidate;
  }

  proposeCandidate(value: unknown, actor: ManagementActorInput, idempotencyKey?: string): unknown {
    const body = objectBody(value);
    return this.facade.learning.proposeCandidate(
      this.candidateContentInput(body, actor),
      idempotencyKey !== undefined ? { command_id: idempotencyKey } : {},
    );
  }

  reviseCandidate(
    candidateId: string,
    value: unknown,
    actor: ManagementActorInput,
    idempotencyKey?: string,
  ): unknown {
    const body = objectBody(value);
    return this.facade.learning.reviseCandidate(
      {
        ...this.candidateContentInput(body, actor),
        candidate_id: candidateId,
        expected_revision: integer(body, "expected_revision"),
      },
      idempotencyKey !== undefined ? { command_id: idempotencyKey } : {},
    );
  }

  reviewCandidate(
    candidateId: string,
    value: unknown,
    actor: ManagementActorInput,
    idempotencyKey?: string,
  ): unknown {
    const body = objectBody(value);
    const decision = text(body, "decision");
    if (decision !== "approve" && decision !== "reject") {
      throw new ManagementError("invalid_input", "decision must be approve or reject");
    }
    return this.facade.learning.reviewCandidate(
      {
        merchant_id: this.facade.merchantId,
        actor: governanceActor(actor),
        candidate_id: candidateId,
        content_hash: text(body, "content_hash"),
        evaluation_id: text(body, "evaluation_id"),
        decision,
        ...(optionalText(body, "reason") !== undefined
          ? { reason: optionalText(body, "reason") }
          : {}),
      },
      idempotencyKey !== undefined ? { command_id: idempotencyKey } : {},
    );
  }

  listReviews(): unknown[] {
    return this.facade.learning.listReviews(this.facade.merchantId);
  }

  getReview(reviewId: string): unknown {
    const review = this.facade.learning.getReview(this.facade.merchantId, reviewId);
    if (review === undefined) throw new ManagementError("not_found", `review ${reviewId} not found`);
    return review;
  }

  publishRelease(value: unknown, actor: ManagementActorInput, idempotencyKey?: string): unknown {
    const body = objectBody(value);
    return this.facade.learning.publishRelease(
      {
        merchant_id: this.facade.merchantId,
        actor: governanceActor(actor),
        approval_ref: text(body, "approval_ref"),
        expected_generation: integer(body, "expected_generation"),
      },
      idempotencyKey !== undefined ? { command_id: idempotencyKey } : {},
    );
  }

  rollbackRelease(
    releaseId: string,
    value: unknown,
    actor: ManagementActorInput,
    idempotencyKey?: string,
  ): unknown {
    const body = objectBody(value);
    return this.facade.learning.rollbackRelease(
      {
        merchant_id: this.facade.merchantId,
        actor: governanceActor(actor),
        target_release_id: releaseId,
        expected_generation: integer(body, "expected_generation"),
        reason: text(body, "reason"),
      },
      idempotencyKey !== undefined ? { command_id: idempotencyKey } : {},
    );
  }

  revokeRelease(
    releaseId: string,
    value: unknown,
    actor: ManagementActorInput,
    idempotencyKey?: string,
  ): unknown {
    const body = objectBody(value);
    return this.facade.learning.revokeRelease(
      {
        merchant_id: this.facade.merchantId,
        actor: governanceActor(actor),
        release_id: releaseId,
        expected_generation: integer(body, "expected_generation"),
        reason: text(body, "reason"),
      },
      idempotencyKey !== undefined ? { command_id: idempotencyKey } : {},
    );
  }

  listReleases(skillKey?: string): unknown[] {
    return this.facade.learning.listReleases(this.facade.merchantId, skillKey);
  }

  getRelease(releaseId: string): unknown {
    const release = this.facade.learning.getRelease(this.facade.merchantId, releaseId);
    if (release === undefined) {
      throw new ManagementError("not_found", `release ${releaseId} not found`);
    }
    return release;
  }

  getActiveRelease(skillKey: string): unknown {
    const release = this.facade.learning.getActiveRelease(this.facade.merchantId, skillKey);
    if (release === undefined) {
      throw new ManagementError("not_found", `no active release for ${skillKey}`);
    }
    return release;
  }

  // ── TOP3 经营任务规则/产物（M4）──────────────────────────────────────

  listRules(): unknown[] {
    return this.facade.operationsJobs.listRules(this.facade.merchantId);
  }

  getRule(ruleId: string): unknown {
    const rule = this.facade.operationsJobs.getRule(this.facade.merchantId, ruleId);
    if (rule === undefined) throw new ManagementError("not_found", `rule ${ruleId} not found`);
    return rule;
  }

  prepareRule(value: unknown): unknown {
    const body = objectBody(value);
    const mode = body.mode === "goal" ? "goal" : "template";
    return this.facade.operationsJobs.prepareRule({
      merchant_id: this.facade.merchantId,
      mode,
      template: text(body, "template") as never,
      trigger_spec: objectBody(body.trigger_spec) as never,
      scope: objectBody(body.scope) as never,
      predicate_spec: objectBody(body.predicate_spec) as never,
      action_type: text(body, "action_type") as never,
      budget: objectBody(body.budget) as never,
      ...(optionalText(body, "goal_text") !== undefined
        ? { goal_text: optionalText(body, "goal_text") }
        : {}),
    });
  }

  activateRule(value: unknown): unknown {
    const body = objectBody(value);
    return this.facade.operationsJobs.activateRule({
      merchant_id: this.facade.merchantId,
      candidate_ref: text(body, "candidate_ref"),
      ...(optionalInteger(body, "expected_generation") !== undefined
        ? { expected_generation: optionalInteger(body, "expected_generation") }
        : {}),
    });
  }

  pauseRule(ruleId: string, value: unknown): unknown {
    const body = objectBody(value);
    return this.facade.operationsJobs.pauseRule({
      merchant_id: this.facade.merchantId,
      rule_id: ruleId,
      expected_version: integer(body, "expected_version"),
      reason: text(body, "reason"),
    });
  }

  listArtifacts(taskId?: string): unknown[] {
    return this.facade.operationsJobs.listArtifacts(this.facade.merchantId, taskId);
  }

  private candidateContentInput(body: Record<string, unknown>, actor: ManagementActorInput) {
    if (!Array.isArray(body.case_ids) || body.case_ids.some((item) => typeof item !== "string")) {
      throw new ManagementError("invalid_input", "case_ids must be a string array");
    }
    if (!Array.isArray(body.proposed_steps)) {
      throw new ManagementError("invalid_input", "proposed_steps must be an array");
    }
    return {
      merchant_id: this.facade.merchantId,
      actor: governanceActor(actor),
      case_ids: body.case_ids as string[],
      skill_key: text(body, "skill_key"),
      trigger: text(body, "trigger"),
      proposed_steps: body.proposed_steps,
      reason: text(body, "reason"),
      ...(body.exclusions !== undefined
        ? { exclusions: stringArray(body, "exclusions") }
        : {}),
      ...(optionalText(body, "base_release_id") !== undefined
        ? { base_release_id: optionalText(body, "base_release_id") }
        : {}),
      ...(body.required_tools !== undefined
        ? { required_tools: stringArray(body, "required_tools") }
        : {}),
    };
  }
}
