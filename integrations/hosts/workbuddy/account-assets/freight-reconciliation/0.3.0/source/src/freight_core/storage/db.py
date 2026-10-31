"""SQLite 存储层（§16.3）：17 张业务表 + 幂等键 + 管理确认请求。

- WAL 模式，仅限本地盘（不得放网络共享文件系统）。
- run 结果不可更新（应用层不提供 UPDATE results）；decision 绑定 result_digest。
- run_id + bill_line_id 唯一归属由 charge_groups.line_ids 与 bill_lines.consumption_run 共同约束。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  carrier_id TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  amount_basis TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  history_coverage_from TEXT,
  history_coverage_to TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  case_revision INTEGER NOT NULL DEFAULT 1,
  frozen_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  imported_at TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  scope_note TEXT,
  mime_type TEXT,
  selected_sheets TEXT NOT NULL DEFAULT '[]',
  detail_rows INTEGER NOT NULL DEFAULT 0,
  parse_error_rows INTEGER NOT NULL DEFAULT 0,
  declared_total_minor INTEGER,
  parsed_total_minor INTEGER,
  amount_complete INTEGER NOT NULL DEFAULT 1,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CONFIRMED',
  UNIQUE (case_id, kind, sha256)
);
CREATE TABLE IF NOT EXISTS source_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  sheet TEXT,
  row_number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  parse_error TEXT,
  UNIQUE (asset_id, sheet, row_number)
);
CREATE TABLE IF NOT EXISTS mapping_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  mapping_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  structure_digest TEXT NOT NULL,
  fields TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  confirmation_ref TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
);
CREATE TABLE IF NOT EXISTS trips (
  case_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  carrier_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  vehicle_class TEXT NOT NULL,
  service_leg_id TEXT NOT NULL,
  departed_at TEXT NOT NULL,
  execution_status TEXT NOT NULL,
  order_ids TEXT NOT NULL DEFAULT '[]',
  asset_id TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  PRIMARY KEY (case_id, trip_id)
);
CREATE TABLE IF NOT EXISTS bill_lines (
  case_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  carrier_id TEXT NOT NULL,
  trip_ref TEXT,
  service_leg_id TEXT,
  charge_code TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  amount_basis TEXT NOT NULL,
  reversal_of TEXT,
  asset_id TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  consumption_run TEXT,
  consumption_group TEXT,
  PRIMARY KEY (case_id, line_id)
);
CREATE TABLE IF NOT EXISTS evidence_links (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  kind TEXT NOT NULL,           -- POD / WAIT / RECEIPT
  trip_id TEXT NOT NULL,
  occurrence_id TEXT,
  state TEXT NOT NULL,          -- VERIFIED / MISSING / CONFLICT / UNPROVIDED
  content_digest TEXT,
  amount_minor INTEGER,
  currency TEXT,
  amount_basis TEXT,
  elapsed_seconds INTEGER,
  file_ref TEXT,
  reviewer_ref TEXT,
  asset_id TEXT,
  row_number INTEGER,
  note TEXT
);
CREATE TABLE IF NOT EXISTS rate_rules (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  carrier_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  vehicle_class TEXT NOT NULL,
  charge_code TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_basis TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT NOT NULL,
  formula TEXT NOT NULL,
  rate_minor INTEGER NOT NULL,
  free_seconds INTEGER NOT NULL DEFAULT 0,
  block_seconds INTEGER NOT NULL DEFAULT 1,
  cap_minor INTEGER,
  confirmed INTEGER NOT NULL DEFAULT 0,
  confirmation_ref TEXT,
  source_refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  PRIMARY KEY (case_id, rule_id, version)
);
CREATE TABLE IF NOT EXISTS match_assignments (
  case_id TEXT NOT NULL,
  bill_line_id TEXT NOT NULL,
  trip_id TEXT,
  occurrence_id TEXT,
  method TEXT NOT NULL,          -- P1 / P2 / P3 / MANUAL / NONE
  state TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  candidates TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (case_id, bill_line_id, occurrence_id)
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL,
  rule_bundle_digest TEXT NOT NULL,
  mapping_digest TEXT NOT NULL,
  matching_digest TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  source_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  bill_line_count INTEGER NOT NULL DEFAULT 0,
  comparable_line_count INTEGER NOT NULL DEFAULT 0,
  unresolved_line_count INTEGER NOT NULL DEFAULT 0,
  out_of_scope_line_count INTEGER NOT NULL DEFAULT 0,
  source_signed_total_minor INTEGER NOT NULL DEFAULT 0,
  comparable_billed_minor INTEGER NOT NULL DEFAULT 0,
  unresolved_billed_minor INTEGER NOT NULL DEFAULT 0,
  out_of_scope_billed_minor INTEGER NOT NULL DEFAULT 0,
  amount_complete INTEGER NOT NULL DEFAULT 1,
  history_coverage_note TEXT,
  supersedes_run_id TEXT,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS charge_groups (
  run_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  carrier_id TEXT NOT NULL,
  trip_id TEXT,
  service_leg_id TEXT,
  charge_code TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_basis TEXT NOT NULL,
  service_time TEXT,
  route_id TEXT,
  vehicle_class TEXT,
  match_state TEXT NOT NULL,
  trip_status TEXT,
  pod_state TEXT NOT NULL,
  billed_minor INTEGER NOT NULL,
  line_ids TEXT NOT NULL,
  event TEXT NOT NULL DEFAULT '{}',
  rules TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id, group_id)
);
CREATE TABLE IF NOT EXISTS results (
  run_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  comparison_status TEXT NOT NULL,
  evidence_status TEXT NOT NULL,
  billed_minor INTEGER NOT NULL,
  expected_minor INTEGER,
  delta_minor INTEGER,
  rule_ref TEXT,
  issues TEXT NOT NULL,
  trace TEXT NOT NULL,
  source_refs TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  PRIMARY KEY (run_id, group_id)
);
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'normal',
  message TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS review_decisions (
  decision_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  confirmed_at TEXT NOT NULL,
  confirmation_ref TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  idempotency_key TEXT,
  request_digest TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS exports (
  export_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  projection TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREPARED',
  actor_id TEXT NOT NULL,
  confirmation_ref TEXT,
  unresolved_group_count INTEGER NOT NULL DEFAULT 0,
  coverage_note TEXT,
  artifacts TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event TEXT NOT NULL,
  trace_id TEXT,
  case_id TEXT,
  run_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  workspace_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, operation, idempotency_key)
);
CREATE TABLE IF NOT EXISTS confirmation_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- mapping / rule_bundle / match / review / freeze / export
  workspace_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  object_digest TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PENDING',
  actor_id TEXT,
  nonce TEXT NOT NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_case ON assets(case_id);
CREATE INDEX IF NOT EXISTS idx_source_rows_asset ON source_rows(asset_id);
CREATE INDEX IF NOT EXISTS idx_bill_lines_case ON bill_lines(case_id);
CREATE INDEX IF NOT EXISTS idx_groups_run ON charge_groups(run_id);
CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id);
CREATE INDEX IF NOT EXISTS idx_issues_run ON issues(run_id);
CREATE INDEX IF NOT EXISTS idx_decisions_case ON review_decisions(case_id);
CREATE INDEX IF NOT EXISTS idx_jobs_case ON jobs(case_id);
"""


class Database:
    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def migrate(self) -> None:
        """升级用显式迁移器，不静默猜兼容（§13）。当前所有版本均为 0.1.0 初始 schema。"""
        self.conn.executescript(SCHEMA)
        self.conn.commit()
