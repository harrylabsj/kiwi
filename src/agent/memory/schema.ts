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
 * SQLite schema and versioned migrations for Principal Memory (design §8–§9).
 *
 * Migrations run in transactions with a schema_migrations ledger; a failed
 * migration rolls back completely — no half-applied schema. The store opens
 * fail-closed when the on-disk schema is NEWER than this build.
 */

import type { DatabaseSync } from "node:sqlite";

export const MEMORY_SCHEMA_VERSION = 6;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

const MIGRATION_1 = `
CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('buyer','merchant')),
  display_name TEXT,
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  memory_schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE private_vault (
  vault_ref TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  kind TEXT NOT NULL CHECK (kind IN ('address','contact','private_budget','merchant_cost','merchant_floor','other')),
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  value_fingerprint TEXT NOT NULL,
  retention_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memory_items (
  memory_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  namespace TEXT NOT NULL CHECK (namespace IN ('profile','constraint','preference','routine','episode','task_context')),
  key TEXT NOT NULL,
  value_json TEXT,
  -- Not a foreign key: forgetting a Restricted memory hard-erases the Vault
  -- row while the tombstone keeps the reference for audit (design §9.2).
  vault_ref TEXT,
  scope_json TEXT NOT NULL DEFAULT '{}',
  source_kind TEXT NOT NULL CHECK (source_kind IN ('explicit','observed','inferred','imported')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal','private','restricted')),
  status TEXT NOT NULL CHECK (status IN ('candidate','active','needs_review','superseded','deleted','expired')),
  confirmed_at TEXT,
  valid_from TEXT,
  expires_at TEXT,
  last_observed_at TEXT,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- value_json and vault_ref are mutually exclusive (design §9.2).
  CHECK ((value_json IS NULL) <> (vault_ref IS NULL))
);
CREATE INDEX idx_memory_items_principal_status ON memory_items (principal_id, status);
CREATE INDEX idx_memory_items_lookup ON memory_items (principal_id, namespace, key);
CREATE INDEX idx_memory_items_expiry ON memory_items (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE memory_evidence (
  evidence_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_items(memory_id),
  source_type TEXT NOT NULL CHECK (source_type IN ('chat','task_feedback','selection','rejection','import')),
  source_ref TEXT NOT NULL,
  polarity TEXT NOT NULL CHECK (polarity IN ('support','contradict')),
  weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
  summary TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_memory_evidence_memory ON memory_evidence (memory_id, source_ref);

CREATE TABLE memory_events (
  event_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'memory.proposed','memory.confirmed','memory.activated','memory.corrected',
    'memory.contradicted','memory.superseded','memory.forgotten','memory.expired')),
  actor TEXT NOT NULL,
  reason TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_memory_events_memory ON memory_events (memory_id, created_at);

CREATE TABLE memory_retrieval_log (
  retrieval_id TEXT PRIMARY KEY,
  task_id TEXT,
  session_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('filter','rank','clarify','negotiate','explain')),
  redaction_level TEXT NOT NULL CHECK (redaction_level IN ('full','coarse','metadata_only')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_retrieval_log_session ON memory_retrieval_log (session_id, created_at);
`;

