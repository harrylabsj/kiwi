/**
 * Fetch the operator-configured trade platform rules from the catalog.
 *
 * The endpoint is public and read-only; failures fall back to the built-in
 * jd/taobao/tmall rules so merchant imports keep working offline.
 */
import {
  DEFAULT_TRADE_PLATFORM_RULES,
  normalizeTradePlatformRules,
  type TradePlatformRule,
} from "../handoff/trade-platform-rules.js";

const REQUEST_TIMEOUT_MS = 2_000;

export async function fetchTradePlatformRules(
  catalogUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TradePlatformRule[]> {
  const base = String(catalogUrl || "").trim().replace(/\/+$/, "");
  if (base === "") return [...DEFAULT_TRADE_PLATFORM_RULES];
  try {
    const response = await fetchImpl(`${base}/v1/marketplace-platforms`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return [...DEFAULT_TRADE_PLATFORM_RULES];
    const body = (await response.json()) as { platforms?: unknown };
    return normalizeTradePlatformRules(body.platforms);
  } catch {
    return [...DEFAULT_TRADE_PLATFORM_RULES];
  }
}
