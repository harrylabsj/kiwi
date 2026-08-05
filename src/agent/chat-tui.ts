/**
 * Main-conversation TUI (design §4, §6.4): plain node:readline over
 * injected streams — no TTY requirement, tests drive it in-memory.
 * Free text goes to the model via the kernel; slash commands are the
 * deterministic control shortcuts.
 */

import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { EXIT } from "../exit-codes.js";
import type { AgentKernel } from "./kernel.js";

export interface ChatTuiOptions {
  kernel: AgentKernel;
  input: Readable;
  output: Writable;
}

/** Run the main chat loop. Resolves EXIT.OK on /quit or EOF. */
export async function runChatTui(options: ChatTuiOptions): Promise<number> {
  const { kernel, input, output } = options;
  const write = (text: string): void => {
    output.write(`${text}\n`);
  };

  const roleLabel = kernel.profile.role === "buyer" ? "Buyer" : "Merchant";
  write(`Kiwi ${roleLabel} · ${kernel.principal.principal_id} · 主对话（/help 查看命令，/quit 退出）`);

  // Restart recovery: wakeups derive from the database, so an immediate tick
  // rebuilds the queue; a slow unref'd timer keeps tracking tasks alive.
  const tickAndNotify = async (): Promise<void> => {
    const result = await kernel.schedulerTick().catch(() => undefined);
    if (result === undefined) return;
    for (const n of result.notifications) {
      write(`[通知] ${n.summary}（任务 ${n.task_id}）`);
    }
  };
  await tickAndNotify();
  const timer = setInterval(() => {
    void tickAndNotify();
  }, 60_000);
  timer.unref();

  try {
    const rl = readline.createInterface({
      input,
      output,
      terminal: (input as { isTTY?: boolean }).isTTY === true,
      prompt: "kiwi> ",
    });
    // EOF (Ctrl-D, or an injected stream that ends) closes the interface while
    // the last line is still being handled; prompting a closed readline throws.
    let rlClosed = false;
    rl.once("close", () => {
      rlClosed = true;
    });
    rl.prompt();
    for await (const rawLine of rl) {
      const line = String(rawLine).trim();
      if (line !== "") {
        const reply = await kernel.handleUserText(line);
        if (reply.text !== "") write(reply.text);
        if (reply.quit) break;
      }
      if (!rlClosed) rl.prompt();
    }
    rl.close();
    return EXIT.OK;
  } finally {
    clearInterval(timer);
  }
}
