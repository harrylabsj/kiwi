/**
 * UCP Profile 领域类型（UCP 2026-04-08 spec family，基线 §3.2 / §25 / §43）。
 *
 * Business 在 `/.well-known/ucp` 发布 profile：
 *
 *   {
 *     ucp: {
 *       version: "YYYY-MM-DD",
 *       services: { "<reverse-domain>.<service>": [ { version, spec, transport, endpoint?, schema? } ] },
 *       capabilities: { "<reverse-domain>.<service>.<capability>": [ { version, spec, schema, extends? } ] },
 *     },
 *     signing_keys?: JWK[],
 *   }
 *
 * 命名不变量（基线 §8.3 + UCP namespace authority 规则）：
 *   - capability 名 = {reverse-domain}.{service}.{capability}（角色三段式）；
 *   - service 名   = {reverse-domain}.{service}；
 *   - reverse-domain 反转即 namespace authority host（com.example.* → example.com，
 *     dev.ucp.* → ucp.dev）；
 *   - spec/schema URL origin MUST 与 namespace authority 一致。
 *
 * 本模块只建模类型与纯函数；运行时校验在 validate.ts，抓取在 resolver.ts。
 */

/** UCP service transport 枚举（UCP 2026-04-08）。 */
export const UCP_TRANSPORTS = ["rest", "mcp", "a2a", "embedded"] as const;
export type UcpTransport = (typeof UCP_TRANSPORTS)[number];

export interface UcpServiceDeclaration {
  version: string;
  spec: string;
  transport: UcpTransport;
  /** a2a transport 时 MUST 指向 Agent Card URL（基线 §25）。 */
  endpoint?: string;
  schema?: string;
  /** forward-compat：未知字段保留。 */
  [key: string]: unknown;
}

export interface UcpCapabilityDeclaration {
  version: string;
  spec: string;
  schema: string;
  /** Vendor Root Capability 不带 extends（基线 §25.2）。 */
  extends?: string | string[];
  [key: string]: unknown;
}

/** JWK 宽松建模（WP2+ 做签名验证时再收紧）。 */
export interface UcpSigningKey {
  kty: string;
  [key: string]: unknown;
}

export interface UcpProfile {
  ucp: {
    /** UCP spec family 日期，YYYY-MM-DD（§43 pin 2026-04-08）。 */
    version: string;
    services?: Record<string, UcpServiceDeclaration[]>;
    capabilities?: Record<string, UcpCapabilityDeclaration[]>;
    [key: string]: unknown;
  };
  signing_keys?: UcpSigningKey[];
  [key: string]: unknown;
}

export interface UcpNamespaceParts {
  reverseDomain: string;
  authorityHost: string;
  service: string;
  capability?: string;
}

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isDnsLabel(label: string): boolean {
  return label.length >= 1 && label.length <= 63 && DNS_LABEL_RE.test(label);
}

/** reverse-domain（如 `example.kiwi`）→ namespace authority host（`kiwi.example`）。 */
export function reverseDomainToAuthority(reverseDomain: string): string {
  return reverseDomain.split(".").reverse().join(".");
}

/**
 * service 名：{reverse-domain}.{service}。reverse-domain 至少 2 labels（真实反向 DNS）。
 * 返回 undefined 表示名字不合法（validate.ts 记为 namespace_invalid）。
 */
export function parseServiceNamespace(name: string): UcpNamespaceParts | undefined {
  const labels = name.split(".");
  if (labels.length < 3) return undefined;
  if (!labels.every(isDnsLabel)) return undefined;
  const service = labels[labels.length - 1]!;
  const reverseDomain = labels.slice(0, -1).join(".");
  return { reverseDomain, authorityHost: reverseDomainToAuthority(reverseDomain), service };
}

/**
 * capability 名：{reverse-domain}.{service}.{capability}。reverse-domain 至少 2 labels。
 * 返回 undefined 表示名字不合法（validate.ts 记为 namespace_invalid）。
 */
export function parseCapabilityNamespace(name: string): UcpNamespaceParts | undefined {
  const labels = name.split(".");
  if (labels.length < 4) return undefined;
  if (!labels.every(isDnsLabel)) return undefined;
  const capability = labels[labels.length - 1]!;
  const service = labels[labels.length - 2]!;
  const reverseDomain = labels.slice(0, -2).join(".");
  return {
    reverseDomain,
    authorityHost: reverseDomainToAuthority(reverseDomain),
    service,
    capability,
  };
}

/** 结构级 HTTPS URL 判定（spec / schema / endpoint）。 */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function originHostFor(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
