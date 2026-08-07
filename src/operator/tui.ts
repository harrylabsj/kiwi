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
 * Operator TUI (design §11–§12) — plain node:readline over injected streams.
 * No UI dependency, no TTY requirement: input/output are injected, so tests
 * drive it with in-memory streams. The TUI only renders controller state and
 * calls typed OperatorController methods; no state transitions live here.
 *
 * Visibility labels follow design §11: 私有 (operator-only), 公开草稿
 * (public draft, sent only after approval), 已发送 (authoritative), 建议
 * (manual-mode advice). Decision summaries are concise lines — never raw
 * chain-of-thought.
 */

import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { EXIT } from "../exit-codes.js";
import { createTheme, type Seg, type Theme } from "../tui/styles.js";
import type { ApprovalResult, OperatorController, PrepareResult } from "./controller.js";
import type { Candidate, OperatorEvent, OperatorMode } from "./types.js";

export interface TuiOptions {
  controller: OperatorController;
  input: Readable;
  output: Writable;
}

const COMMANDS = `/mode <autopilot|supervised|manual> [confirm]  切换运行模式
/strategy [confirm]          查看有效策略；confirm 确认放宽变更
/approve                     批准当前候选决策
/reject [原因]               驳回当前候选并放弃该轮
/revise <指令>               带新指令重新生成候选
/pause                       停止领取新消息
/resume                      恢复领取消息
/why                         解释当前候选与策略命中
/history [n]                 查看最近 n 条操作者事件
/usage                       查看会话用量
/quit                        安全退出`;

function modeLabel(mode: OperatorMode): string {
  return mode === "autopilot" ? "Autopilot" : mode === "manual" ? "Manual" : "Supervised";
}

type Write = (text: string) => void;

/** Bare natural-language aliases for the slash commands (design §12). */
const BARE_APPROVE = /^(approve|accept|批准)$/i;
const BARE_REJECT = /^(reject|驳回|拒绝)$/i;
const BARE_REVISE = /^(revise|重算|重来|重新生成)\s+(.+)$/i;

/**
 * Map a bare (no-slash) operator line to its slash command, so `approve` /
 * `reject` / `revise <指令>` are not swallowed as strategy preferences.
 * Returns undefined when the line is not a known command alias.
 */
function mapBareCommand(line: string): string | undefined {
  const trimmed = line.trim();
  if (BARE_APPROVE.test(trimmed)) return "/approve";
  if (BARE_REJECT.test(trimmed)) return "/reject";
  const revise = BARE_REVISE.exec(trimmed);
  if (revise !== null && revise[2] !== undefined) return `/revise ${revise[2].trim()}`;
  return undefined;
}

function renderHeader(controller: OperatorController, write: Write, theme: Theme): void {
  const state = controller.getState();
  const profile = controller.profile;
  const roleLabel = profile.role === "buyer" ? "Buyer" : "Merchant";
  // segments 拼接与旧文本逐字节一致（off 模式），TTY 下按语义着色
  write(
    theme.segments([
      { text: `Kiwi ${roleLabel}`, color: "primary", bold: true },
      profile.agent_id,
      { text: modeLabel(state.mode), color: modeColor(state.mode) },
      ...(state.paused ? [{ text: "已暂停", color: "warn" as const }] : []),
    ]),
  );
  write(
    theme.enabled
      ? `${theme.paint("会话:", "accent")} ${profile.commerce.base_url} · ${theme.paint("输入 /help 查看命令", "muted", { dim: true })}`
      : `会话: ${profile.commerce.base_url} · 输入 /help 查看命令`,
  );
}

function modeColor(mode: OperatorMode): Seg["color"] {
  return mode === "autopilot" ? "accent" : mode === "supervised" ? "primary" : "warn";
}

