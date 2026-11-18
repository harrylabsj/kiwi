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
 * TOP1-3 三个独立迁移账本注册（设计 v1.1 §18.1 / D-M0-05）。
 *
 * - `learning_schema_migrations`：TOP1 经验学习；M2 建纠正/案例/候选骨架。
 * - `customer_memory_schema_migrations`：TOP2 客户记忆；M1 先建身份/用途域的
 *   `data_grants`（§4.2 DataUseGrant）与来源治理/删除登记；授权是客户身份
 *   域对象，按 §18.1 "身份用途"表组归属本账本；经验/通知用途复用同一张表、
 *   不同 purpose。
 * - `operations_jobs_schema_migrations`：TOP3 经营任务；M1 建后台预算账本，
 *   M4 起加规则/事件/产物表。
 *
 * 三个账本互不复用版本号，也与 `merchant_ops_schema_migrations` 无关。
 * 单写者所有权表（`instance_ownership`）是实例级基础设施，不属于三个模块
 * 账本，随 `merchant_ops` 账本 v2 建表（见 `../ops/schema.ts`）。
 */

import type { DatabaseSync } from "node:sqlite";

import { migrateModuleSchema, type ModuleLedgerSpec } from "./runner.js";

const DATA_GRANTS_V1 = `
-- TOP1-3 M1（设计 v1.1 §4.2 / §9.2 / §18.1）：数据用途授权。
-- 客户（或组织/代理主体）按 purpose 分别授予：customer_memory /
-- history_recall / experience_learning / notification 互不替代。
-- 撤销递增 grant_epoch 并把该 grant 置 REVOKED；重新授权创建新 grant_id、
-- 新 epoch；同一 (merchant, subject, purpose, scope) 每 epoch 至多一条。
CREATE TABLE data_grants (
  grant_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN
    ('customer_memory','history_recall','experience_learning','notification')),
  resource_scope_id TEXT NOT NULL,
  grant_epoch INTEGER NOT NULL CHECK (grant_epoch >= 1),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED','EXPIRED')),
  expires_at TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_data_grants_epoch
  ON data_grants (merchant_id, subject_id, purpose, resource_scope_id, grant_epoch);
CREATE INDEX idx_data_grants_active
  ON data_grants (merchant_id, subject_id, purpose, resource_scope_id, status, expires_at);
`;

/**
 * 来源治理与删除登记（设计 v1.1 §4.2 / §12.2 / §18.1 / §22.1 M1）。
 *
 * - `data_scopes`：erase_scope 的 data_epoch；封存时递增（§12.2）。快照绑定
 *   旧 epoch 后一律失效；封存后读取返回「已封存」。
 * - `source_refs`：来源对象版本（object_id + version 唯一）。payload_ref 是
 *   不透明引用，不存正文。删除时先标 `erased_at`（旧索引/快照立即不可读），
 *   载荷清理作为独立存储面异步完成（§18.2）。
 * - `derivation_edges`：来源派生边（parent → child）。删除时封存受影响边，
 *   由 M3 依边定位记忆/技能候选/草稿（§12.2）。
 * - `deletion_jobs` / `deletion_job_surfaces`：先登记任务再清理；每个存储面
 *   记录 purged / pending / failed，失败可幂等重试（§12.2）。开放任务
 *   （PENDING/PROCESSING）按 (merchant, scope) 唯一，重复请求幂等返回原任务。
 */
