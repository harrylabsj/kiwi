/**
 * 经营任务投影：真实机会/报价映射到 no_change / eligible / data_incomplete。
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { registerGovernanceLedgers } from "../src/merchant-core/migrations/ledgers.js";
import { OperationsProjection } from "../src/merchant-core/operations-jobs/projection.js";
import type { AutomationRule } from "../src/merchant-core/operations-jobs/service.js";

const NOW = "2026-11-18T00:00:00.000Z";
const MERCHANT = "m-1";

function rule(template: AutomationRule["template"]): AutomationRule {
  return {
    rule_id: "rule-1",
    merchant_id: MERCHANT,
    version: 1,
    template,
    trigger_spec: { kind: "daily_local", local_time: "09:00", timezone: "Asia/Shanghai" },
    timezone: "Asia/Shanghai",
    scope: { window: "previous_local_day" },
    predicate_spec: { kind: "fixed_template", template },
    action_type: "internal_summary",
    budget: { max_runs_per_day: 1 },
    authorization_ref: null,
    effective_at: NOW,
    expires_at: "2027-01-01T00:00:00.000Z",
    content_hash: "sha256:rule",
    state: "ACTIVE",
    enable_epoch: 1,
    next_due_at: NOW,
    missed_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function dbWithSchema(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateMerchantOpsSchema(db);
  registerGovernanceLedgers(db);
  return db;
}

function opportunity(db: DatabaseSync, id: string, status: string): void {
  db.prepare(
    `INSERT INTO sales_opportunities
      (opportunity_id, merchant_id, status, owner, revision, created_at, updated_at)
     VALUES (?, ?, ?, 'admin-1', 1, ?, ?)`,
  ).run(id, MERCHANT, status, NOW, NOW);
}

describe("经营任务投影", () => {
  it("无未完成机会 → no_change；有则 eligible 且证据引用真实存在", () => {
    const db = dbWithSchema();
    const projection = new OperationsProjection({ db, now: () => NOW });
    expect(projection.prefilter(rule("unfinished_inquiry_digest"))).toMatchObject({
      result: "no_change",
    });
    opportunity(db, "opp-1", "NEW");
    opportunity(db, "opp-2", "CLOSED");
    const eligible = projection.prefilter(rule("unfinished_inquiry_digest"));
    expect(eligible.result).toBe("eligible");
    expect(eligible.detail).toMatchObject({
      candidates: 1,
      evidence_refs: ["opportunity:opp-1"],
    });
  });

  it("missing_info_draft 只投影 NEEDS_INFO", () => {
    const db = dbWithSchema();
    opportunity(db, "opp-1", "NEW");
    opportunity(db, "opp-2", "NEEDS_INFO");
    const projection = new OperationsProjection({ db, now: () => NOW });
    expect(projection.prefilter(rule("missing_info_draft"))).toMatchObject({
      result: "eligible",
      detail: { evidence_refs: ["opportunity:opp-2"] },
    });
  });

  it("缺表/查询失败 → data_incomplete，不伪造 no_change", () => {
    const empty = new DatabaseSync(":memory:");
    const projection = new OperationsProjection({ db: empty, now: () => NOW });
    const result = projection.prefilter(rule("unfinished_inquiry_digest"));
    expect(result).toMatchObject({ result: "data_incomplete", reason_code: "projection_unavailable" });
  });

  it("quote_expiry_review 投影 72h 内到期选项", () => {
    const db = dbWithSchema();
    db.prepare(
      `INSERT INTO proposal_sets
        (set_id, merchant_id, opportunity_id, requirement_revision, facts_digest,
         policy_version, status, revision, created_at, updated_at)
       VALUES ('set-1', ?, 'opp-1', 1, 'digest', 'p1', 'READY', 1, ?, ?)`,
    ).run(MERCHANT, NOW, NOW);
    db.prepare(
      `INSERT INTO proposal_options
        (set_id, option_id, sku, unit, quantity, currency, adaptation_json,
         eligibility, blocking_json, is_alternative, valid_until)
       VALUES ('set-1', 'opt-1', 'SKU-1', 'piece', 1, 'CNY', '{}', 'SELECTABLE', '{}', 0, ?)`,
    ).run("2026-11-18T12:00:00.000Z");
    const projection = new OperationsProjection({ db, now: () => NOW });
    expect(projection.prefilter(rule("quote_expiry_review"))).toMatchObject({
      result: "eligible",
      detail: { evidence_refs: ["proposal:set-1:opt-1"] },
    });
  });

  it("data_availability_check 在表齐全时为 no_change", () => {
    const db = dbWithSchema();
    const projection = new OperationsProjection({ db, now: () => NOW });
    expect(projection.prefilter(rule("data_availability_check"))).toMatchObject({
      result: "no_change",
    });
  });
});
