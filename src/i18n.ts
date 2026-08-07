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
 * 最小 i18n：自然语言报告（如 /negotiate 总结）跟随用户语言，不写死中文。
 *
 * 语言判定：
 *   1. `KIWI_LANG` 显式覆盖（zh / en）；
 *   2. 否则读 `LANG` / `LC_ALL`：`zh*` → 中文，其余 → 英文（缺省）。
 */

export type KiwiLocale = "zh" | "en";

export function detectLocale(): KiwiLocale {
  const explicit = process.env.KIWI_LANG?.trim().toLowerCase();
  if (explicit === "zh" || explicit === "zh-cn" || explicit === "zh_cn" || explicit === "zh-hans") {
    return "zh";
  }
  if (explicit === "en" || explicit === "en-us" || explicit === "en_us") {
    return "en";
  }
  const lang = (process.env.LANG ?? process.env.LC_ALL ?? "").toLowerCase();
  return lang.startsWith("zh") ? "zh" : "en";
}
