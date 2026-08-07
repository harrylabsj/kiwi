/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Main-conversation TUI (design §4, §6.4): plain node:readline over
 * injected streams — no TTY requirement, tests drive it in-memory.
 * Free text goes to the model via the kernel; slash commands are the
 * deterministic control shortcuts.
 *
 * `/profile <file>`（TUI 层拦截）：加载并切换到另一个 agent profile 的
 * kernel（如 buyer/merchant），供裸 `kiwi` 启动后自由换身份。
 */

import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { EXIT } from "../exit-codes.js";
import type { AgentKernel } from "./kernel.js";

export interface ChatTuiOptions {
  kernel: AgentKernel;
  input: Readable;
  output: Writable;
  /**
   * `/profile <file>` 时调用：加载 profile 并构建新 kernel（调用方负责
   * AgentKernel.open 与 close 语义）。失败时抛错，TUI 保留当前 kernel。
   */
  reload?: (profileFile: string) => Promise<AgentKernel>;
}

function printBanner(kernel: AgentKernel, output: Writable): void {
  const roleLabel = kernel.profile.role === "buyer" ? "Buyer" : "Merchant";
  output.write(
    `Kiwi ${roleLabel} · ${kernel.principal.principal_id} · 主对话（/help 查看命令，/quit 退出）\n`,
  );
}

/** Run the main chat loop. Resolves EXIT.OK on /quit or EOF. */
export async function runChatTui(options: ChatTuiOptions): Promise<number> {
  const { input, output, reload } = options;
  const write = (text: string): void => {
    output.write(`${text}\n`);
  };

  // 可变 kernel 引用：`/profile` 切换时更新，定时器与循环自动跟随。
  let current: { kernel: AgentKernel } = { kernel: options.kernel };
  printBanner(current.kernel, output);

  // Restart recovery: wakeups derive from the database, so an immediate tick
  // rebuilds the queue; a slow unref'd timer keeps tracking tasks alive.
  const tickAndNotify = async (): Promise<void> => {
    const result = await current.kernel.schedulerTick().catch(() => undefined);
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

  // Autonomous negotiation (autopilot): poll for pending negotiation messages
  // and drive one model turn per tick. No-op outside autopilot.
  const negotiate = async (): Promise<void> => {
    const text = await current.kernel.negotiationAutoTick().catch(() => undefined);
    if (text !== undefined && text !== "") write(`[磋商] ${text}`);
  };
  await negotiate();
  const negotiateTimer = setInterval(() => {
    void negotiate();
  }, 15_000);
  negotiateTimer.unref();

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
        if (line.startsWith("/profile")) {
          const file = line.slice("/profile".length).trim();
          if (file === "" || reload === undefined) {
            write("用法：/profile <profile.yaml>（无参数或未配置 reload 时不可用）");
          } else {
            try {
              const next = await reload(file);
              if (next !== current.kernel) {
                await current.kernel.close().catch(() => undefined);
                current = { kernel: next };
                printBanner(current.kernel, output);
              }
            } catch (err) {
              write(`加载 profile 失败，保留当前 agent：${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else {
          const reply = await current.kernel.handleUserText(line);
          if (reply.text !== "") write(reply.text);
          if (reply.quit) break;
        }
      }
      if (!rlClosed) rl.prompt();
    }
    rl.close();
    return EXIT.OK;
  } finally {
    clearInterval(timer);
    clearInterval(negotiateTimer);
  }
}
