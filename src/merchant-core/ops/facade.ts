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
 * 商家经营门面（v0.2 §15.1 / §17）。
 *
 * 把经营计划与机会服务装配到同一 `state.sqlite`，并由构造时的认证主体
 * 注入 `merchant_id`——调用方（HTTP/MCP/CLI）不传商家身份，避免信任工具
 * 参数。后续方案/跟进/订单持久化也接到这个门面，保持一个写入口。
 */

import type { DatabaseSync } from "node:sqlite";

import { migrateMerchantOpsSchema } from "./schema.js";
import { MerchantOperatingPlanRepository } from "../operating/repository.js";
import {
  MerchantOperatingPlanService,
  type CommandOptions,
} from "../operating/service.js";
import type {
  OperatingPlan,
  OperatingPlanInput,
  OperatingPlanReadiness,
  PlanReadinessInput,
  SwitchPlanVersionInput,
  UpdateOperatingPlanInput,
} from "../operating/types.js";
import { OpportunityRepository } from "../opportunity/repository.js";
import {
  OpportunityService,
  type CreateOpportunityInput,
  type IngestSourceInput,
  type RecordRequirementInput,
} from "../opportunity/service.js";
import type {
  OpportunityEvent,
  OpportunityStatus,
  SalesOpportunity,
} from "../opportunity/types.js";
import {
  ProposalService,
  type SelectProposalInput,
} from "../proposal/service.js";
import { ProposalRepository } from "../proposal/repository.js";
import type {
  ApprovalBinding,
  PrepareProposalSetInput,
  ProposalSet,
  SelectionRecord,
} from "../proposal/types.js";
import { FollowUpRepository, type FollowUpTask } from "../followup/repository.js";
import { FollowUpService, type ScheduleFollowUpInput } from "../followup/service.js";
import type { FollowUpStatus } from "../followup/types.js";
import { MerchantOrderService, type ManualOrderReportInput } from "../orders/service.js";
import type { OrderRecordV2 } from "../orders/repository.js";
import { OrderRepository } from "../orders/repository.js";
import type { AttributionInput, RefundFact } from "../orders/model.js";
import { ContributionRepository } from "../contribution/repository.js";
import type { ContributionInput } from "../contribution/types.js";

export interface MerchantOperationsFacadeOptions {
  db: DatabaseSync;
  merchantId: string;
  now?: () => string;
}

export class MerchantOperationsFacade {
  readonly plans: MerchantOperatingPlanService;
  readonly opportunities: OpportunityService;
  readonly proposals: ProposalService;
  readonly followups: FollowUpService;
  readonly orders: MerchantOrderService;
  readonly contributions: ContributionRepository;
  readonly merchantId: string;

  constructor(options: MerchantOperationsFacadeOptions) {
    if (typeof options.merchantId !== "string" || options.merchantId.trim() === "") {
      throw new Error("merchantId must be a non-empty string");
    }
    this.merchantId = options.merchantId;
    const now = options.now ?? (() => new Date().toISOString());
    this.plans = new MerchantOperatingPlanService({
      repository: new MerchantOperatingPlanRepository({ db: options.db, now }),
      now,
    });
    this.opportunities = new OpportunityService({
      repository: new OpportunityRepository({ db: options.db, now }),
      now,
    });
    this.proposals = new ProposalService({
      repository: new ProposalRepository({ db: options.db, now }),
      now,
    });
    this.followups = new FollowUpService({
      repository: new FollowUpRepository({ db: options.db, now }),
      now,
    });
    this.contributions = new ContributionRepository({ db: options.db, now });
    this.orders = new MerchantOrderService({
      orders: new OrderRepository({ db: options.db, now }),
      contributions: this.contributions,
    });
  }

  createPlan(input: Omit<OperatingPlanInput, "merchant_id">, command: CommandOptions = {}): OperatingPlan {
    return this.plans.create({ ...input, merchant_id: this.merchantId }, command);
  }

  updatePlan(
    input: Omit<UpdateOperatingPlanInput, "merchant_id">,
    command: CommandOptions = {},
  ): OperatingPlan {
    return this.plans.update({ ...input, merchant_id: this.merchantId }, command);
  }

  switchPlanVersion(
    input: Omit<SwitchPlanVersionInput, "merchant_id">,
    command: CommandOptions = {},
  ): { previous: OperatingPlan; next: OperatingPlan } {
    return this.plans.switchVersion({ ...input, merchant_id: this.merchantId }, command);
  }

