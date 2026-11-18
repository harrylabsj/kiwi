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
 * TOP1-3 功能开关（设计 v1.1 §20.1 / D-M0-09 参数冻结：收尾决议 §1.2）。
 *
 * - `learning_enabled` / `memory_enabled` / `jobs_enabled` 默认 false，
 *   显式试点启用；关闭时不改变现有路径行为。
 * - `customer_delivery_enabled` P0 **固定关闭**：显式传 true 直接启动失败，
 *   不存在"P0 试开"路径（P1 另行验收，见 §16.3 / M6）。
 * - 严格解析：值只接受布尔（配置对象）或 "true"/"false"（环境变量）；
 *   未知字段、非法值一律抛错——非法配置启动失败，不静默回落。
 *   变化须递增 policy_version，不通过环境变量按请求临时切换。
 */

import { ContextGovernanceError } from "./types.js";

export const GOVERNANCE_FLAG_KEYS = [
  "learning_enabled",
  "memory_enabled",
  "jobs_enabled",
  "customer_delivery_enabled",
] as const;
export type GovernanceFlagKey = (typeof GOVERNANCE_FLAG_KEYS)[number];

export interface GovernanceFeatureFlags {
  readonly learning_enabled: boolean;
  readonly memory_enabled: boolean;
  readonly jobs_enabled: boolean;
  readonly customer_delivery_enabled: boolean;
}

export const GOVERNANCE_FLAGS_DEFAULT: Readonly<GovernanceFeatureFlags> = Object.freeze({
  learning_enabled: false,
  memory_enabled: false,
  jobs_enabled: false,
  customer_delivery_enabled: false,
});

export function assertFeatureEnabled(flags: GovernanceFeatureFlags, key: GovernanceFlagKey): void {
  if (flags[key] !== true) {
    throw new ContextGovernanceError(
      "unsupported_capability",
      `feature_disabled:${key}`,
      `功能 ${key} 未启用；保持现有路径行为`,
    );
  }
}

/**
 * 从配置对象严格解析开关。缺省键取默认 false；未知键、非布尔值抛错。
 */
export function parseGovernanceFeatureFlags(
  input: Record<string, unknown> | undefined,
): GovernanceFeatureFlags {
  const flags = { ...GOVERNANCE_FLAGS_DEFAULT };
  if (input !== undefined) {
    for (const [key, value] of Object.entries(input)) {
      if (!(GOVERNANCE_FLAG_KEYS as readonly string[]).includes(key)) {
        throw new ContextGovernanceError(
          "validation",
          `flag_unknown:${key}`,
          `未知功能开关 "${key}"（严格 schema，未知字段拒绝）`,
        );
      }
      if (typeof value !== "boolean") {
        throw new ContextGovernanceError(
          "validation",
          `flag_invalid:${key}`,
          `功能开关 ${key} 必须是布尔值，收到 ${typeof value}`,
        );
      }
      (flags as Record<GovernanceFlagKey, boolean>)[key as GovernanceFlagKey] = value;
    }
  }
  return Object.freeze(flags) as GovernanceFeatureFlags;
}

export const GOVERNANCE_FLAG_ENV_NAMES: Readonly<Record<GovernanceFlagKey, string>> =
  Object.freeze({
    learning_enabled: "KIWI_GOVERNANCE_LEARNING_ENABLED",
    memory_enabled: "KIWI_GOVERNANCE_MEMORY_ENABLED",
    jobs_enabled: "KIWI_GOVERNANCE_JOBS_ENABLED",
    customer_delivery_enabled: "KIWI_GOVERNANCE_CUSTOMER_DELIVERY_ENABLED",
  });

/** 从环境变量解析开关；非 "true"/"false" 的非空值一律抛错（启动失败）。 */
export function loadGovernanceFeatureFlagsFromEnv(
  env: Record<string, string | undefined> = process.env,
): GovernanceFeatureFlags {
  const input: Record<string, unknown> = {};
  for (const key of GOVERNANCE_FLAG_KEYS) {
    const raw = env[GOVERNANCE_FLAG_ENV_NAMES[key]];
    if (raw === undefined || raw.trim() === "") continue;
    if (raw !== "true" && raw !== "false") {
      throw new ContextGovernanceError(
        "validation",
        `flag_env_invalid:${GOVERNANCE_FLAG_ENV_NAMES[key]}`,
        `${GOVERNANCE_FLAG_ENV_NAMES[key]} 只接受 "true"/"false"，收到 "${raw}"`,
      );
    }
    input[key] = raw === "true";
  }
  return parseGovernanceFeatureFlags(input);
}
