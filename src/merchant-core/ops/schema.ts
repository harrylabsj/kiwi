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
 * 商家持续经营 schema（v0.2 §16/§18）。
 *
 * 与通用 memory schema 分账：买家运行时不应出现商家经营/订单表。商家宿主
 * （cloud bootstrap / merchant runtime）在打开门面时单独迁移本 schema，
 * 使用自己的 `merchant_ops_schema_migrations` 版本账本。
 */

import type { DatabaseSync } from "node:sqlite";

export const MERCHANT_OPS_SCHEMA_VERSION = 1;

const MIGRATION_9 = `
-- 商家持续经营 M1（设计 v0.2 §5.1/§16/§17.1）：经营计划与命令幂等。
-- 计划只引用商品身份、条件、动作与授权；私有成本只存引用，不进本表。
CREATE TABLE merchant_operating_plans (
  plan_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  billing_ref TEXT,
  template_id TEXT,
  template_revision INTEGER,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED')),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  conditions_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  authorization_json TEXT NOT NULL,
  private_rules_ref TEXT,
  owner TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
-- 唯一索引只兜底相同起点；真正的区间不重叠在 BEGIN IMMEDIATE 事务内检查。
CREATE UNIQUE INDEX uq_merchant_operating_plans_start
  ON merchant_operating_plans (merchant_id, source, source_account_id, sku, effective_from);
CREATE INDEX idx_merchant_operating_plans_lookup
  ON merchant_operating_plans (merchant_id, source, source_account_id, sku, status, effective_to);

CREATE TABLE merchant_operating_plan_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  event TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
CREATE INDEX idx_merchant_operating_plan_events_plan
  ON merchant_operating_plan_events (plan_id, seq);

-- 所有商家命令共用：同键同内容重放原结果，同键异内容冲突（v0.2 §17.1）。
CREATE TABLE merchant_command_idempotency (
  merchant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, idempotency_key)
);
`;

const MIGRATION_10 = `
-- 商家持续经营 M1（设计 v0.2 §6）：来源记录、采购机会、关联与需求快照。
-- 来源记录与采购机会分开计数；同一外部询盘/事件幂等；相似文本不自动合并。
CREATE TABLE opportunity_sources (
  source_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  source_namespace TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  external_inquiry_id TEXT NOT NULL,
  raw_excerpt TEXT NOT NULL,
  received_at TEXT NOT NULL,
  operator TEXT NOT NULL,
  parse_version TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, source_namespace, source_account_id, external_inquiry_id)
);
CREATE INDEX idx_opportunity_sources_merchant
  ON opportunity_sources (merchant_id, received_at);

CREATE TABLE opportunity_source_events (
  event_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_id, external_event_id)
);

CREATE TABLE sales_opportunities (
  opportunity_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN
    ('NEW','NEEDS_INFO','READY_FOR_PROPOSAL','PENDING_APPROVAL',
     'WAITING_CUSTOMER','RESULT_UNVERIFIED','CLOSED')),
  owner TEXT NOT NULL,
  next_action TEXT,
  next_action_due_at TEXT,
  waiting_reason TEXT,
  rfq_case_id TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sales_opportunities_merchant_status
  ON sales_opportunities (merchant_id, status);

CREATE TABLE opportunity_links (
  link_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('LINKED','UNLINKED')),
  basis TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_id)
);
CREATE INDEX idx_opportunity_links_opportunity
  ON opportunity_links (opportunity_id, status);

CREATE TABLE opportunity_link_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event TEXT NOT NULL,
  actor TEXT NOT NULL,
  basis TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE opportunity_requirements (
  opportunity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  merchant_id TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (opportunity_id, revision)
);

CREATE TABLE opportunity_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  event TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  side_effects_json TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_opportunity_events_opportunity
  ON opportunity_events (opportunity_id, seq);
`;