const SOURCE_GOVERNANCE_V2 = `
-- 数据域 epoch（来源治理 §4.2 / §12.2）。
CREATE TABLE data_scopes (
  merchant_id TEXT NOT NULL,
  erase_scope_id TEXT NOT NULL,
  data_epoch INTEGER NOT NULL CHECK (data_epoch >= 1),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','SEALED')),
  sealed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, erase_scope_id)
);

-- 来源引用：对象版本唯一；正文在受控 payload 中，本表只存不透明引用。
CREATE TABLE source_refs (
  merchant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  payload_ref TEXT NOT NULL,
  erase_scope_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT,
  erased_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, object_id, version)
);
CREATE INDEX idx_source_refs_scope
  ON source_refs (merchant_id, erase_scope_id);

-- 派生边：对象版本与派生边唯一（§18.1）。
CREATE TABLE derivation_edges (
  merchant_id TEXT NOT NULL,
  parent_object_id TEXT NOT NULL,
  parent_version INTEGER NOT NULL CHECK (parent_version >= 1),
  child_object_id TEXT NOT NULL,
  child_kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sealed_at TEXT,
  PRIMARY KEY (merchant_id, parent_object_id, parent_version, child_object_id)
);

-- 删除任务：先登记再清理（§12.2）；deletion_job_id 供 memory.forget /
-- customer.deletionRequest 返回。
CREATE TABLE deletion_jobs (
  deletion_job_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  erase_scope_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','PROCESSING','COMPLETED')),
  data_epoch INTEGER NOT NULL CHECK (data_epoch >= 1),
  recoverable_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_deletion_jobs_open
  ON deletion_jobs (merchant_id, erase_scope_id)
  WHERE state IN ('PENDING','PROCESSING');

-- 每存储面状态：purged / pending / failed；失败幂等重试（§12.2）。
CREATE TABLE deletion_job_surfaces (
  deletion_job_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PURGED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  receipt_ref TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (deletion_job_id, surface)
);
`;

/**
 * 后台经营预算账本（设计 v1.1 §20.1 / §22.1 M1「预算适配」）。
 *
 * D-M0-09 冻结：每日 20 个逻辑 run、input 100000 / output 12000 token；
 * 单 run 预留 input 5000 / output 600。后台并发 1。预算按商家记账日（宿主
 * 时区）聚合；准入预留、结束对账、未用释放；重启不清零（持久账本）。
 * 未知用量按预留保守占额（不记为免费）。
 */
const BACKGROUND_BUDGET_V1 = `
CREATE TABLE background_budget_days (
  merchant_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  runs_used INTEGER NOT NULL DEFAULT 0 CHECK (runs_used >= 0),
  input_used INTEGER NOT NULL DEFAULT 0 CHECK (input_used >= 0),
  output_used INTEGER NOT NULL DEFAULT 0 CHECK (output_used >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, day_key)
);

CREATE TABLE background_budget_reservations (
  run_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  template TEXT,
  input_reserved INTEGER NOT NULL CHECK (input_reserved >= 0),
  output_reserved INTEGER NOT NULL CHECK (output_reserved >= 0),
  input_actual INTEGER,
  output_actual INTEGER,
  usage_state TEXT CHECK (usage_state IN ('known','unknown')),
  state TEXT NOT NULL CHECK (state IN ('RESERVED','SETTLED','RELEASED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_background_budget_reservations_active
  ON background_budget_reservations (merchant_id, day_key, state);
`;

/**
 * TOP1 经验学习账本 v1（设计 v1.1 §5 / §17.2 / §18.1 / M2-0）。
 *
 * - `learning_corrections`：商家主动纠正（DRAFT → CASE_CREATED；编辑递增
 *   revision；候选派生后编辑使旧候选 STALE）。
 * - `learning_cases`：纠正经 promoteCorrection 形成的案例（每纠正一条，
 *   重新提升时递增 revision，不新建重复案例）。
 * - `learning_candidates`：候选最小骨架（M2-3 起扩展提议正文/冻结产物/
 *   评测与批准字段）；case 变更时旧候选置 STALE。
 * - `learning_events`：审计事件（不含客户正文）。
 * - `learning_rejections`：PII/底价/凭据预检的最小拒绝登记（只存原因与
 *   摘要，不存原文）。
 * - `learning_command_idempotency`：学习命令幂等（merchant + actor +
 *   operation + command_id）。
 */
