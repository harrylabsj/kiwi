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
 * 销售机会服务（v0.2 §6 / FR05–FR07）。
 *
 * 入口服务/操作员只通过这里写机会状态；模型工具不能直接改库。状态迁移走
 * 纯函数 `transitionOpportunity`，非法迁移拒绝；来源记录与事件幂等；
 * 相似文本不自动合并，只由获授权操作员显式关联/解除。
 */

import { contentDigest } from "../../negotiation/jcs.js";
import { OpportunityRepository } from "./repository.js";
import { transitionOpportunity, type TransitionResult } from "./state.js";
import {
  OpportunityError,
  type OpportunityEvent,
  type OpportunityLink,
  type OpportunitySource,
  type OpportunitySourceEvent,
  type OpportunityStatus,
  type RequirementField,
  type RequirementSnapshot,
  type SalesOpportunity,
} from "./types.js";

export interface OpportunityServiceOptions {
  repository: OpportunityRepository;
  now: () => string;
}

export interface CommandOptions {
  idempotency_key?: string;
}

export interface IngestSourceInput {
  merchant_id: string;
  source_namespace: string;
  source_account_id: string;
  external_inquiry_id: string;
  external_event_id: string;
  event_kind: string;
  raw_excerpt: string;
  received_at: string;
  operator: string;
  parse_version: string;
  payload?: unknown;
}

export interface CreateOpportunityInput {
  merchant_id: string;
  source_id: string;
  owner: string;
  operator: string;
  next_action: string;
  next_action_due_at?: string;
  rfq_case_id?: string;
  /** 必须已确认才能进入待方案的字段名；空数组表示无硬性字段。 */
  required_fields: string[];
  requirement_fields: RequirementField[];
  basis: string;
}

export interface RecordRequirementInput {
  merchant_id: string;
  opportunity_id: string;
  expected_revision: number;
  fields: RequirementField[];
  required_fields: string[];
  created_by: string;
  actor: string;
}

export interface AdvanceOpportunityInput {
  merchant_id: string;
  opportunity_id: string;
  expected_revision: number;
  event: OpportunityEvent;
  actor: string;
  next_action?: string | null;
  next_action_due_at?: string | null;
  waiting_reason?: string | null;
}

function requireText(value: unknown, name: string, max = 512): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new OpportunityError("validation", `${name} 必须是非空字符串（≤${max}）`);
  }
  return value;
}

function requireTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new OpportunityError("validation", `${name} 必须是可解析的 RFC 3339 时间`);
  }
  return value;
}

function normalizeFields(fields: RequirementField[]): RequirementField[] {
  if (!Array.isArray(fields)) throw new OpportunityError("validation", "fields 必须是数组");
  const seen = new Set<string>();
  return fields.map((field, index) => {
    const name = requireText(field?.field, `fields[${index}].field`, 128);
    if (seen.has(name)) throw new OpportunityError("validation", `重复字段：${name}`);
    seen.add(name);
    if (field.status !== "CONFIRMED" && field.status !== "UNCONFIRMED" && field.status !== "UNKNOWN") {
      throw new OpportunityError("validation", `fields[${index}].status 非法`);
    }
    const value = field.value;
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new OpportunityError("validation", `fields[${index}].value 类型非法`);
    }
    if (field.status === "CONFIRMED") {
      requireText(field.confirmed_by, `fields[${index}].confirmed_by`, 128);
      requireTimestamp(field.confirmed_at, `fields[${index}].confirmed_at`);
    }
    return {
      field: name,
      value,
      status: field.status,
      ...(field.source !== undefined ? { source: requireText(field.source, `fields[${index}].source`, 128) } : {}),
      ...(field.confirmed_by !== undefined ? { confirmed_by: field.confirmed_by } : {}),
      ...(field.confirmed_at !== undefined ? { confirmed_at: field.confirmed_at } : {}),
    };
  });
}

function isComplete(fields: RequirementField[], required: string[]): boolean {
  const byName = new Map(fields.map((field) => [field.field, field]));
  return required.every((name) => byName.get(name)?.status === "CONFIRMED");
}

export class OpportunityService {
  private readonly repository: OpportunityRepository;
  private readonly now: () => string;

