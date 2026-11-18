/**
 * TOP1-3 M1（D-M0-05）：learning / customer-memory / operations-jobs 独立迁移账本。
 * 幂等重复执行、checksum 冲突、已有 state.sqlite 升级、失败不部分应用。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import {
  CUSTOMER_MEMORY_LEDGER,
  LEARNING_LEDGER,
  OPERATIONS_JOBS_LEDGER,
  registerGovernanceLedgers,
} from "../src/merchant-core/migrations/ledgers.js";
import {
  MigrationLedgerError,
  migrateModuleSchema,
  migrationChecksum,
} from "../src/merchant-core/migrations/runner.js";
import { FollowUpRepository } from "../src/merchant-core/followup/repository.js";
import { DataUseGrantStore } from "../src/merchant-core/context-governance/data-use-grant.js";

describe("独立迁移账本（D-M0-05）", () => {
  let db: DatabaseSync;
  const clock = () => "2026-11-15T00:00:00.000Z";

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
  });
  afterEach(() => db.close());

  function ledgerRows(table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  it("三个账本注册到同一 state.sqlite，learning v2 / customer_memory v3 / operations_jobs v3 建表并记录 checksum", () => {
    registerGovernanceLedgers(db);
    expect(ledgerRows("learning_schema_migrations")).toBe(3);
    expect(ledgerRows("operations_jobs_schema_migrations")).toBe(3);
    expect(ledgerRows("customer_memory_schema_migrations")).toBe(3);
    const rows = db
      .prepare("SELECT version, checksum FROM customer_memory_schema_migrations ORDER BY version")
      .all() as Array<{ version: number; checksum: string }>;
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(rows[0]!.checksum).toBe(migrationChecksum(CUSTOMER_MEMORY_LEDGER.migrations[1]!));
    expect(rows[1]!.checksum).toBe(migrationChecksum(CUSTOMER_MEMORY_LEDGER.migrations[2]!));
    const learningRow = db
      .prepare("SELECT checksum FROM learning_schema_migrations WHERE version = 1")
      .get() as { checksum: string };
    expect(learningRow.checksum).toBe(migrationChecksum(LEARNING_LEDGER.migrations[1]!));

    // 账本应用后即可用：授权表可插入。
    const grants = new DataUseGrantStore({ db, now: clock });
    const grant = grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "customer_memory",
      resource_scope_id: "org",
      expires_at: "2026-12-15T00:00:00.000Z",
    });
    expect(grant.grant_epoch).toBe(1);
    expect(grant.policy_version).toBe("m0-pilot-1");
  });

  it("在已有 state.sqlite 上可重复执行：幂等且不破坏既有数据", () => {
    // 既有库：ops schema + 一条 followup 任务。
    migrateMerchantOpsSchema(db);
    const repo = new FollowUpRepository({ db, now: clock });
    const { task } = repo.transaction(() =>
      repo.createTask({
        merchantId: "m-1",
        triggerEvent: "quote_not_answered",
        actionType: "merchant_todo",
        maxAttempts: 3,
        payload: {},
      }),
    );

    registerGovernanceLedgers(db);
    registerGovernanceLedgers(db);
    registerGovernanceLedgers(db);

    expect(ledgerRows("customer_memory_schema_migrations")).toBe(3);
    expect(ledgerRows("learning_schema_migrations")).toBe(3);
    const after = repo.getTask("m-1", task.task_id);
    expect(after?.task_id).toBe(task.task_id);
    expect(repo.listTasks("m-1")).toHaveLength(1);
  });

  it("learning v1 升级 v2 保留旧数据并幂等", () => {
    migrateModuleSchema(db, LEARNING_LEDGER, 1);
    db.prepare(`INSERT INTO learning_command_idempotency
      (merchant_id, actor_id, operation, command_id, request_digest, result_json, created_at)
      VALUES ('m', 'a', 'op', 'c', 'digest', '{}', '2026-01-01')`).run();
    migrateModuleSchema(db, LEARNING_LEDGER);
    migrateModuleSchema(db, LEARNING_LEDGER);
    expect(ledgerRows("learning_schema_migrations")).toBe(3);
    expect(ledgerRows("learning_command_idempotency")).toBe(1);
  });

  it("checksum 冲突 fail-closed：账本被篡改时拒绝打开", () => {
    registerGovernanceLedgers(db);
    db.prepare(
      "UPDATE customer_memory_schema_migrations SET checksum = 'deadbeef' WHERE version = 1",
    ).run();
    expect(() => migrateModuleSchema(db, CUSTOMER_MEMORY_LEDGER)).toThrowError(MigrationLedgerError);
    try {
      migrateModuleSchema(db, CUSTOMER_MEMORY_LEDGER);
    } catch (err) {
      expect((err as MigrationLedgerError).kind).toBe("checksum_conflict");
    }
  });

  it("账本版本高于本构建时拒绝打开", () => {
    db.exec(
      "CREATE TABLE learning_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT INTO learning_schema_migrations (version, applied_at, checksum) VALUES (4, '2026-01-01T00:00:00.000Z', 'x')",
    ).run();
    expect(() => migrateModuleSchema(db, LEARNING_LEDGER)).toThrowError(MigrationLedgerError);
    try {
      migrateModuleSchema(db, LEARNING_LEDGER);
    } catch (err) {
      expect((err as MigrationLedgerError).kind).toBe("newer_than_build");
    }
  });

  it("迁移失败不部分应用：事务回滚，账本不推进", () => {
    const spec = {
      module: "test-module",
      ledgerTable: "test_module_schema_migrations",
      migrations: {
        1: "CREATE TABLE m1_should_not_exist (id INTEGER); INSERT INTO table_that_does_not_exist (id) VALUES (1);",
      },
    };
    expect(() => migrateModuleSchema(db, spec)).toThrowError(MigrationLedgerError);
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'm1_should_not_exist'",
      )
      .get();
    expect(table).toBeUndefined();
    // 账本表本身先于迁移幂等创建（0 行），但账本未推进。
    expect(ledgerRows("test_module_schema_migrations")).toBe(0);
  });

  it("版本号不连续直接拒绝；空白差异不改变 checksum", () => {
    expect(() =>
      migrateModuleSchema(db, {
        module: "gap",
        ledgerTable: "gap_schema_migrations",
        migrations: { 2: "CREATE TABLE gap_t (id INTEGER);" },
      }),
    ).toThrowError(MigrationLedgerError);
    expect(migrationChecksum("  CREATE TABLE t (id INTEGER);  ")).toBe(
      migrationChecksum("CREATE\n  TABLE\tt (id INTEGER);"),
    );
  });

  it("审查项：账本已有 1、3 而缺 2 → fail-closed 拒绝，不跳过缺失版本", () => {
    const spec = {
      module: "gap-ledger",
      ledgerTable: "gap_ledger_schema_migrations",
      migrations: {
        1: "CREATE TABLE gap_v1 (id INTEGER);",
        2: "CREATE TABLE gap_v2 (id INTEGER);",
        3: "CREATE TABLE gap_v3 (id INTEGER);",
      },
    };
    // 正常应用到 1；随后账本被手工/破坏性写入 3（3 的 checksum 合法）——
    // 修复前 runner 取 max=3 跳过 2 直接"续跑"，schema 状态不可信。
    migrateModuleSchema(db, spec, 1);
    db.prepare(
      "INSERT INTO gap_ledger_schema_migrations (version, applied_at, checksum) VALUES (3, '2026-01-01T00:00:00.000Z', ?)",
    ).run(migrationChecksum(spec.migrations[3]!));

    expect(() => migrateModuleSchema(db, spec)).toThrowError(MigrationLedgerError);
    try {
      migrateModuleSchema(db, spec);
    } catch (err) {
      expect((err as MigrationLedgerError).kind).toBe("ledger_gap");
    }
    // 不推进：迁移 2 的表不存在；账本仍只有 1、3 两行。
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gap_v2'").get(),
    ).toBeUndefined();
    expect(ledgerRows("gap_ledger_schema_migrations")).toBe(2);
  });

  it("审查项：账本只有 2 缺 1 → 同样拒绝；连续账本正常续跑", () => {
    const spec = {
      module: "gap-solo",
      ledgerTable: "gap_solo_schema_migrations",
      migrations: {
        1: "CREATE TABLE gap_s1 (id INTEGER);",
        2: "CREATE TABLE gap_s2 (id INTEGER);",
      },
    };
    db.exec(
      "CREATE TABLE gap_solo_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT INTO gap_solo_schema_migrations (version, applied_at, checksum) VALUES (2, '2026-01-01T00:00:00.000Z', ?)",
    ).run(migrationChecksum(spec.migrations[2]!));
    expect(() => migrateModuleSchema(db, spec)).toThrowError(MigrationLedgerError);
    try {
      migrateModuleSchema(db, spec);
    } catch (err) {
      expect((err as MigrationLedgerError).kind).toBe("ledger_gap");
    }

    // 对照：干净的连续账本正常应用 1 并续跑到 2（换独立账本表）。
    const cleanSpec = {
      module: "gap-clean",
      ledgerTable: "gap_clean_schema_migrations",
      migrations: spec.migrations,
    };
    migrateModuleSchema(db, cleanSpec, 1);
    migrateModuleSchema(db, cleanSpec);
    expect(ledgerRows("gap_clean_schema_migrations")).toBe(2);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gap_s2'").get(),
    ).toBeDefined();
  });
});

describe("账本与 merchant_ops 账本隔离（文件库升级）", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-m1-ledger-"));
    dbPath = join(dir, "state.sqlite");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("旧库（ops v1 时代数据）升级后三账本可用，ops 数据保留", () => {
    const first = new DatabaseSync(dbPath);
    migrateMerchantOpsSchema(first);
    const repo = new FollowUpRepository({ db: first, now: () => "2026-11-15T00:00:00.000Z" });
    repo.transaction(() =>
      repo.createTask({
        merchantId: "m-1",
        triggerEvent: "quote_not_answered",
        actionType: "merchant_todo",
        maxAttempts: 3,
        payload: {},
      }),
    );
    first.close();

    const second = new DatabaseSync(dbPath);
    migrateMerchantOpsSchema(second);
    registerGovernanceLedgers(second);
    const grants = new DataUseGrantStore({
      db: second,
      now: () => "2026-11-15T00:00:00.000Z",
    });
    grants.createGrant({
      merchant_id: "m-1",
      subject_id: "subj-1",
      purpose: "history_recall",
      resource_scope_id: "org",
      expires_at: "2026-12-15T00:00:00.000Z",
    });
    const opsCount = (
      second.prepare("SELECT COUNT(*) AS n FROM followup_tasks").get() as { n: number }
    ).n;
    expect(opsCount).toBe(1);
    // operations-jobs 账本独立推进到 v1（后台预算表），不影响 merchant_ops。
    expect(Object.keys(OPERATIONS_JOBS_LEDGER.migrations)).toEqual(["1", "2", "3"]);
    expect(
      second
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='background_budget_days'",
        )
        .get(),
    ).toBeDefined();
    second.close();
  });
});
