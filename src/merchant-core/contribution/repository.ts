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
 * 私有成本快照与贡献评估持久化（v0.2 §13 / §16）。
 *
 * 成本快照与贡献评估都是版本化历史：新成本不改写旧报价/订单的评估，
 * 事后核算创建新记录。查询按商家隔离。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ContributionAssessment, CostCompleteness } from "./types.js";

export type CostRefKind = "quote" | "order";

export interface PrivateCostSnapshotRecord {
  snapshot_id: string;
  merchant_id: string;
  ref_kind: CostRefKind;
  ref_id: string;
  currency: string;
  completeness: CostCompleteness;
  costs: Record<string, number>;
  missing_items: string[];
  version: number;
  created_at: string;
}

export interface ContributionAssessmentRecord {
  assessment_id: string;
  merchant_id: string;
  ref_kind: CostRefKind;
  ref_id: string;
  assessment: ContributionAssessment;
  cost_snapshot_id: string | null;
  created_at: string;
}

export interface ContributionRepositoryOptions {
  db: DatabaseSync;
  now: () => string;
}

interface SnapshotRow {
  snapshot_id: string;
  merchant_id: string;
  ref_kind: CostRefKind;
  ref_id: string;
  currency: string;
  completeness: CostCompleteness;
  costs_json: string;
  missing_json: string;
  version: number;
  created_at: string;
}

interface AssessmentRow {
  assessment_id: string;
  merchant_id: string;
  ref_kind: CostRefKind;
  ref_id: string;
  method_version: string;
  kind: ContributionAssessment["kind"];
  completeness: CostCompleteness;
  net_revenue_minor: number;
  costs_json: string;
  contribution_minor: number | null;
  known_contribution_minor: number;
  rate_bps: number | null;
  missing_json: string;
  gate_status: ContributionAssessment["gate"]["status"];
  gate_reasons_json: string;
  cost_snapshot_id: string | null;
  created_at: string;
}

function snapshotFromRow(row: SnapshotRow): PrivateCostSnapshotRecord {
  return {
    snapshot_id: row.snapshot_id,
    merchant_id: row.merchant_id,
    ref_kind: row.ref_kind,
    ref_id: row.ref_id,
    currency: row.currency,
    completeness: row.completeness,
    costs: JSON.parse(row.costs_json) as Record<string, number>,
    missing_items: JSON.parse(row.missing_json) as string[],
    version: row.version,
    created_at: row.created_at,
  };
}

function assessmentFromRow(row: AssessmentRow): ContributionAssessmentRecord {
  const costs = JSON.parse(row.costs_json) as ContributionAssessment["costs"];
  return {
    assessment_id: row.assessment_id,
    merchant_id: row.merchant_id,
    ref_kind: row.ref_kind,
    ref_id: row.ref_id,
    assessment: {
      method_version: "kiwi-contribution/1",
      kind: row.kind,
      completeness: row.completeness,
      net_revenue_minor: row.net_revenue_minor,
      costs,
      contribution_minor: row.contribution_minor,
      known_contribution_minor: row.known_contribution_minor,
      missing_cost_items: JSON.parse(row.missing_json) as string[],
      rate_bps: row.rate_bps,
      rate_percent: row.rate_bps === null ? null : Math.round(row.rate_bps) / 100,
      gate: {
        status: row.gate_status,
        reasons: JSON.parse(row.gate_reasons_json) as string[],
      } as ContributionAssessment["gate"],
    },
    cost_snapshot_id: row.cost_snapshot_id,
    created_at: row.created_at,
  };
}

export class ContributionRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(options: ContributionRepositoryOptions) {
    this.db = options.db;
    this.now = options.now;
  }

  saveCostSnapshot(input: Omit<PrivateCostSnapshotRecord, "snapshot_id" | "created_at">): PrivateCostSnapshotRecord {
    const snapshotId = `cost_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO private_cost_snapshots
          (snapshot_id, merchant_id, ref_kind, ref_id, currency, completeness,
           costs_json, missing_json, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshotId,
        input.merchant_id,
        input.ref_kind,
        input.ref_id,
        input.currency,
        input.completeness,
        JSON.stringify(input.costs),
        JSON.stringify(input.missing_items),
        input.version,
        this.now(),
      );
    return this.getCostSnapshot(input.merchant_id, snapshotId)!;
  }

  getCostSnapshot(merchantId: string, snapshotId: string): PrivateCostSnapshotRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM private_cost_snapshots WHERE merchant_id = ? AND snapshot_id = ?")
      .get(merchantId, snapshotId) as unknown as SnapshotRow | undefined;
    return row === undefined ? undefined : snapshotFromRow(row);
  }

  listCostSnapshots(merchantId: string, refKind: CostRefKind, refId: string): PrivateCostSnapshotRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM private_cost_snapshots
          WHERE merchant_id = ? AND ref_kind = ? AND ref_id = ?
          ORDER BY version DESC, created_at DESC`,
      )
      .all(merchantId, refKind, refId) as unknown as SnapshotRow[];
    return rows.map(snapshotFromRow);
  }

  saveAssessment(input: {
    merchantId: string;
    refKind: CostRefKind;
    refId: string;
    assessment: ContributionAssessment;
    costSnapshotId?: string;
  }): ContributionAssessmentRecord {
    const assessmentId = `contrib_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO contribution_assessments
          (assessment_id, merchant_id, ref_kind, ref_id, method_version, kind, completeness,
           net_revenue_minor, costs_json, contribution_minor, known_contribution_minor, rate_bps,
           missing_json, gate_status, gate_reasons_json, cost_snapshot_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        assessmentId,
        input.merchantId,
        input.refKind,
        input.refId,
        input.assessment.method_version,
        input.assessment.kind,
        input.assessment.completeness,
        input.assessment.net_revenue_minor,
        JSON.stringify(input.assessment.costs),
        input.assessment.contribution_minor,
        input.assessment.known_contribution_minor,
        input.assessment.rate_bps,
        JSON.stringify(input.assessment.missing_cost_items),
        input.assessment.gate.status,
        JSON.stringify(input.assessment.gate.reasons),
        input.costSnapshotId ?? null,
        this.now(),
      );
    return this.getAssessment(input.merchantId, assessmentId)!;
  }

  getAssessment(merchantId: string, assessmentId: string): ContributionAssessmentRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM contribution_assessments WHERE merchant_id = ? AND assessment_id = ?")
      .get(merchantId, assessmentId) as unknown as AssessmentRow | undefined;
    return row === undefined ? undefined : assessmentFromRow(row);
  }

  listAssessments(merchantId: string, refKind: CostRefKind, refId: string): ContributionAssessmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM contribution_assessments
          WHERE merchant_id = ? AND ref_kind = ? AND ref_id = ?
          ORDER BY created_at DESC`,
      )
      .all(merchantId, refKind, refId) as unknown as AssessmentRow[];
    return rows.map(assessmentFromRow);
  }
}