const MIGRATION_2 = `
-- v0.3.0-B: Buyer tasks, candidates, observations and tracking rules (§11).
CREATE TABLE buyer_tasks (
  task_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  status TEXT NOT NULL CHECK (status IN (
    'draft','clarifying','ready','searching','tracking','shortlist_ready',
    'awaiting_user','consulting','negotiating','selected_nonbinding',
    'cancelled','failed','expired')),
  goal_text TEXT NOT NULL,
  intent_json TEXT NOT NULL DEFAULT '{}',
  constraints_json TEXT NOT NULL DEFAULT '{}',
  ranking_policy_json TEXT NOT NULL DEFAULT '{}',
  connector_scope_json TEXT NOT NULL DEFAULT '{}',
  search_budget_json TEXT NOT NULL DEFAULT '{}',
  tracking_policy_json TEXT NOT NULL DEFAULT '{}',
  selected_candidate_id TEXT,
  next_run_at TEXT,
  expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_buyer_tasks_principal ON buyer_tasks (principal_id, status);
CREATE INDEX idx_buyer_tasks_wakeup ON buyer_tasks (next_run_at) WHERE next_run_at IS NOT NULL;

CREATE TABLE task_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES buyer_tasks(task_id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  origin TEXT NOT NULL CHECK (origin IN ('user','scheduler','model','connector','policy')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_events_task ON task_events (task_id, created_at);

CREATE TABLE product_candidates (
  candidate_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES buyer_tasks(task_id),
  connector_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  external_product_id TEXT NOT NULL,
  sku TEXT,
  merchant_id TEXT,
  canonical_key TEXT NOT NULL,
  eligibility TEXT NOT NULL CHECK (eligibility IN ('eligible','ineligible','unknown')),
  candidate_status TEXT NOT NULL CHECK (candidate_status IN
    ('discovered','tracked','shortlisted','rejected','selected','stale')),
  score REAL,
  score_explanation_json TEXT,
  rejection_reasons_json TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  latest_observation_id TEXT,
  UNIQUE (task_id, canonical_key)
);
CREATE INDEX idx_candidates_task ON product_candidates (task_id, candidate_status);

CREATE TABLE product_observations (
  observation_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES product_candidates(candidate_id),
  observed_at TEXT NOT NULL,
  source_url_or_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  price_json TEXT NOT NULL DEFAULT '{}',
  promotion_json TEXT NOT NULL DEFAULT '{}',
  stock_json TEXT NOT NULL DEFAULT '{}',
  delivery_json TEXT NOT NULL DEFAULT '{}',
  after_sales_json TEXT NOT NULL DEFAULT '{}',
  merchant_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  fresh_until TEXT NOT NULL,
  UNIQUE (candidate_id, content_hash)
);
CREATE INDEX idx_observations_candidate ON product_observations (candidate_id, observed_at);

CREATE TABLE tracking_rules (
  rule_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES buyer_tasks(task_id),
  candidate_id TEXT REFERENCES product_candidates(candidate_id),
  rule_type TEXT NOT NULL CHECK (rule_type IN (
    'price_below','stock_available','promotion_changed','delivery_before',
    'new_candidate','periodic_review')),
  condition_json TEXT NOT NULL DEFAULT '{}',
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),
  next_check_at TEXT NOT NULL,
  last_triggered_at TEXT,
  cooldown_seconds INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active','paused','completed','expired'))
);
CREATE INDEX idx_tracking_rules_due ON tracking_rules (status, next_check_at);
`;

const MIGRATION_3 = `
-- v0.3.0-C: consultation links and approval WriteApprovalCandidates (§11.8, §16).
-- consultation_links associates a Buyer task + candidate with the authoritative
-- Marketplace Conversation (shopping-cli) without copying its state.
CREATE TABLE consultation_links (
  link_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES buyer_tasks(task_id),
  candidate_id TEXT REFERENCES product_candidates(candidate_id),
  connector_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('consulting','negotiating','closed','stale')),
  last_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, conversation_id)
);
CREATE INDEX idx_consultation_links_task ON consultation_links (task_id, status);
CREATE INDEX idx_consultation_links_conv ON consultation_links (connector_id, conversation_id);

-- WriteApprovalCandidates are content-hashed approval objects (§16): the operator
-- approves a specific argument set against a specific precondition state.
-- arguments_json holds only public catalog/inventory facts — Restricted
-- values (private floors, costs) never enter this table, the event log or
-- any model-visible output.
CREATE TABLE action_candidates (
  candidate_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  task_id TEXT,
  tool TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  preconditions_json TEXT NOT NULL,
  preconditions_hash TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending_approval','approved','executed','rejected','superseded','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_action_candidates_principal ON action_candidates (principal_id, status);
CREATE INDEX idx_action_candidates_expiry ON action_candidates (expires_at) WHERE status = 'pending_approval';
`;

const MIGRATION_4 = `
-- v0.7.0 catalog-first（CD #28）：候选持久化 owner Agent（listing.owner_agent_id，
-- Direct A2A 磋商 negotiate_buyer_task 的 catalogAgentId 输入）。
ALTER TABLE product_candidates ADD COLUMN owner_agent_id TEXT;
`;

const MIGRATION_5 = `
-- v0.7.2：候选持久化商家显示名（listing.merchant.display_name）——与买家沟通
-- 用商家名字而非 catalog_agent_id。
ALTER TABLE product_candidates ADD COLUMN merchant_name TEXT;
`;

