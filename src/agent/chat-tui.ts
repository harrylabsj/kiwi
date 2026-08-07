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
import { createTheme, type Seg } from "../tui/styles.js";
import { PRODUCT_VERSION } from "../product-cli.js";
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

function roleLabelOf(role: string): string {
  return role === "buyer" ? "Buyer" : "Merchant";
}

/** Run the main chat loop. Resolves EXIT.OK on /quit or EOF. */
export async function runChatTui(options: ChatTuiOptions): Promise<number> {
  const { input, output, reload, a2aNode, catalog } = options;
  // Neural Awakening 主题（参照 hermes）：非 TTY 时所有样式直通原文——
  // 既有内存流测试断言字节级不变。
  const theme = createTheme(output as { isTTY?: boolean });
  const write = (text: string): void => {
    output.write(`${theme.decorate(text)}\n`);
  };

  // 可变 kernel 引用：`/profile` 切换时更新，定时器与循环自动跟随。
  let current: { kernel: AgentKernel } = { kernel: options.kernel };

  // 欢迎界面（hermes build_welcome_banner 结构）：大号渐变 logo + 带版本
  // 标题的信息面板；非 TTY 下 theme.welcome 返回现状单行（字节不变）。
  const renderWelcome = (): void => {
    const mode = current.kernel.getMode();
    write(
      theme.welcome({
        roleLabel: roleLabelOf(current.kernel.profile.role),
        id: current.kernel.principal.principal_id,
        tagline: "主对话（/help 查看命令，/quit 退出）",
        versionLabel: `kiwi ${PRODUCT_VERSION}`,
        commerceUrl: current.kernel.profile.commerce.base_url,
        modelLabel: `${current.kernel.profile.model.provider}/${current.kernel.profile.model.model}`,
        modeLabel: mode === "autopilot" ? "Autopilot" : mode === "manual" ? "Manual" : "Supervised",
        a2aOn: a2aNode?.status() !== undefined && a2aNode?.status() !== null,
        catalog,
        commands: "/help /profile /handoff /discover /negotiate /a2a /quit",
      }),
    );
  };
  renderWelcome();

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
      // 彩色 prompt（青色；Node 22 readline 对 ANSI prompt 的宽度计算已验证）
      prompt: theme.enabled ? theme.paint("kiwi> ", "accent") : "kiwi> ",
    });
    // EOF (Ctrl-D, or an injected stream that ends) closes the interface while
    // the last line is still being handled; prompting a closed readline throws.
    let rlClosed = false;
    rl.once("close", () => {
      rlClosed = true;
    });

    // 状态栏 + prompt 重绘（TTY-only）：状态栏写在输入行上方，readline 的
    // 重绘只碰自己的行，正在输入的缓冲由 readline 完整重画不丢字。
    // 非 TTY 下 statusBar 返回空串 → 等价旧 rl.prompt()（零额外字节）。
    const refreshPrompt = (): void => {
      if (rlClosed) return;
      if (theme.enabled) {
        output.write("\r\u001b[K");
        const mode = current.kernel.getMode();
        const modeColor = mode === "autopilot" ? "accent" : mode === "supervised" ? "primary" : "warn";
        const segments: Array<string | Seg> = [
          { text: `Kiwi ${roleLabelOf(current.kernel.profile.role)}`, color: "primary", bold: true },
          current.kernel.principal.principal_id,
          { text: mode === "autopilot" ? "Autopilot" : mode === "manual" ? "Manual" : "Supervised", color: modeColor },
          a2aNode?.status() !== undefined && a2aNode?.status() !== null
            ? { text: "A2A on", color: "ok" }
            : { text: "A2A off", color: "muted", dim: true },
          catalog !== undefined ? `catalog ${catalog}` : "catalog —",
        ];
        output.write(`${theme.statusBar(segments)}\n`);
      }
      rl.prompt();
    };

    refreshPrompt();
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
                renderWelcome();
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
                // panel 化：行内容与现状逐字节一致，TTY 下 box 包裹
                const lines = candidates.map((c) => {
                  const card = c.discovery?.agent_card_url ?? c.merchant?.domain ?? "?";
                  return `[discover] ${c.catalog_agent_id}  status=${c.verification?.status ?? "?"}  ${card}`;
                });
                write(theme.panel(lines));
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
            // panel 化：TTY 下 box 包裹；非 TTY 下 join 输出与现状逐字节一致
            // （保留候选/交付行的前导空格）。
            const lines = [
              `[handoff] 候选 ${summary.candidates.length} 个 / 交付 ${summary.handoffs.length} 个`,
              ...summary.candidates.flatMap((c) => [
                `  candidate ${c.candidate_id}  ${c.lifecycle}  ${c.destination_type} ${c.destination_ref}`,
                `    ${c.display_summary.merchant} — ${c.display_summary.summary}（negotiation ${c.negotiation_id}）`,
              ]),
              ...summary.handoffs.map((h) => `  handoff ${h.handoff_id}  delivery=${h.delivery}`),
            ];
            write(theme.panel(lines));
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
            try {
              write(await current.kernel.confirmHandoffOpened(handoffId, negotiationId));
            } catch (err) {
              write(`[handoff-open] 失败：${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else if (line.startsWith("/handoff-launch ")) {
          const rest = line.slice("/handoff-launch ".length).trim();
          const parts = rest.split(/\s+/);
          const handoffId = parts[0] ?? "";
          const negotiationId = parts[1] ?? "";
          if (handoffId === "" || negotiationId === "") {
            write("用法：/handoff-launch <handoff_id> <negotiation_id>");
          } else {
            try {
              write(await current.kernel.launchHandoff(handoffId, negotiationId));
            } catch (err) {
              write(`[handoff-launch] 失败：${err instanceof Error ? err.message : String(err)}`);
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
      if (!rlClosed) refreshPrompt();
    }
    rl.close();
    return EXIT.OK;
  } finally {
    clearInterval(timer);
    clearInterval(negotiateTimer);
    await a2aNode?.stop().catch(() => undefined);
  }
}
