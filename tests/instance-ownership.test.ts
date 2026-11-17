/**
 * TOP1-3 M1（D-M0-08）：实例级单写者所有权。
 * 双连接单 owner、第二进程 fail-closed、租约接管 + fencing 递增、旧 owner 提交被拒。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateMerchantOpsSchema } from "../src/merchant-core/ops/schema.js";
import {
  InstanceOwnershipError,
  InstanceOwnershipService,
} from "../src/merchant-core/ownership/instance-ownership.js";

const LEASE_MS = 60_000;

describe("实例级单写者所有权（D-M0-08）", () => {
  let dir: string;
  let dbPath: string;
  let dbA: DatabaseSync;
  let dbB: DatabaseSync;
  let serviceA: InstanceOwnershipService;
  let serviceB: InstanceOwnershipService;
  let clock: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-m1-owner-"));
    dbPath = join(dir, "state.sqlite");
    clock = "2026-11-15T00:00:00.000Z";
    const now = (): string => clock;
    dbA = new DatabaseSync(dbPath);
    dbB = new DatabaseSync(dbPath);
    migrateMerchantOpsSchema(dbA);
    migrateMerchantOpsSchema(dbB);
    serviceA = new InstanceOwnershipService({ db: dbA, now, leaseMs: LEASE_MS });
    serviceB = new InstanceOwnershipService({ db: dbB, now, leaseMs: LEASE_MS });
    // 栅栏写入的业务写入测试用（模拟新功能的同库持久写入）。
    dbA.exec(
      "CREATE TABLE IF NOT EXISTS fenced_writes (id TEXT PRIMARY KEY, fencing INTEGER NOT NULL)",
    );
  });
  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function advance(ms: number): void {
    clock = new Date(Date.parse(clock) + ms).toISOString();
  }

  it("双连接单 owner：先获取者持有，第二进程 fail-closed", () => {
    const lease = serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    expect(lease.fencing).toBe(1);
    expect(lease.owner_id).toBe("proc-a");
    expect(lease.lease_expires_at).toBe("2026-11-15T00:01:00.000Z");

    expect(() => serviceB.acquire({ merchant_id: "m-1", owner_id: "proc-b" })).toThrowError(
      InstanceOwnershipError,
    );
    try {
      serviceB.acquire({ merchant_id: "m-1", owner_id: "proc-b" });
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("ownership_held");
    }
    // fail-closed：第二进程没有所有权，提交守卫同样拒绝。
    expect(() => serviceB.assertOwner({ merchant_id: "m-1", owner_id: "proc-b" })).toThrowError(
      InstanceOwnershipError,
    );
  });

  it("续约刷新心跳与到期时间；非 owner 续约被拒", () => {
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    advance(10_000);
    const renewed = serviceA.renew({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 });
    expect(renewed.heartbeat_at).toBe("2026-11-15T00:00:10.000Z");
    expect(renewed.lease_expires_at).toBe("2026-11-15T00:01:10.000Z");

    expect(() =>
      serviceB.renew({ merchant_id: "m-1", owner_id: "proc-b", expected_fencing: 1 }),
    ).toThrowError(
      InstanceOwnershipError,
    );
    try {
      serviceB.renew({ merchant_id: "m-1", owner_id: "proc-b", expected_fencing: 1 });
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("not_owner");
    }
  });

  it("释放后其他进程可获取，fencing 递增", () => {
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    serviceA.release({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 });
    const leaseB = serviceB.acquire({ merchant_id: "m-1", owner_id: "proc-b" });
    expect(leaseB.fencing).toBe(2);
    expect(leaseB.owner_id).toBe("proc-b");
  });

  it("租约过期可接管，fencing 递增；旧 owner 续约与提交都被拒", () => {
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    advance(LEASE_MS + 1); // 到期等号即失效，这里越过到期点

    expect(() =>
      serviceA.renew({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 }),
    ).toThrowError(
      InstanceOwnershipError,
    );
    try {
      serviceA.renew({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 });
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("lease_expired");
    }

    const leaseB = serviceB.acquire({ merchant_id: "m-1", owner_id: "proc-b" });
    expect(leaseB.fencing).toBe(2);

    // 旧 owner：owner 不匹配 → not_owner；带旧 fencing 也一样被拒。
    expect(() =>
      serviceA.assertOwner({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 }),
    ).toThrowError(InstanceOwnershipError);
    try {
      serviceA.assertOwner({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 });
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("not_owner");
    }
  });

  it("旧 fencing token 提交被拒（fencing_mismatch）；接管方持有当前 token 可提交", () => {
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    advance(LEASE_MS + 1);
    // 同 owner_id 重新获取 = 接管，fencing 2；旧 fencing 1 不能再提交。
    const reacquired = serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    expect(reacquired.fencing).toBe(2);

    expect(() =>
      serviceA.assertOwner({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 }),
    ).toThrowError(InstanceOwnershipError);
    try {
      serviceA.assertOwner({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 });
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("fencing_mismatch");
    }
    const ok = serviceA.assertOwner({
      merchant_id: "m-1",
      owner_id: "proc-a",
      expected_fencing: 2,
    });
    expect(ok.fencing).toBe(2);
    // 不带 fencing 的守卫检查也放行当前 owner。
    expect(serviceA.assertOwner({ merchant_id: "m-1", owner_id: "proc-a" }).fencing).toBe(2);
  });

  it("租约过期但尚未被接管时，旧 owner 不能提交（到期等号即失效）", () => {
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    advance(LEASE_MS); // 恰好到期
    expect(() => serviceA.assertOwner({ merchant_id: "m-1", owner_id: "proc-a" })).toThrowError(
      InstanceOwnershipError,
    );
    try {
      serviceA.assertOwner({ merchant_id: "m-1", owner_id: "proc-a" });
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("lease_expired");
    }
  });

  it("审查项（DeepSeek 复验）：release 写入的 updated_at 为定宽 UTC（偏移时钟规范化）", () => {
    clock = "2026-11-16T08:00:00+08:00"; // = UTC 2026-11-16T00:00:00Z
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    clock = "2026-11-16T09:00:00+08:00"; // = UTC 2026-11-16T01:00:00Z
    serviceA.release({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 });
    const row = dbA
      .prepare("SELECT updated_at, heartbeat_at, lease_expires_at FROM instance_ownership")
      .get() as { updated_at: string; heartbeat_at: string; lease_expires_at: string };
    // 修复前：release 的 updated_at 存 now() 原文（偏移形式）。
    expect(row.updated_at).toBe("2026-11-16T01:00:00.000Z");
    expect(row.updated_at.endsWith("Z")).toBe(true);
    expect(row.heartbeat_at).toBe("2026-11-16T00:00:00.000Z");
    expect(row.lease_expires_at).toBe("2026-11-16T00:01:00.000Z"); // 00:00Z + 60s 租期
  });

  it("审查项（DeepSeek 复验）：同 owner 重获后，旧 token 续约被拒且不影响新租约", () => {
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" }); // fencing=1
    advance(LEASE_MS + 1);
    // 同 owner_id 重新 acquire（接管，fencing=2）——owner 判定对旧 worker 是"匹配"的。
    expect(serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" }).fencing).toBe(2);
    const before = dbB
      .prepare("SELECT heartbeat_at, lease_expires_at, fencing FROM instance_ownership")
      .get() as { heartbeat_at: string; lease_expires_at: string; fencing: number };

    // 旧 token（fencing=1）续约：fencing_mismatch，绝不更新新租约。
    expect(() =>
      serviceA.renew({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 }),
    ).toThrowError(InstanceOwnershipError);
    try {
      serviceA.renew({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 });
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("fencing_mismatch");
    }
    const after = dbB
      .prepare("SELECT heartbeat_at, lease_expires_at, fencing FROM instance_ownership")
      .get() as { heartbeat_at: string; lease_expires_at: string; fencing: number };
    expect(after).toEqual(before); // 新租约分毫未动（heartbeat/expires/fencing 原值）

    // 当前 token（fencing=2）续约正常。
    advance(10_000);
    const renewed = serviceA.renew({
      merchant_id: "m-1",
      owner_id: "proc-a",
      expected_fencing: 2,
    });
    expect(renewed.fencing).toBe(2);
    expect(renewed.heartbeat_at).toBe("2026-11-15T00:01:10.001Z");
    expect(renewed.lease_expires_at).toBe("2026-11-15T00:02:10.001Z");
  });

  it("审查项（DeepSeek 复验）：同 owner 重获后，旧实例 stop 无法释放新租约", () => {
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" }); // fencing=1
    advance(LEASE_MS + 1);
    // 同 owner_id 重获（接管，fencing=2）——旧实例随后关闭。
    expect(serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" }).fencing).toBe(2);
    const before = dbB
      .prepare("SELECT heartbeat_at, lease_expires_at, fencing, state FROM instance_ownership")
      .get() as Record<string, unknown>;

    // 修复前：release 的 WHERE 只查 owner_id + HELD → 旧实例 stop 把 fencing=2
    // 的新租约置为 RELEASED。修复后：CAS 旧 fencing → fencing_mismatch 被拒。
    expect(() =>
      serviceA.release({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 }),
    ).toThrowError(InstanceOwnershipError);
    try {
      serviceA.release({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 });
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("fencing_mismatch");
    }
    // 新租约分毫未动：仍 HELD、fencing=2、时间列原值。
    const after = dbB
      .prepare("SELECT heartbeat_at, lease_expires_at, fencing, state FROM instance_ownership")
      .get() as Record<string, unknown>;
    expect(after).toEqual({ ...before, state: "HELD" });
    expect(after).toMatchObject({ fencing: 2, state: "HELD" });

    // 持有当前 token（fencing=2）的实例释放正常。
    serviceA.release({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 2 });
    expect(dbB.prepare("SELECT state FROM instance_ownership").get()).toMatchObject({
      state: "RELEASED",
    });
  });

  it("不同商家互不影响；非法输入拒绝", () => {
    const a = serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    const b = serviceB.acquire({ merchant_id: "m-2", owner_id: "proc-b" });
    expect(a.fencing).toBe(1);
    expect(b.fencing).toBe(1);

    expect(() =>
      new InstanceOwnershipService({ db: dbA, now: () => clock, leaseMs: 0 }),
    ).toThrowError(InstanceOwnershipError);
    expect(() => serviceA.acquire({ merchant_id: "", owner_id: "proc-a" })).toThrowError(
      InstanceOwnershipError,
    );
  });

  it("租约到期判定与偏移/秒级时钟：规范化后按时刻比较，到期等号即失效", () => {
    // 用无毫秒（秒级）时钟获取：存储仍规范化为定宽 "…000Z"。
    clock = "2026-11-16T00:00:00Z";
    const lease = serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    expect(lease.lease_expires_at).toBe("2026-11-16T00:01:00.000Z");
    expect(lease.heartbeat_at).toBe("2026-11-16T00:00:00.000Z");

    // 到期等号（秒级时钟）→ assertOwner 拒绝、renew 失败。
    // 修复前：存储 "…00:01:00.000Z" 与 "…00:01:00Z" 字典序比较（'.'<'Z'），
    // 恰好方向正确但依赖运气；偏移时钟则方向相反——见下一断言。
    clock = "2026-11-16T00:01:00Z";
    expect(() => serviceA.assertOwner({ merchant_id: "m-1", owner_id: "proc-a" })).toThrowError(
      InstanceOwnershipError,
    );
    expect(() =>
      serviceA.renew({ merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 }),
    ).toThrowError(
      InstanceOwnershipError,
    );

    // 偏移时钟（= UTC 2026-11-16T00:00:59Z，到期前 1 秒）→ 仍持有。
    // 修复前："2026-11-15T16:00:59-08:00" 与存储字符串字典序比较，'5'<'6'
    // 误判为已过期（提前失效）；反向偏移则会延长已过期租约。
    clock = "2026-11-15T16:00:59-08:00";
    const held = serviceA.assertOwner({ merchant_id: "m-1", owner_id: "proc-a" });
    expect(held.fencing).toBe(1);
  });

  it("栅栏写入：校验与写入同事务，成功提交且 work 收到当前租约", () => {
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    const lease = serviceA.withFencedWrite(
      { merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 },
      (current) => {
        expect(current.fencing).toBe(1);
        dbA
          .prepare("INSERT INTO fenced_writes (id, fencing) VALUES ('w-1', ?)")
          .run(current.fencing);
        return current;
      },
    );
    expect(lease.fencing).toBe(1);
    expect(dbB.prepare("SELECT fencing FROM fenced_writes WHERE id = 'w-1'").get())
      .toMatchObject({ fencing: 1 });
  });

  it("栅栏写入：work 抛错整体回滚，无部分写入", () => {
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    expect(() =>
      serviceA.withFencedWrite(
        { merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 },
        () => {
          dbA.prepare("INSERT INTO fenced_writes (id, fencing) VALUES ('w-2', 99)").run();
          throw new Error("业务写入中途失败");
        },
      ),
    ).toThrowError("业务写入中途失败");
    expect(dbB.prepare("SELECT COUNT(*) AS n FROM fenced_writes").get()).toEqual({ n: 0 });
    // 失败后所有权不受影响，可再次写入。
    serviceA.withFencedWrite(
      { merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 },
      (current) => {
        dbA.prepare("INSERT INTO fenced_writes (id, fencing) VALUES ('w-3', ?)").run(current.fencing);
        return undefined;
      },
    );
    expect(dbB.prepare("SELECT COUNT(*) AS n FROM fenced_writes").get()).toEqual({ n: 1 });
  });

  it("审查项（检查与写入分离竞态）：assertOwner 通过后租约过期，栅栏写入在提交路径上拒绝", () => {
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    // 先查：此时租约有效，预检通过。
    expect(serviceA.assertOwner({ merchant_id: "m-1", owner_id: "proc-a" }).fencing).toBe(1);
    // 检查与写入之间租约过期——"先查后写"把这次写放行就是缺陷。
    advance(LEASE_MS + 1);
    expect(() =>
      serviceA.withFencedWrite(
        { merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 },
        () => {
          dbA.prepare("INSERT INTO fenced_writes (id, fencing) VALUES ('w-stale', 1)").run();
          return undefined;
        },
      ),
    ).toThrowError(InstanceOwnershipError);
    try {
      serviceA.withFencedWrite(
        { merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 },
        () => undefined,
      );
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("lease_expired");
    }
    // 提交路径拒绝 = 无任何写入落库。
    expect(dbB.prepare("SELECT COUNT(*) AS n FROM fenced_writes").get()).toEqual({ n: 0 });
  });

  it("审查项（栅栏写入）：被接管后旧 owner 提交被拒且不落库", () => {
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    advance(LEASE_MS + 1);
    serviceB.acquire({ merchant_id: "m-1", owner_id: "proc-b" }); // fencing=2
    expect(() =>
      serviceA.withFencedWrite(
        { merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 },
        () => {
          dbA.prepare("INSERT INTO fenced_writes (id, fencing) VALUES ('w-old', 1)").run();
          return undefined;
        },
      ),
    ).toThrowError(InstanceOwnershipError);
    try {
      serviceA.withFencedWrite(
        { merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 },
        () => undefined,
      );
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("not_owner");
    }
    expect(dbB.prepare("SELECT COUNT(*) AS n FROM fenced_writes").get()).toEqual({ n: 0 });
    // 新 owner 栅栏写入正常。
    serviceB.withFencedWrite({ merchant_id: "m-1", owner_id: "proc-b", expected_fencing: 2 }, (current) => {
      dbB.prepare("INSERT INTO fenced_writes (id, fencing) VALUES ('w-new', ?)").run(current.fencing);
      return undefined;
    });
    expect(dbA.prepare("SELECT fencing FROM fenced_writes WHERE id = 'w-new'").get())
      .toMatchObject({ fencing: 2 });
  });

  it("审查项（DeepSeek 实证）：同 owner_id 重获后，省略/旧 fencing 的写事务都被拒", () => {
    serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" }); // fencing=1
    advance(LEASE_MS + 1);
    // 同 owner_id 重新 acquire（接管，fencing=2）——owner 判定对旧 worker 是"匹配"的。
    const reacquired = serviceA.acquire({ merchant_id: "m-1", owner_id: "proc-a" });
    expect(reacquired.fencing).toBe(2);

    // 1) 省略 expected_fencing：写事务没有"无 token"路径，一律 validation。
    expect(() =>
      serviceA.withFencedWrite(
        { merchant_id: "m-1", owner_id: "proc-a" } as unknown as {
          merchant_id: string;
          owner_id: string;
          expected_fencing: number;
        },
        () => undefined,
      ),
    ).toThrowError(/expected_fencing 必须是正整数/);

    // 2) 旧 token（取得时 fencing=1）：fencing_mismatch，无落库。
    expect(() =>
      serviceA.withFencedWrite(
        { merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 },
        () => {
          dbA.prepare("INSERT INTO fenced_writes (id, fencing) VALUES ('w-reacquire-old', 1)").run();
          return undefined;
        },
      ),
    ).toThrowError(InstanceOwnershipError);
    try {
      serviceA.withFencedWrite(
        { merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 1 },
        () => undefined,
      );
    } catch (err) {
      expect((err as InstanceOwnershipError).code).toBe("fencing_mismatch");
    }
    expect(dbB.prepare("SELECT COUNT(*) AS n FROM fenced_writes").get()).toEqual({ n: 0 });

    // 3) 重获后持有当前 token（fencing=2）→ 写入成功。
    serviceA.withFencedWrite(
      { merchant_id: "m-1", owner_id: "proc-a", expected_fencing: 2 },
      (current) => {
        dbA
          .prepare("INSERT INTO fenced_writes (id, fencing) VALUES ('w-reacquire-new', ?)")
          .run(current.fencing);
        return undefined;
      },
    );
    expect(dbB.prepare("SELECT fencing FROM fenced_writes WHERE id = 'w-reacquire-new'").get())
      .toMatchObject({ fencing: 2 });
  });
});