const MIGRATION_6 = `
-- M1 Buyer-owned supplier relationships（pull-relationship 设计 v0.1 §6）：
-- 关系与观察规则属于 Buyer Core 本地，独立表，不塞进 buyer_tasks。
CREATE TABLE supplier_relationships (
  relationship_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  merchant_id TEXT NOT NULL,
  canonical_domain TEXT NOT NULL,
  agent_card_url TEXT NOT NULL,
  ucp_profile_url TEXT,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('saved','watched','preferred')),
  scope_json TEXT NOT NULL DEFAULT '{}',
  policy_json TEXT NOT NULL DEFAULT '{}',
  consent_source TEXT NOT NULL CHECK (consent_source IN ('human_explicit','delegated_policy')),
  status TEXT NOT NULL CHECK (status IN ('active','paused','review_required','expired','deleted')),
  -- M3 receipt 预留列（§10）：M1 不实现 receipt 收发，receipt_status 恒为 'none'。
  receipt_status TEXT NOT NULL DEFAULT 'none' CHECK (receipt_status IN ('none','attested','revoke_pending')),
  receipt_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX idx_supplier_relationships_principal ON supplier_relationships (principal_id, status);

CREATE TABLE supplier_observation_state (
  relationship_id TEXT NOT NULL REFERENCES supplier_relationships(relationship_id),
  source_type TEXT NOT NULL CHECK (source_type IN ('catalog_search','agent_card','ucp_profile','ucp_catalog')),
  source_url_or_ref TEXT,
  etag TEXT,
  last_modified TEXT,
  source_revision TEXT,
  content_digest TEXT,
  -- 上一次成功拉取的规范化快照（只含固定 DTO 字段），供下次 diff 出
  -- listing_added/updated/withdrawn 等具体变化 kind。
  snapshot_json TEXT,
  last_checked_at TEXT,
  last_success_at TEXT,
  next_check_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  backoff_until TEXT,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  last_verified_fingerprint TEXT,
  PRIMARY KEY (relationship_id, source_type)
);
CREATE INDEX idx_supplier_obs_state_due ON supplier_observation_state (next_check_at)
  WHERE next_check_at IS NOT NULL;

-- 只存规范化事实差异（§6.3），不保存可执行远程内容；content_digest 去重。
CREATE TABLE supplier_observations (
  observation_id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL REFERENCES supplier_relationships(relationship_id),
  kind TEXT NOT NULL CHECK (kind IN (
    'listing_added','listing_updated','listing_withdrawn','capability_changed',
    'availability_hint_changed','lead_time_hint_changed','profile_or_identity_changed',
    'freshness_changed','unreachable')),
  source_type TEXT NOT NULL CHECK (source_type IN ('catalog_search','agent_card','ucp_profile','ucp_catalog')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  content_digest TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  fresh_until TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  UNIQUE (relationship_id, kind, content_digest)
);
CREATE INDEX idx_supplier_observations_rel ON supplier_observations (relationship_id, observed_at);
`;

/** Ordered migrations: version number -> SQL. */
const MIGRATIONS: Readonly<Record<number, string>> = {
  1: MIGRATION_1,
  2: MIGRATION_2,
  3: MIGRATION_3,
  4: MIGRATION_4,
  5: MIGRATION_5,
  6: MIGRATION_6,
};

/**
 * Bring the database up to MEMORY_SCHEMA_VERSION. Exposed for rollback tests
 * with an injected (broken) migration set.
 */
export function migrateMemorySchema(
  db: DatabaseSync,
  migrations: Readonly<Record<number, string>> = MIGRATIONS,
  targetVersion: number = MEMORY_SCHEMA_VERSION,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
    v: number | null;
  };
  const current = row.v ?? 0;
  if (current > targetVersion) {
    throw new MigrationError(
      `memory schema version ${current} is newer than this build (${targetVersion}); refusing to open`,
    );
  }
  for (let v = current + 1; v <= targetVersion; v++) {
    const sql = migrations[v];
    if (sql === undefined) {
      throw new MigrationError(`missing migration for schema version ${v}`);
    }
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        v,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new MigrationError(
        `migration to schema version ${v} failed and was rolled back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
