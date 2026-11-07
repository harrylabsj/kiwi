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
 * A2A 反滥用限流配置解析（自托管与云端共用，保持一处语义）。
 *
 * - 未设置 / "0" / "false" / "off" → 不限流（undefined）；
 * - "1" / "true" / "on" → 默认档位表（60s 窗口；匿名来源限额自动缩窄 0.5）；
 * - 其它 → 按 JSON 解析为 ThrottleOptions 覆盖。
 */
import type { ThrottleOptions } from "./server/throttle.js";

export function resolveA2aThrottle(
  raw = process.env.KIWI_A2A_THROTTLE ?? "",
): ThrottleOptions | undefined {
  const v = raw.trim();
  if (v === "" || v === "0" || v === "false" || v === "off") return undefined;
  if (v === "1" || v === "true" || v === "on") return {};
  try {
    const parsed = JSON.parse(v) as ThrottleOptions;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("ThrottleOptions 必须是对象");
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `KIWI_A2A_THROTTLE 非法: ${v}（可选 "1"/"true"/"on" 用默认档位，或 JSON ThrottleOptions）——${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