function renderCandidate(
  controller: OperatorController,
  candidate: Candidate,
  write: Write,
  theme: Theme,
): void {
  // panel 化：TTY 下 box 包裹；off 下 `─`×56 + 内容（legacy 逐字节复刻）
  const lines: string[] = [];
  const counterpart = controller.lastCounterpartMessage;
  if (counterpart !== undefined) lines.push(`对方: ${counterpart}`);
  lines.push("Kiwi 分析:");
  for (const line of candidate.analysis) lines.push(`  · ${line}`);
  if (candidate.route === "advice_only") {
    lines.push(`建议（manual 模式，不自动提交）: ${candidate.decision.public_message}`);
    lines.push(`候选 ${candidate.candidate_id} 仅建议 · /reject 放弃 · /revise <指令> 重算`);
  } else {
    lines.push(`公开草稿: ${candidate.decision.public_message}`);
    lines.push(
      `候选 ${candidate.candidate_id} 等待批准：/approve 批准 · /revise <指令> 重算 · /reject 驳回`,
    );
  }
  write(theme.panel(lines, { legacySeparator: true }));
}

function renderPrepare(
  controller: OperatorController,
  result: PrepareResult,
  write: Write,
  theme: Theme,
): void {
  switch (result.kind) {
    case "awaiting_approval":
    case "advice_ready":
      renderCandidate(controller, result.candidate, write, theme);
      break;
    case "auto_submitted":
      write(
        `[已发送] autopilot 已自动提交 ${result.candidate_id}（${result.policy_result}` +
          `${result.message_id !== undefined ? `，正式消息 #${result.message_id}` : ""}）。`,
      );
      break;
    case "blocked":
      write(`[私有] ${result.reason}`);
      break;
    case "no_work":
      write("[私有] 当前没有待处理消息。");
      break;
  }
}

function renderApproval(result: ApprovalResult, write: Write): void {
  switch (result.kind) {
    case "submitted":
      if (result.settlement === "completed") {
        write(
          `[已发送] 决策已提交（${result.policy_result}` +
            `${result.message_id !== undefined ? `，正式消息 #${result.message_id}` : ""}）。`,
        );
      } else {
        write(`[私有] 提交未通过策略门（${result.policy_result}），本轮已标记失败，不会重发。`);
      }
      break;
    case "replayed":
      write(`[私有] 候选 ${result.candidate_id} 已提交过，批准命令幂等重放，不产生重复消息。`);
      break;
    case "invalid":
      write(`[私有] ${result.reason}`);
      break;
  }
}

function renderStrategy(controller: OperatorController, write: Write): void {
  const strategy = controller.getState().strategy;
  write("[私有] 当前有效策略:");
  if (strategy.directives.length === 0 && strategy.pending_relax === undefined) {
    write("  （暂无会话策略；硬约束来自 profile，模型无权突破）");
  }
  for (const d of strategy.directives) {
    write(`  · [${d.kind}/${d.scope}] ${d.summary}`);
  }
  if (strategy.pending_relax !== undefined) {
    write(`  · 待确认（relax）: ${strategy.pending_relax.summary} — /strategy confirm 应用`);
  }
}

function renderWhy(controller: OperatorController, write: Write): void {
  const report = controller.why();
  write("[私有] 决策说明:");
  if (report.note !== undefined) write(`  ${report.note}`);
  if (report.candidate_id !== undefined) {
    write(`  候选: ${report.candidate_id} · 路由: ${report.route ?? ""}`);
  }
  for (const line of report.analysis) write(`  · ${line}`);
  if (report.reason_codes.length > 0) write(`  理由代码: ${report.reason_codes.join(", ")}`);
  if (report.active_directives.length > 0) {
    write("  生效指令:");
    for (const d of report.active_directives) write(`    · ${d}`);
  }
}

function renderHistory(controller: OperatorController, arg: string, write: Write): void {
  const n = Number.parseInt(arg, 10);
  const events = controller.history(Number.isInteger(n) && n > 0 ? n : 10);
  write(`[私有] 最近 ${events.length} 条事件:`);
  for (const event of events) {
    write(`  ${event.occurred_at}  [${event.visibility}]  ${event.type}${eventSummary(event)}`);
  }
}

