/**
 * F01–F30 验收矩阵完整性测试（V2 阶段一）：
 * - 恰好 30 条、编号 F01..F30 连续无缺无重（禁止删除条目换取「全量覆盖」）；
 * - 状态枚举合法；covered 能力必须挂真实存在的测试文件（防漂移）；
 * - buddy=wired 的条目必须有证据；
 * - 输出状态统计（供报告）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACCEPTANCE_MATRIX } from "./acceptance-matrix.js";

const ROOT = path.resolve(__dirname, "../..");

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

  it("状态统计（报告用）", () => {
    const count = <T extends string>(key: "capability" | "buddy", value: T): number =>
      ACCEPTANCE_MATRIX.filter((e) => e[key] === value).length;
    // 状态只能改善不能倒退：covered/wired 数不得少于本基线
    expect(count("capability", "covered")).toBeGreaterThanOrEqual(16);
    expect(count("buddy", "wired")).toBeGreaterThanOrEqual(4);
  });
});
