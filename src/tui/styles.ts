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
 * TUI 语义样式层（Neural Awakening 主题）——chat-tui 与 operator-tui 的
 * 统一出口：decorate 行首语义前缀配色、box/panel 边框面板、segments 分段
 * 拼接、statusBar 状态栏、banner 启动横幅。
 *
 * 字节直通契约（非 TTY 回归的根基）：mode="off" 时 decorate/box/panel/
 * rule/segments/banner 的输出与升级前逐字节一致——既有 ~30 个 TUI 测试
 * 断言零改动保持绿。
 */

import { kiwiBanner } from "./banner.js";
import {
  detectColorMode,
  paint as paintRaw,
  sgr,
  visibleWidth,
  type ColorKey,
  type ColorMode,
  type PaintOpts,
} from "./theme.js";

/** 语义分段（segments/statusBar 的构件）。 */
export interface Seg {
  text: string;
  color?: ColorKey;
  bold?: boolean;
  dim?: boolean;
}

export interface BannerInput {
  roleLabel: string;
  id: string;
  tagline: string;
}

/** 欢迎面板输入（参照 hermes build_welcome_banner：logo + 带标题信息面板）。 */
export interface WelcomeInput extends BannerInput {
  versionLabel: string;
  commerceUrl: string;
  modelLabel: string;
  modeLabel: string;
  a2aOn: boolean;
  catalog?: string;
  commands: string;
}

/**
 * 剥离终端控制序列与 C0 控制字符（评审项 H7：TUI 渲染的未信任文本——网关
 * public_message、catalog 返回、对手消息——可能携带 ANSI/CR，直通终端可
 * 清屏/伪造审批行/覆盖输入行）。保留 \t 与 \n；对无控制字符的输入是恒等
 * 变换，因此不影响非 TTY 字节直通契约。
 *
 * 正则用动态构造（eslint no-control-regex 禁控制字符字面量进正则字面量，
 * 与 theme.ts visibleWidth 的同类约束一致）。
 */

/** 正则源码里表示 ESC（\x1b）控制字符的转义文本。 */
const ESC_PATTERN = "\\x1b";

/** 按序应用的剥离模式（每类终端控制序列 + C0 控制字符兜底）。 */
const CONTROL_PATTERNS: readonly RegExp[] = [
  // OSC（ESC ] … (BEL | ESC \)）：终端标题、剪贴板写等
  new RegExp(`${ESC_PATTERN}\\](?:[^\\x07${ESC_PATTERN}]|${ESC_PATTERN}(?=[^\\\\]))*(?:\\x07|${ESC_PATTERN}\\\\)`, "g"),
  // CSI（ESC [ 参数 中间字节 终字节）：SGR 颜色、光标移动、擦除、模式切换
  new RegExp(`${ESC_PATTERN}\\[[0-9;:?]*[ -/]*[@-~]`, "g"),
  // DCS/PM/APC（ESC P … ESC \）与 STS
  new RegExp(`${ESC_PATTERN}[PX^_][\\s\\S]*?${ESC_PATTERN}\\\\`, "g"),
  // 残留 ESC + 简单序列
  new RegExp(`${ESC_PATTERN}[0-9;]*[@-~]`, "g"),
];

/** C0 控制字符判定（保留 \t 与 \n；含 \r——防覆盖输入行）。 */
function isC0Control(code: number): boolean {
  return code !== 0x09 && code !== 0x0a && (code < 0x20 || code === 0x7f);
}

export function stripTerminalControls(value: string): string {
  let out = value;
  for (const pattern of CONTROL_PATTERNS) out = out.replace(pattern, "");
  // C0 兜底用码点扫描（控制字符不进正则字面量——eslint no-control-regex）。
  let result = "";
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    if (isC0Control(out.charCodeAt(i))) {
      result += out.slice(prev, i);
      prev = i + 1;
    }
  }
  result += out.slice(prev);
  return result;
}

