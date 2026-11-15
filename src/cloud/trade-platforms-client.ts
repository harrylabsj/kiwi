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
    const normalized = normalizeTradePlatformRules(body.platforms);
    // 非空输入全部不合法 = 响应无效（schema 漂移/脏行），不能当成「运营主动
    // 停用了全部平台」：返回 undefined 让调用方保留上次成功快照。
    if (body.platforms.length > 0 && normalized.length === 0) return undefined;
    return normalized;
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

export interface TradePlatformRulesCacheOptions {
  /** undefined = 未配置 catalog：永远使用内置规则，不发请求。 */
  catalogUrl: string | undefined;
  /** 测试缝。 */
  fetchImpl?: typeof fetch;
  /** 成功刷新后的缓存窗口（毫秒）；默认 30s。 */
  successTtlMs?: number;
  /** 拉取失败后的退避窗口（毫秒）；默认 10s。 */
  failureRetryMs?: number;
  /** 测试缝。 */
  now?: () => number;
}

export interface TradePlatformRulesCache {
  /** 当前快照（内置默认、上次成功值，或运营清空后的 []）。 */
  current(): readonly TradePlatformRule[];
  /**
   * 缓存到期则拉取最新规则并更新快照；始终返回当前快照。
   *
   * 每次导入/列表/发布/报价前都同步打一次 catalog，会让买家报价热路径在
   * catalog 慢或不可达时最多吃满 2s 请求超时，并对 catalog 形成每请求一查的
   * 压力。因此：成功后 successTtlMs 内直接返回快照（运营改平台最迟 30s 生效，
   * 无需重启实例）；失败后 failureRetryMs 内不重试，退避结束前的调用继续用
   * 上次成功快照。
   *
   * 并发调用不共享 in-flight 请求：刷新进行中的调用直接拿当前快照（最多等
   * 一次 2s 请求超时），不会排在请求后面；刷新完成后才更新快照。
   */
  refresh(): Promise<readonly TradePlatformRule[]>;
}

export function createTradePlatformRulesCache(
  options: TradePlatformRulesCacheOptions,
): TradePlatformRulesCache {
  const successTtlMs = options.successTtlMs ?? 30_000;
  const failureRetryMs = options.failureRetryMs ?? 10_000;
  const now = options.now ?? Date.now;
  let snapshot: readonly TradePlatformRule[] = [...DEFAULT_TRADE_PLATFORM_RULES];
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  // 显式记录上次尝试结果：用时间戳相等推断「上次是否成功」在毫秒碰撞时会误判。
  let lastAttemptFailed = false;
  return {
    current: () => snapshot,
    async refresh(): Promise<readonly TradePlatformRule[]> {
      if (options.catalogUrl === undefined) return snapshot;
      const t = now();
      // 上次成功 → 成功窗口；上次失败 → 短退避窗口。
      const skipWindow = lastAttemptFailed ? failureRetryMs : successTtlMs;
      if (lastAttemptAt > Number.NEGATIVE_INFINITY && t - lastAttemptAt < skipWindow) {
        return snapshot;
      }
      lastAttemptAt = t;
      const fresh = await fetchTradePlatformRulesOrNull(options.catalogUrl, options.fetchImpl);
      lastAttemptFailed = fresh === undefined;
      if (fresh !== undefined) snapshot = fresh;
      return snapshot;
    },
  };
}
