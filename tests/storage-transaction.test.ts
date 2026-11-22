/**
 * M1 收尾：受控嵌套事务上下文（显式 SAVEPOINT）。
 * 内层写入后抛错、被外层捕获继续时，部分写入不提交；每层失败只回滚到
 * 自己的进入点；最外层 BEGIN IMMEDIATE/COMMIT/ROLLBACK 语义不变。
 */
import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  endTransactionBoundary,
  inImmediateTransaction,
  isInsideTransaction,
  markTransactionAborted,
  TransactionAutoRolledBackError,
  TransactionBoundaryUncertainError,
} from "../src/merchant-core/storage/transaction.js";

/**
 * 进程夹具清理登记表：Vitest 在外部超时中止测试体后仍会执行 afterEach——
 * 夹具把"杀子进程（SIGTERM→限时→SIGKILL）+ 关库 + 删唯一目录"登记于此，
 * 覆盖外部超时场景（不依赖测试体自身走完 finally）。
 */
interface FixtureCleanupJob {
  job: () => Promise<unknown>;
  /**
   * 预期拒绝匹配器（仅故障注入用例登记）：afterEach 消费拒绝的唯一依据——
   * 返回 true 表示该拒绝是用例已断言的夹具机制错误（AggregateError 实例或
   * mismatch 标记错误）；返回 false/未登记 → 重抛（真实清理失败不吞）。
   */
  expectedRejectionMatch?: (err: unknown) => boolean;
}
const fixtureCleanups: FixtureCleanupJob[] = [];
afterEach(async () => {
  const jobs = fixtureCleanups.splice(0);
  for (const { job, expectedRejectionMatch } of jobs) {
    // 钩子必须**实际等待**共享 cleanup Promise 完整执行（含 SIGKILL 升级与
    // 目录删除）。只有故障注入用例可消费拒绝，且必须**恰好是登记的同一
    // AggregateError 实例**，其错误集合与创建时快照完全一致（任何额外错误
    // → 重抛 → 测试失败）；其余任何清理失败必须让测试失败并保留证据。
    try {
      await job();
    } catch (err) {
      // 消费契约：仅当匹配器确认该拒绝是用例已断言的夹具机制错误时才消费。
      // combo/silent-noop 用例对 AggregateError 做**精确完整错误集合**断言
      //（额外错误在用例断言处失败）；mismatch 错误由负向用例断言内容。
      // afterEach 自身不吞任何清理失败：匹配器返回 false/未登记 → 重抛。
      if (expectedRejectionMatch === undefined || !expectedRejectionMatch(err)) {
        throw err;
      }
      console.error(
        "kiwi-fixture cleanup rejected as expected (matched, asserted by test):",
        (err as Error)?.message,
      );
    }
  }
});

