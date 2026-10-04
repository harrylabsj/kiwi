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
 * ai-runtime 配置解析/校验（U6-4，A79）。
 *
 * 边界（对 A44 引导的硬承诺）：
 * - 默认关闭：不显式开启时本模块不生效，调用方维持现有确定性/规则路径。
 * - 云端凭据由用户自行配置：这里只接受 api_key_env（环境变量**名**），
 *   永不读取、输出或保存密钥值。
 * - WorkBuddy 前台默认模型**不会**自动透传到云端；本配置与前台模型选择
 *   是两层，接线侧不得把前台选择直接灌进这里。
 * - 货币成本不实现：现有 buildModel() 的 cost 全 0 不能当作真实费用 0，
 *   故只提供 token 预算；任何按钱计费的控制项都不在本模块声称落实。
 *
 * 来源：环境变量（KIWI_AI_RUNTIME_*）。不接共享 profile/schema（A79 所有权
 * 边界）；需要并入 profile 的接线改动只交接口建议给经理，由 ZCode 整合。
 */

export const AI_RUNTIME_ENV_PREFIX = "KIWI_AI_RUNTIME_";

const ENV_REF = /^[A-Z][A-Z0-9_]*$/;

/**
 * 允许真实 provider 的校验白名单（仅用于配置校验；装配仍走
 * src/runtime/model.ts 的 buildModel/realStreamFn，不在此重写 provider SDK）。
 * "fake" 仅供离线测试/冒烟，生产配置不得使用。
 */
export const AI_RUNTIME_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "google-vertex",
  "openrouter",
  "deepseek",
  "xai",
  "groq",
  "together",
  "mistral",
  "amazon-bedrock",
] as const;

export interface AiRuntimeTurnLimits {
  /** 单回合 provider 等待硬截止（毫秒）。 */
  deadline_ms: number;
  /** 单回合最大模型步数。 */
  max_steps: number;
  /** 单回合最大输出 token（预留额度用；>0）。 */
  max_output_tokens: number;
}

export interface AiRuntimeConcurrency {
  /** 全局同时在途 provider 调用上限。 */
  max_inflight_global: number;
  /** 单商家同时在途 provider 调用上限。 */
  max_inflight_per_merchant: number;
}

export interface AiRuntimeDailyBudget {
  /** 每自然日（UTC 或本地日，见 store 实现）累计输出+输入 token 上限。 */
  daily_token_limit: number;
}

export interface AiRuntimeConfig {
  enabled: boolean;
  provider: string;
  model: string;
  /** 环境变量名（非值）。 */
  api_key_env: string;
  api?: string;
  base_url?: string;
  thinking_level?: "minimal" | "low" | "medium" | "high";
  turn: AiRuntimeTurnLimits;
  concurrency: AiRuntimeConcurrency;
  budget: AiRuntimeDailyBudget | null;
}

export interface AiRuntimeConfigInput {
  enabled?: boolean;
  provider?: string;
  model?: string;
  api_key_env?: string;
  api?: string;
  base_url?: string;
  thinking_level?: string;
  deadline_ms?: number;
  max_steps?: number;
  max_output_tokens?: number;
  max_inflight_global?: number;
  max_inflight_per_merchant?: number;
  daily_token_limit?: number;
}

export type AiRuntimeConfigError =
  | { kind: "invalid_value"; field: string; reason: string }
  | { kind: "insecure_base_url"; field: "base_url" };

const INT_MAX = 2 ** 31 - 1;

function fail(field: string, reason: string): never {
  throw Object.assign(new Error(`ai-runtime ${field}: ${reason}`), {
    aiRuntimeError: { kind: "invalid_value", field, reason } satisfies AiRuntimeConfigError,
  });
}

function reqPositiveInt(value: number | undefined, field: string, def: number): number {
  if (value === undefined) return def;
  if (!Number.isSafeInteger(value) || value <= 0 || value > INT_MAX) {
    fail(field, `must be a positive safe integer ≤ ${INT_MAX}`);
  }
  return value;
}

function optionalPositiveInt(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0 || value > INT_MAX) {
    fail(field, `must be a positive safe integer ≤ ${INT_MAX}`);
  }
  return value;
}

