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
 * Agent profile loading and validation.
 *
 * Profiles are YAML. Secrets are NEVER stored in the profile: `token_env`
 * and `api_key_env` name environment variables that must be set. Loading a
 * profile never resolves or logs secret values; resolution happens lazily
 * at the point of use via `resolveSecret()`.
 *
 * Validation is fail-closed: unknown fields are rejected, numbers must be
 * finite, runtime limits have hard upper bounds, and cleartext HTTP base
 * URLs are only accepted for loopback hosts.
 */

import { chmodSync, readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { PROTOCOL_VERSION, type Role } from "../negotiation/types.js";

export const RUNTIME_VERSION = "0.6.0";

export interface MerchantPolicy {
  /** 全局默认私有价格下限（major 元；SKU 未在 price_floors 列出的兜底）。 */
  min_unit_price_private?: number;
  /** per-SKU 私有价格下限（major 元）：`{ sku: floor }`，覆盖全局默认。 */
  price_floors?: Record<string, number>;
  /** 全局默认自动折扣上限（%）；SKU 未在 sku_max_discount_percent 列出的兜底。 */
  max_auto_discount_percent?: number;
  /** per-SKU 自动折扣上限（%）：`{ sku: pct }`，覆盖全局默认。 */
  sku_max_discount_percent?: Record<string, number>;
  /** per-SKU 促销（可配置，非硬编码）：`{ sku: { bulk_threshold, bulk_discount_percent } }`。
   *  买家数量 ≥ bulk_threshold 时，成交价 = max(floor, min(还价, list×(1-d%/100)))。 */
  promos?: Record<string, { bulk_threshold?: number; bulk_discount_percent?: number }>;
  inventory_source?: string;
  quote_ttl_seconds?: number;
  auto_negotiate?: boolean;
  human_review_on?: string[];
}

/** merchant 推理后端形态（DeepSeek Harness 运行时插件，§6.9）。 */
export type DecisionBackendKind = "deterministic" | "mock" | "deepseek";

export interface MerchantDecisionConfig {
  backend: DecisionBackendKind;
  /** 缺省 true；false 时禁用后端（回落确定性）。 */
  enabled?: boolean;
}

/** Optional Merchant Experience layer inspired by commerce-agents. */
export interface MerchantExperienceConfig {
  /** Feature gate; omitted/false preserves the 0.7.x tool surface. */
  enabled?: boolean;
  /** Deterministic merchant snapshot/series/digest tools. */
  intelligence?: boolean;
  /** First-read rules for questions that require current backend facts. */
  grounding?: boolean;
  /** Structured host-facing presentation tools. */
  presentation?: boolean;
  /** Packaged, versioned merchant workflow skills. */
  skills?: boolean;
  /** Hard cap for model-visible external content. */
  max_external_context_chars?: number;
  /** Hard cap for one presentation collection. */
  max_presentation_items?: number;
  /** Optional provider prompt-cache retention; omitted preserves provider defaults. */
  prompt_cache_retention?: "none" | "short" | "long";
}

/**
 * Buyer private policy (design §7.2). All fields are required: the local
 * private-policy gate is a security boundary, so a half-specified policy
 * fails closed at load time instead of silently disabling checks.
 *
 * PRIVATE: max_total_price_private never leaves this process — it is not
 * sent to the gateway, not logged, and not shown to the counterpart.
 */
export interface BuyerPolicy {
  target_skus: string[];
  quantity: number;
  max_total_price_private: number;
  /** RFC 3339 date-time with an explicit timezone offset (or Z). */
  acceptable_eta_latest: string;
  required_after_sales_terms: string[];
  auto_negotiate: boolean;
  human_review_on: string[];
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export type ProfileThinkingLevel = (typeof THINKING_LEVELS)[number];

/** API ids supported by the pinned pi-ai 0.83.0 (its KnownApi union). */
export const SUPPORTED_MODEL_APIS: readonly string[] = [
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "pi-messages",
];

/**
 * Commerce credential scopes (design §15.4). Credentials are held separately
 * by scope; the model only ever sees tools, never tokens. When a scope has no
 * credential configured, the corresponding write tools fail closed.
 */
export const COMMERCE_CREDENTIAL_SCOPES = ["negotiation", "catalog", "inventory"] as const;
export type CommerceCredentialScope = (typeof COMMERCE_CREDENTIAL_SCOPES)[number];

export interface AgentProfile {
  runtime_version: string;
  protocol_version: string;
  agent_id: string;
  /** 显示名（可选）——TUI/沟通用名字而非 agent_id（如商家 Veyquo）。 */
  name?: string;
  role: Role;
  owner_id: string;
  commerce: {
    base_url: string;
    /** Name of the env var holding the commerce API token (negotiation scope). */
    token_env: string;
    backend: "local_marketplace" | "external_platform";
    /**
     * Optional per-scope token env refs. `token_env` remains the primary
     * negotiation credential; catalog/inventory tokens must be configured
     * separately or the corresponding merchant write tools fail closed.
     */
    credentials?: Partial<Record<CommerceCredentialScope, { token_env: string }>>;
    /** 商品源故障时是否回退内置演示价（fail-open）；缺省 false = fail-closed。 */
    allow_demo_price_fallback?: boolean;
  };
  model: {
    provider: string;
    model: string;
    /** Name of the env var holding the model API key. */
    api_key_env?: string;
    /** Optional API id override (e.g. "openai-completions"). */
    api?: string;
    /** Optional base URL override for OpenAI-compatible endpoints. */
    base_url?: string;
    thinking_level?: ProfileThinkingLevel;
  };
  runtime: {
    mode: "once" | "foreground";
    poll_interval_seconds: number;
    turn_timeout_seconds: number;
    max_model_steps: number;
    max_retries: number;
  };
  merchant_policy?: MerchantPolicy;
  buyer_policy?: BuyerPolicy;
  /** merchant 推理后端配置（DeepSeek Harness 运行时插件；仅 role=merchant）。 */
  decision?: MerchantDecisionConfig;
  /** Optional commerce-agents-style merchant application layer. */
  merchant_experience?: MerchantExperienceConfig;
  /** 微信远程控制通道（可选段；缺省 = 全默认）。 */
  weixin?: {
    /** 额外授权微信用户（配对扫描者始终自动授权；缺省 = 仅配对者）。 */
    allow_users?: string[];
    /** iLink base URL 覆盖（可选；必须 https 或 loopback）。 */
    base_url?: string;
  };
  /**
   * 商家公网暴露与发布配置（`kiwi merchant init` 引导写入；setup-public / start /
   * publish 据此无参运行）。secret 不写 profile——merchant_token_env 只存环境变量名。
   */
  merchant_public?: {
    /** 公网 A2A 域名（→ KIWI_A2A_PUBLIC_URL）。 */
    public_url?: string;
    /** A2A 节点端口（→ KIWI_A2A_PORT；缺省 9000）。 */
    a2a_port?: number;
    /** shopping-cli 商品库路径（→ SHOPPING_DB_PATH）。 */
    shopping_db_path?: string;
    /** catalog base URL（→ KIWI_CATALOG_URL；缺省官方）。 */
    catalog_url?: string;
    /** 商家 token 环境变量名（值不写 profile）。 */
    merchant_token_env?: string;
  };
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

const REQUIRED_ENV_REF = /^[A-Z][A-Z0-9_]*$/;

/** Hard upper bounds for runtime limits. */
export const RUNTIME_LIMITS = {
  max_model_steps: 20,
  max_retries: 5,
  turn_timeout_seconds: 3600,
  poll_interval_seconds: 3600,
} as const;

const TOP_LEVEL_KEYS = [
  "runtime_version",
  "protocol_version",
  "agent_id",
  "name",
  "role",
  "owner_id",
  "commerce",
  "model",
  "runtime",
  "merchant_policy",
  "buyer_policy",
  "weixin",
  "decision",
  "merchant_experience",
  "merchant_public",
] as const;
/** weixin 段白名单（微信远程控制通道配置；无 *_env 密钥字段——iLink 凭证运行时获取）。 */
const WEIXIN_KEYS = ["allow_users", "base_url"] as const;
const COMMERCE_KEYS = ["base_url", "token_env", "backend", "credentials", "allow_demo_price_fallback"] as const;
const MODEL_KEYS = [
  "provider",
  "model",
  "api_key_env",
  "api",
  "base_url",
  "thinking_level",
] as const;
const RUNTIME_KEYS = [
  "mode",
  "poll_interval_seconds",
  "turn_timeout_seconds",
  "max_model_steps",
  "max_retries",
] as const;
const MERCHANT_POLICY_KEYS = [
  "min_unit_price_private",
  "price_floors",
  "max_auto_discount_percent",
  "sku_max_discount_percent",
  "promos",
  "inventory_source",
  "quote_ttl_seconds",
  "auto_negotiate",
  "human_review_on",
] as const;
const PROMO_KEYS = ["bulk_threshold", "bulk_discount_percent"] as const;
const BUYER_POLICY_KEYS = [
  "target_skus",
  "quantity",
  "max_total_price_private",
  "acceptable_eta_latest",
  "required_after_sales_terms",
  "auto_negotiate",
  "human_review_on",
] as const;
const DECISION_KEYS = ["backend", "enabled"] as const;
const MERCHANT_EXPERIENCE_KEYS = [
  "enabled",
  "intelligence",
  "grounding",
  "presentation",
  "skills",
  "max_external_context_chars",
  "max_presentation_items",
  "prompt_cache_retention",
] as const;
const MERCHANT_PUBLIC_KEYS = ["public_url", "a2a_port", "shopping_db_path", "catalog_url", "merchant_token_env"] as const;
const DECISION_BACKENDS: readonly DecisionBackendKind[] = ["deterministic", "mock", "deepseek"];

/** RFC 3339 date-time with an explicit timezone (offset or Z); naive times fail closed. */
const RFC3339_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Validate an RFC 3339 timestamp that must carry a timezone. */
export function isRfc3339WithTimezone(value: unknown): value is string {
  return typeof value === "string" && RFC3339_TZ.test(value) && !Number.isNaN(Date.parse(value));
}

/** Hosts allowed to use cleartext HTTP. Everything else requires HTTPS. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function req(cond: boolean, message: string): asserts cond {
  if (!cond) throw new ProfileError(message);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  section: string,
  source: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ProfileError(`${source}: ${section} has unknown field "${key}"`);
    }
  }
}

function reqFinite(value: unknown, field: string, source: string): asserts value is number {
  req(
    typeof value === "number" && Number.isFinite(value),
    `${source}: ${field} must be a finite number (NaN/Infinity are not allowed)`,
  );
}

/**
 * Validate a base URL: http(s) only, no embedded credentials, and cleartext
 * HTTP only for loopback hosts (localhost / 127.0.0.1 / ::1).
 */
export function assertSecureBaseUrl(value: unknown, field: string, source: string): string {
  req(typeof value === "string" && value.length > 0, `${source}: ${field} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProfileError(`${source}: ${field} must be a valid URL`);
  }
  req(
    url.protocol === "https:" || url.protocol === "http:",
    `${source}: ${field} must use http or https (got ${url.protocol})`,
  );
  req(
    url.username === "" && url.password === "",
    `${source}: ${field} must not embed credentials (userinfo)`,
  );
  if (url.protocol === "http:") {
    req(
      LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase()),
      `${source}: ${field} uses cleartext HTTP; only loopback hosts (localhost, 127.0.0.1, ::1) may use HTTP — use HTTPS for remote hosts`,
    );
  }
  return value;
}

/** Load, parse and validate a profile file. Never reads secret env values. */
export function loadProfile(path: string): AgentProfile {
  // 权限检查（评审项 L5 / 审查 K-L16）：profile 含私有策略值（max_total_price_private
  // 等）——与数据目录 0700/0600 约定对齐。过宽权限此前仅 console.warn（0644 即被
  // 同机其他用户读取）；best-effort 收紧为 0600，不可写场景回退告警。
  try {
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0) {
      try {
        chmodSync(path, 0o600);
        console.warn(
          `[profile] ${path} was group/world-readable (mode ${(st.mode & 0o777).toString(8)}); ` +
            "tightened to 0600",
        );
      } catch {
        console.warn(
          `[profile] ${path} is group/world-readable (mode ${(st.mode & 0o777).toString(8)}); ` +
            "consider chmod 600 (contains private policy values)",
        );
      }
    }
  } catch {
    // stat 失败由下方 readFileSync 的清晰错误兜底。
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new ProfileError(
      `Cannot read profile ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new ProfileError(
      `Invalid YAML in ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateProfile(data, path);
}

export function validateProfile(data: unknown, source: string): AgentProfile {
  req(isObject(data), `${source}: profile must be a YAML mapping`);
  const p = data;

  // runtime_version 是"生成该 profile 的运行时版本"：只做格式校验，不 gate
  // 精确相等（版本单源评审项：RUNTIME_VERSION 升级不应让全部既有 profile
  // 失效——0.5.0 的 profile 在新代码上必须继续可加载）。
  req(
    typeof p.runtime_version === "string" && /^\d+\.\d+\.\d+$/.test(p.runtime_version),
    `${source}: runtime_version must be a semantic version like ${RUNTIME_VERSION}`,
  );
  req(
    p.protocol_version === PROTOCOL_VERSION,
    `${source}: protocol_version must be ${PROTOCOL_VERSION}`,
  );
  req(typeof p.agent_id === "string" && p.agent_id.length > 0, `${source}: agent_id is required`);
  req(p.role === "buyer" || p.role === "merchant", `${source}: role must be buyer or merchant`);
  req(typeof p.owner_id === "string" && p.owner_id.length > 0, `${source}: owner_id is required`);

  req(isObject(p.commerce), `${source}: commerce section is required`);
  const commerce = p.commerce;
  const commerceBaseUrl = assertSecureBaseUrl(commerce.base_url, "commerce.base_url", source);
  req(
    typeof commerce.token_env === "string" && REQUIRED_ENV_REF.test(commerce.token_env),
    `${source}: commerce.token_env must name an environment variable (e.g. SHOPPING_AGENT_TOKEN); secrets must not be written into the profile`,
  );
  req(
    commerce.backend === "local_marketplace" || commerce.backend === "external_platform",
    `${source}: commerce.backend must be local_marketplace or external_platform`,
  );
  // Optional per-scope credential env refs (§15.4). Fail closed on unknown
  // scopes, missing token_env, or inline secret values — just like token_env.
  let credentials: AgentProfile["commerce"]["credentials"];
  if (commerce.credentials !== undefined) {
    req(isObject(commerce.credentials), `${source}: commerce.credentials must be a mapping`);
    for (const scope of Object.keys(commerce.credentials)) {
      req(
        (COMMERCE_CREDENTIAL_SCOPES as readonly string[]).includes(scope),
        `${source}: commerce.credentials has unknown scope "${scope}" (expected ${COMMERCE_CREDENTIAL_SCOPES.join("/")})`,
      );
      const entry = (commerce.credentials as Record<string, unknown>)[scope] as Record<string, unknown>;
      req(isObject(entry), `${source}: commerce.credentials.${scope} must be a mapping`);
      req(
        typeof entry.token_env === "string" && REQUIRED_ENV_REF.test(entry.token_env),
        `${source}: commerce.credentials.${scope}.token_env must name an environment variable`,
      );
      req(
        Object.keys(entry).length === 1,
        `${source}: commerce.credentials.${scope} only supports token_env`,
      );
    }
    credentials = Object.fromEntries(
      COMMERCE_CREDENTIAL_SCOPES.map((scope) => {
        const entry = (commerce.credentials as Record<string, unknown>)[scope];
        return entry === undefined ? [] : [scope, { token_env: (entry as { token_env: string }).token_env }];
      }).filter((pair) => pair.length > 0),
    ) as AgentProfile["commerce"]["credentials"];
  }
  // 商品源故障回退演示价开关（可选布尔；缺省 fail-closed）。
  const allowDemoPriceFallback = commerce.allow_demo_price_fallback;
  if (allowDemoPriceFallback !== undefined) {
    req(
      typeof allowDemoPriceFallback === "boolean",
      `${source}: commerce.allow_demo_price_fallback must be a boolean`,
    );
  }
  rejectUnknownKeys(commerce, COMMERCE_KEYS, "commerce", source);

  req(isObject(p.model), `${source}: model section is required`);
  const model = p.model;
  req(
    typeof model.provider === "string" && model.provider.length > 0,
    `${source}: model.provider is required`,
  );
  req(
    typeof model.model === "string" && model.model.length > 0,
    `${source}: model.model is required`,
  );
  if (model.api_key_env !== undefined) {
    req(
      typeof model.api_key_env === "string" && REQUIRED_ENV_REF.test(model.api_key_env),
      `${source}: model.api_key_env must name an environment variable`,
    );
  }
  if (model.api !== undefined) {
    req(
      typeof model.api === "string" && SUPPORTED_MODEL_APIS.includes(model.api),
      `${source}: model.api must be one of: ${SUPPORTED_MODEL_APIS.join(", ")}`,
    );
  }
  let modelBaseUrl: string | undefined;
  if (model.base_url !== undefined) {
    modelBaseUrl = assertSecureBaseUrl(model.base_url, "model.base_url", source);
  }
  if (model.thinking_level !== undefined) {
    req(
      typeof model.thinking_level === "string" &&
        (THINKING_LEVELS as readonly string[]).includes(model.thinking_level),
      `${source}: model.thinking_level must be one of: ${THINKING_LEVELS.join(", ")}`,
    );
  }
  rejectUnknownKeys(model, MODEL_KEYS, "model", source);

  req(isObject(p.runtime), `${source}: runtime section is required`);
  const runtime = p.runtime;
  req(
    runtime.mode === "once" || runtime.mode === "foreground",
    `${source}: runtime.mode must be once or foreground`,
  );
  reqFinite(runtime.poll_interval_seconds, "runtime.poll_interval_seconds", source);
  req(
    runtime.poll_interval_seconds > 0 &&
      runtime.poll_interval_seconds <= RUNTIME_LIMITS.poll_interval_seconds,
    `${source}: runtime.poll_interval_seconds must be > 0 and <= ${RUNTIME_LIMITS.poll_interval_seconds}`,
  );
  reqFinite(runtime.turn_timeout_seconds, "runtime.turn_timeout_seconds", source);
  req(
    runtime.turn_timeout_seconds > 0 &&
      runtime.turn_timeout_seconds <= RUNTIME_LIMITS.turn_timeout_seconds,
    `${source}: runtime.turn_timeout_seconds must be > 0 and <= ${RUNTIME_LIMITS.turn_timeout_seconds}`,
  );
  req(
    Number.isInteger(runtime.max_model_steps) && (runtime.max_model_steps as number) >= 1,
    `${source}: runtime.max_model_steps must be an integer >= 1`,
  );
  req(
    (runtime.max_model_steps as number) <= RUNTIME_LIMITS.max_model_steps,
    `${source}: runtime.max_model_steps must be <= ${RUNTIME_LIMITS.max_model_steps}`,
  );
  req(
    Number.isInteger(runtime.max_retries) && (runtime.max_retries as number) >= 0,
    `${source}: runtime.max_retries must be an integer >= 0`,
  );
  req(
    (runtime.max_retries as number) <= RUNTIME_LIMITS.max_retries,
    `${source}: runtime.max_retries must be <= ${RUNTIME_LIMITS.max_retries}`,
  );
  rejectUnknownKeys(runtime, RUNTIME_KEYS, "runtime", source);

  let merchantPolicy: MerchantPolicy | undefined;
  if (p.merchant_policy !== undefined) {
    req(isObject(p.merchant_policy), `${source}: merchant_policy must be a mapping`);
    const mp = p.merchant_policy;
    rejectUnknownKeys(mp, MERCHANT_POLICY_KEYS, "merchant_policy", source);
    if (mp.min_unit_price_private !== undefined) {
      reqFinite(mp.min_unit_price_private, "merchant_policy.min_unit_price_private", source);
      req(
        mp.min_unit_price_private >= 0,
        `${source}: merchant_policy.min_unit_price_private must be >= 0`,
      );
    }
    if (mp.max_auto_discount_percent !== undefined) {
      reqFinite(mp.max_auto_discount_percent, "merchant_policy.max_auto_discount_percent", source);
      req(
        mp.max_auto_discount_percent >= 0 && mp.max_auto_discount_percent <= 100,
        `${source}: merchant_policy.max_auto_discount_percent must be between 0 and 100`,
      );
    }
    if (mp.inventory_source !== undefined) {
      req(
        typeof mp.inventory_source === "string" && mp.inventory_source.length > 0,
        `${source}: merchant_policy.inventory_source must be a non-empty string`,
      );
    }
    if (mp.quote_ttl_seconds !== undefined) {
      reqFinite(mp.quote_ttl_seconds, "merchant_policy.quote_ttl_seconds", source);
      req(mp.quote_ttl_seconds > 0, `${source}: merchant_policy.quote_ttl_seconds must be > 0`);
    }
    if (mp.auto_negotiate !== undefined) {
      req(
        typeof mp.auto_negotiate === "boolean",
        `${source}: merchant_policy.auto_negotiate must be a boolean`,
      );
    }
    if (mp.human_review_on !== undefined) {
      req(
        Array.isArray(mp.human_review_on) &&
          mp.human_review_on.every((c) => typeof c === "string" && c.length > 0),
        `${source}: merchant_policy.human_review_on must be a list of non-empty strings`,
      );
    }
    // per-SKU floor / discount：`{ sku: number }`，键非空字符串，值有限且合理。
    if (mp.price_floors !== undefined) {
      req(isObject(mp.price_floors), `${source}: merchant_policy.price_floors must be a mapping`);
      for (const [sku, floor] of Object.entries(mp.price_floors)) {
        req(sku.length > 0, `${source}: merchant_policy.price_floors key must be a non-empty string`);
        reqFinite(floor, `merchant_policy.price_floors.${sku}`, source);
        req(floor >= 0, `${source}: merchant_policy.price_floors.${sku} must be >= 0`);
      }
    }
    if (mp.sku_max_discount_percent !== undefined) {
      req(
        isObject(mp.sku_max_discount_percent),
        `${source}: merchant_policy.sku_max_discount_percent must be a mapping`,
      );
      for (const [sku, pct] of Object.entries(mp.sku_max_discount_percent)) {
        req(sku.length > 0, `${source}: merchant_policy.sku_max_discount_percent key must be a non-empty string`);
        reqFinite(pct, `merchant_policy.sku_max_discount_percent.${sku}`, source);
        req(pct >= 0 && pct <= 100, `${source}: merchant_policy.sku_max_discount_percent.${sku} must be between 0 and 100`);
      }
    }
    if (mp.promos !== undefined) {
      req(isObject(mp.promos), `${source}: merchant_policy.promos must be a mapping`);
      for (const [sku, promo] of Object.entries(mp.promos)) {
        req(sku.length > 0, `${source}: merchant_policy.promos key must be a non-empty string`);
        req(isObject(promo), `${source}: merchant_policy.promos.${sku} must be a mapping`);
        rejectUnknownKeys(promo as Record<string, unknown>, PROMO_KEYS, `merchant_policy.promos.${sku}`, source);
        const p = promo as Record<string, unknown>;
        if (p.bulk_threshold !== undefined) {
          reqFinite(p.bulk_threshold, `merchant_policy.promos.${sku}.bulk_threshold`, source);
          req(Number.isInteger(p.bulk_threshold) && (p.bulk_threshold as number) >= 1,
            `${source}: merchant_policy.promos.${sku}.bulk_threshold must be a positive integer`);
        }
        if (p.bulk_discount_percent !== undefined) {
          reqFinite(p.bulk_discount_percent, `merchant_policy.promos.${sku}.bulk_discount_percent`, source);
          req((p.bulk_discount_percent as number) >= 0 && (p.bulk_discount_percent as number) <= 100,
            `${source}: merchant_policy.promos.${sku}.bulk_discount_percent must be between 0 and 100`);
        }
      }
    }
    merchantPolicy = { ...mp } as MerchantPolicy;
  }

  let decisionSection: MerchantDecisionConfig | undefined;
  if (p.decision !== undefined) {
    req(isObject(p.decision), `${source}: decision must be a mapping`);
    const d = p.decision;
    rejectUnknownKeys(d, DECISION_KEYS, "decision", source);
    req(
      (DECISION_BACKENDS as readonly string[]).includes(d.backend as string),
      `${source}: decision.backend must be one of: ${DECISION_BACKENDS.join(", ")}`,
    );
    if (d.enabled !== undefined) {
      req(typeof d.enabled === "boolean", `${source}: decision.enabled must be a boolean`);
    }
    // merchant-only 概念：buyer 配置 decision → fail-closed。
    if (p.role !== "merchant") {
      req(false, `${source}: decision is only valid for role=merchant`);
    }
    // deepseek 后端需要 model.api_key_env（只存 env 名，永不存密钥）。
    if (d.backend === "deepseek" && d.enabled !== false) {
      req(
        typeof model.api_key_env === "string" && REQUIRED_ENV_REF.test(model.api_key_env),
        `${source}: decision.backend=deepseek requires model.api_key_env`,
      );
    }
    decisionSection = { backend: d.backend as DecisionBackendKind, ...(d.enabled !== undefined ? { enabled: d.enabled } : {}) };
  }

  let merchantExperience: MerchantExperienceConfig | undefined;
  if (p.merchant_experience !== undefined) {
    req(isObject(p.merchant_experience), `${source}: merchant_experience must be a mapping`);
    const experience = p.merchant_experience;
    rejectUnknownKeys(experience, MERCHANT_EXPERIENCE_KEYS, "merchant_experience", source);
    for (const key of ["enabled", "intelligence", "grounding", "presentation", "skills"] as const) {
      if (experience[key] !== undefined) {
        req(typeof experience[key] === "boolean", `${source}: merchant_experience.${key} must be a boolean`);
      }
    }
    if (experience.max_external_context_chars !== undefined) {
      reqFinite(experience.max_external_context_chars, "merchant_experience.max_external_context_chars", source);
      req(
        experience.max_external_context_chars >= 1_000 && experience.max_external_context_chars <= 50_000,
        `${source}: merchant_experience.max_external_context_chars must be between 1000 and 50000`,
      );
    }
    if (experience.max_presentation_items !== undefined) {
      reqFinite(experience.max_presentation_items, "merchant_experience.max_presentation_items", source);
      req(
        Number.isInteger(experience.max_presentation_items) &&
          experience.max_presentation_items >= 1 &&
          experience.max_presentation_items <= 50,
        `${source}: merchant_experience.max_presentation_items must be an integer between 1 and 50`,
      );
    }
    if (experience.prompt_cache_retention !== undefined) {
      req(
        experience.prompt_cache_retention === "none" ||
          experience.prompt_cache_retention === "short" ||
          experience.prompt_cache_retention === "long",
        `${source}: merchant_experience.prompt_cache_retention must be none, short or long`,
      );
    }
    if (p.role !== "merchant") {
      throw new ProfileError(`${source}: merchant_experience is only valid for role=merchant`);
    }
    const experienceBoolean = (key: "enabled" | "intelligence" | "grounding" | "presentation" | "skills"): boolean | undefined =>
      experience[key] === undefined ? undefined : (experience[key] as boolean);
    merchantExperience = {
      ...(experienceBoolean("enabled") !== undefined ? { enabled: experienceBoolean("enabled") } : {}),
      ...(experienceBoolean("intelligence") !== undefined ? { intelligence: experienceBoolean("intelligence") } : {}),
      ...(experienceBoolean("grounding") !== undefined ? { grounding: experienceBoolean("grounding") } : {}),
      ...(experienceBoolean("presentation") !== undefined ? { presentation: experienceBoolean("presentation") } : {}),
      ...(experienceBoolean("skills") !== undefined ? { skills: experienceBoolean("skills") } : {}),
      ...(experience.max_external_context_chars !== undefined
        ? { max_external_context_chars: experience.max_external_context_chars }
        : {}),
      ...(experience.max_presentation_items !== undefined
        ? { max_presentation_items: experience.max_presentation_items }
        : {}),
      ...(experience.prompt_cache_retention !== undefined
        ? { prompt_cache_retention: experience.prompt_cache_retention }
        : {}),
    };
  }

  let merchantPublic: AgentProfile["merchant_public"] | undefined;
  if (p.merchant_public !== undefined) {
    req(isObject(p.merchant_public), `${source}: merchant_public must be a mapping`);
    const mp = p.merchant_public;
    rejectUnknownKeys(mp, MERCHANT_PUBLIC_KEYS, "merchant_public", source);
    if (mp.public_url !== undefined) {
      req(typeof mp.public_url === "string" && mp.public_url.trim() !== "", `${source}: merchant_public.public_url must be a non-empty string`);
    }
    if (mp.a2a_port !== undefined) {
      req(Number.isInteger(mp.a2a_port) && Number(mp.a2a_port) > 0, `${source}: merchant_public.a2a_port must be a positive integer`);
    }
    if (mp.shopping_db_path !== undefined) {
      req(typeof mp.shopping_db_path === "string" && mp.shopping_db_path.trim() !== "", `${source}: merchant_public.shopping_db_path must be a non-empty string`);
    }
    if (mp.catalog_url !== undefined) {
      req(typeof mp.catalog_url === "string" && mp.catalog_url.trim() !== "", `${source}: merchant_public.catalog_url must be a non-empty string`);
    }
    if (mp.merchant_token_env !== undefined) {
      req(REQUIRED_ENV_REF.test(String(mp.merchant_token_env)), `${source}: merchant_public.merchant_token_env must be an env var name`);
    }
    merchantPublic = {
      ...(mp.public_url !== undefined ? { public_url: String(mp.public_url) } : {}),
      ...(mp.a2a_port !== undefined ? { a2a_port: Number(mp.a2a_port) } : {}),
      ...(mp.shopping_db_path !== undefined ? { shopping_db_path: String(mp.shopping_db_path) } : {}),
      ...(mp.catalog_url !== undefined ? { catalog_url: String(mp.catalog_url) } : {}),
      ...(mp.merchant_token_env !== undefined ? { merchant_token_env: String(mp.merchant_token_env) } : {}),
    };
  }

  let buyerPolicy: BuyerPolicy | undefined;
  if (p.buyer_policy !== undefined) {
    req(isObject(p.buyer_policy), `${source}: buyer_policy must be a mapping`);
    const bp = p.buyer_policy;
    rejectUnknownKeys(bp, BUYER_POLICY_KEYS, "buyer_policy", source);
    // All buyer_policy fields are required: the local private gate must not
    // silently run with a half-specified policy.
    for (const key of BUYER_POLICY_KEYS) {
      req(bp[key] !== undefined, `${source}: buyer_policy.${key} is required`);
    }
    req(
      Array.isArray(bp.target_skus) &&
        bp.target_skus.every((s) => typeof s === "string" && s.length > 0),
      `${source}: buyer_policy.target_skus must be a list of non-empty strings`,
    );
    req(
      Number.isInteger(bp.quantity) && (bp.quantity as number) >= 1,
      `${source}: buyer_policy.quantity must be a positive integer`,
    );
    reqFinite(bp.max_total_price_private, "buyer_policy.max_total_price_private", source);
    req(
      bp.max_total_price_private >= 0,
      `${source}: buyer_policy.max_total_price_private must be >= 0`,
    );
    req(
      isRfc3339WithTimezone(bp.acceptable_eta_latest),
      `${source}: buyer_policy.acceptable_eta_latest must be an RFC 3339 date-time with an explicit timezone (e.g. 2026-08-05T18:00:00+08:00)`,
    );
    req(
      Array.isArray(bp.required_after_sales_terms) &&
        bp.required_after_sales_terms.every((s) => typeof s === "string" && s.length > 0),
      `${source}: buyer_policy.required_after_sales_terms must be a list of non-empty strings`,
    );
    req(
      typeof bp.auto_negotiate === "boolean",
      `${source}: buyer_policy.auto_negotiate must be a boolean`,
    );
    req(
      Array.isArray(bp.human_review_on) &&
        bp.human_review_on.every((c) => typeof c === "string" && c.length > 0),
      `${source}: buyer_policy.human_review_on must be a list of non-empty strings`,
    );
    buyerPolicy = { ...bp } as unknown as BuyerPolicy;
  }

  // Role <-> private policy binding: exactly one, matching the role.
  if (p.role === "buyer") {
    req(buyerPolicy !== undefined, `${source}: role=buyer requires a buyer_policy section`);
    req(
      merchantPolicy === undefined,
      `${source}: role=buyer must not define merchant_policy (policies are role-exclusive)`,
    );
  } else {
    req(
      merchantPolicy !== undefined,
      `${source}: role=merchant requires a merchant_policy section`,
    );
    req(
      buyerPolicy === undefined,
      `${source}: role=merchant must not define buyer_policy (policies are role-exclusive)`,
    );
  }

  // weixin 段（可选）：allow_users 非空字符串数组；base_url 必须 https 或 loopback。
  let weixinSection: AgentProfile["weixin"];
  if (p.weixin !== undefined) {
    req(isObject(p.weixin), `${source}: weixin must be a mapping`);
    rejectUnknownKeys(p.weixin, WEIXIN_KEYS, "weixin", source);
    const wx = p.weixin;
    if (wx.allow_users !== undefined) {
      req(
        Array.isArray(wx.allow_users) &&
          wx.allow_users.every((u) => typeof u === "string" && u.length > 0),
        `${source}: weixin.allow_users must be a list of non-empty strings`,
      );
    }
    let wxBaseUrl: string | undefined;
    if (wx.base_url !== undefined) {
      wxBaseUrl = assertSecureBaseUrl(wx.base_url, "weixin.base_url", source);
    }
    weixinSection = {
      ...(wx.allow_users !== undefined ? { allow_users: wx.allow_users as string[] } : {}),
      ...(wxBaseUrl !== undefined ? { base_url: wxBaseUrl } : {}),
    };
  }

  rejectUnknownKeys(p, TOP_LEVEL_KEYS, "profile", source);

  const profile: AgentProfile = {
    runtime_version: p.runtime_version,
    protocol_version: p.protocol_version,
    agent_id: p.agent_id,
    ...(typeof p.name === "string" && p.name !== "" ? { name: p.name } : {}),
    role: p.role,
    owner_id: p.owner_id,
    commerce: {
      base_url: commerceBaseUrl,
      token_env: commerce.token_env,
      backend: commerce.backend,
      ...(credentials !== undefined ? { credentials } : {}),
      ...(allowDemoPriceFallback === true ? { allow_demo_price_fallback: true } : {}),
    },
    model: {
      provider: model.provider,
      model: model.model,
      ...(model.api_key_env !== undefined ? { api_key_env: model.api_key_env as string } : {}),
      ...(model.api !== undefined ? { api: model.api as string } : {}),
      ...(modelBaseUrl !== undefined ? { base_url: modelBaseUrl } : {}),
      ...(model.thinking_level !== undefined
        ? { thinking_level: model.thinking_level as ProfileThinkingLevel }
        : {}),
    },
    runtime: {
      mode: runtime.mode,
      poll_interval_seconds: runtime.poll_interval_seconds as number,
      turn_timeout_seconds: runtime.turn_timeout_seconds as number,
      max_model_steps: runtime.max_model_steps as number,
      max_retries: runtime.max_retries as number,
    },
    ...(merchantPolicy !== undefined ? { merchant_policy: merchantPolicy } : {}),
    ...(buyerPolicy !== undefined ? { buyer_policy: buyerPolicy } : {}),
    ...(weixinSection !== undefined ? { weixin: weixinSection } : {}),
    ...(decisionSection !== undefined ? { decision: decisionSection } : {}),
    ...(merchantExperience !== undefined ? { merchant_experience: merchantExperience } : {}),
    ...(merchantPublic !== undefined ? { merchant_public: merchantPublic } : {}),
  };
  return profile;
}

/**
 * Resolve a secret from an environment variable reference. Throws
 * ProfileError when unset — callers map this to the config exit code.
 */
export function resolveSecret(envName: string, what: string): string {
  const value = process.env[envName];
  if (value === undefined || value === "") {
    throw new ProfileError(`${what}: environment variable ${envName} is not set`);
  }
  return value;
}

/** Scan loaded profile data for accidentally inlined secrets. */
export function findInlineSecrets(data: unknown): string[] {
  const suspicious = ["api_key", "token", "secret", "password"];
  const hits: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (isObject(node)) {
      for (const [k, v] of Object.entries(node)) {
        const keyPath = path ? `${path}.${k}` : k;
        if (
          typeof v === "string" &&
          suspicious.some((s) => k.toLowerCase().includes(s)) &&
          !k.endsWith("_env") &&
          v.length > 0
        ) {
          hits.push(keyPath);
        }
        walk(v, keyPath);
      }
    }
  };
  walk(data, "");
  return hits;
}
