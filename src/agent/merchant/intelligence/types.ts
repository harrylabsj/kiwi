export interface DataLimitation {
  source: string;
  note: string;
}

export type MetricUnit = "count" | "percent" | "minor_currency";

/** Formal analytics metric names understood by the optional commerce source. */
export type FormalAnalyticsMetric =
  | "gross_sales"
  | "orders"
  | "ad_spend"
  | "roas"
  | "campaign_conversions";

export interface MetricValue {
  name: string;
  value: number | null;
  unit: MetricUnit;
  currency?: string;
  observed_at: string;
  note?: string;
}

export interface MetricPoint {
  date: string;
  value: number;
}

export interface MetricSeries {
  metric: string;
  unit: MetricUnit;
  period: string;
  /** Points use UTC dates; week = Monday, month = first day of month. */
  granularity: "day" | "week" | "month";
  points: MetricPoint[];
  note?: string;
}

/**
 * Optional authoritative sales/marketing adapter. It is deliberately
 * separate from MerchantClient and MerchantStatsStore: deployments can wire
 * an ERP, order service or ad platform without granting the model direct
 * access to that system.
 */
export interface MerchantAnalyticsSource {
  getMetrics(input: {
    merchant_id: string;
    period: string;
  }): Promise<{ metrics: MetricValue[]; limitations?: DataLimitation[] }>;
  queryMetric(input: {
    merchant_id: string;
    metric: string;
    period: string;
    granularity: "day" | "week" | "month";
  }): Promise<MetricSeries | undefined>;
}

export interface MerchantChangePreview {
  candidate_id: string;
  tool: string;
  status: string;
  risk: string;
  expires_at: string;
  stale_sensitive: true;
  changes: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface CatalogHealth {
  total: number;
  active: number;
  paused: number;
  out_of_stock: number | null;
  observed_at: string;
}

export interface MerchantBusinessSnapshot {
  merchant_id: string;
  period: string;
  generated_at: string;
  metrics: MetricValue[];
  alerts: {
    active_negotiations: number;
    human_reviews: number;
    pending_actions: number;
    low_stock: number | null;
  };
  top_sku_contacts?: Array<{
    sku: string;
    contact_events: number;
    distinct_buyers: number;
    negotiations: number;
  }>;
  limitations: DataLimitation[];
}

export interface NegotiationDigestItem {
  negotiation_id: string;
  phase: string;
  buyer_identity: string;
  skus: string[];
  quantity?: number;
  latest_price_minor?: number;
  currency?: string;
  needs_human_review: boolean;
  updated_at: string;
  agreement_id?: string;
}

export interface PendingActionSummary {
  candidate_id: string;
  tool: string;
  risk: string;
  status: string;
  expires_at: string;
  /** Literal invariant: every approval must revalidate current preconditions. */
  stale_sensitive: true;
}
