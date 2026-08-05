/**
 * Buyer task model types (design §11). All shapes are stored as JSON
 * columns in the per-agent SQLite database; private thresholds may be
 * Vault references instead of plaintext.
 */

export const BUYER_TASK_STATUSES = [
  "draft",
  "clarifying",
  "ready",
  "searching",
  "tracking",
  "shortlist_ready",
  "awaiting_user",
  "consulting",
  "negotiating",
  "selected_nonbinding",
  "cancelled",
  "failed",
  "expired",
] as const;
export type BuyerTaskStatus = (typeof BUYER_TASK_STATUSES)[number];

/** Legal transitions (design §11.3). Anything else is rejected. */
export const TASK_TRANSITIONS: Readonly<Record<BuyerTaskStatus, readonly BuyerTaskStatus[]>> = {
  draft: ["clarifying", "ready", "cancelled"],
  clarifying: ["ready", "cancelled"],
  ready: ["searching"],
  searching: ["tracking", "shortlist_ready", "failed"],
  tracking: ["searching", "shortlist_ready", "expired"],
  shortlist_ready: ["awaiting_user"],
  awaiting_user: ["searching", "consulting", "selected_nonbinding", "cancelled"],
  consulting: ["negotiating", "awaiting_user"],
  negotiating: ["awaiting_user", "selected_nonbinding"],
  // 选定不是死胡同：用户改主意或想再谈价时，可回到 consulting 重新磋商。
  selected_nonbinding: ["consulting"],
  cancelled: [],
  failed: [],
  expired: [],
};

export const TRACKING_RULE_TYPES = [
  "price_below",
  "stock_available",
  "delivery_before",
  "new_candidate",
  "periodic_review",
] as const;
export type TrackingRuleType = (typeof TRACKING_RULE_TYPES)[number];

export const RULE_STATUSES = ["active", "paused", "completed", "expired"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export const CANDIDATE_STATUSES = [
  "discovered",
  "tracked",
  "shortlisted",
  "rejected",
  "selected",
  "stale",
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export type CandidateEligibility = "eligible" | "ineligible" | "unknown";

/** Structured search intent extracted from the user's goal (§11.2). */
export interface TaskIntent {
  category?: string;
  use_case?: string;
  quantity?: number;
  location_precision?: "city" | "district";
  city?: string;
  area?: string;
  needed_by?: string;
  required_terms?: string[];
  preferences?: string[];
  query_text?: string;
  open_questions?: string[];
}

/** Current-task hard constraints; private values may be Vault refs (§11.2). */
export interface TaskConstraints {
  max_total_price?: number;
  max_total_price_vault_ref?: string;
  latest_eta?: string;
  required_terms?: string[];
  exclude_out_of_stock?: boolean;
}

export const RANKING_DIMENSIONS = [
  "match",
  "total_cost",
  "promotion",
  "price_history",
  "stock",
  "delivery",
  "after_sales",
  "preference_fit",
  "merchant_quality",
  "freshness",
] as const;
export type RankingDimension = (typeof RANKING_DIMENSIONS)[number];

/** Every weight must trace to the user, a confirmed memory, or defaults (§12.3). */
export interface RankingPolicy {
  weights: Partial<Record<RankingDimension, number>>;
  /** dimension -> "user_instruction" | "default" | a memory_id */
  sources: Partial<Record<RankingDimension, string>>;
}

export interface SearchBudget {
  max_candidates: number;
  max_requests: number;
  timeout_ms: number;
}

export interface TrackingPolicy {
  default_interval_seconds: number;
  default_cooldown_seconds: number;
  observation_ttl_seconds: number;
}

export interface BuyerTask {
  task_id: string;
  principal_id: string;
  status: BuyerTaskStatus;
  goal_text: string;
  intent: TaskIntent;
  constraints: TaskConstraints;
  ranking_policy: RankingPolicy;
  connector_scope: { connectors: string[] };
  search_budget: SearchBudget;
  tracking_policy: TrackingPolicy;
  selected_candidate_id?: string;
  next_run_at?: string;
  expires_at?: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export const TASK_EVENT_TYPES = [
  "created",
  "clarified",
  "search_started",
  "observation_added",
  "shortlisted",
  "tracking_installed",
  "tracking_triggered",
  "notification",
  "approval_requested",
  "consultation_linked",
  "selected",
  "status_changed",
  "failed",
  "expired",
  "cancelled",
] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export const CONSULTATION_LINK_STATUSES = [
  "consulting",
  "negotiating",
  "closed",
  "stale",
] as const;
export type ConsultationLinkStatus = (typeof CONSULTATION_LINK_STATUSES)[number];

/**
 * Buyer Task <-> Marketplace Conversation association (design §11.8).
 * The conversation itself stays authoritative in shopping-cli; this row only
 * links the task/candidate to its id and tracks our own last-processed cursor.
 */
export interface ConsultationLink {
  link_id: string;
  task_id: string;
  candidate_id?: string;
  connector_id: string;
  conversation_id: string;
  status: ConsultationLinkStatus;
  last_message_id?: string;
  created_at: string;
  updated_at: string;
}

export interface TaskEvent {
  event_id: string;
  task_id: string;
  type: TaskEventType | string;
  payload: Record<string, unknown>;
  origin: "user" | "scheduler" | "model" | "connector" | "policy";
  idempotency_key: string;
  created_at: string;
}

export interface ProductCandidate {
  candidate_id: string;
  task_id: string;
  connector_id: string;
  platform: string;
  external_product_id: string;
  sku?: string;
  merchant_id?: string;
  canonical_key: string;
  eligibility: CandidateEligibility;
  candidate_status: CandidateStatus;
  score?: number;
  score_explanation?: ScoreExplanation;
  rejection_reasons: string[];
  first_seen_at: string;
  last_seen_at: string;
  latest_observation_id?: string;
}

export interface ProductObservation {
  observation_id: string;
  candidate_id: string;
  observed_at: string;
  source_url_or_ref: string;
  title: string;
  price: { list: number; currency: string; delivery_fee: number };
  promotion: Record<string, unknown>;
  stock: { quantity: number; observed_at: string };
  delivery: Record<string, unknown>;
  after_sales: Record<string, unknown>;
  merchant: Record<string, unknown>;
  content_hash: string;
  fresh_until: string;
}

export interface TrackingRule {
  rule_id: string;
  task_id: string;
  candidate_id?: string;
  rule_type: TrackingRuleType;
  condition: Record<string, unknown>;
  interval_seconds: number;
  next_check_at: string;
  last_triggered_at?: string;
  cooldown_seconds: number;
  status: RuleStatus;
}

export interface DimensionScore {
  dimension: RankingDimension;
  score: number;
  weight: number;
  /** "user_instruction" | "default" | memory_id */
  source: string;
  note: string;
}

export interface ScoreExplanation {
  dimensions: DimensionScore[];
  used_memories: string[];
  stale_facts: string[];
}

export class BuyerTaskError extends Error {
  readonly code: "validation" | "not_found" | "conflict" | "illegal_transition" | "vault_unavailable";
  constructor(code: BuyerTaskError["code"], message: string) {
    super(message);
    this.name = "BuyerTaskError";
    this.code = code;
  }
}

export const DEFAULT_SEARCH_BUDGET: SearchBudget = {
  max_candidates: 20,
  max_requests: 10,
  timeout_ms: 30_000,
};

export const DEFAULT_TRACKING_POLICY: TrackingPolicy = {
  default_interval_seconds: 1800,
  default_cooldown_seconds: 3600,
  observation_ttl_seconds: 1800,
};
