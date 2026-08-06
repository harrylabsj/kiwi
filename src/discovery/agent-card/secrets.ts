/**
 * Agent Card secret 扫描（基线 §26 MUST NOT 子句 + 安全不变量 24）。
 *
 * Agent Card / public metadata 不得包含：静态 bearer token、API key、password、
 * 私钥、Merchant cost/floor 数据、Principal 私有状态。本扫描器对原始 JSON
 * （含未知/扩展字段）做启发式拒绝，任何命中即视为不可用的 card。
 *
 * 设计取舍：安全扫描宁可误报（fail-closed）也不漏报。合法 card 的常见字符串
 * （name/description 散文、URL、版本号、binding 名、skill id、credential 引用）
 * 均不会命中以下规则。
 */

import { AgentCardError } from "./error.js";

export type SecretKind =
  | "bearer_token"
  | "api_key"
  | "password"
  | "private_key"
  | "authorization_header"
  | "high_entropy_token"
  | "merchant_private_data"
  | "principal_private_state";

export interface SecretFinding {
  /** JSON Pointer 风格路径。 */
  path: string;
  kind: SecretKind;
  detail: string;
}

export interface SecretScanResult {
  ok: boolean;
  findings: SecretFinding[];
}

/** PEM 私钥块。 */
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/** 已知厂商 token 前缀（整串或 word-boundary 片段）。 */
const TOKEN_PREFIX_RE =
  /^(sk-|sk_live_|rk_live_|pk_live_|pk_test_|AKIA|ASIA|ghp_|gho_|ghu_|ghs_|ghr_|xox[baprs]-|ya29\.|eyJ[A-Za-z0-9_-]{6,}\.)/;

/** 内嵌在散文中的 token 片段（整串扫描之外的二次兜底）。 */
const EMBEDDED_TOKEN_RE =
  /\b(sk-[A-Za-z0-9_-]{8,}|sk_live_[A-Za-z0-9]{10,}|pk_live_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})\b/;

/** 显式 Bearer 头。 */
const BEARER_RE = /^Bearer\s+\S/;

/** 安全引用/占位符：env 引用、${VAR}、$VAR、<placeholder>。 */
const PLACEHOLDER_RE =
  /^(env:[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|<[^>]*>)$/;

/** 字段名直接命中即拒绝的敏感键（值非占位符时）。 */
const SENSITIVE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "client_secret",
  "secret_key",
  "private_key",
  "access_token",
  "refresh_token",
  "bearer_token",
  "api_key",
  "apikey",
  "api-key",
  "x-api-key",
  "x-auth-token",
  "authorization",
  "proxy-authorization",
  "authorizationheader",
]);

/** Merchant cost/floor 与 Principal 私有阈值字段名（基线 §4.4 Private by default）。 */
const PRIVATE_COMMERCE_KEYS: ReadonlySet<string> = new Set([
  "cost",
  "costs",
  "unit_cost",
  "cost_price",
  "total_cost",
  "floor",
  "floor_price",
  "price_floor",
  "min_price",
  "minimum_price",
  "min_unit_price",
  "margin",
  "markup",
  "cogs",
  "breakeven",
  "reserve_price",
  "max_budget",
  "budget_limit",
  "max_total_price",
  "max_unit_price",
  "private_threshold",
]);

/** Principal 私有状态键名。 */
const PRINCIPAL_PRIVATE_KEYS: ReadonlySet<string> = new Set([
  "private_memory",
  "principal_memory",
  "principal_private",
  "personal_details",
]);

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function charClasses(value: string): number {
  let count = 0;
  if (/[a-z]/.test(value)) count += 1;
  if (/[A-Z]/.test(value)) count += 1;
  if (/[0-9]/.test(value)) count += 1;
  if (/[^A-Za-z0-9]/.test(value)) count += 1;
  return count;
}

