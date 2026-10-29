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
 * 方案集合持久化（v0.2 §9.3 / §16）。
 *
 * 集合与选项同事务写入；集合状态用 revision CAS 更新。选项里的 pricing 是
 * 计算快照，公开投影仍由引擎生成，不直接回放数据库字段。
 */

import type { DatabaseSync } from "node:sqlite";

import { contentDigest } from "../../negotiation/jcs.js";
import { ProposalError } from "./types.js";
import type {
  ApprovalBinding,
  ProposalOption,
  ProposalSet,
  ProposalSetStatus,
  SelectionRecord,
} from "./types.js";

export interface ProposalRepositoryOptions {
  db: DatabaseSync;
  now: () => string;
}

interface SetRow {
  set_id: string;
  merchant_id: string;
  opportunity_id: string;
  requirement_revision: number;
  facts_digest: string;
  policy_version: string;
  status: ProposalSetStatus;
  stale_reason: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface OptionRow {
  set_id: string;
  option_id: string;
  sku: string;
  unit: string;
  quantity: number;
  unit_price_minor: number | null;
  currency: string;
  pricing_json: string | null;
  valid_until: string | null;
  price_source_json: string | null;
  adaptation_json: string;
  eligibility: ProposalOption["eligibility"];
  blocking_json: string;
  is_alternative: number;
  note: string | null;
}

interface SelectionRow {
  selection_id: string;
  merchant_id: string;
  set_id: string;
  option_id: string;
  selected_by: string;
  selected_at: string;
  requirement_revision: number;
  publish_ref_json: string;
}

interface ApprovalRow {
  approval_id: string;
  merchant_id: string;
  set_id: string;
  option_id: string;
  opportunity_id: string;
  requirement_revision: number;
  policy_version: string;
  content_digest: string;
  scope: "publish_quote";
  expires_at: string;
  created_at: string;
}

function optionFromRow(row: OptionRow): ProposalOption {
  return {
    option_id: row.option_id,
    sku: row.sku,
    unit: row.unit,
    quantity: row.quantity,
    currency: "CNY",
    ...(row.unit_price_minor !== null ? { unit_price_minor: row.unit_price_minor } : {}),
    ...(row.pricing_json !== null ? { pricing: JSON.parse(row.pricing_json) as ProposalOption["pricing"] } : {}),
    ...(row.valid_until !== null ? { valid_until: row.valid_until } : {}),
    ...(row.price_source_json !== null
      ? { price_source: JSON.parse(row.price_source_json) as ProposalOption["price_source"] }
      : {}),
    adaptation: JSON.parse(row.adaptation_json) as ProposalOption["adaptation"],
    eligibility: row.eligibility,
    blocking_reasons: JSON.parse(row.blocking_json) as string[],
    is_alternative: row.is_alternative === 1,
    ...(row.note !== null ? { note: row.note } : {}),
  };
}

function setFromRows(set: SetRow, options: OptionRow[]): ProposalSet {
  return {
    set_id: set.set_id,
    merchant_id: set.merchant_id,
    opportunity_id: set.opportunity_id,
    requirement_revision: set.requirement_revision,
    facts_digest: set.facts_digest,
    policy_version: set.policy_version,
    status: set.status,
    options: options.map(optionFromRow),
    created_at: set.created_at,
    updated_at: set.updated_at,
    revision: set.revision,
    ...(set.stale_reason !== null ? { stale_reason: set.stale_reason } : {}),
  };
}

export class ProposalRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private inTx = false;

  constructor(options: ProposalRepositoryOptions) {
    this.db = options.db;
    this.now = options.now;
  }

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

  saveSet(set: ProposalSet): ProposalSet {
    this.db
      .prepare(
        `INSERT INTO proposal_sets
          (set_id, merchant_id, opportunity_id, requirement_revision, facts_digest,
           policy_version, status, stale_reason, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        set.set_id,
        set.merchant_id,
        set.opportunity_id,
        set.requirement_revision,
        set.facts_digest,
        set.policy_version,
        set.status,
        set.stale_reason ?? null,
        set.revision,
        set.created_at,
        set.updated_at,
      );
    for (const option of set.options) {
      this.db
        .prepare(
          `INSERT INTO proposal_options
            (set_id, option_id, sku, unit, quantity, unit_price_minor, currency,
             pricing_json, valid_until, price_source_json, adaptation_json,
             eligibility, blocking_json, is_alternative, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          set.set_id,
          option.option_id,
          option.sku,
          option.unit,
          option.quantity,
          option.unit_price_minor ?? null,
          option.currency,
          option.pricing !== undefined ? JSON.stringify(option.pricing) : null,
          option.valid_until ?? null,
          option.price_source !== undefined ? JSON.stringify(option.price_source) : null,
          JSON.stringify(option.adaptation),
          option.eligibility,
          JSON.stringify(option.blocking_reasons),
          option.is_alternative ? 1 : 0,
          option.note ?? null,
        );
    }
    return this.getSet(set.merchant_id, set.set_id)!;
  }

