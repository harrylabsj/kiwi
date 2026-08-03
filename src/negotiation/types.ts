/**
 * shopping.negotiation/0.1 protocol types.
 *
 * These types mirror the frozen JSON schemas in
 * contracts/shopping.negotiation/0.1/. The schemas are the source of truth;
 * keep this file in sync with them.
 */

export const PROTOCOL_VERSION = "shopping.negotiation/0.1" as const;

export type Role = "buyer" | "merchant";

export type NextActor = "buyer" | "merchant" | "none";

export type ConversationStatus =
  "open" | "waiting_merchant" | "waiting_buyer" | "human_required" | "closed";

export type DecisionAction =
  "ask" | "propose" | "counter" | "accept_nonbinding" | "decline" | "escalate";

export type StockStatus = "available" | "low" | "out_of_stock" | "unknown";

export interface StockState {
  status: StockStatus;
  quantity: number;
  observed_at: string;
  /** Negotiation never reserves inventory; always false. */
  reserved: false;
}

export interface DeliveryQuote {
  eta_start: string;
  eta_end: string;
  fee: number;
}

export interface Proposal {
  sku: string;
  quantity: number;
  unit_price: number;
  currency: string;
  stock: StockState;
  delivery: DeliveryQuote;
  after_sales_policy_refs: string[];
  /** ISO date-time after which the quote is no longer a current commitment. */
  valid_until: string;
}

export interface NegotiationDecision {
  protocol_version: typeof PROTOCOL_VERSION;
  conversation_id: string;
  in_reply_to_message_id: number;
  action: DecisionAction;
  proposal?: Proposal;
  open_issues: string[];
  public_message: string;
  confidence?: number;
  reason_codes: string[];
  request_human_review: boolean;
}

export type PolicyResultKind = "accepted" | "rejected_retryable" | "human_required";

export interface PolicyResult {
  protocol_version: typeof PROTOCOL_VERSION;
  result: PolicyResultKind;
  conversation_id: string;
  message_id?: number;
  next_actor: NextActor;
  reason_codes: string[];
  public_reason: string;
  retries_remaining: number;
}

export interface SnapshotSource {
  backend: "local_marketplace" | "external_platform";
  external_id?: string;
  observed_at: string;
}

export interface SnapshotProduct {
  sku: string;
  title: string;
  currency: string;
  list_price: number;
  description?: string;
}

export interface SnapshotMessage {
  id: number;
  sender_role: Role;
  created_at: string;
  action?: DecisionAction;
  public_message: string;
  proposal?: Proposal | null;
}

export interface VisiblePolicyResult {
  result: PolicyResultKind;
  reason_codes: string[];
  public_reason: string;
}

export interface NegotiationSnapshot {
  protocol_version: typeof PROTOCOL_VERSION;
  conversation: {
    id: string;
    status: ConversationStatus;
    next_actor: NextActor;
  };
  role: Role;
  in_reply_to_message_id: number;
  product: SnapshotProduct;
  stock: StockState & { source: SnapshotSource };
  delivery: DeliveryQuote & { notes?: string };
  after_sales_policies: { ref: string; summary: string }[];
  messages: SnapshotMessage[];
  current_proposal: Proposal | null;
  open_issues: string[];
  policy_results: VisiblePolicyResult[];
}

export interface CapabilityFlags {
  catalog_read: boolean;
  inventory_read: boolean;
  consultation_read: boolean;
  consultation_write: boolean;
  price_negotiate: boolean;
  webhook: boolean;
  /** shopping.negotiation/0.1 never creates orders; always false. */
  orders: false;
}

export interface CommerceCapabilities {
  protocol_versions: string[];
  backend: "local_marketplace" | "external_platform";
  capabilities: CapabilityFlags;
}