  constructor(options: OpportunityServiceOptions) {
    this.repository = options.repository;
    this.now = options.now;
  }

  /** 来源摄取：同一外部询盘/事件重复进入不新建记录；相似文本不自动合并。 */
  ingestSource(input: IngestSourceInput): {
    source: OpportunitySource;
    event: OpportunitySourceEvent;
    created_source: boolean;
    created_event: boolean;
  } {
    const merchantId = requireText(input.merchant_id, "merchant_id", 128);
    const namespace = requireText(input.source_namespace, "source_namespace", 64);
    const account = requireText(input.source_account_id, "source_account_id", 128);
    const inquiryId = requireText(input.external_inquiry_id, "external_inquiry_id", 256);
    const eventId = requireText(input.external_event_id, "external_event_id", 256);
    const eventKind = requireText(input.event_kind, "event_kind", 64);
    const rawExcerpt = requireText(input.raw_excerpt, "raw_excerpt", 16_384);
    const receivedAt = requireTimestamp(input.received_at, "received_at");
    const operator = requireText(input.operator, "operator", 128);
    const parseVersion = requireText(input.parse_version, "parse_version", 64);

    return this.repository.transaction(() => {
      const existingSource = this.repository.getSourceByExternalId({
        merchantId,
        sourceNamespace: namespace,
        sourceAccountId: account,
        externalInquiryId: inquiryId,
      });
      const source =
        existingSource ??
        this.repository.insertSource({
          merchant_id: merchantId,
          source_namespace: namespace,
          source_account_id: account,
          external_inquiry_id: inquiryId,
          raw_excerpt: rawExcerpt,
          received_at: receivedAt,
          operator,
          parse_version: parseVersion,
        });
      if (existingSource !== undefined) this.repository.touchSource(merchantId, source.source_id);

      const existingEvent = this.repository.getSourceEvent(source.source_id, eventId);
      const event =
        existingEvent ??
        this.repository.insertSourceEvent({
          sourceId: source.source_id,
          externalEventId: eventId,
          eventKind,
          payload: input.payload ?? { raw_excerpt: rawExcerpt, event_kind: eventKind },
          receivedAt,
        });
      return {
        source,
        event,
        created_source: existingSource === undefined,
        created_event: existingEvent === undefined,
      };
    });
  }

  createOpportunity(
    input: CreateOpportunityInput,
    command: CommandOptions = {},
  ): {
    opportunity: SalesOpportunity;
    requirement: RequirementSnapshot;
    link: OpportunityLink;
    side_effects: string[];
  } {
    const fields = normalizeFields(input.requirement_fields);
    const complete = isComplete(fields, input.required_fields);
    return this.withIdempotency(input.merchant_id, "opportunities.create", input, command, () =>
      this.repository.transaction(() => {
        const source = this.repository.getSource(input.merchant_id, input.source_id);
        if (source === undefined) {
          throw new OpportunityError("not_found", `source ${input.source_id} not found`);
        }
        const existingLink = this.repository.getLinkBySource(input.source_id);
        if (existingLink !== undefined && existingLink.status === "LINKED") {
          throw new OpportunityError("source_conflict", "该来源已关联到其他机会；请先解除错误关联");
        }
        const transition = transitionOpportunity("NEW", { type: "INGEST", complete });
        const opportunity = this.repository.insertOpportunity({
          merchantId: input.merchant_id,
          status: transition.to,
          owner: requireText(input.owner, "owner", 128),
          nextAction: requireText(input.next_action, "next_action", 512),
          ...(input.next_action_due_at !== undefined
            ? { nextActionDueAt: requireTimestamp(input.next_action_due_at, "next_action_due_at") }
            : {}),
          ...(input.rfq_case_id !== undefined
            ? { rfqCaseId: requireText(input.rfq_case_id, "rfq_case_id", 128) }
            : {}),
        });
        const requirement = this.repository.insertRequirement({
          merchantId: input.merchant_id,
          opportunityId: opportunity.opportunity_id,
          revision: 1,
          fields,
          createdBy: input.operator,
        });
        const basis = requireText(input.basis, "basis", 512);
        const operator = requireText(input.operator, "operator", 128);
        const link =
          existingLink === undefined
            ? this.repository.insertLink({
                merchantId: input.merchant_id,
                opportunityId: opportunity.opportunity_id,
                sourceId: input.source_id,
                basis,
                confirmedBy: operator,
                confirmedAt: this.now(),
              })
            : this.repository.updateLink({
                linkId: existingLink.link_id,
                merchantId: input.merchant_id,
                expectedRevision: existingLink.revision,
                opportunityId: opportunity.opportunity_id,
                status: "LINKED",
                basis,
                confirmedBy: operator,
                confirmedAt: this.now(),
              });
        this.repository.appendLinkEvent({
          merchantId: input.merchant_id,
          linkId: link.link_id,
          opportunityId: opportunity.opportunity_id,
          sourceId: input.source_id,
          event: "LINKED",
          actor: input.operator,
          basis: input.basis,
        });
        this.repository.appendOpportunityEvent({
          merchantId: input.merchant_id,
          opportunityId: opportunity.opportunity_id,
          event: "INGEST",
          fromStatus: "NEW",
          toStatus: opportunity.status,
          actor: input.operator,
          sideEffects: transition.side_effects,
          detail: { source_id: input.source_id, complete },
        });
        return {
          opportunity,
          requirement,
          link,
          side_effects: transition.side_effects,
        };
      }),
    );
  }

