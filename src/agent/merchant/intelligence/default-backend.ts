import { existsSync } from "node:fs";
import path from "node:path";
import { LedgerStore } from "../../../negotiation/ledger/index.js";
import { TERMINAL_PHASES } from "../../../negotiation/state/phase.js";
import { openMerchantStatsStore } from "../../../merchant/stats-store.js";
import type { MerchantClient } from "../types.js";
import type { WriteApprovalCandidateStore } from "../action-candidate.js";
import type { MerchantIntelligenceBackend, MerchantIntelligenceDependencies } from "./backend.js";
import type {
  CatalogHealth,
  DataLimitation,
  MerchantBusinessSnapshot,
  MetricPoint,
  MetricSeries,
  MerchantAnalyticsSource,
  MerchantChangePreview,
  NegotiationDigestItem,
  PendingActionSummary,
} from "./types.js";
import { publicCandidatePreview } from "../merchant-enrichment.js";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

function utcNow(): string {
  return new Date().toISOString();
}

function dayShift(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

function periodWindow(period: string | undefined, now: string): { label: string; since: string } {
  const today = now.slice(0, 10);
  const label = period ?? `${DEFAULT_DAYS}d`;
  const match = /^(\d+)d$/i.exec(label);
  if (match?.[1] === undefined) throw new Error("period must use Nd syntax, for example 7d or 30d");
  const days = Number(match[1]);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new Error(`period days must be between 1 and ${MAX_DAYS}`);
  }
  return { label: `${days}d`, since: dayShift(today, -(days - 1)) };
}

function metricBucket(date: string, granularity: "day" | "week" | "month"): string {
  if (granularity === "day") return date;
  if (granularity === "month") return `${date.slice(0, 7)}-01`;
  const parsed = new Date(`${date}T00:00:00Z`);
  const day = parsed.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return dayShift(date, mondayOffset);
}

function aggregateMetricPoints(
  points: MetricPoint[],
  granularity: "day" | "week" | "month",
): MetricPoint[] {
  if (granularity === "day") return points;
  const totals = new Map<string, number>();
  for (const point of points) {
    const bucket = metricBucket(point.date, granularity);
    totals.set(bucket, (totals.get(bucket) ?? 0) + point.value);
  }
  return [...totals.entries()].map(([date, value]) => ({ date, value }));
}

function readStatsPath(dataDir: string): string {
  return path.join(dataDir, "a2a", "stats.sqlite");
}

function assertOwned(requested: string, owner: string): void {
  if (requested !== owner) throw new Error("merchant identity does not match the bound session");
}

function extractNegotiation(
  negotiationId: string,
  events: ReturnType<LedgerStore["events"]>,
): NegotiationDigestItem | undefined {
  const tail = events.at(-1);
  if (tail === undefined) return undefined;
  let phase = tail.state_transition?.to_phase ?? "OPEN";
  let buyerIdentity = tail.identity.counterparty_identity;
  let updatedAt = tail.recorded_at;
  let sku: string | undefined;
  let quantity: number | undefined;
  let price: number | undefined;
  let currency: string | undefined;
  let agreementId: string | undefined;
  for (const event of events) {
    if (event.recorded_at > updatedAt) updatedAt = event.recorded_at;
    if (event.state_transition?.to_phase !== undefined) phase = event.state_transition.to_phase;
    if (event.identity.counterparty_identity !== "") buyerIdentity = event.identity.counterparty_identity;
    if (event.agreement_id !== undefined) agreementId = event.agreement_id;
    const payload = event.wire_payload as {
      payload?: { terms?: { items?: Array<{ sku?: string; quantity?: { value?: number }; unit_price?: { amount_minor?: number; currency?: string } }> } };
    } | undefined;
    const item = payload?.payload?.terms?.items?.[0];
    if (item?.sku) sku = item.sku;
    if (item?.quantity?.value !== undefined) quantity = item.quantity.value;
    if (item?.unit_price?.amount_minor !== undefined) price = item.unit_price.amount_minor;
    if (item?.unit_price?.currency !== undefined) currency = item.unit_price.currency;
  }
  return {
    negotiation_id: negotiationId,
    phase,
    buyer_identity: buyerIdentity,
    skus: sku === undefined ? [] : [sku],
    ...(quantity === undefined ? {} : { quantity }),
    ...(price === undefined ? {} : { latest_price_minor: price }),
    ...(currency === undefined ? {} : { currency }),
    needs_human_review: phase === "AWAITING_CLARIFICATION",
    updated_at: updatedAt,
    ...(agreementId === undefined ? {} : { agreement_id: agreementId }),
  };
}