/** 高熵 token 启发式：长、无空白、非 URL/时间戳、至少 3 个字符类或大写字+数字。 */
function looksLikeToken(value: string): boolean {
  if (value.length < 24) return false;
  if (/\s/.test(value)) return false;
  if (looksLikeUrl(value)) return false;
  if (RFC3339.test(value)) return false;
  if (PLACEHOLDER_RE.test(value)) return false;
  return charClasses(value) >= 3 || (/[A-Z]/.test(value) && /[0-9]/.test(value));
}

function detectKindForValue(value: string): SecretKind {
  if (PRIVATE_KEY_RE.test(value)) return "private_key";
  if (BEARER_RE.test(value)) return "bearer_token";
  return "api_key";
}

function kindForSensitiveField(key: string): SecretKind {
  const lower = key.toLowerCase();
  if (
    lower === "authorization" ||
    lower === "proxy-authorization" ||
    lower === "authorizationheader"
  ) {
    return "authorization_header";
  }
  if (lower === "password" || lower === "passwd" || lower === "client_secret") {
    return "password";
  }
  if (lower === "private_key" || lower === "secret_key") {
    return "private_key";
  }
  return "api_key";
}

function scanString(value: string, path: string, findings: SecretFinding[]): void {
  if (PRIVATE_KEY_RE.test(value) || BEARER_RE.test(value) || TOKEN_PREFIX_RE.test(value)) {
    findings.push({
      path,
      kind: detectKindForValue(value),
      detail: "string matches a known secret shape",
    });
    return;
  }
  if (EMBEDDED_TOKEN_RE.test(value)) {
    findings.push({
      path,
      kind: "api_key",
      detail: "prose contains an embedded token-shaped substring",
    });
    return;
  }
  if (looksLikeToken(value)) {
    findings.push({
      path,
      kind: "high_entropy_token",
      detail: "string is a long high-entropy token-shaped value",
    });
  }
}

/** 拼接 JSON Pointer 风格路径：根路径 "/" 不产生双斜杠。 */
function joinPath(path: string, segment: string): string {
  return path === "/" ? `/${segment}` : `${path}/${segment}`;
}

function scanValue(value: unknown, path: string, findings: SecretFinding[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    scanString(value, path, findings);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanValue(item, joinPath(path, String(index)), findings));
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      const childPath = joinPath(path, key);
      const lower = key.toLowerCase();
      if (
        PRIVATE_COMMERCE_KEYS.has(lower) &&
        child !== undefined &&
        child !== null &&
        child !== ""
      ) {
        findings.push({
          path: childPath,
          kind: "merchant_private_data",
          detail: `key "${key}" may carry private cost/floor data (baseline §4.4)`,
        });
      }
      if (
        PRINCIPAL_PRIVATE_KEYS.has(lower) &&
        child !== undefined &&
        child !== null &&
        child !== ""
      ) {
        findings.push({
          path: childPath,
          kind: "principal_private_state",
          detail: `key "${key}" may carry principal private state`,
        });
      }
      if (SENSITIVE_FIELD_NAMES.has(lower) && typeof child === "string") {
        if (child.length > 0 && !PLACEHOLDER_RE.test(child)) {
          findings.push({
            path: childPath,
            kind: kindForSensitiveField(key),
            detail: `key "${key}" holds a static secret-shaped value`,
          });
        }
      }
      scanValue(child, childPath, findings);
    }
  }
}

/** 扫描任意 JSON 值（原始 card 含未知/扩展字段）。纯函数，不抛错。 */
export function scanAgentCardSecrets(value: unknown): SecretScanResult {
  const findings: SecretFinding[] = [];
  scanValue(value, "/", findings);
  return { ok: findings.length === 0, findings };
}

/** 若命中任一 secret 类发现则抛 AgentCardError("secret_found")。 */
export function assertNoAgentCardSecrets(value: unknown): void {
  const result = scanAgentCardSecrets(value);
  if (!result.ok) {
    const first = result.findings[0];
    throw new AgentCardError(
      "secret_found",
      `Agent Card rejected: ${first?.detail ?? "static secret detected"} at ${first?.path ?? "/"}`,
      first?.path ?? "/",
    );
  }
}