const MIGRATION_11 = `
-- 商家持续经营 M2/M3（设计 v0.2 §9/§8）：方案集合、选择/批准与跟进任务持久化。
-- 方案集合只存公开投影 + 选项；批准摘要覆盖对外内容与策略版本。
CREATE TABLE proposal_sets (
  set_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  requirement_revision INTEGER NOT NULL,
  facts_digest TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','EVALUATED','READY','STALE','WITHDRAWN')),
  stale_reason TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_proposal_sets_opportunity
  ON proposal_sets (merchant_id, opportunity_id, updated_at);

CREATE TABLE proposal_options (
  set_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_minor INTEGER,
  currency TEXT NOT NULL,
  pricing_json TEXT,
  valid_until TEXT,
  price_source_json TEXT,
  adaptation_json TEXT NOT NULL,
  eligibility TEXT NOT NULL CHECK (eligibility IN
    ('SELECTABLE','CHANGE_REQUIRES_CUSTOMER_CONFIRMATION','BLOCKED')),
  blocking_json TEXT NOT NULL,
  is_alternative INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (set_id, option_id)
);

CREATE TABLE proposal_selections (
  selection_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  selected_by TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  requirement_revision INTEGER NOT NULL,
  publish_ref_json TEXT NOT NULL
);
CREATE INDEX idx_proposal_selections_set ON proposal_selections (merchant_id, set_id);

CREATE TABLE proposal_approvals (
  approval_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  requirement_revision INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'publish_quote'),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_proposal_approvals_set ON proposal_approvals (merchant_id, set_id, option_id);

-- 跟进任务：租约与 fencing token 保护内部写入；外部副作用仍需回执/幂等键。
CREATE TABLE followup_tasks (
  task_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  opportunity_id TEXT,
  trigger_event TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_version TEXT,
  status TEXT NOT NULL CHECK (status IN
    ('NEW','PENDING','READY','RUNNING','WAITING_APPROVAL',
     'SUCCEEDED','CANCELLED','FAILED','UNKNOWN')),
  due_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  external_call_started INTEGER NOT NULL DEFAULT 0,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_followup_task_idempotency
  ON followup_tasks (merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_followup_due ON followup_tasks (merchant_id, status, due_at);

CREATE TABLE followup_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  external_request_id TEXT,
  receipt_json TEXT,
  error_code TEXT,
  UNIQUE (task_id, attempt_no)
);

CREATE TABLE followup_outbox (
  outbox_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  attempt_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SENT','UNKNOWN')),
  provider_request_id TEXT,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_followup_outbox_task ON followup_outbox (merchant_id, task_id, status);
`;

const MIGRATION_12 = `
-- 商家持续经营 M4（设计 v0.2 §11–§13）：订单事实、事件、归因、退款与成本/贡献。
-- 订单存在、归因与贡献分开存储；外部事件按 (record, event_id) 幂等。
CREATE TABLE order_records_v2 (
  record_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  source_namespace TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  evidence_source TEXT NOT NULL CHECK (evidence_source IN
    ('manual_report','csv_import','external_verified')),
  payment_status TEXT,
  fulfillment_status TEXT,
  refund_status TEXT,
  cancellation_status TEXT,
  currency TEXT,
  total_minor INTEGER,
  source_version TEXT,
  observed_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, source_namespace, source_account_id, external_order_id)
);
CREATE INDEX idx_order_records_v2_merchant ON order_records_v2 (merchant_id, observed_at);

CREATE TABLE order_lines_v2 (
  record_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL,
  unit_price_minor INTEGER,
  PRIMARY KEY (record_id, line_id)
);

CREATE TABLE order_events_v2 (
  event_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  source_version TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  value TEXT NOT NULL,
  amount_minor INTEGER,
  refund_id TEXT,
  raw_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (record_id, external_event_id)
);

CREATE TABLE order_attributions_v2 (
  attribution_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  order_line_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL,
  method TEXT NOT NULL,
  confirmed_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (record_id, order_line_id, opportunity_id)
);

CREATE TABLE refunds_v2 (
  refund_row_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  source_namespace TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  external_order_id TEXT NOT NULL,
  external_refund_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','reversed')),
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, source_namespace, source_account_id, external_order_id, external_refund_id)
);

CREATE TABLE private_cost_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('quote','order')),
  ref_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('COMPLETE','ESTIMATED','INCOMPLETE')),
  costs_json TEXT NOT NULL,
  missing_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_private_cost_snapshots_ref ON private_cost_snapshots (merchant_id, ref_kind, ref_id);

CREATE TABLE contribution_assessments (
  assessment_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('quote','order')),
  ref_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ESTIMATED','ACTUAL')),
  completeness TEXT NOT NULL CHECK (completeness IN ('COMPLETE','ESTIMATED','INCOMPLETE')),
  net_revenue_minor INTEGER NOT NULL,
  costs_json TEXT NOT NULL,
  contribution_minor INTEGER,
  known_contribution_minor INTEGER NOT NULL,
  rate_bps INTEGER,
  missing_json TEXT NOT NULL,
  gate_status TEXT NOT NULL,
  gate_reasons_json TEXT NOT NULL,
  cost_snapshot_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_contribution_assessments_ref ON contribution_assessments (merchant_id, ref_kind, ref_id);
`;

const MIGRATIONS: Readonly<Record<number, string>> = {
  1: `${MIGRATION_9}
${MIGRATION_10}
${MIGRATION_11}
${MIGRATION_12}`,
};

export function migrateMerchantOpsSchema(
  db: DatabaseSync,
  targetVersion: number = MERCHANT_OPS_SCHEMA_VERSION,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchant_ops_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const row = db.prepare("SELECT MAX(version) AS v FROM merchant_ops_schema_migrations").get() as { v: number | null };
  const current = row.v ?? 0;
  if (current > targetVersion) {
    throw new Error(
      `merchant ops schema version ${current} is newer than this build (${targetVersion}); refusing to open`,
    );
  }
  for (let v = current + 1; v <= targetVersion; v++) {
    const sql = MIGRATIONS[v];
    if (sql === undefined) throw new Error(`missing merchant ops migration for version ${v}`);
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO merchant_ops_schema_migrations (version, applied_at) VALUES (?, ?)").run(
        v,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `merchant ops migration to version ${v} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}