/** 行首前缀配色表（按长度降序匹配——`[handoff-open]` 必须先于 `[handoff]`）。 */
const PREFIX_STYLES: ReadonlyArray<{ prefix: string; color: ColorKey; dim?: boolean; bold?: boolean }> = [
  { prefix: "[handoff-open]", color: "accent" },
  { prefix: "[handoff-launch]", color: "accent" },
  { prefix: "[系统记录]", color: "muted", dim: true },
  { prefix: "[negotiate]", color: "accent" },
  { prefix: "[discover]", color: "primary" },
  { prefix: "[handoff]", color: "accent" },
  { prefix: "[通知]", color: "warn" },
  { prefix: "[任务]", color: "error" },
  { prefix: "[磋商]", color: "accent" },
  { prefix: "[已发送]", color: "ok" },
  { prefix: "[记忆]", color: "primary" },
  { prefix: "[模式]", color: "primary" },
  { prefix: "[审批]", color: "accent" },
  { prefix: "[注册]", color: "ok" },
  { prefix: "[私有]", color: "muted", dim: true },
  { prefix: "[a2a]", color: "primary" },
];

const RESET = "\u001b[0m";

export interface Theme {
  readonly mode: ColorMode;
  readonly enabled: boolean;
  paint(text: string, color: ColorKey, opts?: PaintOpts): string;
  /** 行首语义前缀上色（多行逐行）；off 直通原文。 */
  decorate(text: string): string;
  /** 单线框（dim 边框，visibleWidth 对齐）；off → lines.join("\n") 无边框。 */
  box(lines: readonly string[]): string;
  /** box 或 legacy 形态：off 且 legacySeparator → `─`×56 + 内容（operator 现状复刻）。 */
  panel(lines: readonly string[], opts?: { legacySeparator?: boolean }): string;
  /** 分隔线；off → "─".repeat(width)。 */
  rule(width: number): string;
  /** 分段拼接（" · " 分隔）；off → 纯文本 join。 */
  segments(parts: ReadonlyArray<string | Seg>): string;
  /** 底部状态栏（chat/operator prompt 前重绘）；off → ""（不写任何字节）。 */
  statusBar(parts: ReadonlyArray<string | Seg>): string;
  /** 启动横幅；off → 升级前单行 banner 逐字节相同。 */
  banner(input: BannerInput): string;
  /**
   * 欢迎界面（hermes build_welcome_banner 结构）：大号渐变 logo + 带版本
   * 标题的信息面板（身份/会话/模型/运行时/命令）；off → 现状单行逐字节相同。
   */
  welcome(input: WelcomeInput): string;
}