function eventSummary(event: OperatorEvent): string {
  switch (event.type) {
    case "operator.message":
      return `  ${event.payload.text}`;
    case "strategy.patch.proposed":
    case "strategy.patch.applied":
    case "strategy.patch.rejected":
      return `  ${event.payload.patch.kind}: ${event.payload.patch.summary}`;
    case "mode.changed":
      return `  ${event.payload.from} -> ${event.payload.to}`;
    case "candidate.generated":
      return `  ${event.payload.candidate.candidate_id} (${event.payload.candidate.route})`;
    case "candidate.approved":
    case "candidate.rejected":
    case "candidate.revised":
    case "decision.submitted":
      return `  ${event.payload.candidate_id}`;
    case "turn.settled":
      return `  ${event.payload.candidate_id} ${event.payload.settlement}`;
    default:
      return "";
  }
}

function renderUsage(controller: OperatorController, write: Write): void {
  const stats = controller.usage();
  write("[私有] 会话用量:");
  write(
    `  操作者消息: ${stats.operator_messages} · 策略应用/拒绝: ${stats.patches_applied}/${stats.patches_rejected}`,
  );
  write(
    `  候选: ${stats.candidates_generated} · 提交: ${stats.decisions_submitted} · ` +
      `批准/驳回/重算: ${stats.approvals}/${stats.rejections}/${stats.revisions} · 事件: ${stats.events}`,
  );
  write("  模型 token: 不适用（v0.2.0 确定性后端；Pi 后端接入后展示）");
}

async function handleCommand(
  controller: OperatorController,
  line: string,
  write: Write,
  theme: Theme,
): Promise<void> {
  const parts = line.split(/\s+/);
  const command = parts[0] ?? "";
  const rest = parts.slice(1);
  const arg = rest.join(" ").trim();
  const state = controller.getState();

  switch (command) {
    case "/mode": {
      if (arg === "") {
        write(`当前模式: ${modeLabel(state.mode)}`);
        return;
      }
      const target = rest[0] ?? "";
      const result = await controller.setMode(target as OperatorMode, {
        confirmed: rest[1] === "confirm",
      });
      if (result.kind === "changed") write(`[私有] 模式已切换为 ${modeLabel(result.mode)}。`);
      else if (result.kind === "needs_confirmation") write(`[私有] ${result.reason}`);
      else if (result.kind === "unchanged") write(`[私有] 已是 ${modeLabel(result.mode)}。`);
      else write(`[私有] ${result.error}`);
      return;
    }
    case "/strategy": {
      if (arg === "confirm") {
        const result = await controller.confirmStrategy();
        write(result.ok ? "[私有] 已确认并应用放宽变更。" : `[私有] ${result.error}`);
        return;
      }
      renderStrategy(controller, write);
      return;
    }
    case "/approve": {
      renderApproval(await controller.approve(), write);
      return;
    }
    case "/reject": {
      const result = await controller.reject(undefined, arg === "" ? undefined : arg);
      write(result.ok ? "[私有] 已驳回当前候选，本轮不会提交。" : `[私有] ${result.error}`);
      return;
    }
    case "/revise": {
      renderPrepare(controller, await controller.revise(arg), write, theme);
      return;
    }
    case "/pause": {
      await controller.pause();
      write("[私有] 已暂停：不会领取新消息（在途候选仍可处理）。");
      return;
    }
    case "/resume": {
      await controller.resume();
      write("[私有] 已恢复领取消息。");
      return;
    }
    case "/why": {
      renderWhy(controller, write);
      return;
    }
    case "/history": {
      renderHistory(controller, arg, write);
      return;
    }
    case "/usage": {
      renderUsage(controller, write);
      return;
    }
    case "/quit": {
      write("[私有] 正在安全退出…");
      const result = await controller.shutdown();
      if (result.abandoned_candidate !== undefined) {
        write(`[私有] 在途候选 ${result.abandoned_candidate} 已放弃（claim abandoned，未提交）。`);
      }
      write("[私有] 已退出。");
      return;
    }
    case "/help": {
      write(COMMANDS);
      return;
    }
    default:
      write(`[私有] 未知命令 ${command}，输入 /help 查看命令。`);
  }
}

