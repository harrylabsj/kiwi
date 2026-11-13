/**
 * Fetch the operator-configured trade platform rules from the catalog.
 *
 * The endpoint is public and read-only. `fetchTradePlatformRulesOrNull` keeps
 * "catalog unreachable" distinct from "operator intentionally has no enabled
 * platforms" so callers can keep the last known-good snapshot instead of
 * silently downgrading to the built-in jd/taobao/tmall rules. The plain
 * `fetchTradePlatformRules` wrapper preserves the offline default for callers
 * that have no snapshot yet.
 */
import {
  DEFAULT_TRADE_PLATFORM_RULES,
  normalizeTradePlatformRules,
  type TradePlatformRule,
} from "../handoff/trade-platform-rules.js";

const REQUEST_TIMEOUT_MS = 2_000;

/** undefined = catalog unreachable / invalid response; [] = operator disabled all. */
export async function fetchTradePlatformRulesOrNull(
  catalogUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TradePlatformRule[] | undefined> {
  const base = String(catalogUrl || "").trim().replace(/\/+$/, "");
  if (base === "") return undefined;
  try {
    const response = await fetchImpl(`${base}/v1/marketplace-platforms`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { platforms?: unknown };
    if (!Array.isArray(body.platforms)) return undefined;
    return normalizeTradePlatformRules(body.platforms);
  } catch {
    return undefined;
  }
}

export async function fetchTradePlatformRules(
  catalogUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TradePlatformRule[]> {
  return (
    (await fetchTradePlatformRulesOrNull(catalogUrl, fetchImpl)) ?? [
      ...DEFAULT_TRADE_PLATFORM_RULES,
    ]
  );
}
