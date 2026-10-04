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
 * ai-runtime 安全状态探测（U6-4，A79）。
 *
 * 只回答「配置是否齐 / 凭据是否存在 / 装配依赖是否可加载」三个纯本地问题，
 * **绝不发送任何 provider 请求**（连免费探测请求也不发——真实连接探测另需
 * 用户配置与费用授权，不在本模块）。
 *
 * 安全承诺：
 * - 返回值与任何日志/报告都不含密钥值，也不含不可信来源（动态 import 等）
 *   的异常原文——只输出固定原因码（AiRuntimeBlockReason）。
 * - env lookup 注入：调用方传 lookupEnv，测试用虚构键，测试不触真实环境。
 */

import type { AiRuntimeConfig } from "./config.js";
import type { DailyBudgetStore } from "./gate.js";

/** 固定拒绝原因码：供规则回退与日志使用，不含任何敏感细节。 */
export type AiRuntimeBlockReason =
  | "ai_runtime_disabled"
  | "invalid_config"
  | "missing_credential"
  | "assembly_unavailable"
  | "daily_budget_not_persisted"
  | "concurrency_limit"
  | "daily_budget_exhausted";

export type AiRuntimeStatus =
  | { state: "disabled" }
  | { state: "blocked"; reason: AiRuntimeBlockReason; detail: string }
  | { state: "ready"; provider: string; model: string };

export interface AiRuntimeProbeDeps {
  /** 环境变量查找（只查存在性，返回值仅用于 truthy 判断，永不记录）。 */
  lookupEnv: (name: string) => string | undefined;
  /**
   * 装配依赖可加载性检查（例如动态 import pi-agent-core/pi-ai 的封装）。
   * 不得在此构造 Model 或发起任何网络调用。异常被吞掉并映射为
   * assembly_unavailable，原文不外泄。
   */
  checkAssemblyLoadable?: () => Promise<boolean> | boolean;
  /**
   * 日预算持久化 store。配置了 daily_token_limit 时，此处缺失**或**
   * `persistent !== true`（内存实现的能力位为 false）状态均为
   * daily_budget_not_persisted——与 gate 的判定口径一致：内存累计重启
   * 即清零，不得对外声称生产日预算已落实。
   */
  budgetStore?: DailyBudgetStore;
}

/**
 * 探测 ai-runtime 当前可用状态。同步前置检查先行；仅在配置与凭据都齐时才
 * 调用 checkAssemblyLoadable（避免无谓加载模型 SDK）。
 */
export async function probeAiRuntimeStatus(
  config: AiRuntimeConfig,
  deps: AiRuntimeProbeDeps,
): Promise<AiRuntimeStatus> {
  if (!config.enabled) return { state: "disabled" };

  if (!deps.lookupEnv(config.api_key_env)) {
    return {
      state: "blocked",
      reason: "missing_credential",
      detail: `environment variable ${config.api_key_env} is not set (value never read)`,
    };
  }

  if (config.budget !== null && deps.budgetStore?.persistent !== true) {
    return {
      state: "blocked",
      reason: "daily_budget_not_persisted",
      detail:
        "daily_token_limit is set but no persistent DailyBudgetStore is wired; " +
        "in-memory-only budget resets on restart and must not be presented as enforced",
    };
  }

  if (deps.checkAssemblyLoadable) {
    let loadable = false;
    try {
      loadable = await deps.checkAssemblyLoadable();
    } catch {
      loadable = false;
    }
    if (!loadable) {
      return {
        state: "blocked",
        reason: "assembly_unavailable",
        detail: "model assembly dependencies failed to load in this runtime",
      };
    }
  }

  return { state: "ready", provider: config.provider, model: config.model };
}