  recordRequirement(
    input: RecordRequirementInput,
    command: CommandOptions = {},
  ): { opportunity: SalesOpportunity; requirement: RequirementSnapshot; transition: TransitionResult } {
    const fields = normalizeFields(input.fields);
    const complete = isComplete(fields, input.required_fields);
    return this.withIdempotency(input.merchant_id, "opportunities.requirement", input, command, () =>
      this.repository.transaction(() => {
        const current = this.requireOpportunity(input.merchant_id, input.opportunity_id);
        if (current.revision !== input.expected_revision) {
          throw new OpportunityError("version_conflict", "机会已被其他操作修改，请刷新后重试");
        }
        const transition = transitionOpportunity(current.status, {
          type: "REQUIREMENT_UPDATED",
          complete,
        });
        const latest = this.repository.getLatestRequirement(input.merchant_id, input.opportunity_id);
        const requirement = this.repository.insertRequirement({
          merchantId: input.merchant_id,
          opportunityId: input.opportunity_id,
          revision: (latest?.revision ?? 0) + 1,
          fields,
          createdBy: input.created_by,
        });
        const opportunity = this.repository.updateOpportunity({
          merchantId: input.merchant_id,
          opportunityId: input.opportunity_id,
          expectedRevision: input.expected_revision,
          status: transition.to,
        });
        this.repository.appendOpportunityEvent({
          merchantId: input.merchant_id,
          opportunityId: input.opportunity_id,
          event: "REQUIREMENT_UPDATED",
          fromStatus: current.status,
          toStatus: opportunity.status,
          actor: input.actor,
          sideEffects: transition.side_effects,
          detail: { requirement_revision: requirement.revision, complete },
        });
        return { opportunity, requirement, transition };
      }),
    );
  }

  advance(
    input: AdvanceOpportunityInput,
    command: CommandOptions = {},
  ): { opportunity: SalesOpportunity; transition: TransitionResult } {
    return this.withIdempotency(input.merchant_id, `opportunities.${input.event.type}`, input, command, () =>
      this.repository.transaction(() => {
        const current = this.requireOpportunity(input.merchant_id, input.opportunity_id);
        if (current.revision !== input.expected_revision) {
          throw new OpportunityError("version_conflict", "机会已被其他操作修改，请刷新后重试");
        }
        const transition = transitionOpportunity(current.status, input.event);
        const waitingReason =
          input.waiting_reason ??
          (input.event.type === "WAIT_CUSTOMER" ? input.event.reason : undefined);
        const opportunity = this.repository.updateOpportunity({
          merchantId: input.merchant_id,
          opportunityId: input.opportunity_id,
          expectedRevision: input.expected_revision,
          status: transition.to,
          ...(input.next_action !== undefined ? { nextAction: input.next_action } : {}),
          ...(input.next_action_due_at !== undefined
            ? { nextActionDueAt: requireTimestamp(input.next_action_due_at, "next_action_due_at") }
            : {}),
          ...(waitingReason !== undefined ? { waitingReason } : {}),
        });
        this.repository.appendOpportunityEvent({
          merchantId: input.merchant_id,
          opportunityId: input.opportunity_id,
          event: input.event.type,
          fromStatus: current.status,
          toStatus: opportunity.status,
          actor: input.actor,
          sideEffects: transition.side_effects,
          detail: input.event as unknown as Record<string, unknown>,
        });
        return { opportunity, transition };
      }),
    );
  }

