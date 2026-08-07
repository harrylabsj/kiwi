#!/usr/bin/env node
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
 * 组件版本兼容矩阵（product-strategy rev1.1 §13/§19 D3 —— 单一来源）。
 *
 * `kiwi x.y supports shopping-cli >= a.b < c`：矩阵在此定义，`kiwi doctor`
 * 与 `kiwi merchant publish` 共同消费（D3 验收：矩阵有单一来源配置并被
 * doctor 与 publish 共同使用）。
 */

export interface VersionRange {
  /** 支持的最低版本（含）。 */
  min: string;
  /** 支持的最高版本（不含）。 */
  maxExclusive: string;
}

/** Kiwi 0.6.0 支持的 shopping-cli 版本范围（数据引擎契约面）。 */
export const SHOPPING_CLI_COMPAT: VersionRange = {
  min: "2.0.0",
  maxExclusive: "3.0.0",
};

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * 从任意文本提取首个 x.y.z 版本号（容忍 "shopping.py 2.0.0"、"v2.0.0" 等前缀）。
 * 提取失败返回 null（fail-closed：无法判定版本 → 视为不兼容）。
 */
export function parseVersion(text: string): ParsedVersion | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** 语义化比较：a < b → -1；a == b → 0；a > b → 1。 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

/** 版本是否在 [min, maxExclusive) 内。parse 失败 → false（fail-closed）。 */
export function versionInRange(versionText: string, range: VersionRange): boolean {
  const version = parseVersion(versionText);
  const min = parseVersion(range.min);
  const max = parseVersion(range.maxExclusive);
  if (version === null || min === null || max === null) return false;
  return compareVersions(version, min) >= 0 && compareVersions(version, max) < 0;
}

/** 人类可读的支持范围描述（doctor/publish 错误信息共用）。 */
export function compatRangeText(range: VersionRange): string {
  return `>= ${range.min} < ${range.maxExclusive}`;
}
