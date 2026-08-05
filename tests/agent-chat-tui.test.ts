/**
 * Main-chat TUI tests: the readline loop driven with injected in-memory
 * streams — free text, slash commands, /quit, and the EOF-without-/quit
 * path (readline-closed guard).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePathsForDir } from "../src/agent/agent-db.js";
import { runChatTui } from "../src/agent/chat-tui.js";
import { createFakeChatModels } from "../src/agent/fake-chat-model.js";
import { AgentKernel } from "../src/agent/kernel.js";
import { EnvKeyProvider, PrivateVault } from "../src/agent/memory/vault.js";
import { testProfile } from "./helpers.js";

let workDir: string;

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function streams(lines: string[]): { input: Readable; output: Writable; text: () => string } {
  const input = Readable.from([`${lines.join("\n")}\n`]);
  let buffer = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk);
      callback();
    },
  });
  return { input, output, text: () => buffer };
}

async function setup(): Promise<AgentKernel> {
  const { models, model } = createFakeChatModels();
  return AgentKernel.open({
    profile: testProfile(),
    paths: ensurePathsForDir(path.join(workDir, "agent")),
    models,
    model,
    vault: new PrivateVault(new EnvKeyProvider("a".repeat(64))),
  });
}

describe("runChatTui", () => {
  it("answers free text, runs slash commands, and exits cleanly on /quit", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-chat-"));
    const kernel = await setup();
    const { input, output, text } = streams([
      "记住我更喜欢京东自营",
      "/memory",
      "/why",
      "/quit",
    ]);
    const code = await runChatTui({ kernel, input, output });
    expect(code).toBe(0);
    const out = text();
    expect(out).toContain("Kiwi Merchant · merchant-agent:merchant-001 · 主对话");
    expect(out).toContain("已记住");
    expect(out).toContain("[active] preference/chat.note.");
    expect(out).toContain("正在安全退出");
    expect(kernel.isShutdownRequested).toBe(true);
    await kernel.close();
  });

  it("EOF without /quit exits 0 (no readline-after-close crash)", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "kiwi-chat-"));
    const kernel = await setup();
    const { input, output } = streams(["你好"]);
    const code = await runChatTui({ kernel, input, output });
    expect(code).toBe(0);
    await kernel.close();
  });
});
