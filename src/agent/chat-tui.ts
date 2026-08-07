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
import { ShoppingCliCatalogSource } from "../discovery/catalog-source/index.js";
import { negotiateWithAgent } from "../a2a/negotiate.js";
import type { AgentKernel } from "./kernel.js";

/** A2A 节点状态（供 `/a2a` 显示）。 */
export interface ChatA2aNodeStatus {
  role: string;
  url: string;
  agentCardUrl: string;
  catalogAgentId?: string;
}

/** A2A 节点生命周期管理（由 cli 层持有；`/profile` 换角色时 rebuild）。 */
export interface ChatA2aNode {
  status(): ChatA2aNodeStatus | null;
  rebuild(profile: { role: string; agent_id: string }): Promise<void>;
  stop(): Promise<void>;
}

export interface ChatTuiOptions {
  kernel: AgentKernel;
  input: Readable;
  output: Writable;
  /**
   * `/profile <file>` 时调用：加载 profile 并构建新 kernel（调用方负责
   * AgentKernel.open 与 close 语义）。失败时抛错，TUI 保留当前 kernel。
   */
  reload?: (profileFile: string) => Promise<AgentKernel>;
  /** A2A 节点（自动启动，随 `/profile` 角色切换重建）。 */
  a2aNode?: ChatA2aNode;
  /** agent catalog base URL（`/discover`、`/negotiate` 用）。 */
  catalog?: string;
}

function printBanner(kernel: AgentKernel, output: Writable): void {
  const roleLabel = kernel.profile.role === "buyer" ? "Buyer" : "Merchant";
  output.write(
    `Kiwi ${roleLabel} · ${kernel.principal.principal_id} · 主对话（/help 查看命令，/quit 退出）\n`,
  );
}

/** Run the main chat loop. Resolves EXIT.OK on /quit or EOF. */
export async function runChatTui(options: ChatTuiOptions): Promise<number> {
  const { input, output, reload, a2aNode, catalog } = options;
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
                // 换角色：同步重建 A2A 节点（merchant 自动重新注册 catalog）。
                if (a2aNode !== undefined) {
                  await a2aNode.rebuild(current.kernel.profile).catch((err: unknown) => {
                    write(`A2A 节点重建失败（对话继续）：${err instanceof Error ? err.message : String(err)}`);
                  });
                }
                printBanner(current.kernel, output);
              }
            } catch (err) {
              write(`加载 profile 失败，保留当前 agent：${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else if (line === "/a2a") {
          const status = a2aNode?.status();
          if (status === undefined || status === null) {
            write("A2A 节点未启动。");
          } else {
            write(
              `[a2a] ${status.role}@${status.url}${status.catalogAgentId !== undefined ? ` registered ${status.catalogAgentId}` : ""}（card: ${status.agentCardUrl}）`,
            );
          }
        } else if (line.startsWith("/discover")) {
          if (catalog === undefined) {
            write("未配置 agent catalog（KIWI_CATALOG_URL 或 --catalog）。");
          } else {
            try {
              const source = new ShoppingCliCatalogSource({ baseUrl: catalog });
              const candidates = await source.searchCandidates();
              if (candidates.length === 0) {
                write("[discover] catalog 里没有可发现的 agent。");
              } else {
                for (const c of candidates) {
                  const card = c.discovery?.agent_card_url ?? c.merchant?.domain ?? "?";
                  write(`[discover] ${c.catalog_agent_id}  status=${c.verification?.status ?? "?"}  ${card}`);
                }
              }
            } catch (err) {
              write(`[discover] 失败：${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else if (line.startsWith("/negotiate")) {
          if (catalog === undefined) {
            write("未配置 agent catalog（KIWI_CATALOG_URL 或 --catalog）。");
          } else {
            const targetId = line.slice("/negotiate".length).trim();
            write(`[negotiate] 与 ${targetId === "" ? "首个可发现 agent" : targetId} 磋商中…`);
            const result = await negotiateWithAgent({
              catalog,
              ...(targetId !== "" ? { catalogAgentId: targetId } : {}),
            });
            if (result.ok) {
              write(`[negotiate] 成功：${result.steps.join(" → ")}`);
              if (result.agreement !== undefined) {
                const a = result.agreement;
                write(
                  `[negotiate] agreement ${String(a.agreement_id ?? "")} · binding=${String(a.binding_effect ?? "")} · creates_order=${String(a.creates_order)} · reserves_inventory=${String(a.reserves_inventory)} · authorizes_payment=${String(a.authorizes_payment)}`,
                );
              }
            } else {
              write(`[negotiate] 失败：${result.error ?? "未知错误"}`);
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
    await a2aNode?.stop().catch(() => undefined);
  }
}