const LEARNING_V1 = `
CREATE TABLE learning_corrections (
  correction_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','CASE_CREATED','STALE')),
  correction_text TEXT NOT NULL,
  issue_tags_json TEXT NOT NULL,
  case_refs_json TEXT NOT NULL,
  base_release_id TEXT,
  content_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_learning_corrections_merchant
  ON learning_corrections (merchant_id, status, updated_at);

CREATE TABLE learning_cases (
  case_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  correction_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','STALE')),
  source_refs_json TEXT NOT NULL,
  outcome_refs_json TEXT NOT NULL,
  issue_tags_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, correction_id)
);
CREATE INDEX idx_learning_cases_merchant
  ON learning_cases (merchant_id, status, updated_at);

CREATE TABLE learning_candidates (
  candidate_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN
    ('DRAFT','EVALUATING','EVALUATION_FAILED','READY_FOR_REVIEW',
     'APPROVED','REJECTED','STALE','EXPIRED')),
  skill_key TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience = 'customer_reception'),
  base_release_id TEXT,
  trigger_text TEXT NOT NULL,
  proposed_steps_json TEXT NOT NULL,
  exclusions_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  required_tools_json TEXT NOT NULL,
  question_schema_version INTEGER NOT NULL CHECK (question_schema_version >= 1),
  tool_contract_digest TEXT NOT NULL,
  compiled_artifact_json TEXT NOT NULL,
  compiled_artifact_hash TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  eval_report_id TEXT,
  reviewer_id TEXT,
  approval_ref TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_learning_candidates_merchant
  ON learning_candidates (merchant_id, state, updated_at);

-- 候选 ← 案例多对多；删除/纠正传播按案例定位候选。
CREATE TABLE learning_candidate_cases (
  candidate_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (candidate_id, case_id)
);
CREATE INDEX idx_learning_candidate_cases_case
  ON learning_candidate_cases (merchant_id, case_id);

-- 评测：绑定候选冻结产物与套件版本；逐场景持久化，失败/中断可恢复补齐。
CREATE TABLE learning_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 1),
  artifact_hash TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('EVALUATING','READY_FOR_REVIEW','EVALUATION_FAILED','STALE')),
  run_status TEXT NOT NULL CHECK (run_status IN
    ('running','completed','failed','interrupted','paused_budget')),
  runs_completed INTEGER NOT NULL CHECK (runs_completed >= 0),
  budget_cap INTEGER NOT NULL CHECK (budget_cap >= 0),
  results_json TEXT NOT NULL,
  report_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, candidate_id, artifact_hash, suite_version)
);
CREATE INDEX idx_learning_evaluations_candidate
  ON learning_evaluations (merchant_id, candidate_id, state);

-- 审核：批准绑定确切内容/冻结产物/评测报告与截止；待审最长 7 天。
CREATE TABLE learning_reviews (
  review_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 1),
  content_hash TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  question_schema_version INTEGER NOT NULL CHECK (question_schema_version >= 1),
  tool_contract_digest TEXT NOT NULL,
  eval_report_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
  approval_ref TEXT NOT NULL UNIQUE,
  reason TEXT,
  approved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_learning_reviews_candidate
  ON learning_reviews (merchant_id, candidate_id, created_at);

-- 发布版本不可变：ACTIVE/RETIRED/REVOKED；回滚只切生效指针并新增 generation。
CREATE TABLE skill_releases (
  release_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  skill_key TEXT NOT NULL,
  trigger_text TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','RETIRED','REVOKED')),
  artifact_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  compiled_artifact_json TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 1),
  compiler_version TEXT NOT NULL,
  question_schema_version INTEGER NOT NULL CHECK (question_schema_version >= 1),
  tool_contract_digest TEXT NOT NULL,
  eval_report_id TEXT NOT NULL,
  approval_ref TEXT NOT NULL,
  revocation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (revocation_epoch >= 0),
  retired_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, skill_key, generation),
  UNIQUE (merchant_id, approval_ref)
);
CREATE INDEX idx_skill_releases_skill
  ON skill_releases (merchant_id, skill_key, state, generation);

-- 生效指针：release_id 为空表示当前无生效版本（撤回后保持关闭）。
CREATE TABLE skill_active_pointers (
  merchant_id TEXT NOT NULL,
  skill_key TEXT NOT NULL,
  release_id TEXT,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, skill_key)
);

CREATE TABLE learning_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  event TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_learning_events_subject
  ON learning_events (merchant_id, subject_kind, subject_id, event_id);

CREATE TABLE learning_rejections (
  rejection_id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_learning_rejections_merchant
  ON learning_rejections (merchant_id, operation, rejection_id);

CREATE TABLE learning_command_idempotency (
  merchant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, actor_id, operation, command_id)
);
`;

/**
 * TOP2 客户记忆账本 v3（设计 v1.1 §9–§12 / §18.1 / M3）。
 *
 * - 主体与绑定：P0 只启用 organization / agent_scope；person / verified_person
 *   由服务层拒绝（D-M0-01）。绑定挑战 5 分钟单次消费；撤销递增 binding_epoch。
 * - 授权请求：一次性短语/卡片引用双通道，服务端存摘要；消费即失效。
 * - 客户记忆：独立于 owner Principal Memory；candidate/active/needs_review/
 *   superseded/deleted/expired；带 grant/data epoch、来源与 purge_at。
 * - 历史索引：可重建投影，记录 source_version 与授权 epoch；FTS5 trigram
 *   支持中文子串检索（不足 3 字时服务层回退 LIKE）。
 */