describe("受控嵌套事务（savepoint）", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE rows (id TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '')");
  });

  afterEach(() => {
    // 关闭 beforeEach 创建的内存 db，避免跨用例连接累积。
    try {
      db?.close();
    } catch {
      // 关闭失败不掩盖用例结果（内存 db 随进程退出释放）。
    }
  });

  it.each([false, true])("manual WAL read transactions leave the writer slot free (hide flag=%s)", hide => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-read-tx-"));
    const file = join(dir, "ledger.sqlite");
    const reader = new DatabaseSync(file);
    const writer = new DatabaseSync(file);
    const conn = hide ? hideIsTransaction(reader) : reader;
    try {
      reader.exec("PRAGMA journal_mode=WAL; CREATE TABLE entry(n); BEGIN; SELECT * FROM entry");
      writer.exec("BEGIN IMMEDIATE");
      inImmediateTransaction(conn, () => {
        inImmediateTransaction(conn, () => reader.prepare("SELECT * FROM entry").all());
      });
      writer.exec("ROLLBACK");
      // A failed immediate probe could also hold the slot after the callback.
      inImmediateTransaction(conn, () => reader.prepare("SELECT * FROM entry").all());
      writer.exec("BEGIN IMMEDIATE; ROLLBACK");
      reader.exec("ROLLBACK");
      endTransactionBoundary(conn);
    } finally {
      writer.close();
      reader.close();
      rmSync(dir, {recursive: true, force: true});
    }
  });

  function ids(): string[] {
    return (db.prepare("SELECT id FROM rows ORDER BY id").all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
  }

  /** Node 23 模拟：隐藏 isTransaction 属性（对齐 DeepSeek 真实 23.11.1 复现环境）。 */
  function hideIsTransaction(conn: DatabaseSync): DatabaseSync {
    return new Proxy(conn, {
      get(target, prop) {
        if (prop === "isTransaction") return undefined;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as DatabaseSync;
  }

  /**
   * DeepSeek Node 22/23 实证场景：外层事务内直接 `INSERT OR ROLLBACK` 引发
   * 自动回滚、错误被 fn 吞掉、随后嵌套 wrapper 写入。修复前 SAVEPOINT 在
   * autocommit 中开启并 RELEASE 提交 leaked 行（部分提交）；修复后活性探针
   * 在嵌套入口拒绝。`wrapConn` 用于 Node 23 模拟（Proxy 隐藏 isTransaction）。
   */
  function deepSeekProbeScenario(
    db: DatabaseSync,
    wrapConn: (conn: DatabaseSync) => DatabaseSync,
  ): void {
    const conn = wrapConn(db);
    db.exec("CREATE TABLE probe_rows (k TEXT UNIQUE)");
    db.exec("INSERT INTO probe_rows (k) VALUES ('dup')");
    let original: string | undefined;
    expect(() =>
      inImmediateTransaction(conn, () => {
        try {
          conn.prepare("INSERT OR ROLLBACK INTO probe_rows (k) VALUES ('dup')").run();
          expect.unreachable("应抛出 UNIQUE 约束错误");
        } catch (err) {
          original = (err as Error).message; // fn 吞掉原始错误（自动回滚已发生）
        }
        inImmediateTransaction(conn, () => {
          conn.prepare("INSERT INTO probe_rows (k) VALUES ('leaked')").run();
          return undefined;
        });
        return undefined;
      }),
    ).toThrowError(TransactionAutoRolledBackError);
    expect(original).toContain("UNIQUE");
    // 零残留：leaked 未落库；外层 COMMIT 失败没有留下任何数据。
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM probe_rows WHERE k = 'leaked'").get() as { n: number })
        .n,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM probe_rows").get() as { n: number }).n,
    ).toBe(1); // 仅原始 'dup'
    // wrapper 自有边界退出后 poison 解除，连接恢复。
    inImmediateTransaction(conn, () => {
      conn.prepare("INSERT INTO probe_rows (k) VALUES ('ok')").run();
      return undefined;
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM probe_rows WHERE k = 'ok'").get() as { n: number }).n,
    ).toBe(1);
  }

  /** 手工 BEGIN 外层的同类风险： poison 持续到手工所有者显式结束边界。 */
  function deepSeekManualScenario(
    db: DatabaseSync,
    wrapConn: (conn: DatabaseSync) => DatabaseSync,
  ): void {
    const conn = wrapConn(db);
    db.exec("CREATE TABLE probe_rows (k TEXT UNIQUE)");
    db.exec("INSERT INTO probe_rows (k) VALUES ('dup')");
    let original: string | undefined;
    let outerSeen: Error | undefined;
    db.exec("BEGIN IMMEDIATE"); // 手工外层
    try {
      inImmediateTransaction(conn, () => {
        try {
          conn.prepare("INSERT OR ROLLBACK INTO probe_rows (k) VALUES ('dup')").run();
          expect.unreachable();
        } catch (err) {
          original = (err as Error).message;
        }
        inImmediateTransaction(conn, () => {
          conn.prepare("INSERT INTO probe_rows (k) VALUES ('leaked')").run();
          return undefined;
        });
        return undefined;
      });
      expect.unreachable("外层应抛出自动回滚错误");
    } catch (err) {
      outerSeen = err as Error;
    }
    expect(original).toContain("UNIQUE");
    expect(outerSeen!.message).toContain("kiwi-tx"); // TransactionAutoRolledBackError
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM probe_rows WHERE k = 'leaked'").get() as { n: number })
        .n,
    ).toBe(0);
    // 手工 COMMIT 已无事务可提交（诚实失败），随后显式结束边界恢复。
    expect(() => db.exec("COMMIT")).toThrowError(/no transaction is active/i);
    endTransactionBoundary(conn);
    inImmediateTransaction(conn, () => {
      conn.prepare("INSERT INTO probe_rows (k) VALUES ('ok')").run();
      return undefined;
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM probe_rows WHERE k = 'ok'").get() as { n: number }).n,
    ).toBe(1);
  }

  it("内层写入后抛错、外层捕获继续：部分写入不提交", () => {
    const result = inImmediateTransaction(db, () => {
      try {
        inImmediateTransaction(db, () => {
          db.prepare("INSERT INTO rows (id) VALUES ('inner-1')").run();
          throw new Error("inner failure");
        });
        expect.unreachable("内层错误应重抛");
      } catch (err) {
        expect((err as Error).message).toBe("inner failure");
        // 外层捕获内层失败，继续正常业务。
      }
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO rows (id) VALUES ('after-inner')").run();
      });
      return "committed";
    });
    expect(result).toBe("committed");
    expect(ids()).toEqual(["after-inner"]);
  });

  it("内层成功 RELEASE 后外层最终回滚：一并撤销（外层边界不扩大）", () => {
    expect(() =>
      inImmediateTransaction(db, () => {
        inImmediateTransaction(db, () => {
          db.prepare("INSERT INTO rows (id) VALUES ('released')").run();
        });
        throw new Error("outer failure");
      }),
    ).toThrowError("outer failure");
    expect(ids()).toEqual([]);
  });

  it("两层嵌套：内层回滚不影响外层之前的写入", () => {
    inImmediateTransaction(db, () => {
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO rows (id) VALUES ('mid-1')").run();
      });
      try {
        inImmediateTransaction(db, () => {
          inImmediateTransaction(db, () => {
            db.prepare("INSERT INTO rows (id) VALUES ('inner-deep')").run();
          });
          throw new Error("mid failure");
        });
        expect.unreachable();
      } catch {
        // 中层捕获最内层失败。
      }
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO rows (id) VALUES ('mid-2')").run();
      });
      return undefined;
    });
    expect(ids()).toEqual(["mid-1", "mid-2"]);
  });

  it("最外层语义不变：fn 返回即 commit、抛错即 rollback", () => {
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO rows (id) VALUES ('top-ok')").run();
      return undefined;
    });
    expect(ids()).toEqual(["top-ok"]);
    expect(() =>
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO rows (id) VALUES ('top-bad')").run();
        throw new Error("top failure");
      }),
    ).toThrowError("top failure");
    expect(ids()).toEqual(["top-ok"]);
  });

  it("savepoint 回滚恢复先前值：内层 UPDATE 后抛错，外层捕获时旧行保持原值", () => {
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO rows (id, note) VALUES ('row-1', 'original')").run();
      return undefined;
    });

    const result = inImmediateTransaction(db, () => {
      try {
        inImmediateTransaction(db, () => {
          db.prepare("UPDATE rows SET note = 'corrupted' WHERE id = 'row-1'").run();
          db.prepare("INSERT INTO rows (id, note) VALUES ('row-2', 'partial')").run();
          throw new Error("inner failure");
        });
        expect.unreachable("内层错误应重抛");
      } catch (err) {
        expect((err as Error).message).toBe("inner failure");
        // 外层捕获，继续提交本次事务。
      }
      return "committed";
    });
    expect(result).toBe("committed");
    // UPDATE 与 INSERT 都被回滚：旧行保持原值，新行不存在。
    expect(
      db.prepare("SELECT note FROM rows WHERE id = 'row-1'").get(),
    ).toMatchObject({ note: "original" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM rows").get()).toEqual({ n: 1 });
  });

  it("isInsideTransaction 反映事务状态", () => {
    expect(isInsideTransaction(db)).toBe(false);
    inImmediateTransaction(db, () => {
      expect(isInsideTransaction(db)).toBe(true);
      inImmediateTransaction(db, () => {
        expect(isInsideTransaction(db)).toBe(true);
        return undefined;
      });
      return undefined;
    });
    expect(isInsideTransaction(db)).toBe(false);
  });

  it("手工 BEGIN 的外层同样识别（savepoint 而非二次 BEGIN）", () => {
    db.exec("BEGIN IMMEDIATE");
    // 未走 wrapper 的外层：嵌套调用不抛 "cannot start a transaction"。
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO rows (id) VALUES ('manual-outer')").run();
      return undefined;
    });
    db.exec("COMMIT");
    expect(ids()).toEqual(["manual-outer"]);
  });

  it("Node 22.19–23（无 isTransaction 属性）手工 BEGIN 外层不二次 BEGIN", () => {
    // DeepSeek 在真实 Node 23.11.1 复现：node:sqlite 无 isTransaction，旧实现
    // 依赖该属性检测手工外层导致二次 BEGIN。Proxy 隐藏属性模拟该运行时，
    // 修复后统一走 BEGIN 冲突捕获 → SAVEPOINT，不依赖版本属性。
    const dbWithoutFlag = new Proxy(db, {
      get(target, prop) {
        if (prop === "isTransaction") return undefined;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as DatabaseSync;
    db.exec("BEGIN IMMEDIATE");
    inImmediateTransaction(dbWithoutFlag, () => {
      db.prepare("INSERT INTO rows (id) VALUES ('node23-nested')").run();
      return undefined;
    });
    db.exec("COMMIT");
    expect(ids()).toEqual(["node23-nested"]);
    // 同一代理连接上的 wrapper 自嵌套也正常（WeakMap 按同一代理对象计数）。
    db.exec("BEGIN IMMEDIATE");
    inImmediateTransaction(dbWithoutFlag, () => {
      inImmediateTransaction(dbWithoutFlag, () => {
        db.prepare("INSERT INTO rows (id) VALUES ('node23-deep')").run();
      });
      return undefined;
    });
    db.exec("COMMIT");
    expect(ids()).toEqual(["node23-deep", "node23-nested"]); // ids() 按 id 排序
  });

  it("顶层 RAISE(ROLLBACK) 自动回滚后，不掩盖原始错误且连接恢复可用", () => {
    db.exec(`
      CREATE TRIGGER abort_insert BEFORE INSERT ON rows
      WHEN NEW.id = 'abort'
      BEGIN SELECT RAISE(ROLLBACK, 'trigger-abort'); END;
    `);
    let seen: string | undefined;
    try {
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO rows (id) VALUES ('abort')").run();
        return undefined;
      });
      expect.unreachable("应抛出触发器错误");
    } catch (err) {
      seen = (err as Error).message;
    }
    // 原始错误保留；不被 rollback 的 "no transaction is active" 掩盖。
    expect(seen).toContain("trigger-abort");
    expect(seen).not.toContain("no transaction");
    expect(ids()).toEqual([]); // RAISE(ROLLBACK) 已自动回滚
    // 连接恢复可用。
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO rows (id) VALUES ('ok')").run();
      return undefined;
    });
    expect(ids()).toEqual(["ok"]);
  });

  it("嵌套内触发 RAISE(ROLLBACK)：外层捕获后继续写被拒（零残留），原始错误保留", () => {
    db.exec(`
      CREATE TRIGGER abort_insert BEFORE INSERT ON rows
      WHEN NEW.id = 'abort'
      BEGIN SELECT RAISE(ROLLBACK, 'trigger-abort'); END;
    `);
    let innerSeen: string | undefined;
    expect(() =>
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO rows (id) VALUES ('before')").run();
        try {
          inImmediateTransaction(db, () => {
            db.prepare("INSERT INTO rows (id) VALUES ('abort')").run();
            return undefined;
          });
          expect.unreachable("内层错误应重抛");
        } catch (err) {
          // 原始错误不被 savepoint 清理的次生错误掩盖。
          innerSeen = (err as Error).message;
        }
        // RAISE(ROLLBACK) 已把整个事务回滚（含 before）：此时继续写会走
        // autocommit 造成部分提交——wrapper 拒绝（零残留），并指明原因。
        expect(() =>
          inImmediateTransaction(db, () => {
            db.prepare("INSERT INTO rows (id) VALUES ('after')").run();
            return undefined;
          }),
        ).toThrowError(TransactionAutoRolledBackError);
        return undefined;
      }),
      // 自动回滚后外层仍试图提交：诚实失败（TransactionAutoRolledBackError），不伪造成功。
    ).toThrowError(TransactionAutoRolledBackError);
    expect(innerSeen).toContain("trigger-abort");
    expect(ids()).toEqual([]); // 零残留：before 被自动回滚，after 被拒绝
    // 最外层退出后 poison 解除，连接可用于全新事务。
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO rows (id) VALUES ('fresh')").run();
      return undefined;
    });
    expect(ids()).toEqual(["fresh"]);
  });

  it("审查项（手工 BEGIN 边界）：自动回滚后 poison 持续，明确结束边界后恢复", () => {
    db.exec(`
      CREATE TRIGGER abort_insert BEFORE INSERT ON rows
      WHEN NEW.id = 'abort'
      BEGIN SELECT RAISE(ROLLBACK, 'trigger-abort'); END;
    `);
    db.exec("BEGIN IMMEDIATE"); // 手工外层（不经 wrapper）
    let seen: string | undefined;
    try {
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO rows (id) VALUES ('abort')").run();
        return undefined;
      });
      expect.unreachable("应抛出触发器错误");
    } catch (err) {
      seen = (err as Error).message;
    }
    // 1) 原始错误保留（不被 savepoint 清理的次生错误掩盖）。
    expect(seen).toContain("trigger-abort");
    // 2) 当前边界（已被自动回滚）不允许后续写——poison 持续，不提前解除。
    expect(() =>
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO rows (id) VALUES ('leak')").run();
        return undefined;
      }),
    ).toThrowError(TransactionAutoRolledBackError);
    // 3) 手工边界结束：COMMIT 已无事务可提交（诚实失败），随后明确结束边界。
    expect(() => db.exec("COMMIT")).toThrowError(/no transaction is active/i);
    endTransactionBoundary(db);
    // 4) 连接恢复：全新事务可用。
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO rows (id) VALUES ('recovered')").run();
      return undefined;
    });
    expect(ids()).toEqual(["recovered"]);
  });

  it("审查项（Node 23 模拟，无 isTransaction）：手工边界场景与 Node 22 行为一致", () => {
    // DeepSeek 在真实 Node 23.11.1 复现 poison 永久滞留；本地以 Proxy 隐藏
    // isTransaction 模拟该运行时（走 BEGIN DEFERRED 回退探针）。
    const conn = new Proxy(db, {
      get(target, prop) {
        if (prop === "isTransaction") return undefined;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as DatabaseSync;
    db.exec(`
      CREATE TRIGGER abort_insert BEFORE INSERT ON rows
      WHEN NEW.id = 'abort'
      BEGIN SELECT RAISE(ROLLBACK, 'trigger-abort'); END;
    `);
    db.exec("BEGIN IMMEDIATE");
    let seen: string | undefined;
    try {
      inImmediateTransaction(conn, () => {
        conn.prepare("INSERT INTO rows (id) VALUES ('abort')").run();
        return undefined;
      });
      expect.unreachable("应抛出触发器错误");
    } catch (err) {
      seen = (err as Error).message;
    }
    expect(seen).toContain("trigger-abort");
    expect(() =>
      inImmediateTransaction(conn, () => {
        conn.prepare("INSERT INTO rows (id) VALUES ('leak')").run();
        return undefined;
      }),
    ).toThrowError(TransactionAutoRolledBackError);
    expect(() => db.exec("COMMIT")).toThrowError(/no transaction is active/i);
    endTransactionBoundary(conn);
    inImmediateTransaction(conn, () => {
      conn.prepare("INSERT INTO rows (id) VALUES ('recovered')").run();
      return undefined;
    });
    expect(ids()).toEqual(["recovered"]);
  });

  it("审查项：poison 未解除前持续被拒；wrapper 上下文活跃时不能结束手工边界", () => {
    db.exec(`
      CREATE TRIGGER abort_insert BEFORE INSERT ON rows
      WHEN NEW.id = 'abort'
      BEGIN SELECT RAISE(ROLLBACK, 'trigger-abort'); END;
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO rows (id) VALUES ('abort')").run();
        return undefined;
      });
      expect.unreachable();
    } catch {
      // poison 已设置
    }
    // 多次尝试仍被拒（不自动消失）。
    for (let i = 0; i < 3; i++) {
      expect(() => inImmediateTransaction(db, () => undefined)).toThrowError(
        TransactionAutoRolledBackError,
      );
    }
    // wrapper 上下文活跃时（此处 depth=0、手工边界已死）允许结束；若 wrapper
    // BEGIN 外层未退出则必须拒绝（防止在活跃事务中半途解除）。
    endTransactionBoundary(db);
    // 状态机可重复：再次手工边界 + 自动回滚 → 再次 poison → 再次显式恢复。
    db.exec("BEGIN IMMEDIATE");
    try {
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO rows (id) VALUES ('abort')").run();
        return undefined;
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("trigger-abort");
    }
    expect(() => inImmediateTransaction(db, () => undefined)).toThrowError(
      TransactionAutoRolledBackError,
    );
    endTransactionBoundary(db);
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO rows (id) VALUES ('final')").run();
      return undefined;
    });
    expect(ids()).toEqual(["final"]);
  });

  it("审查项（DeepSeek 实测）：INSERT OR ROLLBACK 自动回滚后，原始 UNIQUE 错误保留且连接可复用", () => {
    db.exec("CREATE TABLE uniq_rows (k TEXT UNIQUE)");
    db.exec("INSERT INTO uniq_rows (k) VALUES ('dup')");
    let seen: string | undefined;
    try {
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO uniq_rows (k) VALUES ('first')").run();
        // 冲突子句 ROLLBACK：约束冲突时 SQLite 自动回滚整个事务。
        db.prepare("INSERT OR ROLLBACK INTO uniq_rows (k) VALUES ('dup')").run();
        return undefined;
      });
      expect.unreachable("应抛出 UNIQUE 约束错误");
    } catch (err) {
      seen = (err as Error).message;
    }
    // 原始 UNIQUE 错误保留；不被 catch 中 ROLLBACK 的 "no transaction" 掩盖。
    expect(seen).toContain("UNIQUE");
    expect(seen).not.toContain("no transaction");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM uniq_rows WHERE k = 'first'").get(),
    ).toEqual({ n: 0 }); // 自动回滚：事务内写入零残留
    // 连接可复用。
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO uniq_rows (k) VALUES ('ok')").run();
      return undefined;
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM uniq_rows WHERE k = 'ok'").get(),
    ).toEqual({ n: 1 });
  });

  it("审查项（DeepSeek Node 22 实证）：外层内直接 INSERT OR ROLLBACK 被 fn 吞掉后，嵌套 wrapper 写入被拒、零残留", () => {
    deepSeekProbeScenario(db, (conn) => conn);
  });

  it("审查项（Node 23 模拟，无 isTransaction）：同一探针场景行为一致", () => {
    deepSeekProbeScenario(db, (conn) => hideIsTransaction(conn));
  });

  it("审查项（手工外层同类风险，Node 22）：嵌套写入被拒，手工边界显式恢复", () => {
    deepSeekManualScenario(db, (conn) => conn);
  });

  it("审查项（手工外层同类风险，Node 23 模拟）：行为一致", () => {
    deepSeekManualScenario(db, (conn) => hideIsTransaction(conn));
  });

  it("审查项（DeepSeek 复验）：内层 fn 吞掉自动回滚错误，RELEASE 报 no such savepoint → TARB（cause 保留），外层不吞", () => {
    db.exec("CREATE TABLE probe_rows (k TEXT UNIQUE)");
    db.exec("INSERT INTO probe_rows (k) VALUES ('dup')");
    let innerSwallowed = false;
    let tarb: TransactionAutoRolledBackError | undefined;
    try {
      inImmediateTransaction(db, () => {
        inImmediateTransaction(db, () => {
          try {
            // 内层 fn 直接语句触发自动回滚（整个事务销毁），随后吞掉错误。
            db.prepare("INSERT OR ROLLBACK INTO probe_rows (k) VALUES ('dup')").run();
            expect.unreachable();
          } catch {
            innerSwallowed = true;
          }
          return undefined;
        });
        expect.unreachable("内层 RELEASE 失败应转为 TARB 重抛");
      });
      expect.unreachable("外层应抛出 TARB");
    } catch (err) {
      tarb = err as TransactionAutoRolledBackError;
    }
    expect(innerSwallowed).toBe(true);
    expect(tarb).toBeInstanceOf(TransactionAutoRolledBackError);
    // 错误语义明确：TARB；可获得的底层证据保留在 cause。
    expect(tarb!.message).toContain("kiwi-tx");
    expect((tarb!.cause as Error | undefined)?.message).toContain("no such savepoint");
    // 零残留 + wrapper 自有边界退出后连接恢复。
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM probe_rows").get() as { n: number }).n,
    ).toBe(1); // 仅原始 'dup'
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO probe_rows (k) VALUES ('ok')").run();
      return undefined;
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM probe_rows WHERE k = 'ok'").get() as { n: number }).n,
    ).toBe(1);
  });

  it("审查项（DeepSeek 复验）：外层也吞掉 TARB → 外层 RELEASE 失败同转 TARB，零残留不伪造成功", () => {
    db.exec("CREATE TABLE probe_rows2 (k TEXT UNIQUE)");
    db.exec("INSERT INTO probe_rows2 (k) VALUES ('dup')");
    expect(() =>
      inImmediateTransaction(db, () => {
        try {
          inImmediateTransaction(db, () => {
            try {
              db.prepare("INSERT OR ROLLBACK INTO probe_rows2 (k) VALUES ('dup')").run();
              expect.unreachable();
            } catch {
              // 内层 fn 吞掉原始错误
            }
            return undefined;
          });
          expect.unreachable();
        } catch {
          // 外层 fn 也吞掉 TARB，继续正常返回
        }
        return undefined;
      }),
    ).toThrowError(TransactionAutoRolledBackError);
    // 零残留：整个事务被自动回滚，外层未伪造提交成功。
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM probe_rows2").get() as { n: number }).n,
    ).toBe(1);
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO probe_rows2 (k) VALUES ('ok')").run();
      return undefined;
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM probe_rows2 WHERE k = 'ok'").get() as { n: number }).n,
    ).toBe(1);
  });

  it("审查项（DeepSeek 复验）：手工边界无 wrapper 接触的自动回滚，mark 后写被拒、end 后恢复", () => {
    db.exec("CREATE TABLE probe_rows3 (k TEXT UNIQUE)");
    db.exec("INSERT INTO probe_rows3 (k) VALUES ('dup')");
    db.exec("BEGIN IMMEDIATE");
    let original: string | undefined;
    try {
      // 死亡发生在任何 wrapper 接触之前：wrapper 无从分辨已死边界与干净结束。
      db.prepare("INSERT OR ROLLBACK INTO probe_rows3 (k) VALUES ('dup')").run();
      expect.unreachable();
    } catch (err) {
      original = (err as Error).message;
      // 所有者确认：观察到自动回滚 → 标记，防止后续 wrapper 写入 autocommit 泄漏。
      markTransactionAborted(db);
    }
    expect(original).toContain("UNIQUE");
    expect(() =>
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO probe_rows3 (k) VALUES ('leaked')").run();
        return undefined;
      }),
    ).toThrowError(TransactionAutoRolledBackError);
    // 手工 COMMIT 已无事务可提交；明确结束边界后恢复。
    expect(() => db.exec("COMMIT")).toThrowError(/no transaction is active/i);
    endTransactionBoundary(db);
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO probe_rows3 (k) VALUES ('recovered')").run();
      return undefined;
    });
    // 零残留：leaked 被拒；recovered 正常。
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM probe_rows3 WHERE k = 'leaked'").get() as { n: number })
        .n,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM probe_rows3 WHERE k = 'recovered'").get() as {
        n: number;
      }).n,
    ).toBe(1);
  });

  it("记录（既有语义）：无接触死亡且未 mark 时，wrapper 按新事务执行——不承诺零残留", () => {
    // DeepSeek 场景的未确认变体：所有者未调用 markTransactionAborted。
    // wrapper 无法分辨"已死边界"与"干净结束后的事务"（Node 22/23 无检测
    // 手段），按全新事务执行——本测试如实钉住该行为与边界，不假装零残留。
    db.exec("CREATE TABLE probe_rows4 (k TEXT UNIQUE)");
    db.exec("INSERT INTO probe_rows4 (k) VALUES ('dup')");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT OR ROLLBACK INTO probe_rows4 (k) VALUES ('dup')").run();
      expect.unreachable();
    } catch {
      // 吞掉，未 mark
    }
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO probe_rows4 (k) VALUES ('leaked')").run();
      return undefined;
    });
    // leaked 以独立事务提交（记录在案的实质边界）。
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM probe_rows4 WHERE k = 'leaked'").get() as { n: number })
        .n,
    ).toBe(1);
  });

  it("审查项（DeepSeek 复验 B）：手工边界干净 COMMIT 后未 end，wrapper 写入不确定态 fail-closed 拒绝；end 后恢复", () => {
    db.exec("BEGIN IMMEDIATE");
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO rows (id) VALUES ('in-manual')").run();
      return undefined;
    });
    db.exec("COMMIT"); // 手工边界干净结束，但所有者未调用 end——状态不确定
    // 干净结束与未观察的自动回滚不可区分：fail-closed 拒绝（独立于 TARB）。
    expect(() =>
      inImmediateTransaction(db, () => {
        db.prepare("INSERT INTO rows (id) VALUES ('after-commit')").run();
        return undefined;
      }),
    ).toThrowError(TransactionBoundaryUncertainError);
    // 'after-commit' 未落库（零残留）。
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM rows WHERE id = 'after-commit'").get() as { n: number })
        .n,
    ).toBe(0);
    // 所有者明确结束边界后恢复。
    endTransactionBoundary(db);
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO rows (id) VALUES ('after-end')").run();
      return undefined;
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM rows WHERE id = 'after-end'").get() as { n: number })
        .n,
    ).toBe(1);
    expect(ids()).toEqual(["after-end", "in-manual"]);
  });

  it("审查项（DeepSeek 复验 A）：干净手工 COMMIT 残留记账 + 另一连接持写锁 → busy 以不确定态表达（不伪装 TARB、保留 cause），fail-closed 重试仍拒，end 后恢复", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-m1-busy-"));
    const dbA = new DatabaseSync(join(dir, "state.sqlite"));
    const dbB = new DatabaseSync(join(dir, "state.sqlite"));
    try {
      dbA.exec("CREATE TABLE busy_rows (id TEXT PRIMARY KEY)");
      // depth=1 manual 记账（干净 COMMIT 后残留）。
      dbA.exec("BEGIN IMMEDIATE");
      inImmediateTransaction(dbA, () => {
        dbA.prepare("INSERT INTO busy_rows (id) VALUES ('in-manual')").run();
        return undefined;
      });
      dbA.exec("COMMIT");
      // 另一连接持写锁：探针 BEGIN IMMEDIATE 得 SQLITE_BUSY。
      dbB.exec("BEGIN IMMEDIATE");
      let seen: Error | undefined;
      try {
        inImmediateTransaction(dbA, () => {
          dbA.prepare("INSERT INTO busy_rows (id) VALUES ('leaked')").run();
          return undefined;
        });
        expect.unreachable("应抛出不确定态错误");
      } catch (err) {
        seen = err as Error;
      }
      // 不确定而非已确认回滚：独立错误类型，cause 保留 busy。
      expect(seen).toBeInstanceOf(TransactionBoundaryUncertainError);
      expect(seen!.name).toBe("TransactionBoundaryUncertainError");
      expect(seen!.message).toContain("不确定");
      expect(seen!.cause).toBeDefined();
      expect(String((seen!.cause as Error).message)).toMatch(/locked|busy/i);
      // fail-closed 重试：仍拒（不确定态持续，不因锁释放自动解除）。
      expect(() =>
        inImmediateTransaction(dbA, () => {
          dbA.prepare("INSERT INTO busy_rows (id) VALUES ('leaked-retry')").run();
          return undefined;
        }),
      ).toThrowError(TransactionBoundaryUncertainError);
      // 零残留。
      expect(
        (dbA.prepare("SELECT COUNT(*) AS n FROM busy_rows WHERE id LIKE 'leaked%'").get() as {
          n: number;
        }).n,
      ).toBe(0);
      // 恢复：锁释放 + 所有者明确结束边界。
      dbB.exec("COMMIT");
      dbB.close();
      endTransactionBoundary(dbA);
      inImmediateTransaction(dbA, () => {
        dbA.prepare("INSERT INTO busy_rows (id) VALUES ('after-lock')").run();
        return undefined;
      });
      expect(
        (dbA.prepare("SELECT COUNT(*) AS n FROM busy_rows WHERE id = 'after-lock'").get() as {
          n: number;
        }).n,
      ).toBe(1);
    } finally {
      try { dbB.close(); } catch { /* 已关闭 */ }
      dbA.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("审查项（Node 23 模拟）：busy 不确定态行为与 Node 22 一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-m1-busy23-"));
    const dbA = new DatabaseSync(join(dir, "state.sqlite"));
    const dbB = new DatabaseSync(join(dir, "state.sqlite"));
    try {
      dbA.exec("CREATE TABLE busy_rows (id TEXT PRIMARY KEY)");
      // 与 A-1 同流：手工边界内先有 wrapper 接触（登记 depth=1 manual 记账）。
      const dbA23 = hideIsTransaction(dbA);
      dbA.exec("BEGIN IMMEDIATE");
      inImmediateTransaction(dbA23, () => {
        dbA.prepare("INSERT INTO busy_rows (id) VALUES ('in-manual')").run();
        return undefined;
      });
      dbA.exec("COMMIT"); // 记账残留（depth=1 manual，未 end）
      dbB.exec("BEGIN IMMEDIATE"); // 另一连接持写锁
      expect(() =>
        inImmediateTransaction(dbA23, () => {
          dbA23.prepare("INSERT INTO busy_rows (id) VALUES ('leaked')").run();
          return undefined;
        }),
      ).toThrowError(TransactionBoundaryUncertainError);
      // fail-closed 重试仍拒；零残留。
      expect(() =>
        inImmediateTransaction(dbA23, () => undefined),
      ).toThrowError(TransactionBoundaryUncertainError);
      expect(
        (dbA.prepare("SELECT COUNT(*) AS n FROM busy_rows WHERE id = 'leaked'").get() as { n: number })
          .n,
      ).toBe(0);
      dbB.exec("COMMIT");
      dbB.close();
      endTransactionBoundary(dbA23);
      inImmediateTransaction(dbA23, () => {
        dbA23.prepare("INSERT INTO busy_rows (id) VALUES ('ok')").run();
        return undefined;
      });
      expect(
        (dbA.prepare("SELECT COUNT(*) AS n FROM busy_rows WHERE id = 'ok'").get() as { n: number })
          .n,
      ).toBe(1);
    } finally {
      try { dbB.close(); } catch { /* 已关闭 */ }
      dbA.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("审查项（C）：顶层 fn 吞自动回滚后返回 → COMMIT 确认失败转 TARB(cause=commitErr)；裸写泄漏如实记录", () => {
    db.exec("CREATE TABLE leak_rows (k TEXT UNIQUE)");
    db.exec("INSERT INTO leak_rows (k) VALUES ('dup')");
    let tarb: TransactionAutoRolledBackError | undefined;
    try {
      inImmediateTransaction(db, () => {
        try {
          // 顶层 fn 直接语句触发自动回滚并吞掉错误。
          db.prepare("INSERT OR ROLLBACK INTO leak_rows (k) VALUES ('dup')").run();
          expect.unreachable();
        } catch {
          // 吞掉（纪律边界：随后继续裸写/返回 = 既有记录在案行为）
        }
        db.prepare("INSERT INTO rows (id) VALUES ('raw-leak')").run();
        return undefined;
      });
      expect.unreachable("COMMIT 应确认失败并转 TARB");
    } catch (err) {
      tarb = err as TransactionAutoRolledBackError;
    }
    expect(tarb).toBeInstanceOf(TransactionAutoRolledBackError);
    expect(tarb!.message).toContain("kiwi-tx");
    // cause = 原始 COMMIT 错误（no transaction is active）。
    expect((tarb!.cause as Error | undefined)?.message).toContain("no transaction is active");
    // 如实记录：裸写已 autocommit（实质边界），事务内其余写入被回滚。
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM rows WHERE id = 'raw-leak'").get() as { n: number })
        .n,
    ).toBe(1);
    // 连接恢复可用。
    inImmediateTransaction(db, () => {
      db.prepare("INSERT INTO rows (id) VALUES ('ok')").run();
      return undefined;
    });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM rows WHERE id = 'ok'").get() as { n: number }).n,
    ).toBe(1);
  });

  it("审查项：kind=wrapper 的边界不能手工结束（wrapper 自有边界由 finally 管理）", () => {
    expect(() =>
      inImmediateTransaction(db, () => {
        expect(() => endTransactionBoundary(db)).toThrowError(/wrapper 自有边界/);
        return undefined;
      }),
    ).not.toThrow(); // 外层正常提交（内部断言已验证拒绝）
    // 退出后 kind/depth 已清，endTransactionBoundary 为无害清理。
    expect(() => endTransactionBoundary(db)).not.toThrow();
  });
});

describe("受控嵌套事务（savepoint）——进程级抢占夹具", () => {
  /**
   * 进程级抢占夹具（可注入期限）：父库建表并进入事务（持锁）后写 go marker
   * 放行子进程抢锁；子进程（可选延迟/可选行为模式）抢锁并写 lock marker；
   * 父探针遇 busy → fail-closed TARB(cause=busy)。真实预算默认
   * 10s/10s/5s/2s（不为故障注入压缩）；故障测试注入短期限与行为模式
   * （ignore-sigterm / exit3 / rollback-failed）。清理登记到 fixtureCleanups
   * （afterEach 覆盖外部超时中止场景）；共享进行中的 cleanup Promise——
   * 重复调用等待同一份完成，不会跳过尚未执行的清理。
   */
  /** close 证据断言：每个已创建连接都有 closed=true 且无错误（isOpen=false 证据）。 */
  const expectDbClosed = (
    evidence: Array<{ name: string; closed: boolean; error?: string }>,
    name: string,
  ): void => {
    const entry = evidence.find((item) => item.name === name);
    expect(entry).toBeDefined();
    expect(entry!.closed).toBe(true);
    expect(entry!.error).toBeUndefined();
  };

  interface PreemptFixtureOptions {
    /** 子进程拿到 go 后、抢锁前的延迟（慢启动模拟）。 */
    childLockDelayMs?: number;
    /** 子进程行为模式（默认 normal）。 */
    mode?: "normal" | "ignore-sigterm" | "exit3" | "rollback-failed";
    /** 注入不存在的 spawn 命令（ENOENT 故障测试）。 */
    spawnCommand?: string;
    /** kind=silent-noop 时，best-effort 真实关闭也注入失败（负向验证）。 */
    bestEffortAlsoFails?: boolean;
    /**
     * 用例显式声明的完整预期关闭错误消息集合（按发生顺序）。提供后：
     * 实际集合与声明不一致（额外/缺失/内容不符）→ 专用 mismatch 错误，
     * 透传 AggregateError 的路径被阻断——额外错误无法被静默吞掉。
     */
    expectedCloseErrors?: string[];
    /** 注入指定连接的 close 故障（throw=close 抛错；silent-noop=close 返回但句柄仍打开）。 */
    closeFailure?: {
      db: "dbA" | "dbRecovered" | "both";
      kind: "throw" | "silent-noop";
    };
    /** 父等待子进程抢锁的期限（默认 10000ms）。 */
    lockWaitMs?: number;
    /** 父等待 ack 的期限（默认 10000ms）。 */
    ackWaitMs?: number;
    /** 父等待子进程退出的期限（默认 5000ms）。 */
    exitWaitMs?: number;
    /** SIGTERM 后的宽限（默认 2000ms，超时 SIGKILL）。 */
    killGraceMs?: number;
    /** 锁确认后的拦截钩子（模拟外部超时中断；抛错即中断后续流程）。 */
    onLocked?: () => void;
    /** 拦截后跳过 release/ack/exit 流程，直接清理（强制终止验证）。 */
    skipReleaseAndExit?: boolean;
  }

  interface PreemptFixtureResult {
    dir: string;
    /** 外层 wrapper 抛出的错误：TARB（探针 busy）或期限错误。 */
    outerError: Error | undefined;
    uniqueSeen: string | undefined;
    leakedCount: number;
    totalCount: number;
    recoveredCount: number;
    ackContent: string;
    /** 实际退出码（信号终止时为 null）。 */
    exitCode: number | null;
    /** 实际终止信号（正常退出为 null）。 */
    signalCode: string | null;
    closed: boolean;
    /** 子进程在 exitWaitMs 期限内退出（事件驱动确认）。 */
    exitedInTime: boolean;
    /** 清理实际对存活子进程执行了 SIGKILL 强制终止（尝试发信号不算）。 */
    childWasKilled: boolean;
    /** 显式关闭证据（每个已创建连接的实际 close 结果）。 */
    closeEvidence: Array<{ name: string; closed: boolean; error?: string }>;
    /** cleanup 完成后各连接的实际打开状态（true=仍打开=清理缺陷）。 */
    isOpenAfter: { dbA: boolean | undefined; dbRecovered: boolean | undefined };
    isExited: () => boolean;
  }

  async function runPreemptFixture(
    options: PreemptFixtureOptions = {},
  ): Promise<PreemptFixtureResult> {
    const mode = options.mode ?? "normal";
    const lockWaitMs = options.lockWaitMs ?? 10_000;
    const ackWaitMs = options.ackWaitMs ?? 10_000;
    const exitWaitMs = options.exitWaitMs ?? 5_000;
    const killGraceMs = options.killGraceMs ?? 2_000;
    const childLockDelayMs = options.childLockDelayMs ?? 0;
    const dir = mkdtempSync(join(tmpdir(), "kiwi-m1-preempt-"));
    const dbPath = join(dir, "state.sqlite");
    const goMarker = join(dir, "go.marker");
    const lockMarker = join(dir, "lock.marker");
    const releaseMarker = join(dir, "release.marker");
    const ackMarker = join(dir, "ack.marker");
    let dbA: DatabaseSync | undefined;
    let dbRecovered: DatabaseSync | undefined;
    let child: ChildProcess | undefined;
    let childExited = false;
    let childClosed = false;
    let childExitCode: number | null = null;
    let childSignal: string | null = null;
    let spawnError: Error | undefined;
    /** 发信号尝试计数（SIGTERM/SIGKILL）；守卫拒绝（无有效 pid）不计。 */
    let signalAttempts = 0;
    /** 仅当子进程实际以 signalCode "SIGKILL" 退出时置位（基于结果判定）。 */
    let childWasKilled = false;
    /** 显式关闭证据（close 的实际结果，随结果/抛出错误附带供核对）。 */
    const closeEvidence: Array<{ name: string; closed: boolean; error?: string }> = [];
    /** 关闭失败的真实异常（任一失败不跳过另一连接，最终透传）。 */
    const closeErrors: unknown[] = [];
    /** 共享进行中的 cleanup Promise：重复调用等待同一份完成，不跳过清理。 */
    let cleanupPromise:
      | Promise<{ dbA: boolean | undefined; dbRecovered: boolean | undefined }>
      | undefined;
    /** cleanup 的拒绝实例（AggregateError）与创建时的错误集合快照。 */
    let aggregateRejection: AggregateError | undefined;
    let aggregateErrorsSnapshot: string[] | undefined;
    const isExited = (): boolean =>
      child !== undefined && (child.exitCode !== null || child.signalCode !== null);
    const waitForExit = async (): Promise<boolean> => {
      const c = child!;
      if (c.exitCode !== null || c.signalCode !== null) return true;
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), exitWaitMs);
        c.once("exit", () => { clearTimeout(timer); resolve(true); });
        c.once("close", () => { clearTimeout(timer); resolve(true); });
      });
    };
    let isOpenAfter: { dbA: boolean | undefined; dbRecovered: boolean | undefined } = {
      dbA: undefined,
      dbRecovered: undefined,
    };
    const cleanup = async (): Promise<{ dbA: boolean | undefined; dbRecovered: boolean | undefined }> => {
      if (cleanupPromise !== undefined) return cleanupPromise;
      cleanupPromise = (async () => {
        try { writeFileSync(goMarker, "go"); } catch { /* 目录可能已不可用 */ }
        try { writeFileSync(releaseMarker, "release"); } catch { /* 同上 */ }
        if (child !== undefined) {
          if (child.pid !== undefined && !isExited()) {
            signalAttempts += 1;
            child.kill("SIGTERM");
            const graceDeadline = Date.now() + killGraceMs;
            while (!isExited() && Date.now() < graceDeadline) {
              // 事件驱动等待（不阻塞事件循环——exit/close 事件需要送达）。
              await new Promise<void>((r) => setTimeout(r, 20));
            }
            if (!isExited()) {
              // 忽略 SIGTERM 的子进程：SIGKILL 强制终止；childWasKilled 在
              // 退出确认（signalCode === "SIGKILL"）后再判定，不凭发信号尝试。
              signalAttempts += 1;
              child.kill("SIGKILL");
            }
          }
          const exitDeadline = Date.now() + exitWaitMs;
          while (!isExited() && !childClosed && Date.now() < exitDeadline) {
            await new Promise<void>((r) => setTimeout(r, 20));
          }
          // 'close' 在 stdio 冲刷后才触发（晚于 exit）：有界等待补齐。
          if (!isExited() || !childClosed) {
            await new Promise<void>((resolve) => {
              const t = setTimeout(() => resolve(), 300);
              child!.once("close", () => { clearTimeout(t); childClosed = true; resolve(); });
            });
          }
          child.removeAllListeners();
        }
        // childWasKilled 基于实际信号结果：子进程以 signalCode "SIGKILL" 退出
        // 才置真（SIGTERM 尝试/正常退出均不算；发信号尝试不计入）。
        if (child !== undefined && isExited() && child.signalCode === "SIGKILL") {
          childWasKilled = true;
        }
        // 显式关闭已创建的连接（rmSync 之前）：各自独立尝试——任一关闭异常
        // 不跳过另一连接及子进程清理；真实异常收集后透传，不悄然当成功。
        // close 后实际检查 isOpen：静默 no-op close（返回但句柄仍打开）不被
        // 当作关闭成功。
        const attemptClose = (name: string, target: DatabaseSync | undefined): void => {
          if (target === undefined) return;
          const injected =
            options.closeFailure !== undefined &&
            (options.closeFailure.db === name || options.closeFailure.db === "both")
            ? options.closeFailure.kind
            : undefined;
          try {
            if (injected === "throw") {
              throw new Error(`kiwi-fixture: 注入的 ${name} close 异常`);
            }
            if (injected !== "silent-noop") {
              target.close();
            }
            // close 后实际检查 isOpen：静默失败不被当作成功。
            if (target.isOpen) {
              throw new Error(`kiwi-fixture: ${name} close 后 isOpen 仍为 true（静默失败）`);
            }
            closeEvidence.push({ name, closed: true });
          } catch (err) {
            // 故障证据先入册（closed=false + 注入/真实错误），**随后 best-effort
            // 真实关闭**——不把注入的静默 no-op/抛错当作最终状态，避免仅靠
            // 进程退出释放句柄。
            closeEvidence.push({ name, closed: false, error: String(err) });
            closeErrors.push(err);
            try {
              if (options.bestEffortAlsoFails === true) {
                // 故障注入：best-effort 真实关闭也失败（句柄仍打开）——
                // 如实暴露，供用例断言 isOpenAfter 与 AggregateError 内容。
                throw new Error(`kiwi-fixture: ${name} 注入的 best-effort close 失败`, {
                  cause: err,
                });
              }
              if (target.isOpen) target.close();
              if (target.isOpen) {
                throw new Error(`kiwi-fixture: ${name} best-effort close 后 isOpen 仍为 true`, {
                  cause: err,
                });
              }
              closeEvidence.push({ name: `${name}:best-effort`, closed: true });
            } catch (recoverErr) {
              // best-effort 失败同样是可检查错误：进入 AggregateError。
              closeEvidence.push({
                name: `${name}:best-effort`,
                closed: false,
                error: String(recoverErr),
              });
              closeErrors.push(recoverErr);
            }
          }
        };
        attemptClose("dbA", dbA);
        attemptClose("dbRecovered", dbRecovered);
        // 显式关闭证据已在上方采集。isOpenAfter：cleanup 完成后各连接的
        // 实际打开状态（供测试断言"真实关闭"而非仅声称）——赋值外层变量。
        isOpenAfter = {
          dbA: dbA?.isOpen,
          dbRecovered: dbRecovered?.isOpen,
        };
        // rmSync 前置守卫：仅当不存在仍存活的子进程（已退出——exitCode 或
        // signalCode 置位，或从未成功 spawn——pid 未定义）时才删除目录；
        // SIGKILL 都未生效的极端情形 **保留现场**，不隐瞒。
        const childGone =
          child === undefined || isExited() || child.pid === undefined;
        if (childGone) {
          rmSync(dir, { recursive: true, force: true });
        }
        // 关闭失败的真实异常在此透传（目录删除已完成，不泄漏资源）；附带
        // dir/isOpenAfter/closeEvidence 供测试断言目录已删除、真实关闭状态与
        // 精确完整错误集合。登记拒绝实例与错误集合快照——afterEach 仅消费
        // 与快照一致的同一实例（额外错误 → 重抛 → 测试失败）。
        if (closeErrors.length > 0) {
          // 用例声明的预期集合核对：快照生成前的任何额外/缺失错误在此
          // fail-closed（专用 mismatch 错误，阻断 AggregateError 透传）。
          if (options.expectedCloseErrors !== undefined) {
            const actualMessages = closeErrors.map((item) => String((item as Error).message));
            const expectedMessages = options.expectedCloseErrors;
            const mismatch =
              actualMessages.length !== expectedMessages.length ||
              expectedMessages.some((message, index) => actualMessages[index] !== message);
            if (mismatch) {
              const mismatchError = new Error(
                `kiwi-fixture: 关闭错误集合与用例声明不一致——实际 [${actualMessages.join(" | ")}]，` +
                  `预期 [${expectedMessages.join(" | ")}]（额外/缺失错误均视为失败）`,
              );
              // 夹具自有的"声明集合不匹配"信号：afterEach 可识别并消费
              // （用例负责断言该错误的内容），不与真实清理失败混淆。
              (mismatchError as { isFixtureMismatch?: boolean }).isFixtureMismatch = true;
              (mismatchError as { dir?: string }).dir = dir;
              (mismatchError as { isOpenAfter?: typeof isOpenAfter }).isOpenAfter = isOpenAfter;
              (mismatchError as { actualCloseErrorMessages?: string[] }).actualCloseErrorMessages =
                actualMessages;
              throw mismatchError;
            }
          }
          const aggregate = new AggregateError(
            closeErrors,
            "kiwi-fixture: 关闭数据库连接失败",
          );
          aggregateRejection = aggregate;
          aggregateErrorsSnapshot = closeErrors.map((item) => String((item as Error).message));
          (aggregate as { dir?: string }).dir = dir;
          (aggregate as { isOpenAfter?: typeof isOpenAfter }).isOpenAfter = isOpenAfter;
          (aggregate as {
            closeEvidence?: Array<{ name: string; closed: boolean; error?: string }>;
          }).closeEvidence = closeEvidence;
          (aggregate as { errorsSnapshot?: string[] }).errorsSnapshot = aggregateErrorsSnapshot;
          throw aggregate;
        }
        return isOpenAfter;
      })();
      return cleanupPromise;
    };
    fixtureCleanups.push({
      job: cleanup,
      // 仅 close 故障注入会使 cleanup 以 AggregateError 拒绝（预期，由用例
      // 断言**精确完整错误集合**）；其余清理失败均为真实失败，钩子必须重抛。
      // mismatch 错误（声明集合不一致）同样由用例断言后消费。
      expectedRejectionMatch: (err: unknown) =>
        err === aggregateRejection ||
        (err as { isFixtureMismatch?: boolean }).isFixtureMismatch === true,
    });
    try {
      dbA = new DatabaseSync(dbPath);
      const db = dbA;
      const childScript = `
        const { DatabaseSync } = require("node:sqlite");
        const fs = require("node:fs");
        const [dbPath, goMarker, lockMarker, releaseMarker, ackMarker, lockDelayMs, mode] = process.argv.slice(1);
        const db = new DatabaseSync(dbPath);
        const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        if (mode === "ignore-sigterm") process.on("SIGTERM", () => { /* 忽略 SIGTERM */ });
        // 等待父库建表并进入事务（go marker）后再抢锁，避免 schema 阶段 SQLITE_BUSY。
        const goDeadline = Date.now() + 15000;
        while (Date.now() < goDeadline && !fs.existsSync(goMarker)) sleep(10);
        if (Number(lockDelayMs) > 0) sleep(Number(lockDelayMs));
        const deadline = Date.now() + 15000;
        let locked = false;
        while (Date.now() < deadline) {
          try { db.exec("BEGIN IMMEDIATE"); locked = true; break; } catch { sleep(5); }
        }
        fs.writeFileSync(lockMarker, locked ? "locked" : "timeout");
        if (locked) {
          if (mode === "ignore-sigterm") {
            // 不观察 release marker：持锁自旋直至被 SIGKILL（有上限防泄漏）。
            const spinDeadline = Date.now() + 15000;
            while (Date.now() < spinDeadline) sleep(20);
          } else {
            const relDeadline = Date.now() + 15000;
            while (Date.now() < relDeadline && !fs.existsSync(releaseMarker)) sleep(10);
            if (mode === "rollback-failed") { try { db.close(); } catch {} }
            // ack 仅在成功回滚后发送；失败写 rollback-failed。
            let rolled = false;
            try { db.exec("ROLLBACK"); rolled = true; } catch {}
            fs.writeFileSync(ackMarker, rolled ? "released" : "rollback-failed");
            if (mode === "exit3") process.exit(3);
          }
        }
        try { db.close(); } catch { /* rollback-failed 模式已关闭 */ }
      `;
      const spawnCommand = options.spawnCommand ?? process.execPath;
      child = spawn(spawnCommand, [
        "-e", childScript, dbPath, goMarker, lockMarker, releaseMarker, ackMarker,
        String(childLockDelayMs), mode,
      ]);
      child.on("error", (err: Error) => { spawnError = err; });
      child.on("exit", (code: number | null, signal: string | null) => {
        childExitCode = code;
        childSignal = signal ?? null;
        childExited = true;
      });
      child.on("close", () => { childClosed = true; });
      // spawn 失败（注入不存在的命令 → ENOENT）：pid 在 spawn() 返回时即未
      // 定义。等待 'error' 事件送达（事件驱动、有界——保证事件循环可处理）
      // → fatal 清理（关库 + 删唯一目录；无存活子进程）→ 立即抛出原始错误：
      // 不进入 release/ack/exit/recovery 流程（无 10s ack 阻塞、无恢复写入、
      // exitedInTime 不产生与"无 exit"事实矛盾的真值）。
      if (child.pid === undefined) {
        await new Promise<void>((resolve) => {
          if (spawnError !== undefined) return resolve();
          const timer = setTimeout(() => resolve(), 500);
          child!.once("error", (err) => { spawnError = err; clearTimeout(timer); resolve(); });
        });
        const spawnFailure = spawnError ??
          new Error("kiwi-fixture: 子进程未成功 spawn（pid 未定义）");
        // fatal 清理失败（如注入的 close 异常）作为 cause 附带：原始 ENOENT
        // （code/上下文）与 cleanup 异常两个错误均可检查，互不覆盖。
        let cleanupFailure: unknown;
        try {
          await cleanup();
        } catch (err) {
          cleanupFailure = err;
        }
        // 附带可核对证据（在 cleanup 之后采集：isOpenAfter 由 cleanup 写入）：
        // 无有效 pid → 无信号尝试；目录已随 fatal 清理删除；close 证据齐全。
        (spawnFailure as { signalAttempts?: number; dir?: string }).signalAttempts =
          signalAttempts;
        (spawnFailure as { dir?: string }).dir = dir;
        (spawnFailure as {
          closeEvidence?: Array<{ name: string; closed: boolean; error?: string }>;
        }).closeEvidence = closeEvidence;
        (spawnFailure as {
          isOpenAfter?: { dbA: boolean | undefined; dbRecovered: boolean | undefined };
        }).isOpenAfter = isOpenAfter;
        if (cleanupFailure !== undefined) {
          (spawnFailure as { cause?: unknown }).cause = cleanupFailure;
        }
        throw spawnFailure;
      }
      db.exec("CREATE TABLE preempt_rows (k TEXT UNIQUE)");
      db.exec("INSERT INTO preempt_rows (k) VALUES ('dup')");
      let outerError: Error | undefined;
      let uniqueSeen: string | undefined;
      try {
        inImmediateTransaction(db, () => {
          // 父已建表并持写锁：放行子进程抢锁（其 BEGIN 将 busy 至自动回滚释放）。
          writeFileSync(goMarker, "go");
          try {
            db.prepare("INSERT OR ROLLBACK INTO preempt_rows (k) VALUES ('dup')").run();
            expect.unreachable();
          } catch (err) {
            if ((err as Error).message.includes("UNIQUE")) {
              uniqueSeen = (err as Error).message;
            }
            // 吞掉（纪律边界：wrapper 外的裸写/吞错不承诺零残留）
          }
          // 明确同步握手：父确认子进程已持有目标库写锁（marker 内容）后，
          // 探针才会运行——TARB.cause 中的 busy 即真实观察到的锁冲突。
          const deadline = Date.now() + lockWaitMs;
          let locked = false;
          while (Date.now() < deadline) {
            if (existsSync(lockMarker) && readFileSync(lockMarker, "utf8") === "locked") {
              locked = true;
              break;
            }
            if (child!.pid === undefined) {
              // ENOENT 等 spawn 失败：pid 同步未定义，立刻失败（不阻塞 15s）。
              throw spawnError ?? new Error("kiwi-fixture: 子进程未成功 spawn（pid 未定义）");
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          }
          if (!locked) {
            throw new Error(
              `kiwi-fixture: 子进程抢锁期限已到（lockWaitMs=${lockWaitMs}，childLockDelayMs=${childLockDelayMs}）`,
            );
          }
          options.onLocked?.();
          // 子进程持锁：探针 BEGIN IMMEDIATE → busy → fail-closed TARB(cause=busy)。
          inImmediateTransaction(db, () => {
            db.prepare("INSERT INTO preempt_rows (k) VALUES ('leaked')").run();
            return undefined;
          });
          return undefined;
        });
        expect.unreachable("外层应抛出错误（TARB 或期限）");
      } catch (err) {
        outerError = err as Error;
      }
      // 观测计数（skip 与否均成立）：自动回滚已回滚 OR ROLLBACK 写入；leaked
      // 写入被探针 TARB 拒绝，均不应存在。
      const leakedCount = (
        db.prepare("SELECT COUNT(*) AS n FROM preempt_rows WHERE k = 'leaked'").get() as { n: number }
      ).n;
      const totalCount = (
        db.prepare("SELECT COUNT(*) AS n FROM preempt_rows").get() as { n: number }
      ).n;
      if (options.skipReleaseAndExit === true) {
        // 模拟外部超时中断/强制终止验证：不释放子进程，直接清理 → 对仍存活
        // 的子进程 SIGTERM（宽限）→ SIGKILL，随后删除目录。
        await cleanup();
        return {
          dir,
          outerError,
          uniqueSeen,
          leakedCount,
          totalCount,
          recoveredCount: 0, // 清理路径不执行恢复插入
          ackContent: "", // 未等待 ack（子进程未成功回滚或被强制终止）
          exitCode: childExitCode,
          signalCode: childSignal,
          closed: childClosed,
          exitedInTime: false,
          childWasKilled,
          closeEvidence,
          isOpenAfter,
          isExited: () => childExited || (childExitCode !== null || childSignal !== null),
        };
      }
      // 释放子进程（独立 release marker），等待其 ack（仅成功回滚后发送）。
      writeFileSync(releaseMarker, "release");
      const ackDeadline = Date.now() + ackWaitMs;
      let ackContent = "";
      while (Date.now() < ackDeadline) {
        if (existsSync(ackMarker)) {
          ackContent = readFileSync(ackMarker, "utf8");
          if (ackContent !== "") break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      // 子进程退出（事件驱动 + 可注入期限）。
      const exitedInTime = await waitForExit();
      // 恢复：锁释放（成功回滚或子进程已被清理）后全新连接可用。
      dbRecovered = new DatabaseSync(dbPath);
      inImmediateTransaction(dbRecovered, () => {
        dbRecovered!.prepare("INSERT INTO preempt_rows (k) VALUES ('recovered')").run();
        return undefined;
      });
      const recoveredCount = (
        dbRecovered!.prepare("SELECT COUNT(*) AS n FROM preempt_rows WHERE k = 'recovered'").get() as {
          n: number;
        }
      ).n;
      await cleanup();
      return {
        dir,
        outerError,
        uniqueSeen,
        leakedCount,
        totalCount,
        recoveredCount,
        ackContent,
        exitCode: childExitCode,
        signalCode: childSignal,
        closed: childClosed,
        exitedInTime,
        childWasKilled,
        closeEvidence,
        isOpenAfter,
        isExited: () => childExited || (childExitCode !== null || childSignal !== null),
      };
    } catch (fatal) {
      // 清理自身失败（如关库异常）不掩盖原始 fatal 错误。
      try {
        await cleanup();
      } catch {
        // 保留原始 fatal。
      }
      throw fatal;
    }
  }

  it("审查项（进程级抢占）：父库建表并进入事务后子进程抢锁，探针 busy 在 kind=wrapper 深度 fail-closed（TARB cause=busy）且零残留", async () => {
    // 真实预算（默认 10s/10s/5s/2s）：不因故障注入压缩真实抢锁预算。
    const fixture = await runPreemptFixture();
    expect(fixture.outerError).toBeInstanceOf(TransactionAutoRolledBackError);
    expect(fixture.outerError!.message).toContain("kiwi-tx");
    expect(String((fixture.outerError!.cause as Error | undefined)?.message)).toMatch(/locked|busy/i);
    expect(fixture.uniqueSeen).toContain("UNIQUE");
    expect(fixture.leakedCount).toBe(0);
    expect(fixture.totalCount).toBe(1); // 仅原始 'dup'
    expect(fixture.ackContent).toBe("released");
    // 实际退出记录：正常退出码 0、无信号——childWasKilled 为 false（未 SIGKILL）。
    expect(fixture.exitCode).toBe(0);
    expect(fixture.signalCode).toBeNull();
    expect(fixture.childWasKilled).toBe(false);
    expect(fixture.closed).toBe(true);
    expect(fixture.exitedInTime).toBe(true);
    expect(fixture.isExited()).toBe(true);
    expect(fixture.recoveredCount).toBe(1);
    // 实际 close 证据：两个连接均显式关闭（isOpen=false），无静默失败。
    expect(fixture.closeEvidence.map((item) => item.name)).toEqual(["dbA", "dbRecovered"]);
    expectDbClosed(fixture.closeEvidence, "dbA");
    expectDbClosed(fixture.closeEvidence, "dbRecovered");
    // 真实关闭断言：cleanup 后两个连接的实际打开状态均为 false。
    expect(fixture.isOpenAfter.dbA).toBe(false);
    expect(fixture.isOpenAfter.dbRecovered).toBe(false);
    expect(existsSync(fixture.dir)).toBe(false);
  });

  it("审查项（慢启动）：子进程抢锁前延迟在真实预算内，不产生伪失败", async () => {
    const fixture = await runPreemptFixture({ childLockDelayMs: 400 });
    expect(fixture.outerError).toBeInstanceOf(TransactionAutoRolledBackError);
    expect(String((fixture.outerError!.cause as Error | undefined)?.message)).toMatch(/locked|busy/i);
    expect(fixture.leakedCount).toBe(0);
    expect(fixture.ackContent).toBe("released");
    expect(fixture.exitCode).toBe(0);
    expect(fixture.signalCode).toBeNull();
    expect(fixture.childWasKilled).toBe(false);
    // 真实关闭断言。
    expect(fixture.isOpenAfter.dbA).toBe(false);
    expect(existsSync(fixture.dir)).toBe(false);
  });

  it("审查项（ignore-sigterm 注入）：SIGTERM 被忽略 → SIGKILL 强制终止（childWasKilled），零残留且目录删除", async () => {
    // child 忽略 SIGTERM 且不观察 release marker：ack 等待按注入期限到期，
    // 清理钩子升级 SIGKILL 强制终止持锁子进程。
    const fixture = await runPreemptFixture({
      mode: "ignore-sigterm",
      ackWaitMs: 400,
      exitWaitMs: 300,
      killGraceMs: 300,
      skipReleaseAndExit: true,
    });
    expect(fixture.outerError).toBeInstanceOf(TransactionAutoRolledBackError);
    expect(String((fixture.outerError!.cause as Error | undefined)?.message)).toMatch(/locked|busy/i);
    // 实际终止证据：信号终止（exitCode null + SIGKILL），而非"尝试过发信号"。
    expect(fixture.childWasKilled).toBe(true);
    expect(fixture.exitCode).toBeNull();
    expect(fixture.signalCode).toBe("SIGKILL");
    expect(fixture.ackContent).toBe(""); // 未成功回滚，无成功 ack
    expect(fixture.leakedCount).toBe(0);
    // 真实关闭断言：SIGKILL 后连接被 cleanup 显式关闭（skip 路径未创建
    // dbRecovered，其打开状态如实为 undefined）。
    expect(fixture.isOpenAfter.dbA).toBe(false);
    expect(fixture.isOpenAfter.dbRecovered).toBeUndefined();
    // 目录先断言存在，再检查删除。
    expect(fixture.dir).toBeDefined();
    expect(existsSync(fixture.dir)).toBe(false); // 子进程终止后才删除目录
  });

  it("审查项（exit3 注入）：ack 后以退出码 3 退出 → 实际退出码被如实记录", async () => {
    const fixture = await runPreemptFixture({ mode: "exit3" });
    expect(fixture.outerError).toBeInstanceOf(TransactionAutoRolledBackError);
    expect(fixture.leakedCount).toBe(0);
    expect(fixture.ackContent).toBe("released");
    // 记录实际退出码：非 0 退出被如实断言，childExited 不掩盖。
    expect(fixture.exitCode).toBe(3);
    expect(fixture.signalCode).toBeNull();
    expect(fixture.childWasKilled).toBe(false);
    // 真实关闭断言。
    expect(fixture.isOpenAfter.dbA).toBe(false);
    expect(existsSync(fixture.dir)).toBe(false);
  });

  it("审查项（rollback-failed 注入）：回滚失败 → ack=rollback-failed 被如实断言", async () => {
    // 子进程在 release 后先关闭数据库再尝试 ROLLBACK → 回滚失败 →
    // ack = rollback-failed（非 released）；父进程如实断言该失败路径。
    const fixture = await runPreemptFixture({ mode: "rollback-failed" });
    expect(fixture.outerError).toBeInstanceOf(TransactionAutoRolledBackError);
    expect(fixture.leakedCount).toBe(0);
    expect(fixture.ackContent).toBe("rollback-failed");
    expect(fixture.exitCode).toBe(0);
    expect(fixture.signalCode).toBeNull();
    // 子进程关闭连接即释放锁：恢复插入正常。
    expect(fixture.recoveredCount).toBe(1);
    // 真实关闭断言。
    expect(fixture.isOpenAfter.dbA).toBe(false);
    expect(existsSync(fixture.dir)).toBe(false);
  });

  it("审查项（spawn ENOENT 注入）：fatal 清理后立即抛原始错误（无 10s ack 阻塞、无恢复写入、无有效 pid 不发信号、目录清理）", async () => {
    const started = Date.now();
    let thrown: (Error & {
      dir?: string;
      signalAttempts?: number;
      code?: string;
      closeEvidence?: Array<{ name: string; closed: boolean; error?: string }>;
    }) | undefined;
    try {
      await runPreemptFixture({ spawnCommand: "kiwi-m1-fixture-nonexistent-command" });
      expect.unreachable("spawn 失败应抛出原始错误");
    } catch (err) {
      thrown = err as Error & {
        dir?: string;
        signalAttempts?: number;
        code?: string;
        closeEvidence?: Array<{ name: string; closed: boolean; error?: string }>;
      };
    }
    // 原始错误保留（ENOENT 语义，不被 ack/exit 路径掩盖）。
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/ENOENT|pid 未定义|spawn/i);
    // fail-fast：不再同步阻塞默认 10s ack（修复前 ~10s+）；耗时可核对。
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5000);
    // 无有效 pid → 无信号尝试（signalAttempts=0 随错误附带，供核对）。
    expect(thrown!.signalAttempts).toBe(0);
    // 收紧：spawn 错误的 code 恰为 ENOENT。
    expect((thrown as unknown as { code?: string }).code).toBe("ENOENT");
    // fatal 清理：唯一目录已删除；无恢复写入（throw 先于恢复插入，控制流
    // 保证恢复代码不可达）。
    expect(thrown!.dir).toBeDefined();
    expect(existsSync(thrown!.dir!)).toBe(false);
    // close 证据：dbA 显式关闭；dbRecovered 从未创建（无记录）。
    expect(thrown!.closeEvidence!.map((item) => item.name)).toEqual(["dbA"]);
    expectDbClosed(thrown!.closeEvidence!, "dbA");
  });

  it("审查项（组合故障注入）：spawn ENOENT + dbA close 抛错 → 原始 code/上下文保留，cleanup 异常作为 cause 可检查", async () => {
    let thrown: (Error & {
      dir?: string;
      signalAttempts?: number;
      code?: string;
      cause?: unknown;
      closeEvidence?: Array<{ name: string; closed: boolean; error?: string }>;
      isOpenAfter?: { dbA: boolean | undefined; dbRecovered: boolean | undefined };
    }) | undefined;
    try {
      await runPreemptFixture({
        spawnCommand: "kiwi-m1-fixture-nonexistent-command",
        closeFailure: { db: "dbA", kind: "throw" },
        // 用例显式声明的完整预期关闭错误集合（额外/缺失即 mismatch 失败）。
        expectedCloseErrors: ["kiwi-fixture: 注入的 dbA close 异常"],
      });
      expect.unreachable("spawn 失败应抛出原始错误");
    } catch (err) {
      thrown = err as Error & {
        dir?: string;
        signalAttempts?: number;
        code?: string;
        cause?: unknown;
      };
    }
    // 原始错误保留：ENOENT code 与上下文不被 cleanup 异常覆盖。
    expect(thrown).toBeDefined();
    expect(thrown!.code).toBe("ENOENT");
    expect(thrown!.message).toContain("kiwi-m1-fixture-nonexistent-command");
    // cleanup 异常作为 cause 附带：两个错误均可检查。
    expect(thrown!.cause).toBeDefined();
    expect((thrown!.cause as AggregateError).name).toBe("AggregateError");
    expect(
      (thrown!.cause as AggregateError).errors.some((item) =>
        String((item as Error).message).includes("注入的 dbA close 异常"),
      ),
    ).toBe(true);
    // 无有效 pid → 无信号尝试；fatal 清理后唯一目录不存在。
    expect(thrown!.signalAttempts).toBe(0);
    expect(thrown!.dir).toBeDefined();
    expect(existsSync(thrown!.dir!)).toBe(false);
    // 故障证据保留：dbA 的 close 注入失败（closed=false + 注入错误）。
    expect(thrown!.closeEvidence!.find((item) => item.name === "dbA")).toMatchObject({
      closed: false,
    });
    // best-effort 真实关闭证据：注入失败后仍显式关闭成功（非仅靠进程退出）。
    expect(thrown!.closeEvidence!.find((item) => item.name === "dbA:best-effort")).toMatchObject({
      closed: true,
    });
    // 实际关闭断言：cleanup 后 dbA 的 isOpen 为 false。
    expect(thrown!.isOpenAfter).toEqual({ dbA: false, dbRecovered: undefined });
  });

  it("审查项（silent-noop 注入）：close 返回但 isOpen 仍为 true → AggregateError（两个连接均失败）且目录删除", async () => {
    let aggError: AggregateError | undefined;
    try {
      await runPreemptFixture({
        closeFailure: { db: "both", kind: "silent-noop" },
        expectedCloseErrors: [
          "kiwi-fixture: dbA close 后 isOpen 仍为 true（静默失败）",
          "kiwi-fixture: dbRecovered close 后 isOpen 仍为 true（静默失败）",
        ],
      });
      expect.unreachable("close 静默失败应抛出 AggregateError");
    } catch (err) {
      aggError = err as AggregateError;
    }
    // 两个连接的静默失败均被 isOpen 实际检查捕获并收集。
    expect(aggError).toBeInstanceOf(AggregateError);
    expect(aggError!.errors).toHaveLength(2);
    expect(
      aggError!.errors.every((item) =>
        String((item as Error).message).includes("isOpen 仍为 true"),
      ),
    ).toBe(true);
    // 目录清理照常（本场景无存活子进程）：AggregateError 附带 dir 供断言。
    expect(existsSync((aggError as { dir?: string }).dir ?? "")).toBe(false);
  });

  it("审查项（bestEffortAlsoFails 注入）：best-effort 也失败 → isOpenAfter 如实 true/true，AggregateError 含全部 4 条错误", async () => {
    let aggError: AggregateError | undefined;
    try {
      await runPreemptFixture({
        closeFailure: { db: "both", kind: "silent-noop" },
        bestEffortAlsoFails: true,
        expectedCloseErrors: [
          "kiwi-fixture: dbA close 后 isOpen 仍为 true（静默失败）",
          "kiwi-fixture: dbA 注入的 best-effort close 失败",
          "kiwi-fixture: dbRecovered close 后 isOpen 仍为 true（静默失败）",
          "kiwi-fixture: dbRecovered 注入的 best-effort close 失败",
        ],
      });
      expect.unreachable("close 双重失败应抛出 AggregateError");
    } catch (err) {
      aggError = err as AggregateError;
    }
    expect(aggError).toBeInstanceOf(AggregateError);
    // 精确完整错误集合：2 条静默失败 + 2 条 best-effort 注入失败。
    expect(aggError!.errors).toHaveLength(4);
    expect((aggError!.errors[0] as Error).message).toBe(
      "kiwi-fixture: dbA close 后 isOpen 仍为 true（静默失败）",
    );
    expect((aggError!.errors[1] as Error).message).toBe(
      "kiwi-fixture: dbA 注入的 best-effort close 失败",
    );
    expect((aggError!.errors[2] as Error).message).toBe(
      "kiwi-fixture: dbRecovered close 后 isOpen 仍为 true（静默失败）",
    );
    expect((aggError!.errors[3] as Error).message).toBe(
      "kiwi-fixture: dbRecovered 注入的 best-effort close 失败",
    );
    // 恢复断言：子进程正常退出后，全新连接可用。
    expect(existsSync((aggError as { dir?: string }).dir!)).toBe(false);
  });

  it("审查项（额外错误负向验证）：声明 1 条而实际 2 条 → mismatch 显式失败（额外错误不被吞）", async () => {
    // 真实子进程 + closeFailure both-throw：实际产生 2 条关闭错误（dbA 注入
    // + dbRecovered 注入），但用例只声明第 1 条——快照生成前的集合核对必须
    // fail-closed（专用 mismatch 错误），不透传 AggregateError、不静默吞掉
    // 额外错误。
    let mismatch: (Error & {
      dir?: string;
      isOpenAfter?: { dbA: boolean | undefined; dbRecovered: boolean | undefined };
      actualCloseErrorMessages?: string[];
      isFixtureMismatch?: boolean;
    }) | undefined;
    try {
      await runPreemptFixture({
        closeFailure: { db: "both", kind: "throw" },
        expectedCloseErrors: ["kiwi-fixture: 注入的 dbA close 异常"],
      });
      expect.unreachable("集合不一致应抛出 mismatch 错误");
    } catch (err) {
      mismatch = err as Error & {
        dir?: string;
        isOpenAfter?: { dbA: boolean | undefined; dbRecovered: boolean | undefined };
        actualCloseErrorMessages?: string[];
        isFixtureMismatch?: boolean;
      };
    }
    // mismatch 错误语义：明确声明集合不匹配（非 TARB、非 AggregateError），
    // isFixtureMismatch 标记 + 实际/预期集合都可检查。
    expect(mismatch).toBeDefined();
    expect(mismatch!.isFixtureMismatch).toBe(true);
    expect(mismatch!.message).toContain("关闭错误集合与用例声明不一致");
    expect(mismatch!.message).toContain("注入的 dbA close 异常");
    expect(mismatch!.message).toContain("注入的 dbRecovered close 异常");
    expect(mismatch!.actualCloseErrorMessages).toEqual([
      "kiwi-fixture: 注入的 dbA close 异常",
      "kiwi-fixture: 注入的 dbRecovered close 异常",
    ]);
    // isOpenAfter 证据随错误附带：两个连接的 best-effort 关闭均成功。
    expect(mismatch!.isOpenAfter).toEqual({ dbA: false, dbRecovered: false });
    // 目录已删除（子进程已正常退出）；零残留。
    expect(mismatch!.dir).toBeDefined();
    expect(existsSync(mismatch!.dir!)).toBe(false);
  });
  it("审查项（超时注入）：抢锁期限强制为显式错误（不掩盖），子进程被清理、目录删除", async () => {
    // 期限 250ms < 子进程延迟 400ms：父等待到期 → 显式期限错误（非 TARB、
    // 不掩盖）；清理钩子强制终止仍未抢到锁的子进程并删除目录。
    const fixture = await runPreemptFixture({
      lockWaitMs: 250,
      childLockDelayMs: 400,
      skipReleaseAndExit: true,
    });
    expect(fixture.outerError).toBeDefined();
    expect(fixture.outerError).not.toBeInstanceOf(TransactionAutoRolledBackError);
    expect(fixture.outerError!.message).toContain("kiwi-fixture: 子进程抢锁期限已到");
    // 子进程被清理钩子以 SIGTERM 终止（期限未到即杀死——尚未抢到锁）：
    // 实际终止信号被如实记录（SIGKILL 语义的 childWasKilled 为 false——
    // 正常子进程无需 SIGKILL）；未成功回滚 → 无成功 ack。
    expect(fixture.exitCode).toBeNull();
    expect(fixture.signalCode).toBe("SIGTERM");
    expect(fixture.childWasKilled).toBe(false);
    expect(fixture.isExited()).toBe(true);
    expect(fixture.ackContent).toBe("");
    expect(existsSync(fixture.dir)).toBe(false);
    expect(fixture.leakedCount).toBe(0);
    expect(fixture.totalCount).toBe(1);
    expect(fixture.recoveredCount).toBe(0); // 清理路径不执行恢复插入
    // 真实关闭断言：cleanup 显式关闭已创建的 dbA（dbRecovered 从未创建）。
    expect(fixture.isOpenAfter.dbA).toBe(false);
    expect(fixture.isOpenAfter.dbRecovered).toBeUndefined();
  });

  it("审查项（cleanup 覆盖外部超时）：子进程持锁时直接调用清理 → 强制终止 + 目录删除", async () => {
    // 模拟外部超时中止：锁确认后不写 release、不走完流程，直接调用登记的
    // cleanup（即 afterEach 将执行的动作）→ 子进程被强制终止、目录删除。
    const result = await runPreemptFixture({
      onLocked: () => {
        // 模拟外部超时中断：不返回，由测试直接触发清理。
        throw new Error("kiwi-fixture: 模拟外部超时中止");
      },
      skipReleaseAndExit: true,
    });
    // 子进程持锁存活 → SIGTERM 终止：实际信号被如实记录（SIGKILL 语义的
    // childWasKilled 为 false）。
    expect(result.exitCode).toBeNull();
    expect(result.signalCode).toBe("SIGTERM");
    expect(result.childWasKilled).toBe(false);
    expect(result.isExited()).toBe(true);
    expect(existsSync(result.dir)).toBe(false);
    expect(result.leakedCount).toBe(0);
    expect(result.totalCount).toBe(1);
    // skip 路径未执行恢复插入 → dbRecovered 从未创建：close 证据仅 dbA。
    expect(result.closeEvidence.map((item) => item.name)).toEqual(["dbA"]);
    expectDbClosed(result.closeEvidence, "dbA");
    // 真实关闭断言。
    expect(result.isOpenAfter.dbA).toBe(false);
    expect(result.isOpenAfter.dbRecovered).toBeUndefined();
  });
});
