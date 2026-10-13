/** Build product links from a supported marketplace and its opaque decimal product ID. */
export type MarketplaceTradePlatform = "jd" | "taobao" | "tmall";

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

const PLATFORM_ALIASES: Readonly<Record<string, MarketplaceTradePlatform>> = {
  jd: "jd",
  jingdong: "jd",
  "jing dong": "jd",
  京东: "jd",
  京东商城: "jd",
  taobao: "taobao",
  淘宝: "taobao",
  淘宝网: "taobao",
  tmall: "tmall",
  天猫: "tmall",
  天猫商城: "tmall",
};

export function normalizeMarketplaceTradePlatform(value: unknown): MarketplaceTradePlatform {
  const normalized = typeof value === "string" ? value.trim().normalize("NFKC").toLowerCase() : "";
  const platform = Object.hasOwn(PLATFORM_ALIASES, normalized)
    ? PLATFORM_ALIASES[normalized]
    : undefined;
  if (platform === undefined) {
    throw new MarketplaceProductLinkError(
      "trade_platform",
      "交易平台必须是京东、淘宝、天猫（jd/taobao/tmall）",
    );
  }
  return platform;
}

function empty(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim() === "");
}

/** The two optional fields form one pair. Never coerce a number or normalize ID digits. */
export function parseMarketplaceProductFields(value: {
  trade_platform?: unknown;
  platform_product_id?: unknown;
}): MarketplaceProductFields {
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
  const trade_platform = normalizeMarketplaceTradePlatform(value.trade_platform);
  const id = value.platform_product_id;
  if (typeof id !== "string" || !/^[1-9][0-9]*$/.test(id)) {
    throw new MarketplaceProductLinkError(
      "platform_product_id",
      "平台商品ID必须为ASCII正整数字符串；不能填数字类型、科学计数法、URL或公式",
    );
  }
  return { trade_platform, platform_product_id: id };
}

/** No arbitrary URL input, network requests, order placement or payment authorization. */
export function buildMarketplaceProductLink(platform: unknown, id: unknown): string | undefined {
  const fields = parseMarketplaceProductFields({
    trade_platform: platform,
    platform_product_id: id,
  });
  if (fields.trade_platform === undefined || fields.platform_product_id === undefined)
    return undefined;
  switch (fields.trade_platform) {
    case "jd":
      return `https://item.jd.com/${fields.platform_product_id}.html`;
    case "taobao":
      return `https://item.taobao.com/item.htm?id=${fields.platform_product_id}`;
    case "tmall":
      return `https://detail.tmall.com/item.htm?id=${fields.platform_product_id}`;
  }
}