const CUSTOMER_MEMORY_V3 = `
CREATE TABLE customer_subjects (
  subject_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN
    ('organization','agent_scope','person','verified_person')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, subject_id)
);
CREATE INDEX idx_customer_subjects_merchant
  ON customer_subjects (merchant_id, status);

CREATE TABLE subject_bindings (
  binding_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  assurance_class TEXT NOT NULL,
  proof_ref TEXT NOT NULL,
  binding_epoch INTEGER NOT NULL CHECK (binding_epoch >= 1),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (merchant_id, binding_id)
);
CREATE INDEX idx_subject_bindings_actor
  ON subject_bindings (merchant_id, actor_id, status, binding_epoch);

CREATE TABLE binding_challenges (
  challenge_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  target_subject_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  proof_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_binding_challenges_actor
  ON binding_challenges (merchant_id, actor_id, created_at);

CREATE TABLE grant_requests (
  grant_request_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  resource_scope_id TEXT NOT NULL,
  grant_ttl_seconds INTEGER NOT NULL CHECK (grant_ttl_seconds >= 1),
  phrase_digest TEXT NOT NULL,
  confirmation_ref_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_grant_requests_subject
  ON grant_requests (merchant_id, subject_id, purpose, created_at);

CREATE TABLE customer_memories (
  memory_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  resource_scope_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_ref TEXT NOT NULL,
  value_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('candidate','active','needs_review','superseded','deleted','expired')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('explicit','observed','inferred')),
  source_refs_json TEXT NOT NULL,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  confirmed_by TEXT,
  confirmed_at TEXT,
  valid_from TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_confirmed_at TEXT,
  policy_version TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  grant_id TEXT NOT NULL,
  grant_epoch INTEGER NOT NULL CHECK (grant_epoch >= 1),
  data_epoch INTEGER NOT NULL CHECK (data_epoch >= 1),
  erase_scope_id TEXT NOT NULL,
  purge_at TEXT NOT NULL,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customer_memories_subject
  ON customer_memories (merchant_id, subject_id, state, updated_at);
CREATE INDEX idx_customer_memories_scope
  ON customer_memories (merchant_id, erase_scope_id);

CREATE TABLE customer_memory_evidence (
  evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_customer_memory_evidence_memory
  ON customer_memory_evidence (merchant_id, memory_id);

CREATE TABLE customer_memory_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  event TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_customer_memory_events_subject
  ON customer_memory_events (merchant_id, subject_id, event_id);

CREATE TABLE memory_set_versions (
  merchant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, subject_id)
);

CREATE TABLE history_index (
  document_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sku TEXT,
  occurred_at TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  is_current INTEGER NOT NULL CHECK (is_current IN (0,1)),
  text TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_epoch INTEGER NOT NULL CHECK (grant_epoch >= 1),
  erase_scope_id TEXT NOT NULL,
  purge_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_history_index_subject
  ON history_index (merchant_id, subject_id, occurred_at);

CREATE VIRTUAL TABLE history_fts USING fts5(
  document_id UNINDEXED,
  merchant_id UNINDEXED,
  subject_id UNINDEXED,
  text,
  tokenize = 'trigram'
);

CREATE TABLE history_cursors (
  cursor_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_epoch INTEGER NOT NULL CHECK (grant_epoch >= 1),
  query_digest TEXT NOT NULL,
  offset INTEGER NOT NULL CHECK (offset >= 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_history_cursors_expiry
  ON history_cursors (expires_at);
`;

export const CUSTOMER_MEMORY_LEDGER: ModuleLedgerSpec = {
  module: "customer-memory",
  ledgerTable: "customer_memory_schema_migrations",
  migrations: { 1: DATA_GRANTS_V1, 2: SOURCE_GOVERNANCE_V2, 3: CUSTOMER_MEMORY_V3 },
};

const LEARNING_V2 = `
CREATE TABLE learning_evaluation_claims (
  claim_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE learning_evaluation_config (
  evaluation_key TEXT PRIMARY KEY,
  config_digest TEXT NOT NULL,
  pending_attempt TEXT
);
`;

