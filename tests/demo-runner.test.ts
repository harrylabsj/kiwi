/**
 * `kiwi demo`（Issue 13）端到端测试：拓扑启动 → fan-out RFQ → Agreement → Handoff → 清理。
 * 依赖真实 kiwi-catalog sibling 目录（KIWI_CATALOG_DIR 或 ../kiwi-catalog）；
 * 缺失时跳过（CI 上无 sibling 仓库），本地有 sibling 才跑。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDemo } from "../src/demo/demo-runner.js";

const catalogAvailable =
  existsSync(
    path.join(
      process.env.KIWI_CATALOG_DIR ?? path.resolve(process.cwd(), "../kiwi-catalog"),
      "pyproject.toml",
    ),
  );

describe("kiwi demo（Issue 13）", () => {
  it.skipIf(!catalogAvailable)("场景 A：3 商家 fan-out → 最优选择 → Agreement → Handoff，全部清理", async () => {
    const lines: string[] = [];
    const summary = await runDemo("a", { onLog: (_p, d) => lines.push(d) });

    // 3 商家都被询价并返回 offer。
    expect(summary.result.offers.length).toBe(3);
    // 选了最低价那家（Gamma ¥820 < Beta ¥850 < Alpha ¥880）。
    expect(summary.result.chosen.merchant.id).toBe("merchant-gamma");

    // Agreement 三副作用恒 false。
    expect(summary.result.agreement.binding_effect).toBe("nonbinding");
    expect(summary.result.agreement.creates_order).toBe(false);
    expect(summary.result.agreement.authorizes_payment).toBe(false);
    expect(summary.result.agreement.reserves_inventory).toBe(false);

    // Handoff 候选存在，不执行。
    expect(summary.result.handoffCandidate.handoff_candidate_id).toMatch(/^hcan_/);
    expect(summary.result.handoffCandidate.creates_order).toBe(false);
    expect(summary.result.handoffCandidate.authorizes_payment).toBe(false);
    expect(summary.result.handoffCandidate.reserves_inventory).toBe(false);

    // 清理日志。
    expect(lines.some((l) => l.includes("已关闭"))).toBe(true);
    expect(summary.cleaned).toBe(true);
  });

  it.skipIf(!catalogAvailable)("场景 B：工业批量参数化（数量阶梯条件成交）", async () => {
    const summary = await runDemo("b");
    expect(summary.result.offers.length).toBe(3);
    expect(summary.result.agreement.agreement_id).toMatch(/^agr_/);
    expect(summary.result.agreement.authorizes_payment).toBe(false);
  });

  it("未知场景 fail-closed", async () => {
    await expect(runDemo("zzz")).rejects.toThrow(/unknown demo scenario/);
  });
});
