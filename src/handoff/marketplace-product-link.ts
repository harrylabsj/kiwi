/**
 * Merchant-selected trade platform and its opaque decimal product ID.
 *
 * The allowed platform set is operator-configured (catalog
 * `/v1/marketplace-platforms`); merchants never submit a full URL.  The public
 * product link is generated from the platform's url template.
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
  readonly field: "trade_platform" | "platform_product_id";

  constructor(field: "trade_platform" | "platform_product_id", message: string) {
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

/** The two optional fields form one pair. Never coerce a number or normalize ID digits. */
export function parseMarketplaceProductFields(
  value: {
    trade_platform?: unknown;
    platform_product_id?: unknown;
  },
  rules: readonly TradePlatformRule[] = DEFAULT_TRADE_PLATFORM_RULES,
): MarketplaceProductFields {
  const platformEmpty = empty(value.trade_platform);
  const idEmpty = empty(value.platform_product_id);
  if (platformEmpty && idEmpty) return {};
  if (platformEmpty) {
    throw new MarketplaceProductLinkError("trade_platform", "填写平台商品ID时必须同时填写交易平台");
  }
  if (idEmpty) {
    throw new MarketplaceProductLinkError(
      "platform_product_id",
      "填写交易平台时必须同时填写平台商品ID",
    );
  }
  const trade_platform = normalizeMarketplaceTradePlatform(value.trade_platform, rules);
  const id = value.platform_product_id;
  if (typeof id !== "string" || !/^[1-9][0-9]*$/.test(id)) {
    throw new MarketplaceProductLinkError(
      "platform_product_id",
      "平台商品ID必须为ASCII正整数字符串；不能填数字类型、科学计数法、URL或公式",
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