function agreementsReachedSince(dataDir: string, since: string): number {
  const ledger = new LedgerStore({ dir: path.join(dataDir, "a2a"), now: utcNow });
  let count = 0;
  for (const negotiationId of ledger.listNegotiations()) {
    if (ledger.events(negotiationId).some((event) =>
      event.state_transition?.to_phase === "AGREEMENT_REACHED" && event.recorded_at.slice(0, 10) >= since,
    )) {
      count += 1;
    }
  }
  return count;
}

export class DefaultMerchantIntelligenceBackend implements MerchantIntelligenceBackend {
  private readonly merchantId: string;
  private readonly dataDir: string;
  private readonly merchantClient: MerchantClient;
  private readonly approvals: WriteApprovalCandidateStore;
  private readonly now: () => string;
  private readonly analyticsSource?: MerchantAnalyticsSource;
  private readonly principalId: string;

  constructor(deps: MerchantIntelligenceDependencies) {
    this.merchantId = deps.merchant_id;
    this.dataDir = deps.data_dir;
    this.merchantClient = deps.merchant_client;
    this.approvals = deps.approvals;
    this.analyticsSource = deps.analytics_source;
    this.principalId = deps.principal_id ?? this.merchantId;
    this.now = deps.now ?? utcNow;
  }

  private validateSourceMetric(metric: unknown): metric is import("./types.js").MetricValue {
    if (metric === null || typeof metric !== "object" || Array.isArray(metric)) return false;
    const value = metric as Record<string, unknown>;
    return (
      typeof value.name === "string" && value.name.length > 0 && value.name.length <= 80 &&
      (value.value === null || (typeof value.value === "number" && Number.isFinite(value.value))) &&
      (value.unit === "count" || value.unit === "percent" || value.unit === "minor_currency") &&
      typeof value.observed_at === "string" && value.observed_at.length > 0 &&
      (value.currency === undefined || typeof value.currency === "string") &&
      (value.note === undefined || typeof value.note === "string")
    );
  }

  private async readAnalyticsMetrics(
    period: string,
  ): Promise<{ metrics: import("./types.js").MetricValue[]; limitations: DataLimitation[] }> {
    if (this.analyticsSource === undefined) return { metrics: [], limitations: [] };
    try {
      const result = await this.analyticsSource.getMetrics({ merchant_id: this.merchantId, period });
      if (result === null || typeof result !== "object" || !Array.isArray(result.metrics)) {
        return { metrics: [], limitations: [{ source: "analytics", note: "分析数据源返回了无效结构" }] };
      }
      const metrics: import("./types.js").MetricValue[] = [];
      const names = new Set<string>();
      let invalidCount = 0;
      let duplicateCount = 0;
      for (const metric of result.metrics) {
        if (!this.validateSourceMetric(metric)) {
          invalidCount += 1;
          continue;
        }
        if (names.has(metric.name)) {
          duplicateCount += 1;
          continue;
        }
        names.add(metric.name);
        metrics.push(metric);
      }
      return {
        metrics,
        limitations: [
          ...(Array.isArray(result.limitations) ? result.limitations.filter((item) =>
            item !== null && typeof item === "object" &&
            typeof item.source === "string" && typeof item.note === "string",
          ) : []),
          ...(invalidCount > 0 ? [{ source: "analytics", note: `${invalidCount} 个指标因格式无效被丢弃` }] : []),
          ...(duplicateCount > 0 ? [{ source: "analytics", note: `${duplicateCount} 个重复指标被丢弃` }] : []),
        ],
      };
    } catch {
      return { metrics: [], limitations: [{ source: "analytics", note: "销售/活动分析数据源暂时不可用" }] };
    }
  }

  private validSourceSeries(
    value: unknown,
    metric: string,
    period: string,
    granularity: "day" | "week" | "month",
  ): value is MetricSeries {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const series = value as Record<string, unknown>;
    if (
      series.metric !== metric || series.period !== period || series.granularity !== granularity ||
      (series.unit !== "count" && series.unit !== "percent" && series.unit !== "minor_currency") ||
      !Array.isArray(series.points) || series.points.length > 10_000
    ) return false;
    return series.points.every((point) => {
      if (point === null || typeof point !== "object" || Array.isArray(point)) return false;
      const item = point as Record<string, unknown>;
      return typeof item.date === "string" && item.date.length > 0 && item.date.length <= 32 &&
        typeof item.value === "number" && Number.isFinite(item.value);
    }) && (series.currency === undefined || typeof series.currency === "string") &&
      (series.note === undefined || typeof series.note === "string");
  }

