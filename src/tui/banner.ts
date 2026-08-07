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
 * 启动横幅（参照 hermes banner.py HERMES_AGENT_LOGO）：`██` box 字符
 * 大字 "K I W I"（figlet standard 几何，6 行 × 30 列）+ **逐行垂直渐变**
 * （每行一个颜色，蓝 → 青 → 白；hermes 的 logo 同为逐行变色）。纯函数。
 *
 * mode="off" 时 kiwiBanner 返回空串（非 TTY 由 styles.banner/welcome
 * 输出现状单行）。
 */

import { ESC, type ColorMode, hexToRgb, rgb } from "./theme.js";

/**
 * 6 行 × 30 列 box 字符 art（K I W I；figlet standard 几何：
 * K=7 / I=5 / W=7 列，字母间隔 2 列；逐行严格等宽）。
 */
export const KIWI_ART: readonly string[] = [
  "██   ██  █████  ██   ██  █████",
  "██  ██     █    ██   ██    █  ",
  "██ ██      █    ██ █ ██    █  ",
  "████       █    ██ █ ██    █  ",
  "██  ██     █    ██ █ ██    █  ",
  "██   ██  █████  ██████   █████",
];

/** 渐变停靠点：pos ∈ [0,1]，hex 为 24-bit 色。 */
export interface GradientStop {
  pos: number;
  hex: string;
}

export const KIWI_GRADIENT: readonly GradientStop[] = [
  { pos: 0.0, hex: "#4FC3F7" }, // 蓝
  { pos: 0.55, hex: "#00BCD4" }, // 青
  { pos: 1.0, hex: "#E0F7FA" }, // 近白
];

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** t ∈ [0,1] → 插值后的 hex 色。 */
export function stopColor(stops: readonly GradientStop[], t: number): string {
  if (t <= stops[0]!.pos) return stops[0]!.hex;
  for (let i = 1; i < stops.length; i++) {
    const hi = stops[i]!;
    if (t <= hi.pos) {
      const lo = stops[i - 1]!;
      const span = hi.pos - lo.pos;
      const k = span === 0 ? 0 : (t - lo.pos) / span;
      const a = hexToRgb(lo.hex);
      const b = hexToRgb(hi.hex);
      return `#${[lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")}`;
    }
  }
  return stops[stops.length - 1]!.hex;
}

/** 逐字符水平渐变（空格不涂色）；通用工具（logo 用逐行渐变，见 rowGradient）。 */
export function gradientText(
  text: string,
  stops: readonly GradientStop[] = KIWI_GRADIENT,
): string {
  const chars = [...text];
  const count = chars.length;
  let out = "";
  for (let i = 0; i < count; i++) {
    const ch = chars[i]!;
    if (ch === " ") {
      out += ch;
      continue;
    }
    const t = count <= 1 ? 0 : i / (count - 1);
    out += `${rgb(stopColor(stops, t))}${ch}${ESC}[0m`;
  }
  return out;
}

/**
 * 逐行垂直渐变（hermes logo 风格）：第 i 行取 t = i/(n-1) 的插值色，
 * 整行同色——比逐字符渐变更有"分层"感。
 */
export function rowGradient(
  lines: readonly string[],
  stops: readonly GradientStop[] = KIWI_GRADIENT,
): string {
  const count = lines.length;
  return lines
    .map((line, i) => {
      const t = count <= 1 ? 0 : i / (count - 1);
      return `${rgb(stopColor(stops, t))}${line}${ESC}[0m`;
    })
    .join("\n");
}

/** 渐变大字 art（含尾换行）；mode=off 返回空串（由 styles 决定非 TTY 形态）。 */
export function kiwiBanner(mode: ColorMode): string {
  if (mode === "off") return "";
  return `${rowGradient(KIWI_ART)}\n`;
}
