import type { WriteApprovalCandidateStore } from "../action-candidate.js";
import type { MerchantClient } from "../types.js";
import type {
  CatalogHealth,
  MerchantBusinessSnapshot,
  MetricSeries,
  NegotiationDigestItem,
  PendingActionSummary,
  MerchantChangePreview,
} from "./types.js";
import type { MerchantAnalyticsSource } from "./types.js";

export interface MerchantIntelligenceBackend {
  getBusinessSnapshot(input: { merchant_id: string; period?: string }): Promise<MerchantBusinessSnapshot>;
  queryMetric(input: {
    merchant_id: string;
    metric: string;
    period?: string;
    granularity?: "day" | "week" | "month";
  }): Promise<MetricSeries>;
  getCatalogHealth(input: { merchant_id: string }): Promise<CatalogHealth>;
  getNegotiationDigest(input: {
    merchant_id: string;
    status?: "active" | "agreement" | "all";
    limit?: number;
  }): Promise<NegotiationDigestItem[]>;
  getPendingActions(): Promise<PendingActionSummary[]>;
  getCandidatePreview(input: {
    principal_id: string;
    candidate_id: string;
  }): Promise<MerchantChangePreview | undefined>;
}

export interface MerchantIntelligenceDependencies {
  merchant_id: string;
  data_dir: string;
  merchant_client: MerchantClient;
  approvals: WriteApprovalCandidateStore;
  /** Principal that owns the process-bound approval store. */
  principal_id?: string;
  /** Optional formal sales/campaign/ROAS authority. */
  analytics_source?: MerchantAnalyticsSource;
  now?: () => string;
}