  async getBusinessSnapshot(input: { merchant_id: string; period?: string }): Promise<MerchantBusinessSnapshot> {
    assertOwned(input.merchant_id, this.merchantId);
    const now = this.now();
    const window = periodWindow(input.period, now);
    const limitations: DataLimitation[] = [];
    let distinctBuyers: number | null = null;
    let contactEvents: number | null = null;
    let negotiations: number | null = null;
    let topSkuContacts: Array<{ sku: string; contact_events: number; distinct_buyers: number; negotiations: number }> = [];
    const statsPath = readStatsPath(this.dataDir);
    if (existsSync(statsPath)) {
      const store = openMerchantStatsStore({ dbPath: statsPath });
      try {
        const totals = store.totalsSince(window.since);
        distinctBuyers = totals.distinct_buyers;
        contactEvents = totals.contact_events;
        negotiations = totals.negotiations;
        topSkuContacts = store.topSkus(window.since, 10);
      } finally {
        store.close();
      }
    } else {
      limitations.push({ source: "merchant_stats", note: "没有买家触达统计数据" });
    }
    const [negotiationDigest, reviews, catalogHealth] = await Promise.all([
      this.getNegotiationDigest({ merchant_id: this.merchantId, status: "active", limit: 100 }),
      this.merchantClient.getHumanReviewQueue(this.merchantId),
      this.getCatalogHealth({ merchant_id: this.merchantId }),
    ]);
    const pending = await this.getPendingActions();
    const analytics = await this.readAnalyticsMetrics(window.label);
    const metricNames = new Set([
      "distinct_buyers",
      "contact_events",
      "negotiations",
      "agreements_reached",
      "agreement_rate",
      "human_review_count",
      "pending_action_count",
      "active_negotiations",
    ]);
    const acceptedAnalytics = analytics.metrics.filter((metric) => {
      if (metricNames.has(metric.name)) {
        analytics.limitations.push({ source: "analytics", note: `指标 ${metric.name} 与本地权威源冲突，已拒绝外部值` });
        return false;
      }
      metricNames.add(metric.name);
      return true;
    });
    const agreementsReached = agreementsReachedSince(this.dataDir, window.since);
    const agreementRate = negotiations === null || negotiations === 0
      ? null
      : Math.round((agreementsReached / negotiations) * 10_000) / 100;
    if (negotiations === null) {
      limitations.push({ source: "negotiation_ledger", note: "无法计算 agreements_reached 和 agreement_rate" });
    } else if (negotiations === 0) {
      limitations.push({ source: "agreement_rate", note: "分母 negotiations 为 0，agreement_rate 不适用" });
    }
    return {
      merchant_id: input.merchant_id,
      period: window.label,
      generated_at: now,
      metrics: [
        {
          name: "distinct_buyers",
          value: distinctBuyers,
          unit: "count",
          observed_at: now,
          note: "按认证身份去重，不等同于真实自然人数量",
        },
        { name: "contact_events", value: contactEvents, unit: "count", observed_at: now },
        { name: "negotiations", value: negotiations, unit: "count", observed_at: now },
        { name: "agreements_reached", value: negotiations === null ? null : agreementsReached, unit: "count", observed_at: now },
        {
          name: "agreement_rate",
          value: agreementRate,
          unit: "percent",
          observed_at: now,
          note: "agreements_reached / negotiations；分母为统计窗口内的触达磋商数",
        },
        { name: "human_review_count", value: reviews.length, unit: "count", observed_at: now },
        { name: "pending_action_count", value: pending.length, unit: "count", observed_at: now },
        { name: "active_negotiations", value: negotiationDigest.length, unit: "count", observed_at: now },
        ...acceptedAnalytics,
      ],
      alerts: {
        active_negotiations: negotiationDigest.length,
        human_reviews: reviews.length,
        pending_actions: pending.length,
        low_stock: null,
      },
      top_sku_contacts: topSkuContacts,
      limitations: [
        ...limitations,
        ...analytics.limitations,
        ...(catalogHealth.out_of_stock === null
          ? [{ source: "inventory", note: "当前没有精确库存数据，无法计算缺货数量" }]
          : [{ source: "inventory", note: "当前没有统一低库存阈值数据源" }]),
      ],
    };
  }