export function createTheme(
  output: { isTTY?: boolean },
  override?: { color?: ColorMode },
): Theme {
  const mode: ColorMode = override?.color ?? detectColorMode(process.env, output.isTTY === true);
  const enabled = mode !== "off";

  const paint = (text: string, color: ColorKey, opts: PaintOpts = {}): string =>
    paintRaw(text, mode, color, opts);

  const decorate = (text: string): string => {
    const cleaned = stripTerminalControls(text);
    if (!enabled) return cleaned;
    return cleaned
      .split("\n")
      .map((line) => {
        for (const style of PREFIX_STYLES) {
          if (line.startsWith(style.prefix)) {
            return (
              paint(style.prefix, style.color, { bold: style.bold, dim: style.dim }) +
              line.slice(style.prefix.length)
            );
          }
        }
        if (line.startsWith("公开草稿:")) {
          return paint("公开草稿:", "primary", { bold: true }) + line.slice("公开草稿:".length);
        }
        if (line.startsWith("建议（")) {
          return paint(line, "warn");
        }
        return line;
      })
      .join("\n");
  };

  const borderStyle = (): string => sgr(mode, "muted", { dim: true });

  const box = (lines: readonly string[]): string => {
    const cleaned = lines.map((line) => stripTerminalControls(line));
    if (!enabled) return cleaned.join("\n");
    const width = Math.max(1, ...cleaned.map((line) => visibleWidth(line)));
    const border = borderStyle();
    const top = `${border}┌${"─".repeat(width + 2)}┐${RESET}`;
    const bottom = `${border}└${"─".repeat(width + 2)}┘${RESET}`;
    const rows = cleaned.map((line) => {
      const pad = " ".repeat(Math.max(0, width - visibleWidth(line)));
      return `${border}│${RESET} ${line}${pad} ${border}│${RESET}`;
    });
    return [top, ...rows, bottom].join("\n");
  };

  const panel = (lines: readonly string[], opts: { legacySeparator?: boolean } = {}): string => {
    const cleaned = lines.map((line) => stripTerminalControls(line));
    if (!enabled) {
      return opts.legacySeparator === true
        ? `${"─".repeat(56)}\n${cleaned.join("\n")}`
        : cleaned.join("\n");
    }
    return box(cleaned);
  };

  const rule = (width: number): string => {
    if (!enabled) return "─".repeat(width);
    return `${borderStyle()}${"─".repeat(width)}${RESET}`;
  };

  const segments = (parts: ReadonlyArray<string | Seg>): string =>
    parts
      .map((part) => {
        if (typeof part === "string") return stripTerminalControls(part);
        return paint(stripTerminalControls(part.text), part.color ?? "text", { bold: part.bold, dim: part.dim });
      })
      .join(" · ");

  const statusBar = (parts: ReadonlyArray<string | Seg>): string => {
    if (!enabled) return "";
    return segments(parts);
  };

  const banner = (input: BannerInput): string => {
    if (!enabled) {
      return stripTerminalControls(`Kiwi ${input.roleLabel} · ${input.id} · ${input.tagline}`);
    }
    const art = kiwiBanner(mode); // art 自带尾换行
    const info = segments([
      { text: `Kiwi ${input.roleLabel}`, color: "primary", bold: true },
      input.id,
      { text: input.tagline, color: "muted", dim: true },
    ]);
    return `${art}${info}`; // 末尾换行由调用方 write() 补
  };

  const welcome = (input: WelcomeInput): string => {
    if (!enabled) {
      return stripTerminalControls(`Kiwi ${input.roleLabel} · ${input.id} · ${input.tagline}`);
    }
    const lines = [
      `${paint(`Kiwi ${input.roleLabel}`, "primary", { bold: true })} · ${input.id}`,
      `${paint("会话:", "accent")} ${input.commerceUrl}`,
      `${paint("模型:", "accent")} ${input.modelLabel}`,
      `${paint("运行时:", "accent")} ${input.modeLabel} · ${
        input.a2aOn ? paint("A2A on", "ok") : paint("A2A off", "muted", { dim: true })
      }${input.catalog !== undefined ? ` · ${paint("catalog", "muted", { dim: true })} ${input.catalog}` : ""}`,
      "",
      `${paint("命令:", "accent", { bold: true })} ${input.commands}`,
    ];
    const innerWidth = Math.max(1, ...lines.map((line) => visibleWidth(line)));
    const border = borderStyle();
    // 带标题顶边：┌─ {version} ───…──┐（标题段计入内容宽，右段补齐）
    const titleText = ` ${input.versionLabel} `;
    // 顶边 = ┌ + ─ + title + ─×p + ┐：总宽须等于内容宽 + 2（与行一致）
    const pad = Math.max(0, innerWidth - visibleWidth(titleText) - 2);
    const top = `${border}┌─${RESET}${paint(titleText, "primary", { bold: true })}${border}${"─".repeat(pad + 1)}┐${RESET}`;
    const bottom = `${border}└${"─".repeat(innerWidth + 2)}┘${RESET}`;
    const rows = lines.map((line) => {
      const padInner = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
      return `${border}│${RESET} ${line}${padInner} ${border}│${RESET}`;
    });
    return `${kiwiBanner(mode)}\n${[top, ...rows, bottom].join("\n")}`; // 尾部换行由调用方 write() 补
  };

  return { mode, enabled, paint, decorate, box, panel, rule, segments, statusBar, banner, welcome };
}