  linkSource(input: {
    merchant_id: string;
    opportunity_id: string;
    source_id: string;
    basis: string;
    operator: string;
  }, command: CommandOptions = {}): OpportunityLink {
    return this.withIdempotency(input.merchant_id, "opportunities.link", input, command, () =>
      this.repository.transaction(() => {
        this.requireOpportunity(input.merchant_id, input.opportunity_id);
        if (this.repository.getSource(input.merchant_id, input.source_id) === undefined) {
          throw new OpportunityError("not_found", `source ${input.source_id} not found`);
        }
        const existing = this.repository.getLinkBySource(input.source_id);
        if (existing !== undefined && existing.status === "LINKED") {
          if (existing.opportunity_id === input.opportunity_id) return existing;
          throw new OpportunityError("source_conflict", "该来源已关联到其他机会；请先解除错误关联");
        }
        const link =
          existing === undefined
            ? this.repository.insertLink({
                merchantId: input.merchant_id,
                opportunityId: input.opportunity_id,
                sourceId: input.source_id,
                basis: requireText(input.basis, "basis", 512),
                confirmedBy: requireText(input.operator, "operator", 128),
                confirmedAt: this.now(),
              })
            : this.repository.updateLink({
                linkId: existing.link_id,
                merchantId: input.merchant_id,
                expectedRevision: existing.revision,
                opportunityId: input.opportunity_id,
                status: "LINKED",
                basis: requireText(input.basis, "basis", 512),
                confirmedBy: requireText(input.operator, "operator", 128),
                confirmedAt: this.now(),
              });
        this.repository.appendLinkEvent({
          merchantId: input.merchant_id,
          linkId: link.link_id,
          opportunityId: input.opportunity_id,
          sourceId: input.source_id,
          event: "LINKED",
          actor: input.operator,
          basis: input.basis,
        });
        return link;
      }),
    );
  }

  unlinkSource(input: {
    merchant_id: string;
    source_id: string;
    basis: string;
    operator: string;
  }, command: CommandOptions = {}): OpportunityLink {
    return this.withIdempotency(input.merchant_id, "opportunities.unlink", input, command, () =>
      this.repository.transaction(() => {
        const existing = this.repository.getLinkBySource(input.source_id);
        if (existing === undefined || existing.status === "UNLINKED") {
          throw new OpportunityError("not_found", "该来源没有可解除的关联");
        }
        const link = this.repository.updateLink({
          linkId: existing.link_id,
          merchantId: input.merchant_id,
          expectedRevision: existing.revision,
          opportunityId: existing.opportunity_id,
          status: "UNLINKED",
          basis: requireText(input.basis, "basis", 512),
          confirmedBy: requireText(input.operator, "operator", 128),
          confirmedAt: this.now(),
        });
        this.repository.appendLinkEvent({
          merchantId: input.merchant_id,
          linkId: link.link_id,
          opportunityId: existing.opportunity_id,
          sourceId: input.source_id,
          event: "UNLINKED",
          actor: input.operator,
          basis: input.basis,
        });
        return link;
      }),
    );
  }

  getOpportunity(merchantId: string, opportunityId: string): SalesOpportunity | undefined {
    return this.repository.getOpportunity(merchantId, opportunityId);
  }

  listOpportunities(
    merchantId: string,
    filter: { status?: OpportunityStatus; owner?: string } = {},
  ): SalesOpportunity[] {
    return this.repository.listOpportunities(merchantId, filter);
  }

  private requireOpportunity(merchantId: string, opportunityId: string): SalesOpportunity {
    const opportunity = this.repository.getOpportunity(merchantId, opportunityId);
    if (opportunity === undefined) {
      throw new OpportunityError("not_found", `opportunity ${opportunityId} not found`);
    }
    return opportunity;
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
        throw new OpportunityError("idempotency_conflict", "同一幂等键已用于不同内容");
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