async function handleLine(
  controller: OperatorController,
  line: string,
  write: Write,
  theme: Theme,
): Promise<void> {
  if (line.startsWith("/")) {
    await handleCommand(controller, line, write, theme);
    return;
  }
  const bare = mapBareCommand(line);
  if (bare !== undefined) {
    await handleCommand(controller, bare, write, theme);
    return;
  }
  const result = await controller.sendOperatorMessage(line);
  if (result.kind === "applied") {
    write(`[私有] 策略已应用（${result.patch.kind}）：${result.patch.summary}`);
  } else if (result.kind === "needs_confirmation") {
    write(`[私有] 该变更放宽约束：${result.patch.summary}`);
    write("[私有] 输入 /strategy confirm 确认应用，或继续输入其他指令忽略。");
  } else if (result.patch?.kind === "chat") {
    write(`[私有] 该消息未作为策略指令：${result.reason}`);
  } else if (result.patch?.kind === "out_of_scope") {
    write(`[私有] 超出 Kiwi v0.2 能力范围：${result.reason}`);
  } else {
    write(`[私有] 已拒绝：${result.reason}`);
  }
}

/**
 * Run the TUI loop. Resolves EXIT.OK on /quit or EOF; on EOF without /quit
 * the controller is still shut down safely (pending candidate abandoned).
 */
export async function runTui(options: TuiOptions): Promise<number> {
  const { controller, input, output } = options;
  // Neural Awakening 主题（参照 hermes）：非 TTY 时所有样式直通原文。
  const theme = createTheme(output as { isTTY?: boolean });
  const write: Write = (text) => {
    output.write(`${theme.decorate(text)}\n`);
  };

  renderHeader(controller, write, theme);
  // Initial pull: show the current candidate (supervised never submits here).
  const initial = await controller.prepareNextCandidate();
  if (initial.kind !== "no_work" && initial.kind !== "blocked") {
    renderPrepare(controller, initial, write, theme);
  }

  const rl = readline.createInterface({
    input,
    output,
    terminal: (input as { isTTY?: boolean }).isTTY === true,
    prompt: theme.enabled ? theme.paint("kiwi> ", "accent") : "kiwi> ",
  });
  // EOF (Ctrl-D, or an injected stream that ends) closes the interface while
  // the last command is still being awaited; prompting a closed readline
  // throws ERR_USE_AFTER_CLOSE, so track it and skip the re-prompt.
  let rlClosed = false;
  rl.once("close", () => {
    rlClosed = true;
  });
  // 状态栏 + prompt 重绘（TTY-only；非 TTY 零额外字节）。
  const refreshPrompt = (): void => {
    if (rlClosed) return;
    if (theme.enabled) {
      output.write("\r\u001b[K");
      const state = controller.getState();
      const roleLabel = controller.profile.role === "buyer" ? "Buyer" : "Merchant";
      output.write(
        `${theme.statusBar([
          { text: `Kiwi ${roleLabel}`, color: "primary", bold: true },
          controller.profile.agent_id,
          { text: modeLabel(state.mode), color: modeColor(state.mode) },
          ...(state.paused ? [{ text: "已暂停", color: "warn" as const }] : []),
        ])}\n`,
      );
    }
    rl.prompt();
  };
  refreshPrompt();
  for await (const rawLine of rl) {
    const line = String(rawLine).trim();
    if (line !== "") {
      await handleLine(controller, line, write, theme);
    }
    if (controller.getState().shutdown) break;
    // After each command, surface newly arrived work (never auto-submits in
    // supervised/manual; prepare is a no-op while one candidate is pending).
    if (!controller.getState().paused && controller.getState().approval.kind === "idle") {
      const prepared = await controller.prepareNextCandidate();
      if (prepared.kind !== "no_work" && prepared.kind !== "blocked") {
        renderPrepare(controller, prepared, write, theme);
      }
    }
    if (!rlClosed) refreshPrompt();
  }
  rl.close();
  if (!controller.getState().shutdown) {
    await controller.shutdown();
  }
  return EXIT.OK;
}