  getSet(merchantId: string, setId: string): ProposalSet | undefined {
    const row = this.db
      .prepare("SELECT * FROM proposal_sets WHERE merchant_id = ? AND set_id = ?")
      .get(merchantId, setId) as unknown as SetRow | undefined;
    if (row === undefined) return undefined;
    const options = this.db
      .prepare("SELECT * FROM proposal_options WHERE set_id = ? ORDER BY rowid")
      .all(setId) as unknown as OptionRow[];
    return setFromRows(row, options);
  }

  listSetsForOpportunity(merchantId: string, opportunityId: string): ProposalSet[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM proposal_sets
          WHERE merchant_id = ? AND opportunity_id = ?
          ORDER BY updated_at DESC`,
      )
      .all(merchantId, opportunityId) as unknown as SetRow[];
    const optionsFor = this.db.prepare("SELECT * FROM proposal_options WHERE set_id = ? ORDER BY rowid");
    return rows.map((row) => setFromRows(row, optionsFor.all(row.set_id) as unknown as OptionRow[]));
  }

  updateSetStatus(input: {
    merchantId: string;
    setId: string;
    expectedRevision: number;
    status: ProposalSetStatus;
    staleReason?: string;
  }): ProposalSet {
    const result = this.db
      .prepare(
        `UPDATE proposal_sets
            SET status = ?, stale_reason = ?, revision = revision + 1, updated_at = ?
          WHERE merchant_id = ? AND set_id = ? AND revision = ?`,
      )
      .run(
        input.status,
        input.staleReason ?? null,
        this.now(),
        input.merchantId,
        input.setId,
        input.expectedRevision,
      );
    if (Number(result.changes) !== 1) {
      throw new ProposalError("validation", "方案集合并发更新冲突");
    }
    return this.getSet(input.merchantId, input.setId)!;
  }

  insertSelection(record: SelectionRecord): SelectionRecord {
    this.db
      .prepare(
        `INSERT INTO proposal_selections
          (selection_id, merchant_id, set_id, option_id, selected_by, selected_at,
           requirement_revision, publish_ref_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.selection_id,
        record.merchant_id,
        record.set_id,
        record.option_id,
        record.selected_by,
        record.selected_at,
        record.requirement_revision,
        JSON.stringify(record.publish_reference),
      );
    return this.getSelection(record.merchant_id, record.selection_id)!;
  }

  getSelection(merchantId: string, selectionId: string): SelectionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM proposal_selections WHERE merchant_id = ? AND selection_id = ?")
      .get(merchantId, selectionId) as unknown as SelectionRow | undefined;
    if (row === undefined) return undefined;
    return {
      selection_id: row.selection_id,
      merchant_id: row.merchant_id,
      set_id: row.set_id,
      option_id: row.option_id,
      selected_by: row.selected_by,
      selected_at: row.selected_at,
      requirement_revision: row.requirement_revision,
      publish_reference: JSON.parse(row.publish_ref_json) as SelectionRecord["publish_reference"],
    };
  }

  insertApproval(binding: ApprovalBinding): ApprovalBinding {
    this.db
      .prepare(
        `INSERT INTO proposal_approvals
          (approval_id, merchant_id, set_id, option_id, opportunity_id,
           requirement_revision, policy_version, content_digest, scope, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.approval_id,
        binding.merchant_id,
        binding.set_id,
        binding.option_id,
        binding.opportunity_id,
        binding.requirement_revision,
        binding.policy_version,
        binding.content_digest,
        binding.scope,
        binding.expires_at,
        binding.created_at,
      );
    return this.getApproval(binding.merchant_id, binding.approval_id)!;
  }

  getApproval(merchantId: string, approvalId: string): ApprovalBinding | undefined {
    const row = this.db
      .prepare("SELECT * FROM proposal_approvals WHERE merchant_id = ? AND approval_id = ?")
      .get(merchantId, approvalId) as unknown as ApprovalRow | undefined;
    return row === undefined ? undefined : { ...row };
  }

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
