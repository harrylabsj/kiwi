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
 * TUI 主题原语（Neural Awakening，参照 hermes ui-tui theme.ts）——纯函数、
 * 零状态、零依赖。
 *
 * - PALETTE：深黑蓝底 + 蓝/青语义色（primary/accent/ok/warn/error/muted）；
 * - ColorMode 三档：off（非 TTY / NO_COLOR / TERM=dumb → 字节直通，测试与
 *   管道输出不变）、basic（16 色退化映射，老终端）、24bit（COLORTERM 或
 *   现代 TERM）；
 * - paint() 是唯一着色入口；visibleWidth() 用字符扫描剥离 ANSI 并计入 CJK
 *   双宽（**不用正则**——eslint no-control-regex 禁 ESC 字面量进正则）。
 */

/** ESC 转义前缀（字符串字面量，不进正则）。 */
export const ESC = "\u001b";

export const PALETTE = {
  bg: "#0A0E14", // 深黑蓝底
  primary: "#4FC3F7", // 蓝：a2a/discover/记忆/模式/角色
  accent: "#00BCD4", // 青：磋商/handoff/negotiate/prompt
  ok: "#81C784", // 绿：已发送/注册
  warn: "#FFD54F", // 黄：通知/建议
  error: "#EF5350", // 红：任务失败
  muted: "#8FA3BF", // 灰蓝：dim 文本/私有/系统记录/边框
  text: "#E6EDF3", // 主文本
} as const;

export type ColorKey = keyof typeof PALETTE;

export type ColorMode = "off" | "basic" | "24bit";

export interface PaintOpts {
  bold?: boolean;
  dim?: boolean;
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace(/^#/, "");
  const parsed = Number.parseInt(value, 16);
  if (value.length !== 6 || Number.isNaN(parsed)) {
    throw new TypeError(`invalid hex color: ${hex}`);
  }
  return [(parsed >> 16) & 0xff, (parsed >> 8) & 0xff, parsed & 0xff];
}

/** 24-bit 前景色 SGR：\x1b[38;2;R;G;Bm */
export function rgb(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${ESC}[38;2;${r};${g};${b}m`;
}

/** 16 色退化映射（basic 模式）：按语义色就近映射到标准前景色。 */
export function rgbFg256(color: ColorKey): string {
  const table: Record<ColorKey, number> = {
    bg: 40, // 黑底
    primary: 34, // 蓝
    accent: 36, // 青
    ok: 32, // 绿
    warn: 33, // 黄
    error: 31, // 红
    muted: 90, // 亮黑（灰）
    text: 37, // 白
  };
  return `${ESC}[${table[color]}m`;
}

/** 完整样式前缀（bold/dim 修饰 + 前景色 SGR，不含 reset）；off 返回空串。 */
export function sgr(mode: ColorMode, color: ColorKey, opts: PaintOpts = {}): string {
  if (mode === "off") return "";
  const prefix = mode === "24bit" ? rgb(PALETTE[color]) : rgbFg256(color);
  const style = `${opts.bold === true ? `${ESC}[1m` : ""}${opts.dim === true ? `${ESC}[2m` : ""}`;
  return `${style}${prefix}`;
}

/** 语义色 → 着色文本（sgr + reset）；off 模式直通原文。 */
export function paint(text: string, mode: ColorMode, color: ColorKey, opts: PaintOpts = {}): string {
  if (mode === "off") return text;
  return `${sgr(mode, color, opts)}${text}${ESC}[0m`;
}

/** CJK 宽字符区间（Unicode East Asian Wide/Fullwidth 主要区段，零依赖表）。 */
export function isWide(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/** 可见宽度：剥离 ANSI（本包产出的 CSI SGR 序列）后计数，CJK 记 2。 */
export function visibleWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === ESC) {
      // 跳过 \x1b[…m（仅本包产出的 SGR 序列；遇非 m 终止符保守按字符继续）
      const end = text.indexOf("m", i + 1);
      if (end !== -1) {
        i = end;
        continue;
      }
      continue;
    }
    width += isWide(ch) ? 2 : 1;
  }
  return width;
}

/**
 * 颜色模式判定：off = 非 TTY / NO_COLOR / TERM=dumb；24bit = COLORTERM 声明
 * truecolor/24bit，或 TERM 为现代终端（xterm/screen/tmux/kitty/alacritty/
 * wezterm）且不带 -256color 后缀；其余（WSL 老终端/cmd）basic 16 色退化。
 */
export function detectColorMode(env: Record<string, string | undefined>, outputIsTty: boolean): ColorMode {
  if (!outputIsTty) return "off";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "off";
  const term = env.TERM ?? "";
  if (term === "dumb") return "off";
  const colorTerm = env.COLORTERM ?? "";
  if (colorTerm === "truecolor" || colorTerm === "24bit") return "24bit";
  // tmux/kitty/alacritty/wezterm 原生透传 truecolor（tmux-256color 亦然）；
  // xterm/screen 只有不带 -256color 后缀才算现代（否则 16 色退化）。
  const truecolorTerminals = ["tmux", "kitty", "alacritty", "wezterm"];
  if (truecolorTerminals.some((name) => term.startsWith(name))) return "24bit";
  if (/^(xterm|screen)/.test(term) && !term.includes("-256color")) return "24bit";
  return "basic";
}
