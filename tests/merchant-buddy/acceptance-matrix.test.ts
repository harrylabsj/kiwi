/**
 * F01–F30 验收矩阵完整性测试（V2 阶段一冻结；BUG-08 修订）：
 * - 恰好 30 条、编号 F01..F30 连续无缺无重（禁止删除条目换取「全量覆盖」）；
 * - 状态枚举合法；covered 能力必须挂真实存在的测试文件（防漂移）；
 * - BUG-08 发布范围语义：committed 条目必须 wired/partial（承诺项不得
 *   pending）；deferred 条目必须 pending（延后项不得宣称交付）；committed
 *   集合在本测试中冻结——悄悄把承诺项改成 deferred 换通过会直接失败；
 * - partial 必须有受限产品说明（不计为完整交付）；
 * - wired 必须声明 Buddy/MCP 到达路径，mcpTools 逐个与真实 MCP 注册表
 *   核对（不是"底层测试文件存在"就算到达）；
 * - 统计口径 = V2 承诺范围（不再以 covered>=16 / wired>=4 之类的最低数量
 *   阈值冒充"全量完成"）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateMemorySchema } from "../../src/agent/memory/schema.js";
import { WriteApprovalCandidateStore } from "../../src/agent/merchant/action-candidate.js";
import {
  FakeMerchantClient,
  fakeMerchantProduct,
} from "../../src/agent/merchant/fake-merchant-client.js";
import { MerchantCoreService } from "../../src/merchant-core/service.js";
import { buildMerchantMcpTools } from "../../src/mcp/merchant-tools.js";
import { testProfile } from "../helpers.js";
import { ACCEPTANCE_MATRIX } from "./acceptance-matrix.js";

const ROOT = path.resolve(__dirname, "../..");
const T0 = "2026-09-15T10:00:00.000Z";
const PRINCIPAL = "merchant-agent:merchant-001";

/**
 * 冻结的 V2 承诺集合（BUG-08）：15 项 committed（10 wired + 5 partial），
 * 其余 15 项显式 deferred。修改这个集合 = 修改 V2 发布承诺，必须随 PR 说明。
 */
const V2_COMMITTED = new Set([
  "F03",
  "F04",
  "F05",
  "F06",
  "F07",
  "F08",
  "F11",
  "F12",
  "F14",
  "F15",
  "F17",
  "F19",
  "F20",
  "F25",
  "F29",
]);

/** 构造最小 core，取真实 MCP 工具注册表（wired 到达路径核对用）。 */
function mcpToolNames(): Set<string> {
  const db = new DatabaseSync(":memory:");
  try {
    migrateMemorySchema(db);
    db.prepare(
      `INSERT INTO principals (principal_id, owner_id, role, locale, timezone, memory_schema_version, created_at, updated_at)
       VALUES (?, 'merchant-001', 'merchant', 'zh-CN', 'Asia/Shanghai', 3, ?, ?)`,
    ).run(PRINCIPAL, T0, T0);
    const store = new WriteApprovalCandidateStore({ db, principalId: PRINCIPAL, now: () => T0 });
    const core = new MerchantCoreService({
      profile: testProfile(),
      merchantClient: new FakeMerchantClient({ products: [fakeMerchantProduct()] }),
      approvals: store,
      mode: () => "supervised",
      now: () => T0,
      commandPrincipalId: PRINCIPAL,
    });
    return new Set(buildMerchantMcpTools(core).listTools(undefined).map((t) => t.name));
  } finally {
    db.close();
  }
}

describe("F01–F30 验收矩阵完整性", () => {
  it("恰好 30 条，编号 F01..F30 连续无缺无重", () => {
    expect(ACCEPTANCE_MATRIX).toHaveLength(30);
    const ids = ACCEPTANCE_MATRIX.map((e) => e.id);
    expect(new Set(ids).size).toBe(30);
    expect([...ids].sort()).toEqual(
      Array.from({ length: 30 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`),
    );
  });

  it("状态枚举合法；wired/covered 条目挂真实存在的测试证据", () => {
    for (const entry of ACCEPTANCE_MATRIX) {
      expect(["A", "B", "C"]).toContain(entry.category);
      expect(["covered", "partial", "missing"]).toContain(entry.capability);
      expect(["wired", "partial", "pending"]).toContain(entry.buddy);
      expect(["committed", "deferred"]).toContain(entry.v2Scope);
      if (entry.capability === "covered" || entry.buddy === "wired") {
        expect(entry.evidence.length, `${entry.id} 缺证据`).toBeGreaterThan(0);
      }
      for (const evidence of entry.evidence) {
        expect(existsSync(path.join(ROOT, evidence)), `${entry.id} 证据不存在: ${evidence}`).toBe(
          true,
        );
      }
    }
  });

  it("BUG-08 发布范围语义：承诺项不得 pending；延后项不得宣称交付；范围与冻结集合一致", () => {
    for (const entry of ACCEPTANCE_MATRIX) {
      const committed = V2_COMMITTED.has(entry.id);
      expect(
        entry.v2Scope,
        `${entry.id} v2Scope 与冻结的 V2 承诺集合不一致（改范围须同步改 V2_COMMITTED 并随 PR 说明）`,
      ).toBe(committed ? "committed" : "deferred");
      if (committed) {
        expect(["wired", "partial"], `${entry.id} 是 V2 承诺项，不得处于 pending`).toContain(
          entry.buddy,
        );
      } else {
        expect(entry.buddy, `${entry.id} 已声明延后，不得宣称 partial/wired`).toBe("pending");
      }
    }
  });

  it("partial 必须有受限产品说明；wired 必须声明到达路径且 MCP 工具真实存在", () => {
    const registry = mcpToolNames();
    for (const entry of ACCEPTANCE_MATRIX) {
      if (entry.buddy === "partial") {
        expect(
          (entry.note ?? "").trim().length,
          `${entry.id} partial 缺受限产品说明（不计为完整交付）`,
        ).toBeGreaterThan(0);
      }
      if (entry.buddy === "wired") {
        const reach = entry.reach;
        const hasReach =
          reach !== undefined &&
          ((reach.mcpTools?.length ?? 0) > 0 ||
            reach.mcpResources === true ||
            reach.adminPage === true ||
            (reach.cli?.length ?? 0) > 0);
        expect(hasReach, `${entry.id} wired 缺 Buddy/MCP 到达路径声明`).toBe(true);
        for (const tool of reach?.mcpTools ?? []) {
          expect(registry.has(tool), `${entry.id} 声明的 MCP 工具不在真实注册表中: ${tool}`).toBe(
            true,
          );
        }
      }
    }
  });

  it("状态统计（报告用；口径 = V2 承诺范围，不以最低阈值冒充全量）", () => {
    const committed = ACCEPTANCE_MATRIX.filter((e) => e.v2Scope === "committed");
    const count = (entries: typeof ACCEPTANCE_MATRIX, buddy: string): number =>
      entries.filter((e) => e.buddy === buddy).length;
    const stats = {
      committed_total: committed.length,
      committed_wired: count(committed, "wired"),
      committed_partial: count(committed, "partial"),
      deferred_pending: count(ACCEPTANCE_MATRIX, "pending"),
    };
    // 防倒退：承诺范围内 wired 数不得少于本基线（这不是"全量完成"证明，
    // 全量与否由上面的范围语义断言 + 平台实测清单（PLATFORM_MANUAL）共同界定）。
    expect(stats.committed_wired).toBeGreaterThanOrEqual(10);
    // 报告输出（供发布说明引用）。
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
  });
});
