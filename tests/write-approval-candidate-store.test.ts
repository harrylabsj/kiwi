// WriteApprovalCandidateStore 清扫事务的原子性（P2-1 刀 1 补漏）。
//
// `expireDue` / `expireForRecovery` 此前是 SELECT + 循环 UPDATE 的 autocommit
// 序列：中途失败会留下"一部分候选已 expired、另一部分还 pending"的半截清扫——
// /pending 会继续展示一个本该被清扫的动作。本文件注入"第二条 UPDATE 失败"，
// 断言第一条 UPDATE 的效果也不存在（回滚），即清扫要么全部生效、要么全部不生效。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrateMemorySchema } from "../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../src/agent/merchant/action-candidate.js";

const NOW = "2026-09-22T00:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";

function realDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateMemorySchema(db);
  db.prepare(
    `INSERT INTO principals
     (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
     VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
  ).run(PRINCIPAL, NOW, NOW);
  return db;
}

/** 包装真实 db：第 N 条 UPDATE action_candidates 的 run 抛错（模拟中途存储失败）。 */
function failingUpdate(db: DatabaseSync, failOnCall: number): DatabaseSync {
  let calls = 0;
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      if (sql.includes("UPDATE action_candidates")) {
        calls += 1;
        if (calls === failOnCall) {
          return {
            run: () => {
              throw new Error("injected storage failure");
            },
          };
        }
      }
      return db.prepare(sql);
    },
  } as unknown as DatabaseSync;
}

function seedTwo(store: WriteApprovalCandidateStore, expiresAt: string): string[] {
  const a = store.create({
    tool: "t",
    arguments: {},
    preconditions: {},
    risk: "write_catalog",
    expires_at: expiresAt,
  });
  const b = store.create({
    tool: "t",
    arguments: {},
    preconditions: {},
    risk: "write_catalog",
    expires_at: expiresAt,
  });
  return [a.candidate_id, b.candidate_id];
}

describe("清扫事务原子性（P2-1 刀 1 补漏）", () => {
  it("expireDue：第二条 UPDATE 失败 → 第一条的效果也不存在", () => {
    const real = realDb();
    const store = new WriteApprovalCandidateStore({
      db: failingUpdate(real, 2),
      principalId: PRINCIPAL,
      now: () => NOW,
    });
    const ids = seedTwo(store, "2026-09-21T00:00:00.000Z"); // 均已到期

    expect(() => store.expireDue()).toThrow(/injected storage failure/);
    // 无事务时这里会观察到第一个候选已 expired（半截清扫）
    for (const id of ids) {
      expect(store.get(id)?.status).toBe("pending_approval");
    }
  });

  it("expireForRecovery：第二条 UPDATE 失败 → 第一条的效果也不存在", () => {
    const real = realDb();
    const store = new WriteApprovalCandidateStore({
      db: failingUpdate(real, 2),
      principalId: PRINCIPAL,
      now: () => NOW,
    });
    const ids = seedTwo(store, "2026-09-30T00:00:00.000Z"); // 未到期也会被恢复清扫

    expect(() => store.expireForRecovery()).toThrow(/injected storage failure/);
    for (const id of ids) {
      expect(store.get(id)?.status).toBe("pending_approval");
    }
  });
});
