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
 * 试点发布前检查（设计 v1.1 §22.2–§22.3 / M5）。
 *
 * 只做只读检查并返回稳定检查码；不部署、不修改数据。默认全关时只验证
 * 账本/表就绪；任一模块开启时额外要求实例所有权为 HELD。
 */

import type { DatabaseSync } from "node:sqlite";

import type { GovernanceFeatureFlags } from "./feature-flags.js";

export interface PilotReadinessCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly detail?: string;
}

export interface PilotReadinessReport {
  readonly merchant_id: string;
  readonly ready: boolean;
  readonly checks: readonly PilotReadinessCheck[];
}

function tableExists(db: DatabaseSync, table: string): boolean {
  try {
    return (
      db
        .prepare(
          "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
        )
        .get(table) !== undefined
    );
  } catch {
    return false;
  }
}

function count(db: DatabaseSync, sql: string, params: Array<string | number> = []): number | undefined {
  try {
    return Number((db.prepare(sql).get(...params) as { n: number } | undefined)?.n ?? 0);
  } catch {
    return undefined;
  }
}

export function checkPilotReadiness(input: {
  db: DatabaseSync;
  merchantId: string;
  flags: GovernanceFeatureFlags;
}): PilotReadinessReport {
  const { db, merchantId, flags } = input;
  const checks: PilotReadinessCheck[] = [];
  const modulesEnabled = flags.learning_enabled || flags.memory_enabled || flags.jobs_enabled;

  checks.push({
    id: "customer_delivery_disabled",
    ok: flags.customer_delivery_enabled === false,
    ...(flags.customer_delivery_enabled === false ? {} : { code: "CUSTOMER_DELIVERY_ENABLED" }),
  });
  checks.push({
    id: "personal_memory_disabled",
    ok: true,
    detail: "P0 关闭 person/verified_person（D-M0-01）；E1 宿主证据未提供，个人记忆保持关闭",
  });

  const ledgers: Array<[string, string]> = [
    ["learning", "learning_schema_migrations"],
    ["customer_memory", "customer_memory_schema_migrations"],
    ["operations_jobs", "operations_jobs_schema_migrations"],
  ];
  for (const [id, table] of ledgers) {
    const rows = count(db, `SELECT COUNT(*) AS n FROM ${table}`);
    checks.push({
      id: `ledger_${id}`,
      ok: rows !== undefined,
      ...(rows === undefined ? { code: "LEDGER_MISSING" } : { detail: `versions=${rows}` }),
    });
  }

  const requiredTables = [
    "data_grants",
    "data_scopes",
    "source_refs",
    "deletion_jobs",
    "customer_memories",
    "history_index",
    "event_inbox",
    "automation_rules",
    "background_budget_days",
  ];
  for (const table of requiredTables) {
    const ok = tableExists(db, table);
    checks.push({
      id: `table_${table}`,
      ok,
      ...(ok ? {} : { code: "TABLE_MISSING" }),
    });
  }

  if (modulesEnabled) {
    const ownership = (() => {
      try {
        return db
          .prepare(
            "SELECT state FROM instance_ownership WHERE merchant_id = ?",
          )
          .get(merchantId) as { state: string } | undefined;
      } catch {
        return undefined;
      }
    })();
    checks.push({
      id: "instance_ownership",
      ok: ownership?.state === "HELD",
      ...(ownership?.state === "HELD" ? {} : { code: "OWNERSHIP_NOT_HELD" }),
    });
  } else {
    checks.push({
      id: "modules_default_off",
      ok: true,
      detail: "learning/memory/jobs 默认关闭；不要求实例所有权",
    });
  }

  const openDeletionJobs = count(
    db,
    "SELECT COUNT(*) AS n FROM deletion_jobs WHERE merchant_id = ? AND state IN ('PENDING','PROCESSING')",
    [merchantId],
  );
  checks.push({
    id: "deletion_registry",
    ok: openDeletionJobs !== undefined,
    ...(openDeletionJobs === undefined
      ? { code: "DELETION_REGISTRY_MISSING" }
      : { detail: `open_jobs=${openDeletionJobs}` }),
  });

  const backupPending = count(
    db,
    "SELECT COUNT(*) AS n FROM deletion_job_surfaces WHERE status = 'FAILED' AND last_error = 'backup_pending'",
  );
  checks.push({
    id: "backup_pending_visible",
    ok: backupPending !== undefined,
    ...(backupPending === undefined ? { code: "DELETION_SURFACES_MISSING" } : { detail: `pending=${backupPending}` }),
  });

  const unknownTasks = count(
    db,
    "SELECT COUNT(*) AS n FROM followup_tasks WHERE merchant_id = ? AND status = 'UNKNOWN'",
    [merchantId],
  );
  checks.push({
    id: "unknown_tasks_visible",
    ok: unknownTasks !== undefined,
    ...(unknownTasks === undefined ? { code: "TASKS_MISSING" } : { detail: `unknown=${unknownTasks}` }),
  });

  return {
    merchant_id: merchantId,
    ready: checks.every((check) => check.ok),
    checks,
  };
}
