/**
 * Merchant-selected trade platform and its opaque decimal product ID.
 *
 * The allowed platform set is operator-configured (catalog
 * `/v1/marketplace-platforms`).  A merchant may enter either the platform
 * product ID or a full product detail-page URL; both are resolved to the same
 * opaque ID, and the public link is regenerated from the platform's url
 * template so tracking parameters or lookalike hosts never reach the catalog.
 */
import {
  DEFAULT_TRADE_PLATFORM_RULES,
  buildTradePlatformUrl,
  resolveTradePlatform,
  type TradePlatformRule,
} from "./trade-platform-rules.js";

export type MarketplaceTradePlatform = string;

export interface MarketplaceProductFields {
  trade_platform?: MarketplaceTradePlatform;
  platform_product_id?: string;
}

export class MarketplaceProductLinkError extends Error {
  readonly field: "trade_platform" | "platform_product_id" | "platform_product_url";

  constructor(
    field: "trade_platform" | "platform_product_id" | "platform_product_url",
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceProductLinkError";
    this.field = field;
  }
}

/**
 * Resolve a merchant-entered platform against the operator's rule set.  Known
 * ids/labels/legacy aliases map to the rule id; anything else is rejected.
 */
export function normalizeMarketplaceTradePlatform(
  value: unknown,
  rules: readonly TradePlatformRule[] = DEFAULT_TRADE_PLATFORM_RULES,
): MarketplaceTradePlatform {
  const rule = resolveTradePlatform(value, rules);
  if (rule === undefined) {
    const labels = rules.map((item) => item.label).join("、");
    throw new MarketplaceProductLinkError(
      "trade_platform",
      `交易平台不在允许范围内${labels ? `（可选：${labels}）` : ""}`,
    );
  }
  return rule.id;
}

