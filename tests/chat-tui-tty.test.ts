/**
 * 聊天 TUI TTY 门控测试（Neural Awakening 主题）：
 * - tty=true：输出含 24-bit ANSI（渐变横幅、状态栏、box 面板、彩色 prompt）；
 * - 非 TTY 对照：输出不含任何 ESC 序列（字节直通回归门）。
 *
 * env 用 vi.stubEnv 固定（TERM/COLORTERM），保证 24bit 判定确定性。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePathsForDir } from "../src/agent/agent-db.js";
import { runChatTui } from "../src/agent/chat-tui.js";
import { createFakeChatModels } from "../src/agent/fake-chat-model.js";
import { AgentKernel } from "../src/agent/kernel.js";
import { EnvKeyProvider, PrivateVault } from "../src/agent/memory/vault.js";
import { PRODUCT_VERSION } from "../src/product-cli.js";
import { startTestA2aStack, testProfile } from "./helpers.js";
import { streams } from "./tui-helpers.js";

const ESC = "\u001b";

let workDir: string;

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** 固定 24bit 颜色模式（TTY 门控测试用）。 */
function stubTruecolorEnv(): void {
  vi.stubEnv("TERM", "xterm-256color");
  vi.stubEnv("COLORTERM", "truecolor");
  vi.stubEnv("NO_COLOR", "");
}

async function openKernel(): Promise<AgentKernel> {
  const { models, model } = createFakeChatModels();
  return AgentKernel.open({
    profile: testProfile(),
    paths: ensurePathsForDir(path.join(workDir, "agent")),
    models,
    model,
    vault: new PrivateVault(new EnvKeyProvider("a".repeat(64))),
  });
}

describe("runChatTui TTY 样式（Neural Awakening）", () => {
  it("TTY：渐变横幅 + 状态栏 + 彩色 prompt + /discover box 面板", async () => {
    stubTruecolorEnv();
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-chat-tty-"));
    const stack = await startTestA2aStack({});
    try {
      const kernel = await openKernel();
      const { input, output, text } = streams(["/discover", "/quit"], { tty: true });
      const code = await runChatTui({
        kernel,
        input,
        output,
        catalog: stack.catalogUrl,
      });
      expect(code).toBe(0);
      const out = text();
      // 24-bit 渐变 logo（box 字符 art）
      expect(out).toContain(`${ESC}[38;2;`);
      expect(out).toContain("██"); // art 可见
      // 欢迎面板：版本标题 + 会话/模型/命令信息行
      expect(out).toContain("┌─"); // 面板顶边
      expect(out).toContain(`kiwi ${PRODUCT_VERSION}`);
      expect(out).toContain("会话:");
      expect(out).toContain("模型:");
      expect(out).toContain("命令:");
      // 状态栏（catalog 段）
      expect(out).toContain(`catalog ${stack.catalogUrl}`);
      // /discover box 面板边框
      expect(out).toContain("┌");
      expect(out).toContain("┘");
      expect(out).toContain("[discover]");
      // 彩色 prompt（青色 accent #00BCD4 = 0;188;212）
      expect(out).toContain(`${ESC}[38;2;0;188;212mkiwi> `);
      await kernel.close();
    } finally {
      await stack.stop();
    }
  });

  it("非 TTY 对照：输出不含任何 ESC 序列（字节直通）", async () => {
    stubTruecolorEnv();
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-chat-tty-"));
    const kernel = await openKernel();
    const { input, output, text } = streams(["/memory", "/quit"]);
    const code = await runChatTui({ kernel, input, output });
    expect(code).toBe(0);
    expect(text()).not.toContain(ESC);
    await kernel.close();
  });
});
