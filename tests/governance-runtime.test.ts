/**
 * M1 收尾接线集成验证（D-M0-08 / X12 / 收尾决议 §1.2）。
 * initializeGovernanceRuntime：全关不获取、开启即获取+心跳、第二进程 fail-closed、
 * 租约接管 + fencing 递增、续约失败关闭新功能但现有路径可用、customer_delivery 锁死。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import { FollowUpService } from "../src/merchant-core/followup/service.js";
import { FollowUpRepository } from "../src/merchant-core/followup/repository.js";
import {
  loadGovernanceFeatureFlagsFromEnv,
  parseGovernanceFeatureFlags,
} from "../src/merchant-core/context-governance/feature-flags.js";
import {
  GovernanceRuntimeError,
  initializeGovernanceRuntime,
  type GovernanceRuntimeEvent,
} from "../src/merchant-core/ownership/runtime.js";
import {
  InstanceOwnershipError,
  InstanceOwnershipService,
} from "../src/merchant-core/ownership/instance-ownership.js";

const LEASE_MS = 60_000;
const MEMORY_ON = parseGovernanceFeatureFlags({ memory_enabled: true });
const ALL_OFF = parseGovernanceFeatureFlags(undefined);

describe("governance 运行时接线（M1 收尾）", () => {
  let dir: string;
  let dbPath: string;
  let dbA: DatabaseSync;
  let dbB: DatabaseSync;
  let clock: string;
  let events: GovernanceRuntimeEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-m1-runtime-"));
    dbPath = join(dir, "state.sqlite");
    clock = "2026-11-16T00:00:00.000Z";
    dbA = new DatabaseSync(dbPath);
    dbB = new DatabaseSync(dbPath);
    migrateMerchantOpsSchema(dbA);
    migrateMerchantOpsSchema(dbB);
    events = [];
  });
  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function advance(ms: number): void {
    clock = new Date(Date.parse(clock) + ms).toISOString();
  }

  function init(
    db: DatabaseSync,
    flags: ReturnType<typeof parseGovernanceFeatureFlags>,
    ownerId: string,
  ) {
    return initializeGovernanceRuntime({
      db,
      merchantId: "m-1",
      flags,
      ownerId,
      now: () => clock,
      leaseMs: LEASE_MS,
      // 心跳周期远大于测试时长：tick 一律由测试手动驱动。
      heartbeatMs: 3_600_000,
      onEvent: (event) => events.push(event),
    });
  }

  function followUpOn(db: DatabaseSync): FollowUpService {
    return new FollowUpService({
      repository: new FollowUpRepository({ db, now: () => clock }),
      now: () => clock,
    });
  }

  function eventTypes(): string[] {
    return events.map((event) => event.type);
  }

  it("1) 三个开关全关：不 acquire、现有路径不变、账本注册幂等", () => {
    const runtime = init(dbA, ALL_OFF, "proc-a");
    expect(runtime.featureEnabled).toBe(false);
    expect(runtime.active).toBe(false);
    expect(eventTypes()).toEqual(["ledgers_registered"]);
    expect(() => runtime.assertOwner()).toThrowError(GovernanceRuntimeError);
    try {
      runtime.assertOwner();
    } catch (err) {
      expect((err as GovernanceRuntimeError).code).toBe("feature_disabled");
    }
    // 账本重复注册幂等（不 acquire、不报错）。
    const again = init(dbA, ALL_OFF, "proc-a");
    expect(eventTypes().slice(-1)).toEqual(["ledgers_registered"]);
    // 现有路径不受影响：followup 正常排程；所有权表无记录。
    const task = followUpOn(dbA).schedule({
      merchant_id: "m-1",
      trigger_event: "quote_not_answered",
      action_type: "merchant_todo",
      max_attempts: 3,
      payload: {},
    }).task;
    expect(task.status).toBe("PENDING");
    expect(
      dbA.prepare("SELECT COUNT(*) AS n FROM instance_ownership").get(),
    ).toEqual({ n: 0 });
    expect(
      dbA.prepare("SELECT COUNT(*) AS n FROM customer_memory_schema_migrations").get(),
    ).toEqual({ n: 3 });
    void again;
  });

  it("2) 任一开关开启：acquire 成功并心跳续约成功", () => {
    const runtime = init(dbA, MEMORY_ON, "proc-a");
    expect(runtime.featureEnabled).toBe(true);
    expect(runtime.active).toBe(true);
    const lease = runtime.assertOwner();
    expect(lease.fencing).toBe(1);
    expect(eventTypes()).toEqual(["ledgers_registered", "ownership_acquired"]);

    advance(20_000); // leaseMs/3 心跳点
    runtime.tick();
    expect(eventTypes()).toEqual([
      "ledgers_registered",
      "ownership_acquired",
      "ownership_renewed",
    ]);
    const renewed = runtime.assertOwner({ expected_fencing: 1 });
    expect(renewed.lease_expires_at).toBe("2026-11-16T00:01:20.000Z");
    runtime.stop();
    expect(eventTypes()).toContain("ownership_released");
  });

  it("3) 第二进程 acquire 失败：fail-closed 不启用新功能，现有路径保持", () => {
    const first = init(dbA, MEMORY_ON, "proc-a");
    expect(first.active).toBe(true);

    events = [];
    const second = init(dbB, MEMORY_ON, "proc-b");
    expect(second.active).toBe(false);
    expect(eventTypes()).toEqual(["ledgers_registered", "ownership_acquisition_failed"]);
    expect(events[1]).toMatchObject({ type: "ownership_acquisition_failed", reason: "ownership_held" });
    expect(() => second.assertOwner()).toThrowError(GovernanceRuntimeError);
    try {
      second.assertOwner();
    } catch (err) {
      expect((err as GovernanceRuntimeError).code).toBe("not_acquired");
    }
    // 第二进程现有路径不受影响（原接待/经营行为保持）。
    const task = followUpOn(dbB).schedule({
      merchant_id: "m-1",
      trigger_event: "quote_not_answered",
      action_type: "merchant_todo",
      max_attempts: 3,
      payload: {},
    }).task;
    expect(task.status).toBe("PENDING");
    first.stop();
    second.stop();
  });

  it("4) 租约过期后第二实例接管，fencing 递增；旧实例 assertOwner 被拒", () => {
    const first = init(dbA, MEMORY_ON, "proc-a");
    expect(first.active).toBe(true);
    advance(LEASE_MS + 1);

    events = [];
    const second = init(dbB, MEMORY_ON, "proc-b");
    expect(second.active).toBe(true);
    expect(events).toContainEqual({ type: "ownership_acquired", fencing: 2 });
    expect(second.assertOwner().fencing).toBe(2);

    // 旧实例：内存租约仍在，但逐次校验拒绝（owner 已变更，透传底层原因码）。
    expect(() => first.assertOwner()).toThrowError(InstanceOwnershipError);
    try {
      first.assertOwner({ expected_fencing: 1 });
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("not_owner");
    }
    // 旧实例再 tick：renew 被拒 → ownership_lost，新功能写入永久关闭。
    first.tick();
    expect(events).toContainEqual({ type: "ownership_lost", reason: "not_owner" });
    expect(first.active).toBe(false);
    expect(() => first.assertOwner()).toThrowError(GovernanceRuntimeError);
    second.stop();
  });

  it("5) 续约失败后新功能写入被拒，现有路径仍可运行", () => {
    const runtime = init(dbA, MEMORY_ON, "proc-a");
    runtime.assertOwner({ expected_fencing: 1 });
    advance(LEASE_MS + 1); // 过期，无人接管
    runtime.tick();
    expect(events).toContainEqual({ type: "ownership_lost", reason: "lease_expired" });
    expect(runtime.active).toBe(false);
    expect(() => runtime.assertOwner()).toThrowError(GovernanceRuntimeError);
    try {
      runtime.assertOwner();
    } catch (err) {
      expect((err as GovernanceRuntimeError).code).toBe("not_acquired");
    }
    // 已提交结果不回滚、表不删除；现有路径照常。
    const task = followUpOn(dbA).schedule({
      merchant_id: "m-1",
      trigger_event: "quote_not_answered",
      action_type: "merchant_todo",
      max_attempts: 3,
      payload: {},
    }).task;
    expect(task.status).toBe("PENDING");
    const heartbeats = dbA
      .prepare("SELECT COUNT(*) AS n FROM instance_ownership")
      .get() as { n: number };
    expect(heartbeats.n).toBe(1);
  });

  it("6) customer_delivery_enabled=true：配置层启动失败（映射 GOVERNANCE_FLAGS_INVALID）", () => {
    expect(() =>
      loadGovernanceFeatureFlagsFromEnv({ KIWI_GOVERNANCE_CUSTOMER_DELIVERY_ENABLED: "true" }),
    ).toThrowError(/P0 固定关闭/);
    // bootstrap 把解析失败包装为 CloudStartupError（code=GOVERNANCE_FLAGS_INVALID），
    // 不进入 initializeGovernanceRuntime——运行时只接受已解析的 flags。
  });

  it("新库首启（bootstrap 真实顺序）：运行时先迁移 ops schema，acquire 成功", () => {
    // bootstrap 在 openMerchantOperationsFacade 之前调用运行时；新库上
    // instance_ownership 必须由运行时先行幂等建表（修复"no such table"）。
    const fresh = new DatabaseSync(join(dir, "fresh.sqlite")); // 不做任何迁移
    try {
      const runtime = init(fresh, MEMORY_ON, "proc-a");
      expect(runtime.active).toBe(true);
      expect(eventTypes()).toEqual(["ledgers_registered", "ownership_acquired"]);
      const lease = runtime.assertOwner();
      expect(lease.fencing).toBe(1);
      expect(
        fresh
          .prepare("SELECT owner_id, fencing, state FROM instance_ownership")
          .get(),
      ).toMatchObject({ owner_id: "proc-a", fencing: 1, state: "HELD" });
      runtime.stop();
      expect(eventTypes()).toContain("ownership_released");
    } finally {
      fresh.close();
    }
  });

  it("旧库（merchant_ops v1）升级：v1 数据保留，运行时迁移 v2 并获取所有权", () => {
    const legacy = new DatabaseSync(join(dir, "legacy.sqlite"));
    try {
      migrateMerchantOpsSchema(legacy, 1); // 模拟 v1 时代已有库
      const repo = new FollowUpRepository({ db: legacy, now: () => clock });
      const { task } = repo.transaction(() =>
        repo.createTask({
          merchantId: "m-1",
          triggerEvent: "quote_not_answered",
          actionType: "merchant_todo",
          maxAttempts: 3,
          payload: {},
        }),
      );
      // 运行时先于 facade 启动：就地升级 v1 → v2 并获取所有权。
      const runtime = init(legacy, MEMORY_ON, "proc-a");
      expect(runtime.active).toBe(true);
      expect(events).toContainEqual({ type: "ownership_acquired", fencing: 1 });
      expect(runtime.assertOwner({ expected_fencing: 1 }).fencing).toBe(1);
      // v1 数据无损；账本推进到 v2。
      expect(repo.getTask("m-1", task.task_id)?.task_id).toBe(task.task_id);
      expect(
        legacy
          .prepare("SELECT version FROM merchant_ops_schema_migrations ORDER BY version")
          .all(),
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
      // 随后 facade 打开（完整迁移）幂等，不干扰已持有的所有权。
      migrateMerchantOpsSchema(legacy);
      expect(runtime.assertOwner({ expected_fencing: 1 }).fencing).toBe(1);
      runtime.stop();
    } finally {
      legacy.close();
    }
  });

  it("补充：账本注册失败时即使开关开启也不获取所有权（fail-closed）", () => {
    // 预埋损坏的账本 checksum。
    dbA.exec(
      "CREATE TABLE customer_memory_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)",
    );
    dbA.prepare(
      "INSERT INTO customer_memory_schema_migrations (version, applied_at, checksum) VALUES (1, '2026-01-01T00:00:00.000Z', 'corrupted')",
    ).run();

    const runtime = init(dbA, MEMORY_ON, "proc-a");
    // fail-closed：不获取所有权、不写所有权行。失败发生在登记阶段，必须
    // 如实报 ledger_registration_failed——不得先发 ledgers_registered 再伪造
    // ownership_acquisition_failed（事件语义固定）。
    expect(runtime.active).toBe(false);
    expect(eventTypes()).not.toContain("ownership_acquired");
    expect(eventTypes()).not.toContain("ledgers_registered");
    expect(eventTypes()).toContain("ledger_registration_failed");
    expect(eventTypes()).not.toContain("ownership_acquisition_failed");
    expect(() => runtime.assertOwner()).toThrowError(GovernanceRuntimeError);
    // 所有权表无记录：未做任何新功能写入。
    expect(dbA.prepare("SELECT COUNT(*) AS n FROM instance_ownership").get()).toEqual({ n: 0 });
  });

  it("补充：stop() 释放所有权后其他进程可获取；stop 幂等且未获取时安全", () => {
    const first = init(dbA, MEMORY_ON, "proc-a");
    first.stop();
    expect(eventTypes()).toEqual([
      "ledgers_registered",
      "ownership_acquired",
      "ownership_released",
    ]);
    expect(first.active).toBe(false);
    first.stop(); // 幂等：无新事件
    expect(eventTypes().filter((type) => type === "ownership_released")).toHaveLength(1);

    events = [];
    const second = init(dbB, MEMORY_ON, "proc-b");
    expect(events).toContainEqual({ type: "ownership_acquired", fencing: 2 });
    second.stop();

    // 全关实例 stop() 安全（从未获取）。
    events = [];
    init(dbA, ALL_OFF, "proc-c").stop();
    expect(eventTypes()).toEqual(["ledgers_registered"]);
  });

  it("审查项：新功能写入走 writeUnderOwnership，校验与写入同事务", () => {
    const runtime = init(dbA, MEMORY_ON, "proc-a");
    runtime.assertOwner({ expected_fencing: 1 });
    // FollowUpService.schedule（内部 repository.transaction）入栅栏：受控
    // 嵌套事务（SAVEPOINT）下不再抛 "cannot start a transaction"。
    const { task } = runtime.writeUnderOwnership((lease) => {
      expect(lease.fencing).toBe(1);
      return followUpOn(dbA).schedule({
        merchant_id: "m-1",
        trigger_event: "governed_write",
        action_type: "merchant_todo",
        max_attempts: 3,
        payload: {},
      });
    });
    expect(task.status).toBe("PENDING");
    // 第二连接可见（已提交）。
    expect(
      dbB.prepare("SELECT COUNT(*) AS n FROM followup_tasks WHERE trigger_event = 'governed_write'").get(),
    ).toEqual({ n: 1 });
  });

  it("审查项：内层事务写入后抛错被外层捕获，部分写入不提交（SAVEPOINT 回滚）", () => {
    const runtime = init(dbA, MEMORY_ON, "proc-a");
    const repo = new FollowUpRepository({ db: dbA, now: () => clock });
    const result = runtime.writeUnderOwnership(() => {
      try {
        repo.transaction(() => {
          repo.createTask({
            merchantId: "m-1",
            triggerEvent: "partial",
            actionType: "merchant_todo",
            maxAttempts: 3,
            payload: {},
          });
          throw new Error("inner failure");
        });
        expect.unreachable("内层错误应重抛");
      } catch (err) {
        expect((err as Error).message).toBe("inner failure");
        // 外层捕获内层失败，继续正常返回 → 栅栏事务提交。
      }
      return "continued";
    });
    expect(result).toBe("continued");
    // 内层部分写入未提交；栅栏事务本身正常提交（所有权不变）。
    expect(
      dbB.prepare("SELECT COUNT(*) AS n FROM followup_tasks WHERE trigger_event = 'partial'").get(),
    ).toEqual({ n: 0 });
    expect(runtime.assertOwner({ expected_fencing: 1 }).fencing).toBe(1);
    // 内层抛错未被捕获：栅栏整体回滚（work 内 schedule 的写入一并撤销）。
    expect(() =>
      runtime.writeUnderOwnership(() => {
        followUpOn(dbA).schedule({
          merchant_id: "m-1",
          trigger_event: "rolled-back",
          action_type: "merchant_todo",
          max_attempts: 3,
          payload: {},
        });
        throw new Error("work failure after schedule");
      }),
    ).toThrowError("work failure after schedule");
    expect(
      dbB.prepare("SELECT COUNT(*) AS n FROM followup_tasks WHERE trigger_event = 'rolled-back'").get(),
    ).toEqual({ n: 0 });
  });

  it("审查项（DeepSeek 复验）：旧实例 tick 不回写新 fencing、不能写、新实例不受影响", () => {
    const oldRuntime = init(dbA, MEMORY_ON, "proc-a"); // fencing=1
    oldRuntime.assertOwner({ expected_fencing: 1 });
    advance(LEASE_MS + 1);
    const newRuntime = init(dbB, MEMORY_ON, "proc-a"); // 同 owner 重获，fencing=2
    expect(newRuntime.assertOwner({ expected_fencing: 2 }).fencing).toBe(2);
    const before = dbB
      .prepare("SELECT heartbeat_at, lease_expires_at, fencing FROM instance_ownership")
      .get() as { heartbeat_at: string; lease_expires_at: string; fencing: number };

    // 修复前：tick 的 renew 只 CAS owner_id → 把新实例的租约续上，并把
    // fencing=2 写回旧实例内存（完整绕过）。修复后：续约 CAS 旧 fencing →
    // fencing_mismatch → ownership_lost，内存租约清空。
    oldRuntime.tick();
    expect(events).toContainEqual({ type: "ownership_lost", reason: "fencing_mismatch" });
    expect(oldRuntime.active).toBe(false);
    expect(() => oldRuntime.assertOwner()).toThrowError(GovernanceRuntimeError);
    try {
      oldRuntime.writeUnderOwnership(() => undefined);
    } catch (err) {
      expect((err as GovernanceRuntimeError).code).toBe("not_acquired");
    }

    // 新实例不受影响：所有权行未被旧实例续约（heartbeat/expires/fencing 原值）。
    const after = dbB
      .prepare("SELECT heartbeat_at, lease_expires_at, fencing FROM instance_ownership")
      .get() as { heartbeat_at: string; lease_expires_at: string; fencing: number };
    expect(after).toEqual(before);

    // 新实例心跳续约与写入照常。
    advance(20_000);
    events = [];
    newRuntime.tick();
    expect(events).toEqual([{ type: "ownership_renewed", fencing: 2 }]);
    const { task } = newRuntime.writeUnderOwnership(() =>
      followUpOn(dbB).schedule({
        merchant_id: "m-1",
        trigger_event: "new-owner-write",
        action_type: "merchant_todo",
        max_attempts: 3,
        payload: {},
      }),
    );
    expect(task.status).toBe("PENDING");
    newRuntime.stop();
  });

  it("审查项（DeepSeek 复验）：旧实例 stop 不影响同 owner 重获的新租约", () => {
    const oldRuntime = init(dbA, MEMORY_ON, "proc-a"); // fencing=1
    oldRuntime.assertOwner({ expected_fencing: 1 });
    advance(LEASE_MS + 1);
    const newRuntime = init(dbB, MEMORY_ON, "proc-a"); // 同 owner 重获，fencing=2
    expect(newRuntime.assertOwner({ expected_fencing: 2 }).fencing).toBe(2);
    const before = dbB
      .prepare("SELECT heartbeat_at, lease_expires_at, fencing, state FROM instance_ownership")
      .get() as Record<string, unknown>;

    // 修复前：stop 的 release 只查 owner_id + HELD → 旧实例关闭把新租约置为
    // RELEASED。修复后：CAS 旧 fencing → ownership_release_failed。
    oldRuntime.stop();
    expect(events).toContainEqual({
      type: "ownership_release_failed",
      reason: "fencing_mismatch",
    });
    // 新租约分毫未动，新实例的写入与关闭照常。
    const after = dbB
      .prepare("SELECT heartbeat_at, lease_expires_at, fencing, state FROM instance_ownership")
      .get() as Record<string, unknown>;
    expect(after).toEqual({ ...before, state: "HELD" });
    expect(after).toMatchObject({ fencing: 2, state: "HELD" });
    const { task } = newRuntime.writeUnderOwnership(() =>
      followUpOn(dbB).schedule({
        merchant_id: "m-1",
        trigger_event: "survives-old-stop",
        action_type: "merchant_todo",
        max_attempts: 3,
        payload: {},
      }),
    );
    expect(task.status).toBe("PENDING");
    newRuntime.stop();
    expect(events).toContainEqual({ type: "ownership_released" });
  });

  it("审查项（DeepSeek 复验）：预检不采纳接管方 token，旧实例 fail-closed", () => {
    const oldRuntime = init(dbA, MEMORY_ON, "proc-a"); // fencing=1
    oldRuntime.assertOwner({ expected_fencing: 1 });
    advance(LEASE_MS + 1);
    // 同 owner_id 新实例接管（fencing=2）。
    const newRuntime = init(dbB, MEMORY_ON, "proc-a");
    expect(newRuntime.assertOwner().fencing).toBe(2);

    // 修复前：旧实例的无 token 预检把内存租约刷新为接管方的 fencing=2，
    // 随后 writeUnderOwnership 绑定 2 成功落库（绕过）。修复后：预检以自己
    // 取得时的 fencing 核验 → fail-closed 抛 fencing_mismatch。
    expect(() => oldRuntime.assertOwner()).toThrowError(InstanceOwnershipError);
    try {
      oldRuntime.assertOwner();
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("fencing_mismatch");
    }
    // 显式传入接管方 token 的预检同样 validation 拒绝（不凭空升级持有状态）。
    expect(() => oldRuntime.assertOwner({ expected_fencing: 2 })).toThrowError(
      GovernanceRuntimeError,
    );
    // 写入仍被拒且无落库；错误码为 fencing_mismatch——证明写入提交的是旧
    // token（fencing=1）；若预检采纳了新 token，此处会成功落库（缺陷形态）。
    expect(() =>
      oldRuntime.writeUnderOwnership(() =>
        followUpOn(dbA).schedule({
          merchant_id: "m-1",
          trigger_event: "refresh-bypass",
          action_type: "merchant_todo",
          max_attempts: 3,
          payload: {},
        }),
      ),
    ).toThrowError(InstanceOwnershipError);
    try {
      oldRuntime.writeUnderOwnership(() => undefined);
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("fencing_mismatch");
    }
    expect(
      dbB.prepare("SELECT COUNT(*) AS n FROM followup_tasks WHERE trigger_event = 'refresh-bypass'").get(),
    ).toEqual({ n: 0 });
    // 接管方（持有 fencing=2）预检与写入正常。
    expect(newRuntime.assertOwner({ expected_fencing: 2 }).fencing).toBe(2);

    // 审查项（DeepSeek 复验）：显式 expected_fencing 只是断言，不透传——
    // 旧实例传接管方的 2 一律 validation 拒绝（修复前透传后成功写入）。
    expect(() =>
      oldRuntime.writeUnderOwnership(() => undefined, { expected_fencing: 2 }),
    ).toThrowError(GovernanceRuntimeError);
    try {
      oldRuntime.writeUnderOwnership(() => undefined, { expected_fencing: 2 });
    } catch (err) {
      expect((err as GovernanceRuntimeError).code).toBe("validation");
      expect((err as GovernanceRuntimeError).message).toContain("不一致");
    }
    expect(
      dbB.prepare("SELECT COUNT(*) AS n FROM followup_tasks WHERE trigger_event = 'refresh-bypass'").get(),
    ).toEqual({ n: 0 });

    // 默认绑定：不传 token → 绑定本实例取得的 fencing=1 → fencing_mismatch。
    try {
      oldRuntime.writeUnderOwnership(() => undefined);
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("fencing_mismatch");
    }
    // 有效 token：接管方（fencing=2）显式传 2 成功写入。
    const { task: adopted } = newRuntime.writeUnderOwnership(
      () =>
        followUpOn(dbB).schedule({
          merchant_id: "m-1",
          trigger_event: "valid-token-write",
          action_type: "merchant_todo",
          max_attempts: 3,
          payload: {},
        }),
      { expected_fencing: 2 },
    );
    expect(adopted.status).toBe("PENDING");
    newRuntime.stop();
  });

  it("审查项（DeepSeek 实证）：同 owner_id 重获后，旧 runtime 实例的写入被拒", () => {
    const runtimeA = init(dbA, MEMORY_ON, "proc-a"); // fencing=1
    runtimeA.assertOwner({ expected_fencing: 1 });
    advance(LEASE_MS + 1);
    // 同 owner_id 的新实例接管（fencing=2）——owner 判定对旧实例是"匹配"的。
    const runtimeB = init(dbB, MEMORY_ON, "proc-a");
    expect(runtimeB.assertOwner({ expected_fencing: 2 }).fencing).toBe(2);

    // 旧实例（内存租约仍持 fencing=1）写入：runtime 默认绑定取得时的
    // fencing → fencing_mismatch，无落库。
    expect(() =>
      runtimeA.writeUnderOwnership(() =>
        followUpOn(dbA).schedule({
          merchant_id: "m-1",
          trigger_event: "stale-runtime-write",
          action_type: "merchant_todo",
          max_attempts: 3,
          payload: {},
        }),
      ),
    ).toThrowError(InstanceOwnershipError);
    try {
      runtimeA.writeUnderOwnership(() => undefined);
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("fencing_mismatch");
    }
    expect(
      dbA.prepare("SELECT COUNT(*) AS n FROM followup_tasks WHERE trigger_event = 'stale-runtime-write'").get(),
    ).toEqual({ n: 0 });

    // 新实例（绑定 fencing=2）写入成功。
    const { task } = runtimeB.writeUnderOwnership(() =>
      followUpOn(dbB).schedule({
        merchant_id: "m-1",
        trigger_event: "fresh-runtime-write",
        action_type: "merchant_todo",
        max_attempts: 3,
        payload: {},
      }),
    );
    expect(task.status).toBe("PENDING");
    expect(
      dbA.prepare("SELECT COUNT(*) AS n FROM followup_tasks WHERE trigger_event = 'fresh-runtime-write'").get(),
    ).toEqual({ n: 1 });
    runtimeB.stop();
  });

  it("审查项（检查与写入分离竞态）：assertOwner 通过后租约过期，writeUnderOwnership 在提交路径拒绝", () => {
    const runtime = init(dbA, MEMORY_ON, "proc-a");
    // 先查：租约有效，预检通过。
    expect(runtime.assertOwner({ expected_fencing: 1 }).fencing).toBe(1);
    // 预检与写入之间租约过期。
    advance(LEASE_MS + 1);
    const repo = new FollowUpRepository({ db: dbA, now: () => clock });
    expect(() =>
      runtime.writeUnderOwnership(() => {
        return repo.createTask({
          merchantId: "m-1",
          triggerEvent: "stale_write",
          actionType: "merchant_todo",
          maxAttempts: 3,
          payload: {},
        }).task;
      }),
    ).toThrowError(InstanceOwnershipError);
    try {
      runtime.writeUnderOwnership(() => undefined);
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("lease_expired");
    }
    // 提交路径拒绝 = 无写入落库。
    expect(
      dbB.prepare("SELECT COUNT(*) AS n FROM followup_tasks WHERE trigger_event = 'stale_write'").get(),
    ).toEqual({ n: 0 });
  });

  it("审查项：ownership_lost 后写入通道关闭；work 抛错整体回滚；全关拒绝", () => {
    const runtime = init(dbA, MEMORY_ON, "proc-a");
    advance(LEASE_MS + 1);
    runtime.tick(); // ownership_lost
    expect(events).toContainEqual({ type: "ownership_lost", reason: "lease_expired" });
    const repo = new FollowUpRepository({ db: dbA, now: () => clock });
    expect(() => runtime.writeUnderOwnership(() => repo.createTask({
      merchantId: "m-1", triggerEvent: "x", actionType: "t", maxAttempts: 1, payload: {},
    }))).toThrowError(GovernanceRuntimeError);
    try {
      runtime.writeUnderOwnership(() => undefined);
    } catch (err) {
      expect((err as GovernanceRuntimeError).code).toBe("not_acquired");
    }

    // work 抛错 → 整体回滚。
    const active = init(dbB, MEMORY_ON, "proc-b");
    const repoB = new FollowUpRepository({ db: dbB, now: () => clock });
    expect(() =>
      active.writeUnderOwnership(() => {
        repoB.createTask({ merchantId: "m-1", triggerEvent: "boom", actionType: "t", maxAttempts: 1, payload: {} });
        throw new Error("业务失败");
      }),
    ).toThrowError("业务失败");
    expect(
      dbA.prepare("SELECT COUNT(*) AS n FROM followup_tasks WHERE trigger_event = 'boom'").get(),
    ).toEqual({ n: 0 });
    active.stop();

    // 全关：写入通道不存在。
    const off = init(dbA, ALL_OFF, "proc-c");
    expect(() => off.writeUnderOwnership(() => undefined)).toThrowError(GovernanceRuntimeError);
    try {
      off.writeUnderOwnership(() => undefined);
    } catch (err) {
      expect((err as GovernanceRuntimeError).code).toBe("feature_disabled");
    }
  });

  it("补充：双连接 InstanceOwnershipService 直查（接线前的底层保证不变）", () => {
    const serviceA = new InstanceOwnershipService({ db: dbA, now: () => clock, leaseMs: LEASE_MS });
    const serviceB = new InstanceOwnershipService({ db: dbB, now: () => clock, leaseMs: LEASE_MS });
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    expect(() => serviceB.acquire({ merchant_id: "m-1", owner_id: "proc-b" })).toThrowError(
      /fail-closed/,
    );
  });

  it("审查项（回调隔离）：ledgers_registered 抛含 database is locked 文案的非 DB 错误 → 原错上抛（不重试、不吞、不伪造失败事件）", () => {
    // DeepSeek 实证：含锁文案的非 DB 回调错误此前在 DB 重试区被误重试并吞
    // 掉。修复后 emit 已移出重试区——回调抛什么（含锁文案）都不触发重试、
    // 不被吞：原错原样上抛给调用方；无 ledger_registration_failed 伪造。
    const events: GovernanceRuntimeEvent[] = [];
    let thrown: Error | undefined;
    try {
      initializeGovernanceRuntime({
        db: dbA,
        merchantId: "m-1",
        flags: MEMORY_ON,
        ownerId: "proc-a",
        now: () => clock,
        leaseMs: LEASE_MS,
        heartbeatMs: 3_600_000,
        onEvent: (event) => {
          events.push(event);
          if (event.type === "ledgers_registered") {
            throw new Error("database is locked（模拟回调层非 DB 错误文案）");
          }
        },
      });
      expect.unreachable("回调原错应上抛");
    } catch (err) {
      thrown = err as Error;
    }
    // 原错保留：消息即回调抛的内容（不被包装/覆盖）。
    expect(thrown!.message).toBe("database is locked（模拟回调层非 DB 错误文案）");
    // 事件按序如实：ledgers_registered（回调抛错 → 异常上抛终止启动——
    // acquire 未执行）。无伪造失败事件。
    expect(events.map((e) => e.type)).toEqual(["ledgers_registered"]);
    // 成功路径包裹：回调异常 → 以取得时 fencing 安全释放（DB 行 RELEASED，
    // 不残留 HELD——避免"租约 HELD 而 runtime inactive"错位）。
    expect(
      dbA.prepare("SELECT state FROM instance_ownership").get(),
    ).toMatchObject({ state: "RELEASED" });
  });

  it("审查项（全关回调隔离）：ALL_OFF 的 ledgers_registered 抛含 database is locked 文案 → 原错上抛（不重试、不吞、无 ownership 行）", () => {
    // DeepSeek 实证缺口：ownership === undefined 分支的 emit 仍在 DB 重试 try
    // 内；回调抛含锁文案的非 DB 错误会被误判为瞬时锁竞争 → 退避重试 → 第二
    // 次因去重不再 emit → 错误被吞、启动"成功"。修复后 emit 位于 DB 重试区
    // 之外：调用次数恒为 1，原错原样上抛。
    const events: GovernanceRuntimeEvent[] = [];
    let thrown: Error | undefined;
    try {
      initializeGovernanceRuntime({
        db: dbA,
        merchantId: "m-1",
        flags: ALL_OFF,
        ownerId: "proc-a",
        now: () => clock,
        leaseMs: LEASE_MS,
        heartbeatMs: 3_600_000,
        onEvent: (event) => {
          events.push(event);
          if (event.type === "ledgers_registered") {
            throw new Error("database is locked（全关回调模拟）");
          }
        },
      });
      expect.unreachable("全关回调原错应上抛");
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toBe("database is locked（全关回调模拟）");
    // 回调只收到一次 ledgers_registered（不因锁文案重试）。
    expect(events.map((e) => e.type)).toEqual(["ledgers_registered"]);
    // 全关不获取所有权：无 ownership 行（重试也不得伪造 acquire）。
    expect(
      dbA.prepare("SELECT COUNT(*) AS n FROM instance_ownership").get(),
    ).toEqual({ n: 0 });
  });

  it("审查项（回调隔离）：ownership_acquired 回调抛错 → 租约以 fencing 安全释放（DB 行 RELEASED）+ 异常上抛", () => {
    const events: GovernanceRuntimeEvent[] = [];
    let thrown: Error | undefined;
    try {
      initializeGovernanceRuntime({
        db: dbA,
        merchantId: "m-1",
        flags: MEMORY_ON,
        ownerId: "proc-a",
        now: () => clock,
        leaseMs: LEASE_MS,
        heartbeatMs: 3_600_000,
        onEvent: (event) => {
          events.push(event);
          if (event.type === "ownership_acquired") {
            throw new Error("模拟 ownership_acquired 回调异常");
          }
        },
      });
      expect.unreachable("回调异常应上抛");
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toBe("模拟 ownership_acquired 回调异常");
    expect(events.map((e) => e.type)).toEqual(["ledgers_registered", "ownership_acquired"]);
    // DB 行不残留 HELD：以取得时 fencing 安全释放 → RELEASED。
    expect(
      dbA.prepare("SELECT state FROM instance_ownership").get(),
    ).toMatchObject({ state: "RELEASED" });
  });

  it("审查项（续租暂时 BUSY）：tick 遇 BUSY → renewal_deferred 且保留 lease（不越期写入仍被拒）；锁释放后 tick 恢复", () => {
    const runtime = init(dbA, MEMORY_ON, "proc-a");
    runtime.assertOwner({ expected_fencing: 1 });
    // 注入暂时 BUSY：另一连接持锁（同时刻 renew 的 BEGIN 会 locked）。
    const locker = new DatabaseSync(dbPath);
    locker.exec("BEGIN IMMEDIATE");
    advance(20_000);
    runtime.tick();
    expect(events).toContainEqual({ type: "ownership_renewal_deferred", reason: expect.any(String) });
    // lease 保留（deferred 不清空）：越期写入仍被拒——错误类型如实
    //（此处先到期后锁释放，writeUnderOwnership 的期限校验拒绝）。
    advance(LEASE_MS + 1);
    expect(() =>
      runtime.writeUnderOwnership(() => undefined),
    ).toThrowError();
    locker.exec("COMMIT");
    locker.close();
    // 锁释放后：接管方（新实例）正常获取 → tick 续约成功（BUSY 恢复路径
    // 由 renewal_deferred → 后续 tick 事件驱动验证）。
    const newRuntime = init(dbB, MEMORY_ON, "proc-new");
    expect(newRuntime.active).toBe(true);
    newRuntime.tick();
    expect(events).toContainEqual({ type: "ownership_renewed", fencing: 2 });
    newRuntime.stop();
  });

  it("审查项（primitive 抛值）：onEvent 抛字符串 → 原值原样上抛（不被 TypeError 覆盖）", () => {
    let thrown: unknown;
    try {
      initializeGovernanceRuntime({
        db: dbA,
        merchantId: "m-1",
        flags: MEMORY_ON,
        ownerId: "proc-a",
        now: () => clock,
        leaseMs: LEASE_MS,
        heartbeatMs: 3_600_000,
        onEvent: () => {
          throw "primitive-string-rejection";
        },
      });
      expect.unreachable("primitive 抛值应原样上抛");
    } catch (err) {
      thrown = err;
    }
    // 原值保留：字符串本身（不被对象包装 TypeError 覆盖）。
    expect(thrown).toBe("primitive-string-rejection");
    // 安全释放照常：DB 行 RELEASED。
    expect(
      dbA.prepare("SELECT state FROM instance_ownership").get(),
    ).toMatchObject({ state: "RELEASED" });
  });

  it("审查项（tick 回调异常）：ownership_renewed 回调抛错 → 安全处理（保留租约、专用可诊断事件、无 ownership_lost）", () => {
    const events: GovernanceRuntimeEvent[] = [];
    const runtime = initializeGovernanceRuntime({
      db: dbA,
      merchantId: "m-1",
      flags: MEMORY_ON,
      ownerId: "proc-a",
      now: () => clock,
      leaseMs: LEASE_MS,
      heartbeatMs: 3_600_000,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "ownership_renewed") {
          throw new Error("模拟 renewed 回调异常");
        }
      },
    });
    expect(runtime.active).toBe(true);
    advance(20_000);
    runtime.tick(); // 续约成功但回调抛错 → 安全处理（不崩溃、不误报 lost）
    expect(runtime.active).toBe(true); // 租约保留（真实持有）
    // 专用可诊断事件（非 ownership_lost 误报）。
    const cbFail = events.find(
      (e): e is GovernanceRuntimeEvent & { type: "ownership_renewal_callback_failed"; reason: string } =>
        e.type === "ownership_renewal_callback_failed",
    );
    expect(cbFail).toBeDefined();
    expect(cbFail!.reason).toContain("模拟 renewed 回调异常");
    expect(events.some((e) => e.type === "ownership_lost")).toBe(false);
    // 租约真实续上：fencing 未变、到期时间推进。
    expect(runtime.assertOwner({ expected_fencing: 1 }).fencing).toBe(1);
    // 仍可安全释放。
    runtime.stop();
    expect(events).toContainEqual({ type: "ownership_released" });
  });

  it("审查项（真实 timer 持续抛错）：onEvent 连续抛错（含处理 renewal_callback_failed 时）→ 定时器边界安全（不崩溃、行不误报 HELD、stop 可释放）", async () => {
    // 真实心跳 timer：onEvent 对 ownership_renewed 与
    // ownership_renewal_callback_failed 都抛错——定时器边界的异常被安全处理
    //（专用事件可诊断），不产生未捕获崩溃、不误报 ownership_lost。
    const events: GovernanceRuntimeEvent[] = [];
    const runtime = initializeGovernanceRuntime({
      db: dbA,
      merchantId: "m-1",
      flags: MEMORY_ON,
      ownerId: "proc-a",
      now: () => clock,
      leaseMs: 60000,
      heartbeatMs: 50, // 真实 timer 快速触发
      onEvent: (event) => {
        events.push(event);
        if (
          event.type === "ownership_renewed" ||
          event.type === "ownership_renewal_callback_failed"
        ) {
          throw new Error("模拟 timer 内连续抛错");
        }
      },
    });
    expect(runtime.active).toBe(true);
    // 让真实 timer 跑多轮（都抛错）。
    await new Promise<void>((r) => setTimeout(r, 300));
    // 安全：行仍 HELD（所有权真实持有，不因回调异常丢失）、无 ownership_lost
    // 误报、runtime 仍 active。
    expect(
      dbA.prepare("SELECT state FROM instance_ownership").get(),
    ).toMatchObject({ state: "HELD" });
    expect(events.some((e) => e.type === "ownership_lost")).toBe(false);
    expect(runtime.active).toBe(true);
    // stop 可释放（真实释放 DB 行）。
    runtime.stop();
    expect(events).toContainEqual({ type: "ownership_released" });
    expect(
      dbA.prepare("SELECT state FROM instance_ownership").get(),
    ).toMatchObject({ state: "RELEASED" });
    expect(runtime.active).toBe(false);
  });

  it("审查项（重复 start 幂等）：已持有租约时重复 start 不重新 acquire、保留可释放状态", () => {
    const runtime = init(dbA, MEMORY_ON, "proc-a");
    expect(runtime.active).toBe(true);
    events = [];
    runtime.start(); // 重复启动
    expect(events).toEqual([]); // 无重复事件/无重复 acquire
    expect(runtime.active).toBe(true);
    expect(runtime.assertOwner({ expected_fencing: 1 }).fencing).toBe(1);
    // 仍可释放（stop 正常走完）。
    runtime.stop();
    expect(eventTypes()).toEqual(["ownership_released"]);
  });
});
