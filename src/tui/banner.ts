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
 * 启动横幅（参照 hermes banner.ts / hermes-hud neofetch）：box 字符
 * "K I W I" ASCII art + 水平渐变（蓝 → 青 → 白），纯函数。
 *
 * 渐变只对可见字符上色（空格直通）；每行独立起止，视觉上呈"呼吸感"色带。
 * mode="off" 时 kiwiBanner 返回空串（非 TTY 由 styles.banner 输出现状单行）。
 */

import { ESC, type ColorMode, rgb } from "./theme.js";

/** 6 行 × 23 列 figlet ASCII art（K I W I；逐行严格等宽，渐变/对齐无歧义）。 */
export const KIWI_ART: readonly string[] = [
  "K   K IIIII W   W IIIII",
  "K  K   I    W   W   I  ",
  "K K    I    W W W   I  ",
  "KK     I    W W W   I  ",
  "K  K   I    W W W   I  ",
  "K   K IIIII WW WW IIIII",
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

function stopColor(stops: readonly GradientStop[], t: number): string {
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

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace(/^#/, "");
  const parsed = Number.parseInt(value, 16);
  return [(parsed >> 16) & 0xff, (parsed >> 8) & 0xff, parsed & 0xff];
}

/** 逐字符水平渐变（空格不涂色）；每行独立起止。 */
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

/** 渐变 art（含尾换行）；mode=off 返回空串（由 styles.banner 决定非 TTY 形态）。 */
export function kiwiBanner(mode: ColorMode): string {
  if (mode === "off") return "";
  return `${KIWI_ART.map((line) => gradientText(line)).join("\n")}\n`;
}