  pausePlan(planId: string, expectedRevision: number, actor?: string): OperatingPlan {
    return this.plans.pause(
      {
        merchant_id: this.merchantId,
        plan_id: planId,
        expected_revision: expectedRevision,
        ...(actor !== undefined ? { actor } : {}),
      },
      actor !== undefined ? { actor } : {},
    );
  }

  resumePlan(planId: string, expectedRevision: number, actor?: string): OperatingPlan {
    return this.plans.resume(
      {
        merchant_id: this.merchantId,
        plan_id: planId,
        expected_revision: expectedRevision,
        ...(actor !== undefined ? { actor } : {}),
      },
      actor !== undefined ? { actor } : {},
    );
  }

  getEffectivePlan(input: {
    source: string;
    sourceAccountId: string;
    sku: string;
    at?: string;
  }): OperatingPlan | undefined {
    return this.plans.getEffective({ merchantId: this.merchantId, ...input });
  }

  listPlans(filter: Parameters<MerchantOperatingPlanService["list"]>[1] = {}): OperatingPlan[] {
    return this.plans.list(this.merchantId, filter);
  }

  planReadiness(plan: OperatingPlan, input: PlanReadinessInput): OperatingPlanReadiness {
    return this.plans.readiness(plan, input);
  }

  ingestSource(input: Omit<IngestSourceInput, "merchant_id">): ReturnType<OpportunityService["ingestSource"]> {
    return this.opportunities.ingestSource({ ...input, merchant_id: this.merchantId });
  }

  createOpportunity(
    input: Omit<CreateOpportunityInput, "merchant_id">,
    command: CommandOptions = {},
  ): ReturnType<OpportunityService["createOpportunity"]> {
    return this.opportunities.createOpportunity(
      { ...input, merchant_id: this.merchantId },
      command,
    );
  }

  recordRequirement(
    input: Omit<RecordRequirementInput, "merchant_id">,
    command: CommandOptions = {},
  ): ReturnType<OpportunityService["recordRequirement"]> {
    return this.opportunities.recordRequirement(
      { ...input, merchant_id: this.merchantId },
      command,
    );
  }

  advanceOpportunity(
    input: {
      opportunity_id: string;
      expected_revision: number;
      event: OpportunityEvent;
      actor: string;
      next_action?: string | null;
      next_action_due_at?: string | null;
      waiting_reason?: string | null;
    },
    command: CommandOptions = {},
  ): ReturnType<OpportunityService["advance"]> {
    return this.opportunities.advance(
      { ...input, merchant_id: this.merchantId },
      command,
    );
  }

  getOpportunity(opportunityId: string): SalesOpportunity | undefined {
    return this.opportunities.getOpportunity(this.merchantId, opportunityId);
  }

  listOpportunities(
    filter: { status?: OpportunityStatus; owner?: string } = {},
  ): SalesOpportunity[] {
    return this.opportunities.listOpportunities(this.merchantId, filter);
  }

  prepareProposal(
    input: Omit<PrepareProposalSetInput, "merchant_id">,
    command: CommandOptions = {},
  ): ProposalSet {
    return this.proposals.prepare({ ...input, merchant_id: this.merchantId }, command);
  }

  selectProposal(
    input: Omit<SelectProposalInput, "merchant_id">,
    command: CommandOptions = {},
  ): SelectionRecord {
    return this.proposals.select({ ...input, merchant_id: this.merchantId }, command);
  }

  approveProposal(
    input: { set_id: string; option_id: string; policy_version: string; expires_at: string; now: string },
    command: CommandOptions = {},
  ): ApprovalBinding {
    return this.proposals.approve({ ...input, merchant_id: this.merchantId }, command);
  }

  verifyProposalApproval(input: {
    approval_id: string;
    option_id: string;
    policy_version: string;
    now: string;
  }): ApprovalBinding {
    return this.proposals.verifyApproval({ ...input, merchant_id: this.merchantId });
  }

  markProposalStale(input: {
    set_id: string;
    expected_revision: number;
    reason: string;
    now: string;
  }, command: CommandOptions = {}): ProposalSet {
    return this.proposals.markStale({ ...input, merchant_id: this.merchantId }, command);
  }

  withdrawProposal(input: {
    set_id: string;
    expected_revision: number;
    now: string;
  }, command: CommandOptions = {}): ProposalSet {
    return this.proposals.withdraw({ ...input, merchant_id: this.merchantId }, command);
  }

