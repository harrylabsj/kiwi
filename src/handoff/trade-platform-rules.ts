/**
 * Operator-configurable trade platform rules.
 *
 * Merchants only submit a platform + opaque product ID; the product link is
 * generated from the operator's url template.  The authoritative list lives in
 * the catalog (`/v1/marketplace-platforms`, managed by the ops portal).  These
 * built-in defaults keep the merchant runtime usable before the first fetch.
 */
export interface TradePlatformRule {
  id: string;
  label: string;
  domain: string;
  url_template: string;
  sort_order: number;
}

export const DEFAULT_TRADE_PLATFORM_RULES: readonly TradePlatformRule[] = [
  {
    id: "jd",
    label: "京东",
    domain: "jd.com",
    url_template: "https://item.jd.com/{id}.html",
    sort_order: 10,
  },
  {
    id: "taobao",
    label: "淘宝",
    domain: "taobao.com",
    url_template: "https://item.taobao.com/item.htm?id={id}",
    sort_order: 20,
  },
  {
    id: "tmall",
    label: "天猫",
    domain: "tmall.com",
    url_template: "https://detail.tmall.com/item.htm?id={id}",
    sort_order: 30,
  },
];

/** Legacy aliases accepted for platform lookup (id or label is preferred). */
const LEGACY_ALIASES: Readonly<Record<string, string>> = {
  jingdong: "jd",
  "jing dong": "jd",
  京东商城: "jd",
  淘宝网: "taobao",
  天猫商城: "tmall",
};

export function normalizePlatformKey(value: unknown): string {
  return typeof value === "string" ? value.trim().normalize("NFKC").toLowerCase() : "";
}

export function isTradePlatformRule(value: unknown): value is TradePlatformRule {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id.trim() !== "" &&
    typeof row.label === "string" &&
    row.label.trim() !== "" &&
    typeof row.domain === "string" &&
    row.domain.trim() !== "" &&
    typeof row.url_template === "string" &&
    row.url_template.includes("{id}") &&
    (row.sort_order === undefined || typeof row.sort_order === "number")
  );
}

export function normalizeTradePlatformRules(value: unknown): TradePlatformRule[] {
  if (!Array.isArray(value)) return [...DEFAULT_TRADE_PLATFORM_RULES];
  const rules = value
    .filter(isTradePlatformRule)
    .map((row) => ({
      id: row.id.trim().toLowerCase(),
      label: row.label.trim(),
      domain: row.domain.trim().toLowerCase(),
      url_template: row.url_template.trim(),
      sort_order: Number.isFinite(row.sort_order) ? Number(row.sort_order) : 0,
    }))
    .filter((row) => row.id !== "");
  return rules.length > 0 ? rules : [...DEFAULT_TRADE_PLATFORM_RULES];
}

/** Resolve a merchant-entered platform (id, label, or legacy alias) to a rule. */
export function resolveTradePlatform(
  value: unknown,
  rules: readonly TradePlatformRule[] = DEFAULT_TRADE_PLATFORM_RULES,
): TradePlatformRule | undefined {
  const key = normalizePlatformKey(value);
  if (key === "") return undefined;
  const alias = Object.hasOwn(LEGACY_ALIASES, key) ? LEGACY_ALIASES[key] : key;
  return (
    rules.find((rule) => rule.id === alias) ??
    rules.find((rule) => normalizePlatformKey(rule.label) === key)
  );
}

/**
 * Build the public product link from a rule and an opaque decimal product ID.
 * The generated host must stay inside the rule's trusted domain.
 */
export function buildTradePlatformUrl(
  rule: TradePlatformRule,
  productId: unknown,
): string | undefined {
  if (typeof productId !== "string" || !/^[1-9][0-9]*$/.test(productId)) return undefined;
  const url = rule.url_template.replace("{id}", productId);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
      return undefined;
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== rule.domain && !host.endsWith("." + rule.domain)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}
