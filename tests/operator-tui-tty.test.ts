/**
 * Operator TUI TTY 门控测试（Neural Awakening 主题）：
 * - tty=true：header 分段着色、候选面板 box 包裹、[已发送] 绿色；
 * - 语义不变：与现有非 TTY 测试相同的 controller 行为断言（/approve 才提交）。
 */
import { describe, expect, it, vi } from "vitest";
import { streams } from "./tui-helpers.js";
import type { FakeCommerceClient } from "../src/commerce/fake-client.js";
import { OperatorController } from "../src/operator/controller.js";
import { DeterministicNegotiationRunner } from "../src/operator/runner.js";
import { InMemoryOperatorEventStore } from "../src/operator/store.js";
import { createStrategyEngine } from "../src/operator/strategy.js";
import { runTui } from "../src/operator/tui.js";
import { NOW, testMarketplace, testProfile } from "./helpers.js";

const ESC = "\u001b";

function tuiSetup(): { controller: OperatorController; merchant: FakeCommerceClient } {
  const { merchant } = testMarketplace();
  const profile = testProfile();
  const controller = new OperatorController({
    profile,
    store: new InMemoryOperatorEventStore(),
    engine: createStrategyEngine(),
    runner: new DeterministicNegotiationRunner(profile, merchant),
    now: () => NOW,
  });
  return { controller, merchant };
}

describe("runTui TTY 样式（Neural Awakening）", () => {
  it("TTY：header 分段着色 + 候选面板 box + [已发送] 绿，语义不变", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("COLORTERM", "truecolor");
    vi.stubEnv("NO_COLOR", "");
    const { controller, merchant } = tuiSetup();
    await controller.start();
    const { input, output, text } = streams(["/strategy", "/approve", "/quit"], { tty: true });

    const code = await runTui({ controller, input, output });
    expect(code).toBe(0);

    const out = text();
    // 24-bit 着色（header 角色段 primary 蓝 #4FC3F7 = 79;195;247）
    expect(out).toContain(`${ESC}[38;2;79;195;247m`);
    // 候选面板 box 边框
    expect(out).toContain("┌");
    expect(out).toContain("┘");
    // 语义不变：文本断言与既有非 TTY 测试一致
    expect(out).toContain("Kiwi Merchant");
    expect(out).toContain("公开草稿");
    expect(out).toContain("等待批准");
    expect(out).toContain("Kiwi 分析");
    // [已发送] ok 绿（#81C784 = 129;199;132）
    expect(out).toContain(`${ESC}[38;2;129;199;132m[已发送]`);
    // 行为不变：/approve 才产生正式消息
    expect(merchant.messages()).toHaveLength(2);
    expect(merchant.claimStatus(1)).toBe("processed");
    expect(controller.getState().shutdown).toBe(true);
    vi.unstubAllEnvs();
  });

  it("非 TTY 对照：输出不含任何 ESC 序列（字节直通）", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("COLORTERM", "truecolor");
    vi.stubEnv("NO_COLOR", "");
    const { controller } = tuiSetup();
    await controller.start();
    const { input, output, text } = streams(["/quit"]);
    const code = await runTui({ controller, input, output });
    expect(code).toBe(0);
    expect(text()).not.toContain(ESC);
    vi.unstubAllEnvs();
  });
});