  getProposal(setId: string): ProposalSet | undefined {
    return this.proposals.get(this.merchantId, setId);
  }

  listProposals(opportunityId: string): ProposalSet[] {
    return this.proposals.listForOpportunity(this.merchantId, opportunityId);
  }

  scheduleFollowUp(input: Omit<ScheduleFollowUpInput, "merchant_id">): FollowUpTask {
    return this.followups.schedule({ ...input, merchant_id: this.merchantId }).task;
  }

  listFollowUps(
    filter: { status?: FollowUpStatus; opportunityId?: string } = {},
  ): FollowUpTask[] {
    return this.followups.list(this.merchantId, filter);
  }

  claimFollowUp(taskId: string, workerId: string, leaseMs: number): FollowUpTask {
    return this.followups.claim({
      merchant_id: this.merchantId,
      task_id: taskId,
      worker_id: workerId,
      lease_ms: leaseMs,
    }).task;
  }

  finishFollowUp(input: {
    task_id: string;
    fencing_token: number;
    outcome: "succeeded" | "failed" | "unknown";
    receipt?: Record<string, unknown>;
    error_code?: string;
  }): FollowUpTask {
    return this.followups.finish({ ...input, merchant_id: this.merchantId });
  }

  stopFollowUp(taskId: string, inFlight: boolean): FollowUpTask {
    return this.followups.stop({
      merchant_id: this.merchantId,
      task_id: taskId,
      in_flight: inFlight,
    });
  }

  recoverFollowUps(): FollowUpTask[] {
    return this.followups.recoverExpiredLeases(this.merchantId);
  }

  listOrders(): OrderRecordV2[] {
    return this.orders.listOrders(this.merchantId);
  }

  getOrder(recordId: string): OrderRecordV2 | undefined {
    return this.orders.getOrder(this.merchantId, recordId);
  }

  recordManualOrder(input: Omit<ManualOrderReportInput, "identity"> & {
    source_namespace: string;
    source_account_id: string;
    external_order_id: string;
  }): OrderRecordV2 {
    return this.orders.recordManualReport({
      ...input,
      identity: {
        merchant_id: this.merchantId,
        source_namespace: input.source_namespace,
        source_account_id: input.source_account_id,
        external_order_id: input.external_order_id,
      },
    });
  }

  recordCsvOrderReport(input: { csv: string; reportedBy: string; observedAtFallback: string }): OrderRecordV2[] {
    return this.orders.recordCsvReport({ merchantId: this.merchantId, ...input });
  }

  verifyOrder(recordId: string, input: { verified: boolean; source_version: string; verified_at: string }): OrderRecordV2 {
    return this.orders.verifyWithSourceFact({
      merchantId: this.merchantId,
      recordId,
      ...input,
    });
  }

  attributeOrder(recordId: string, allocations: AttributionInput[]): ReturnType<MerchantOrderService["attribute"]> {
    return this.orders.attribute(recordId, allocations);
  }

  recordOrderRefund(recordId: string, refund: RefundFact): { status: string; totalMinor: number } {
    return this.orders.recordRefund({ merchantId: this.merchantId, recordId, refund });
  }

  assessOrderContribution(recordId: string, contribution: ContributionInput, costSnapshotId?: string): ReturnType<MerchantOrderService["assessContribution"]> {
    return this.orders.assessContribution({
      merchantId: this.merchantId,
      recordId,
      contribution,
      ...(costSnapshotId !== undefined ? { costSnapshotId } : {}),
    });
  }

  linkOpportunitySource(input: {
    opportunity_id: string;
    source_id: string;
    basis: string;
    operator: string;
  }): ReturnType<OpportunityService["linkSource"]> {
    return this.opportunities.linkSource({ ...input, merchant_id: this.merchantId });
  }

  unlinkOpportunitySource(input: {
    source_id: string;
    basis: string;
    operator: string;
  }): ReturnType<OpportunityService["unlinkSource"]> {
    return this.opportunities.unlinkSource({ ...input, merchant_id: this.merchantId });
  }
}

/** 打开门面；数据库缺迁移时先补到当前版本（幂等）。 */
export function openMerchantOperationsFacade(
  options: MerchantOperationsFacadeOptions,
): MerchantOperationsFacade {
  migrateMerchantOpsSchema(options.db);
  return new MerchantOperationsFacade(options);
}