  async queryMetric(input: {
    merchant_id: string;
    metric: string;
    period?: string;
    granularity?: "day" | "week" | "month";
  }): Promise<MetricSeries> {
    assertOwned(input.merchant_id, this.merchantId);
    const now = this.now();
    const window = periodWindow(input.period, now);
    const granularity = input.granularity ?? "day";
    if (!["distinct_buyers", "contact_events", "negotiations"].includes(input.metric)) {
      if (this.analyticsSource !== undefined) {
        try {
          const sourceSeries = await this.analyticsSource.queryMetric({
            merchant_id: this.merchantId,
            metric: input.metric,
            period: window.label,
            granularity,
          });
          if (sourceSeries !== undefined) {
            if (!this.validSourceSeries(sourceSeries, input.metric, window.label, granularity)) {
              return { metric: input.metric, unit: "count", period: window.label, granularity, points: [], note: "分析数据源返回了无效指标序列" };
            }
            return sourceSeries;
          }
        } catch {
          return {
            metric: input.metric,
            unit: "count",
            period: window.label,
            granularity,
            points: [],
            note: "分析数据源暂时不可用",
          };
        }
      }
      return {
        metric: input.metric,
        unit: "count",
        period: window.label,
        granularity,
        points: [],
        note: "当前数据源不提供该指标",
      };
    }
    const statsPath = readStatsPath(this.dataDir);
    if (!existsSync(statsPath)) {
      return {
        metric: input.metric,
        unit: "count",
        period: window.label,
        granularity,
        points: [],
        note: "没有买家触达统计数据",
      };
    }
    const store = openMerchantStatsStore({ dbPath: statsPath });
    try {
      const daily = store.dailySince(window.since);
      const byDay = new Map(daily.map((row) => [row.day, row]));
      const days = Number(window.label.slice(0, -1));
      const points: MetricPoint[] = [];
      for (let i = 0; i < days; i += 1) {
        const date = dayShift(window.since, i);
        const row = byDay.get(date);
        const field = input.metric === "contact_events"
          ? "contact_events"
          : input.metric === "negotiations"
            ? "negotiations"
            : "distinct_buyers";
        points.push({ date, value: row?.[field] ?? 0 });
      }
      return {
        metric: input.metric,
        unit: "count",
        period: window.label,
        granularity,
        points: aggregateMetricPoints(points, granularity),
      };
    } finally {
      store.close();
    }
  }

  async getCatalogHealth(input: { merchant_id: string }): Promise<CatalogHealth> {
    assertOwned(input.merchant_id, this.merchantId);
    const products = await this.merchantClient.listProducts(input.merchant_id);
    const outOfStock = products.some((product) => product.stock === undefined)
      ? null
      : products.filter((product) => (product.stock ?? 0) <= 0).length;
    return {
      total: products.length,
      active: products.filter((product) => !product.paused).length,
      paused: products.filter((product) => product.paused).length,
      out_of_stock: outOfStock,
      observed_at: this.now(),
    };
  }

  async getNegotiationDigest(input: {
    merchant_id: string;
    status?: "active" | "agreement" | "all";
    limit?: number;
  }): Promise<NegotiationDigestItem[]> {
    assertOwned(input.merchant_id, this.merchantId);
    const ledger = new LedgerStore({ dir: path.join(this.dataDir, "a2a"), now: this.now });
    const wanted = input.status ?? "all";
    const rows: NegotiationDigestItem[] = [];
    for (const negotiationId of ledger.listNegotiations()) {
      const row = extractNegotiation(negotiationId, ledger.events(negotiationId));
      if (row === undefined) continue;
      const active = !(TERMINAL_PHASES as readonly string[]).includes(row.phase);
      const agreement = row.agreement_id !== undefined || row.phase === "AGREEMENT_REACHED";
      if (wanted === "active" && !active) continue;
      if (wanted === "agreement" && !agreement) continue;
      rows.push(row);
    }
    return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, Math.max(1, Math.min(input.limit ?? 20, 100)));
  }

  async getPendingActions(): Promise<PendingActionSummary[]> {
    return this.approvals.listPending().map((candidate) => ({
      candidate_id: candidate.candidate_id,
      tool: candidate.tool,
      risk: candidate.risk,
      status: candidate.status,
      expires_at: candidate.expires_at,
      stale_sensitive: true,
    }));
  }

  async getCandidatePreview(input: {
    principal_id: string;
    candidate_id: string;
  }): Promise<MerchantChangePreview | undefined> {
    if (input.principal_id !== this.principalId) {
      throw new Error("principal identity does not match the bound session");
    }
    return publicCandidatePreview(this.approvals.get(input.candidate_id));
  }
}