function isLoopback(url: URL): boolean {
  const host = url.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/**
 * 解析并校验 ai-runtime 配置。fail-closed：非法值一律抛错（带结构化
 * aiRuntimeError），不静默回退。enabled=false 时其余字段可选且不做强校验
 * （缺省关闭路径不应因无关脏配置而炸）。
 */
export function parseAiRuntimeConfig(input: AiRuntimeConfigInput): AiRuntimeConfig {
  const enabled = input.enabled === true;

  if (!enabled) {
    return {
      enabled: false,
      provider: "",
      model: "",
      api_key_env: "",
      turn: {
        deadline_ms: reqPositiveInt(input.deadline_ms, "deadline_ms", 30_000),
        max_steps: reqPositiveInt(input.max_steps, "max_steps", 20),
        max_output_tokens: reqPositiveInt(input.max_output_tokens, "max_output_tokens", 8192),
      },
      concurrency: {
        max_inflight_global: reqPositiveInt(input.max_inflight_global, "max_inflight_global", 4),
        max_inflight_per_merchant: reqPositiveInt(
          input.max_inflight_per_merchant,
          "max_inflight_per_merchant",
          1,
        ),
      },
      budget: null,
    };
  }

  const provider = input.provider;
  if (typeof provider !== "string" || provider.length === 0) fail("provider", "is required when enabled");
  if (!(AI_RUNTIME_PROVIDERS as readonly string[]).includes(provider)) {
    fail("provider", `unknown provider "${provider}" (assembly not provided by ai-runtime)`);
  }

  const model = input.model;
  if (typeof model !== "string" || model.length === 0) fail("model", "is required when enabled");

  const apiKeyEnv = input.api_key_env;
  if (typeof apiKeyEnv !== "string" || !ENV_REF.test(apiKeyEnv)) {
    fail("api_key_env", "must name an environment variable (A-Z/0-9/_), value never stored");
  }

  let baseUrl: string | undefined;
  if (input.base_url !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(input.base_url);
    } catch {
      fail("base_url", "must be a valid URL");
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed))) {
      const err = Object.assign(new Error("ai-runtime base_url: cleartext http only allowed for loopback"), {
        aiRuntimeError: { kind: "insecure_base_url", field: "base_url" } satisfies AiRuntimeConfigError,
      });
      throw err;
    }
    baseUrl = input.base_url;
  }

  const thinking = input.thinking_level;
  if (thinking !== undefined && !["minimal", "low", "medium", "high"].includes(thinking)) {
    fail("thinking_level", 'must be one of "minimal" | "low" | "medium" | "high"');
  }

  const dailyLimit = optionalPositiveInt(input.daily_token_limit, "daily_token_limit") ?? null;

  const thinkingLevel = thinking as "minimal" | "low" | "medium" | "high" | undefined;

  return {
    enabled: true,
    provider,
    model,
    api_key_env: apiKeyEnv,
    api: input.api,
    base_url: baseUrl,
    thinking_level: thinkingLevel,
    turn: {
      deadline_ms: reqPositiveInt(input.deadline_ms, "deadline_ms", 30_000),
      max_steps: reqPositiveInt(input.max_steps, "max_steps", 20),
      max_output_tokens: reqPositiveInt(input.max_output_tokens, "max_output_tokens", 8192),
    },
    concurrency: {
      max_inflight_global: reqPositiveInt(input.max_inflight_global, "max_inflight_global", 4),
      max_inflight_per_merchant: reqPositiveInt(
        input.max_inflight_per_merchant,
        "max_inflight_per_merchant",
        1,
      ),
    },
    budget: dailyLimit === null ? null : { daily_token_limit: dailyLimit },
  };
}

/** 从 process.env 读取 KIWI_AI_RUNTIME_* 变量并解析（CLI/bootstrap 用）。 */
export function loadAiRuntimeConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): AiRuntimeConfig {
  const pick = (name: string): string | undefined => {
    const v = env[`${AI_RUNTIME_ENV_PREFIX}${name}`];
    return v === undefined || v === "" ? undefined : v;
  };
  const num = (name: string): number | undefined => {
    const raw = pick(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  return parseAiRuntimeConfig({
    enabled: pick("ENABLED") === "true" || pick("ENABLED") === "1",
    provider: pick("PROVIDER"),
    model: pick("MODEL"),
    api_key_env: pick("API_KEY_ENV"),
    api: pick("API"),
    base_url: pick("BASE_URL"),
    thinking_level: pick("THINKING_LEVEL"),
    deadline_ms: num("DEADLINE_MS"),
    max_steps: num("MAX_STEPS"),
    max_output_tokens: num("MAX_OUTPUT_TOKENS"),
    max_inflight_global: num("MAX_INFLIGHT_GLOBAL"),
    max_inflight_per_merchant: num("MAX_INFLIGHT_PER_MERCHANT"),
    daily_token_limit: num("DAILY_TOKEN_LIMIT"),
  });
}