export const LEARNING_LEDGER: ModuleLedgerSpec = {
  module: "learning",
  ledgerTable: "learning_schema_migrations",
  migrations: { 1: LEARNING_V1, 2: LEARNING_V2 },
};

/**
 * TOP3 经营任务账本 v2（设计 v1.1 §13–§16 / §18.1 / M4）。
 *
 * EventInbox 只保存必要投影与摘要；规则版本不可变，生效指针/enable_epoch
 * 单独保存；评估、occurrence 与产物分别记录，保证 no_change 零模型调用、
 * eligible 同事务入队、提交有唯一回执。
 */
const OPERATIONS_JOBS_V2 = `
CREATE TABLE event_inbox (
  inbox_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  source_scope TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  entity_ref TEXT NOT NULL,
  source_version TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  evidence_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (merchant_id, source_scope, external_event_id)
);
CREATE INDEX idx_event_inbox_entity ON event_inbox (merchant_id, entity_ref, occurred_at);

CREATE TABLE automation_rules (
  rule_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  template TEXT NOT NULL,
  trigger_spec_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  predicate_spec_json TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN
    ('internal_summary','internal_draft','merchant_todo')),
  budget_json TEXT NOT NULL,
  authorization_ref TEXT,
  effective_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','PAUSED')),
  enable_epoch INTEGER NOT NULL CHECK (enable_epoch >= 0),
  next_due_at TEXT,
  missed_count INTEGER NOT NULL DEFAULT 0 CHECK (missed_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_automation_rules_due
  ON automation_rules (merchant_id, state, next_due_at);

CREATE TABLE automation_rule_candidates (
  candidate_ref TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('template','goal')),
  template TEXT NOT NULL,
  trigger_spec_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  predicate_spec_json TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN
    ('internal_summary','internal_draft','merchant_todo')),
  budget_json TEXT NOT NULL,
  goal_text TEXT,
  content_hash TEXT NOT NULL,
  requires_confirmation INTEGER NOT NULL DEFAULT 1,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_rule_candidates_merchant
  ON automation_rule_candidates (merchant_id, created_at);

CREATE TABLE rule_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  trigger_key TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN
    ('no_change','blocked','eligible','superseded','data_incomplete')),
  reason_code TEXT,
  window_start TEXT,
  window_end TEXT,
  detail_json TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  UNIQUE (merchant_id, rule_id, rule_version, trigger_key)
);
CREATE INDEX idx_rule_evaluations_rule
  ON rule_evaluations (merchant_id, rule_id, evaluated_at);

CREATE TABLE automation_cursors (
  merchant_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  cursor_key TEXT NOT NULL,
  cursor_value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, rule_id, cursor_key)
);

CREATE TABLE operation_artifacts (
  artifact_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  result_kind TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  receipt_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (merchant_id, task_id, result_kind)
);

CREATE TABLE operation_receipts (
  receipt_ref TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  result_kind TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const OPERATIONS_JOBS_V3 = `
-- C02：来源实体版本水位。v8 后收到 v7 只记录 superseded，不回滚事实。
ALTER TABLE event_inbox ADD COLUMN source_version_rank INTEGER;
ALTER TABLE event_inbox ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0;
CREATE TABLE source_entity_versions (
  merchant_id TEXT NOT NULL,
  source_scope TEXT NOT NULL,
  entity_ref TEXT NOT NULL,
  version_rank INTEGER NOT NULL,
  inbox_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (merchant_id, source_scope, entity_ref)
);
`;

export const OPERATIONS_JOBS_LEDGER: ModuleLedgerSpec = {
  module: "operations-jobs",
  ledgerTable: "operations_jobs_schema_migrations",
  migrations: { 1: BACKGROUND_BUDGET_V1, 2: OPERATIONS_JOBS_V2, 3: OPERATIONS_JOBS_V3 },
};

/**
 * 在商家 `state.sqlite` 上注册三个模块账本（幂等；启动/门面装配时调用）。
 * 任何一条迁移失败即抛错，由调用方 fail-closed（功能保持关闭，原接待不受影响）。
 */
export function registerGovernanceLedgers(db: DatabaseSync): void {
  migrateModuleSchema(db, CUSTOMER_MEMORY_LEDGER);
  migrateModuleSchema(db, LEARNING_LEDGER);
  migrateModuleSchema(db, OPERATIONS_JOBS_LEDGER);
}
