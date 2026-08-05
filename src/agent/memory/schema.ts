/**
 * SQLite schema and versioned migrations for Principal Memory (design §8–§9).
 *
 * Migrations run in transactions with a schema_migrations ledger; a failed
 * migration rolls back completely — no half-applied schema. The store opens
 * fail-closed when the on-disk schema is NEWER than this build.
 */

import type { DatabaseSync } from "node:sqlite";

export const MEMORY_SCHEMA_VERSION = 1;

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

/** Ordered migrations: version number -> SQL. */
const MIGRATIONS: Readonly<Record<number, string>> = {
  1: MIGRATION_1,
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