function empty(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim() === "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Path shape of a template whose `{id}` lives in the path; undefined for query templates. */
function templatePathPattern(template: string): RegExp | undefined {
  const noHash = template.split("#")[0] ?? "";
  const queryIndex = noHash.indexOf("?");
  const pathPart = queryIndex === -1 ? noHash : noHash.slice(0, queryIndex);
  const queryPart = queryIndex === -1 ? "" : noHash.slice(queryIndex + 1);
  if (queryPart.includes("{id}")) return undefined;
  const matched = /^https:\/\/[^/]+(\/[^?#]*)$/.exec(pathPart);
  const path = matched?.[1] ?? "/";
  if (!path.includes("{id}")) return undefined;
  return new RegExp(`^${path.split("{id}").map(escapeRegExp).join("([^/]+)")}$`);
}

/** Static path prefix before `{id}` (e.g. `/ip/` for walmart); `/` when absent. */
function templatePathPrefix(template: string): string {
  const noHash = template.split("#")[0] ?? "";
  const queryIndex = noHash.indexOf("?");
  const pathPart = queryIndex === -1 ? noHash : noHash.slice(0, queryIndex);
  const matched = /^https:\/\/[^/]+(\/[^?#]*)$/.exec(pathPart);
  const path = matched?.[1] ?? "/";
  const prefix = path.split("{id}")[0] ?? "/";
  return prefix === "" ? "/" : prefix;
}

/** Query parameter name whose value is `{id}` in the template (e.g. taobao `id`). */
function templateQueryParam(template: string): string | undefined {
  const queryIndex = template.indexOf("?");
  if (queryIndex === -1) return undefined;
  for (const pair of (template.slice(queryIndex + 1).split("#")[0] ?? "").split("&")) {
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    if (pair.slice(equals + 1) === "{id}") return decodeURIComponent(pair.slice(0, equals));
  }
  return undefined;
}

/**
 * Extract the opaque product ID from a full product detail-page URL.
 *
 * The URL must stay on the platform's trusted domain and use the platform's
 * own path/query shape (from `url_template`); extra tracking parameters and
 * fragments are tolerated but dropped — only the ID is kept.
 */
function productIdFromUrl(rule: TradePlatformRule, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new MarketplaceProductLinkError("platform_product_url", "商品链接不是合法 URL");
  }
  if (url.protocol !== "https:") {
    throw new MarketplaceProductLinkError("platform_product_url", "商品链接必须使用 https://");
  }
  if (url.username !== "" || url.password !== "" || url.port !== "") {
    throw new MarketplaceProductLinkError(
      "platform_product_url",
      "商品链接不能包含用户名、密码或端口",
    );
  }
  const host = url.hostname.toLowerCase();
  if (host !== rule.domain && !host.endsWith(`.${rule.domain}`)) {
    throw new MarketplaceProductLinkError(
      "platform_product_url",
      `商品链接域名必须是 ${rule.domain}（收到 ${host}）`,
    );
  }
  const queryParam = templateQueryParam(rule.url_template);
  let id: string | null;
  if (queryParam !== undefined) {
    id = url.searchParams.get(queryParam);
    if (id === null) {
      throw new MarketplaceProductLinkError(
        "platform_product_url",
        `商品链接缺少平台商品ID参数 ${queryParam}`,
      );
    }
  } else {
    const pattern = templatePathPattern(rule.url_template);
    if (pattern === undefined) {
      throw new MarketplaceProductLinkError(
        "platform_product_url",
        "平台链接模板无法识别商品ID，请填写平台商品ID",
      );
    }
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const matched = pattern.exec(pathname);
    if (matched !== null) {
      id = matched[1] ?? null;
    } else {
      // 真实详情页常带可读 slug 或尾斜杠（如 /ip/some-name/123、/123/）。
      // 只放宽到「模板静态前缀之下、最后一个纯数字路径段」，仍限定平台域名。
      const prefix = templatePathPrefix(rule.url_template);
      const segments = pathname.split("/").filter(Boolean);
      const last = segments[segments.length - 1] ?? "";
      const candidate = last.endsWith(".html") ? last.slice(0, -5) : last;
      id =
        pathname.startsWith(prefix) && /^[1-9][0-9]*$/.test(candidate)
          ? candidate
          : null;
      if (id === null) {
        throw new MarketplaceProductLinkError(
          "platform_product_url",
          `商品链接路径不符合平台格式（${rule.url_template}）`,
        );
      }
    }
  }
  if (id === null || !/^[1-9][0-9]*$/.test(id)) {
    throw new MarketplaceProductLinkError(
      "platform_product_url",
      "商品链接中的商品ID必须为ASCII正整数字符串",
    );
  }
  return id;
}

/**
 * Resolve the optional trade-entry fields. Platform is mandatory whenever an ID
 * or a full URL is provided; the platform may be written as id or label, in
 * Chinese or English. At least one of ID/URL is required. When both are given
 * they must point at the same product.
 */
export function parseMarketplaceProductFields(
  value: {
    trade_platform?: unknown;
    platform_product_id?: unknown;
    platform_product_url?: unknown;
  },
  rules: readonly TradePlatformRule[] = DEFAULT_TRADE_PLATFORM_RULES,
): MarketplaceProductFields {
  const platformEmpty = empty(value.trade_platform);
  const idEmpty = empty(value.platform_product_id);
  const urlEmpty = empty(value.platform_product_url);
  if (platformEmpty && idEmpty && urlEmpty) return {};
  if (platformEmpty) {
    throw new MarketplaceProductLinkError(
      "trade_platform",
      "填写平台商品ID或商品链接时必须同时填写交易平台",
    );
  }
  if (idEmpty && urlEmpty) {
    throw new MarketplaceProductLinkError(
      "platform_product_id",
      "填写交易平台时必须同时填写平台商品ID或商品链接",
    );
  }
  const trade_platform = normalizeMarketplaceTradePlatform(value.trade_platform, rules);
  const rule = resolveTradePlatform(trade_platform, rules);
  if (rule === undefined) {
    // normalizeMarketplaceTradePlatform 已保证存在；保留防御性分支。
    throw new MarketplaceProductLinkError("trade_platform", "交易平台不在允许范围内");
  }
  let id: string | undefined;
  if (!idEmpty) {
    const rawId = value.platform_product_id;
    if (typeof rawId !== "string" || !/^[1-9][0-9]*$/.test(rawId)) {
      throw new MarketplaceProductLinkError(
        "platform_product_id",
        "平台商品ID必须为ASCII正整数字符串；不能填数字类型、科学计数法、URL或公式",
      );
    }
    id = rawId;
  }
  if (!urlEmpty) {
    const rawUrl = value.platform_product_url;
    if (typeof rawUrl !== "string") {
      throw new MarketplaceProductLinkError("platform_product_url", "商品链接必须是文本");
    }
    const fromUrl = productIdFromUrl(rule, rawUrl);
    if (id !== undefined && id !== fromUrl) {
      throw new MarketplaceProductLinkError(
        "platform_product_url",
        `商品链接与平台商品ID不一致（链接为 ${fromUrl}，ID 为 ${id}）`,
      );
    }
    id = fromUrl;
  }
  if (id === undefined) {
    throw new MarketplaceProductLinkError(
      "platform_product_id",
      "填写交易平台时必须同时填写平台商品ID或商品链接",
    );
  }
  return { trade_platform, platform_product_id: id };
}

/** Build the public product link from the operator's rule (no arbitrary URL input). */
export function buildMarketplaceProductLink(
  platform: unknown,
  id: unknown,
  rules: readonly TradePlatformRule[] = DEFAULT_TRADE_PLATFORM_RULES,
): string | undefined {
  const fields = parseMarketplaceProductFields(
    { trade_platform: platform, platform_product_id: id },
    rules,
  );
  if (fields.trade_platform === undefined || fields.platform_product_id === undefined)
    return undefined;
  const rule = resolveTradePlatform(fields.trade_platform, rules);
  if (rule === undefined) return undefined;
  return buildTradePlatformUrl(rule, fields.platform_product_id);
}
