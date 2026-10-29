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
 * 方案服务：引擎 + 持久化（v0.2 §9/§10）。
 *
 * 引擎负责规则；本服务负责加载/保存、revision CAS 与幂等键。选择不等于
 * 批准；批准绑定发布前仍须调用 `verifyApproval`。
 */

import { contentDigest } from "../../negotiation/jcs.js";
import {
  createApprovalBinding,
  createSelection,
  markSetStale,
  prepareProposalSet,
  verifyApprovalBinding,
  withdrawSet,
} from "./engine.js";
import { ProposalRepository } from "./repository.js";
import {
  ProposalError,
  type ApprovalBinding,
  type PrepareProposalSetInput,
  type ProposalSet,
  type PublishReference,
  type SelectionRecord,
} from "./types.js";

export interface ProposalServiceOptions {
  repository: ProposalRepository;
  now: () => string;
}

export interface CommandOptions {
  idempotency_key?: string;
}

export interface SelectProposalInput {
  merchant_id: string;
  set_id: string;
  option_id: string;
  selected_by: string;
  requirement_revision: number;
  publish_reference: PublishReference;
  now: string;
}

export class ProposalService {
  private readonly repository: ProposalRepository;
  private readonly now: () => string;

  constructor(options: ProposalServiceOptions) {
    this.repository = options.repository;
    this.now = options.now;
  }

  prepare(input: PrepareProposalSetInput, command: CommandOptions = {}): ProposalSet {
    return this.withIdempotency(input.merchant_id, "proposal_sets.prepare", input, command, () =>
      this.repository.transaction(() => {
        const set = prepareProposalSet(input);
        return this.repository.saveSet(set);
      }),
    );
  }

  get(merchantId: string, setId: string): ProposalSet | undefined {
    return this.repository.getSet(merchantId, setId);
  }

  listForOpportunity(merchantId: string, opportunityId: string): ProposalSet[] {
    return this.repository.listSetsForOpportunity(merchantId, opportunityId);
  }

  select(input: SelectProposalInput, command: CommandOptions = {}): SelectionRecord {
    return this.withIdempotency(input.merchant_id, "proposal_sets.select", input, command, () =>
      this.repository.transaction(() => {
        const set = this.requireSet(input.merchant_id, input.set_id);
        const selection = createSelection({
          merchant_id: input.merchant_id,
          set,
          option_id: input.option_id,
          selected_by: input.selected_by,
          requirement_revision: input.requirement_revision,
          publish_reference: input.publish_reference,
          now: input.now,
        });
        return this.repository.insertSelection(selection);
      }),
    );
  }

  approve(
    input: {
      merchant_id: string;
      set_id: string;
      option_id: string;
      policy_version: string;
      expires_at: string;
      now: string;
    },
    command: CommandOptions = {},
  ): ApprovalBinding {
    return this.withIdempotency(input.merchant_id, "proposal_sets.approve", input, command, () =>
      this.repository.transaction(() => {
        const set = this.requireSet(input.merchant_id, input.set_id);
        const binding = createApprovalBinding({
          merchant_id: input.merchant_id,
          set,
          option_id: input.option_id,
          policy_version: input.policy_version,
          expires_at: input.expires_at,
          now: input.now,
        });
        return this.repository.insertApproval(binding);
      }),
    );
  }

  /** 发布前复验：批准摘要、策略、需求版本、有效期与集合状态必须仍一致。 */
  verifyApproval(input: {
    merchant_id: string;
    approval_id: string;
    option_id: string;
    policy_version: string;
    now: string;
  }): ApprovalBinding {
    const binding = this.repository.getApproval(input.merchant_id, input.approval_id);
    if (binding === undefined) {
      throw new ProposalError("not_found", `approval ${input.approval_id} not found`);
    }
    const set = this.requireSet(input.merchant_id, binding.set_id);
    verifyApprovalBinding({
      binding,
      set,
      option_id: input.option_id,
      policy_version: input.policy_version,
      now: input.now,
    });
    return binding;
  }

  markStale(input: {
    merchant_id: string;
    set_id: string;
    expected_revision: number;
    reason: string;
    now: string;
  }, command: CommandOptions = {}): ProposalSet {
    return this.withIdempotency(input.merchant_id, "proposal_sets.stale", input, command, () =>
      this.repository.transaction(() => {
        const set = this.requireSet(input.merchant_id, input.set_id);
        if (set.revision !== input.expected_revision) {
          throw new ProposalError("validation", "方案集合并发更新冲突");
        }
        const stale = markSetStale(set, input.reason, input.now);
        return this.repository.updateSetStatus({
          merchantId: input.merchant_id,
          setId: input.set_id,
          expectedRevision: input.expected_revision,
          status: stale.status,
          ...(stale.stale_reason !== undefined ? { staleReason: stale.stale_reason } : {}),
        });
      }),
    );
  }

  withdraw(input: {
    merchant_id: string;
    set_id: string;
    expected_revision: number;
    now: string;
  }, command: CommandOptions = {}): ProposalSet {
    return this.withIdempotency(input.merchant_id, "proposal_sets.withdraw", input, command, () =>
      this.repository.transaction(() => {
        const set = this.requireSet(input.merchant_id, input.set_id);
        if (set.revision !== input.expected_revision) {
          throw new ProposalError("validation", "方案集合并发更新冲突");
        }
        const withdrawn = withdrawSet(set, input.now);
        return this.repository.updateSetStatus({
          merchantId: input.merchant_id,
          setId: input.set_id,
          expectedRevision: input.expected_revision,
          status: withdrawn.status,
        });
      }),
    );
  }

  private requireSet(merchantId: string, setId: string): ProposalSet {
    const set = this.repository.getSet(merchantId, setId);
    if (set === undefined) throw new ProposalError("not_found", `set ${setId} not found`);
    return set;
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
    if (key.trim() === "" || key.length > 128) {
      throw new ProposalError("validation", "idempotency_key 必须是非空字符串（≤128）");
    }
    const digest = contentDigest({ operation, request });
    const existing = this.repository.readIdempotent(merchantId, key);
    if (existing !== undefined) {
      if (existing.operation !== operation || existing.requestDigest !== digest) {
        throw new ProposalError("validation", "同一幂等键已用于不同内容");
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
