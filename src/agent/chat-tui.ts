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
import { negotiateWithAgent, summarizeNegotiation } from "../a2a/negotiate.js";
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
  // 失败的 tick 必须可见：搜索/观察错误写进聊天（按内容去重，干净一轮后重置），
  // 否则"任务在 tracking 但一直失败"会表现为无声卡住。
  const surfacedErrors = new Set<string>();
  const tickAndNotify = async (): Promise<void> => {
    const result = await current.kernel.schedulerTick().catch(() => undefined);
    if (result === undefined) return;
    for (const n of result.notifications) {
      write(`[通知] ${n.summary}（任务 ${n.task_id}）`);
    }
    if (result.errors.length === 0) {
      surfacedErrors.clear();
      return;
    }
    for (const e of result.errors) {
      if (surfacedErrors.has(e)) continue;
      surfacedErrors.add(e);
      write(`[任务] ${e}`);
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
        } else if (line === "/handoff" || line.startsWith("/handoff ")) {
          const summary = current.kernel.handoffSummary;
          if (summary.enabled === false) {
            write("[handoff] 当前 kernel 未启用 Handoff（buyer 角色）。");
          } else {
            write(`[handoff] 候选 ${summary.candidates.length} 个 / 交付 ${summary.handoffs.length} 个`);
            for (const c of summary.candidates) {
              write(
                `  candidate ${c.candidate_id}  ${c.lifecycle}  ${c.destination_type} ${c.destination_ref}
` +
                  `    ${c.display_summary.merchant} — ${c.display_summary.summary}（negotiation ${c.negotiation_id}）`,
              );
            }
            for (const h of summary.handoffs) {
              write(`  handoff ${h.handoff_id}  delivery=${h.delivery}`);
            }
          }
        } else if (line.startsWith("/handoff-open ")) {
          const rest = line.slice("/handoff-open ".length).trim();
          const parts = rest.split(/\s+/);
          const handoffId = parts[0] ?? "";
          const negotiationId = parts[1] ?? "";
          if (handoffId === "") {
            write("用法：/handoff-open <handoff_id> <negotiation_id>");
          } else if (negotiationId === "") {
            write("缺少 negotiation_id（handoff 事件按 negotiation 落链，需提供）。");
          } else {
            write(await current.kernel.confirmHandoffOpened(handoffId, negotiationId));
          }
        } else if (line.startsWith("/handoff-launch ")) {
          const rest = line.slice("/handoff-launch ".length).trim();
          const parts = rest.split(/\s+/);
          const handoffId = parts[0] ?? "";
          const negotiationId = parts[1] ?? "";
          if (handoffId === "" || negotiationId === "") {
            write("用法：/handoff-launch <handoff_id> <negotiation_id>");
          } else {
            write(await current.kernel.launchHandoff(handoffId, negotiationId));
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
            const summary = summarizeNegotiation(result);
            write(`[negotiate]\n${summary}`);
            // 磋商结果注入会话 + 写入记忆：下一轮提问时模型能看到（消除"两个脑"）。
            if (result.ok) {
              await current.kernel.injectContext(summary).catch(() => undefined);
              await current.kernel
                .recordNegotiation({
                  negotiationId: result.negotiationId,
                  catalogAgentId: result.catalogAgentId,
                  sku: result.facts?.sku ?? "sku-001",
                  quantity: result.facts?.quantity ?? 200,
                  offerPriceMinor: result.facts?.offerPriceMinor,
                  dealPriceMinor: result.facts?.dealPriceMinor,
                  ...(result.agreement?.agreement_id !== undefined
                    ? { agreementId: String(result.agreement.agreement_id) }
                    : {}),
                })
                .catch(() => undefined);
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
