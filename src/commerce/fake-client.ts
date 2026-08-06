/**
 * FakeCommerceClient — deterministic, in-memory implementation of the
 * CommerceClient interface with LocalMarketplace semantics, for both roles.
 *
 * Exists so tests and local development never depend on a real model or a
 * running shopping-cli service. It enforces a representative subset of the
 * authoritative server-side policy gate: schema validation, next_actor
 * routing, claim binding, SKU/quantity facts, merchant private price floor,
 * policy-ref validity, private-threshold leakage scan, idempotent submit,
 * and the no-order boundary. The buyer's private budget is NOT here — like
 * the real gateway, the fake never sees it; it is enforced locally inside
 * the Kiwi submit tool (runtime/buyer-policy.ts).
 *
 * Each client instance is bound to a token-derived identity (role + owner),
 * mirroring the real API where the Bearer token determines the actor. Two
 * clients can share one marketplace state (createFakeMarketplace) so buyer
 * and merchant agents can alternate turns in-process.
 */

import { validateAgainst } from "../contracts/schemas.js";
import {
  PROTOCOL_VERSION,
  type CommerceCapabilities,
  type NegotiationDecision,
  type NegotiationSnapshot,
  type PolicyResult,
  type Role,
} from "../negotiation/types.js";
import {
  CommerceError,
  type ClaimResult,
  type CommerceClient,
  type CommerceHealth,
  type HeartbeatResult,
  type PendingMessage,
  type ProcessResult,
  type ProcessStatus,
  type StaleRecoveryResult,
} from "./types.js";

export interface FakeProduct {
  sku: string;
  title: string;
  currency: string;
  list_price: number;
  stock_quantity: number;
  /** Private merchant floor price. Never appears in snapshots. */
  floor_price?: number;
  delivery: { eta_start: string; eta_end: string; fee: number; notes?: string };
  policies: { ref: string; summary: string }[];
}

export interface FakeMarketplaceConfig {
  merchant_id: string;
  buyer_id: string;
  product: FakeProduct;
  /** The inbound buyer message that starts the negotiation. */
  buyer_message_text?: string;
  /** Fixed clock (ISO string) so tests are deterministic. */
  now?: string;
  /** Retryable rejections allowed before escalation. Default 2. */
  max_retries?: number;
  /** Stock staleness window in milliseconds. Default 1 hour. */
  stock_ttl_ms?: number;
}

/** Token-derived identity, like the real gateway derives from a Bearer token. */
export interface FakeIdentity {
  role: Role;
  owner_id: string;
}

export interface FakeMessage {
  id: number;
  conversation_id: string;
  sender_role: Role;
  created_at: string;
  action?: string;
  public_message: string;
  proposal?: Record<string, unknown> | null;
}

interface ClaimRow {
  message_id: number;
  /** Token-derived identity that owns the claim, e.g. shopping-cli-merchant-agent:m1. */
  agent_id: string;
  idempotency_key: string;
  status: ProcessStatus;
  attempts: number;
  updated_at: string;
  last_error?: string;
}

interface AuditEvent {
  event: string;
  conversation_id: string;
  actor: string;
  details: Record<string, unknown>;
  created_at: string;
}

/** Mutable marketplace state; share it to let two role clients alternate. */
export interface FakeMarketplaceState {
  conversationStatus: string;
  messageSeq: number;
  msgs: FakeMessage[];
  claims: Map<number, ClaimRow>;
  submissions: Map<string, PolicyResult>;
  audit: AuditEvent[];
  openIssues: string[];
  currentProposal: Record<string, unknown> | null;
}

const RETRYABLE: ReadonlySet<ProcessStatus> = new Set(["failed", "abandoned"]);

function conversationIdOf(config: FakeMarketplaceConfig): string {
  return `conv-${config.merchant_id}`;
}

function initialState(config: FakeMarketplaceConfig): FakeMarketplaceState {
  const state: FakeMarketplaceState = {
    conversationStatus: "waiting_merchant",
    messageSeq: 0,
    msgs: [],
    claims: new Map(),
    submissions: new Map(),
    audit: [],
    openIssues: [],
    currentProposal: null,
  };
  const text = config.buyer_message_text ?? "买 2 件可以便宜一点吗？";
  state.messageSeq += 1;
  state.msgs.push({
    id: state.messageSeq,
    conversation_id: conversationIdOf(config),
    sender_role: "buyer",
    created_at: config.now ?? "2026-08-03T15:00:00+08:00",
    action: "ask",
    public_message: text,
  });
  return state;
}

export interface FakeCommerceClientOptions {
  identity?: FakeIdentity;
  state?: FakeMarketplaceState;
}

/** One marketplace with both role clients bound to it (buyer + merchant). */
export function createFakeMarketplace(config: FakeMarketplaceConfig): {
  state: FakeMarketplaceState;
  merchant: FakeCommerceClient;
  buyer: FakeCommerceClient;
} {
  const state = initialState(config);
  return {
    state,
    merchant: new FakeCommerceClient(config, {
      identity: { role: "merchant", owner_id: config.merchant_id },
      state,
    }),
    buyer: new FakeCommerceClient(config, {
      identity: { role: "buyer", owner_id: config.buyer_id },
      state,
    }),
  };
}

export class FakeCommerceClient implements CommerceClient {
  readonly config: FakeMarketplaceConfig;
  readonly identity: FakeIdentity;
  private now: string;
  private readonly maxRetries: number;
  private readonly stockTtlMs: number;
  private readonly state: FakeMarketplaceState;

  constructor(config: FakeMarketplaceConfig, options?: FakeCommerceClientOptions) {
    this.config = config;
    this.identity = options?.identity ?? { role: "merchant", owner_id: config.merchant_id };
    this.state = options?.state ?? initialState(config);
    this.now = config.now ?? "2026-08-03T15:00:00+08:00";
    this.maxRetries = config.max_retries ?? 2;
    this.stockTtlMs = config.stock_ttl_ms ?? 3_600_000;
  }

  private get counterpart(): Role {
    return this.identity.role === "merchant" ? "buyer" : "merchant";
  }

  /** Server-style claim identity, e.g. shopping-cli-merchant-agent:merchant-001. */
  private get agentId(): string {
    return `shopping-cli-${this.identity.role}-agent:${this.identity.owner_id}`;
  }

  /** Test helper: advance the fake clock deterministically (stale-claim tests). */
  advanceTime(ms: number): void {
    this.now = new Date(Date.parse(this.now) + ms).toISOString();
  }

  private get waitingStatus(): string {
    return this.identity.role === "merchant" ? "waiting_merchant" : "waiting_buyer";
  }

  // ---- test inspection helpers -------------------------------------------

  auditEvents(): readonly AuditEvent[] {
    return this.state.audit;
  }

  messages(): readonly FakeMessage[] {
    return this.state.msgs;
  }

  conversationState(): { status: string; open_issues: string[] } {
    return { status: this.state.conversationStatus, open_issues: [...this.state.openIssues] };
  }

  /** Test inspection: current process status of a claim, if any. */
  claimStatus(messageId: number): ProcessStatus | undefined {
    return this.state.claims.get(messageId)?.status;
  }

  private record(event: string, details: Record<string, unknown>): void {
    this.state.audit.push({
      event,
      conversation_id: this.conversationId,
      actor: `${this.identity.role}:${this.identity.owner_id}`,
      details: { schema_version: 1, event_type: event, ...details },
      created_at: this.now,
    });
  }

  private get conversationId(): string {
    return conversationIdOf(this.config);
  }

  private appendMessage(
    sender: Role,
    text: string,
    extra: { action?: string; proposal?: Record<string, unknown> | null } = {},
  ): FakeMessage {
    this.state.messageSeq += 1;
    const msg: FakeMessage = {
      id: this.state.messageSeq,
      conversation_id: this.conversationId,
      sender_role: sender,
      created_at: this.now,
      public_message: text,
    };
    if (extra.action !== undefined) msg.action = extra.action;
    if (extra.proposal !== undefined) msg.proposal = extra.proposal;
    this.state.msgs.push(msg);
    return msg;
  }

  // ---- CommerceClient -----------------------------------------------------

  health(): Promise<CommerceHealth> {
    return Promise.resolve({
      ok: true,
      service: "kiwi-fake-marketplace",
      version: "0.5.0",
      details: { storage: "in-memory" },
    });
  }

  getCapabilities(): Promise<CommerceCapabilities> {
    return Promise.resolve({
      protocol_versions: [PROTOCOL_VERSION],
      backend: "local_marketplace",
      capabilities: {
        catalog_read: true,
        inventory_read: true,
        consultation_read: true,
        consultation_write: true,
        price_negotiate: true,
        webhook: false,
        orders: false,
      },
    });
  }

  listPendingMessages(): Promise<PendingMessage[]> {
    const expectedOwner =
      this.identity.role === "merchant" ? this.config.merchant_id : this.config.buyer_id;
    if (this.identity.owner_id !== expectedOwner) return Promise.resolve([]);
    if (this.state.conversationStatus !== this.waitingStatus) return Promise.resolve([]);
    const last = this.state.msgs[this.state.msgs.length - 1];
    if (!last || last.sender_role !== this.counterpart) return Promise.resolve([]);
    // A message under an active (processing) claim is not pending work:
    // without this, two same-identity workers would both see it and both
    // proceed. Settled claims (failed/abandoned/processed) stay listed —
    // failed/abandoned are reclaimable, processed follows the real
    // gateway's reply-based listing.
    if (this.state.claims.get(last.id)?.status === "processing") return Promise.resolve([]);
    return Promise.resolve([
      {
        conversation_id: this.conversationId,
        message_id: last.id,
        conversation_status: this.state.conversationStatus,
        sender_role: this.counterpart,
        preview: last.public_message,
        created_at: last.created_at,
      },
    ]);
  }

  claimMessage(input: {
    conversation_id: string;
    message_id: number;
    idempotency_key: string;
  }): Promise<ClaimResult> {
    if (input.conversation_id !== this.conversationId) {
      return Promise.reject(
        new CommerceError("not_found", `Unknown conversation ${input.conversation_id}`, 404),
      );
    }
    const msg = this.state.msgs.find((m) => m.id === input.message_id);
    const last = this.state.msgs[this.state.msgs.length - 1];
    if (!msg || msg.sender_role !== this.counterpart || last?.id !== msg.id) {
      return Promise.reject(
        new CommerceError(
          "validation",
          `Message ${input.message_id} is not a claimable ${this.counterpart} message`,
          400,
        ),
      );
    }
    const existing = this.state.claims.get(input.message_id);
    if (existing) {
      // Contract (commerce/types.ts): a non-retryable existing claim returns
      // claimed=false. This holds even for a same-key replay while the claim
      // is still processing — the key is deterministic
      // (agent_id:message_id:protocol), so two same-identity workers produce
      // the same key and must never both be told they hold the claim.
      if (!RETRYABLE.has(existing.status)) {
        return Promise.resolve({
          claimed: false,
          status: existing.status,
          attempts: existing.attempts,
          idempotency_key: existing.idempotency_key,
        });
      }
      // failed/abandoned are reclaimable — including under the same
      // deterministic key, which is exactly how a retrying worker reclaims.
      existing.status = "processing";
      existing.attempts += 1;
      existing.idempotency_key = input.idempotency_key;
      existing.agent_id = this.agentId;
      existing.updated_at = this.now;
      delete existing.last_error;
      this.record("agent_message_claimed", {
        message_id: input.message_id,
        attempts: existing.attempts,
      });
      return Promise.resolve({
        claimed: true,
        status: "processing",
        attempts: existing.attempts,
        idempotency_key: existing.idempotency_key,
      });
    }
    const row: ClaimRow = {
      message_id: input.message_id,
      agent_id: this.agentId,
      idempotency_key: input.idempotency_key,
      status: "processing",
      attempts: 1,
      updated_at: this.now,
    };
    this.state.claims.set(input.message_id, row);
    this.record("agent_message_claimed", { message_id: input.message_id, attempts: 1 });
    return Promise.resolve({
      claimed: true,
      status: "processing",
      attempts: 1,
      idempotency_key: input.idempotency_key,
    });
  }

  private requireClaim(messageId: number): ClaimRow {
    const claim = this.state.claims.get(messageId);
    // Like the real gateway, another identity's claim is invisible (404).
    if (!claim || claim.agent_id !== this.agentId) {
      throw new CommerceError("not_found", `No claim for message ${messageId} by this agent`, 404);
    }
    if (claim.status !== "processing") {
      throw new CommerceError("conflict", `Message ${messageId} is not under an active claim`, 409);
    }
    return claim;
  }

  async getNegotiationSnapshot(input: {
    conversation_id: string;
    message_id: number;
  }): Promise<NegotiationSnapshot> {
    if (input.conversation_id !== this.conversationId) {
      return Promise.reject(
        new CommerceError("not_found", `Unknown conversation ${input.conversation_id}`, 404),
      );
    }
    this.requireClaim(input.message_id);
    const p = this.config.product;
    const nextActor =
      this.state.conversationStatus === "waiting_merchant"
        ? "merchant"
        : this.state.conversationStatus === "waiting_buyer"
          ? "buyer"
          : "none";
    const snapshot: NegotiationSnapshot = {
      protocol_version: PROTOCOL_VERSION,
      conversation: {
        id: this.conversationId,
        status: this.state.conversationStatus as NegotiationSnapshot["conversation"]["status"],
        next_actor: nextActor,
      },
      role: this.identity.role,
      in_reply_to_message_id: input.message_id,
      product: {
        sku: p.sku,
        title: p.title,
        currency: p.currency,
        list_price: p.list_price,
      },
      stock: {
        status: p.stock_quantity > 2 ? "available" : p.stock_quantity > 0 ? "low" : "out_of_stock",
        quantity: p.stock_quantity,
        observed_at: this.now,
        reserved: false,
        source: { backend: "local_marketplace", observed_at: this.now },
      },
      delivery: { ...p.delivery },
      after_sales_policies: p.policies.map((pol) => ({ ...pol })),
      messages: this.state.msgs.slice(-20).map((m) => {
        const out: NegotiationSnapshot["messages"][number] = {
          id: m.id,
          sender_role: m.sender_role,
          created_at: m.created_at,
          public_message: m.public_message,
        };
        if (m.action !== undefined) {
          out.action = m.action as NegotiationSnapshot["messages"][number]["action"];
        }
        if (m.proposal !== undefined) {
          out.proposal = m.proposal as NegotiationSnapshot["messages"][number]["proposal"];
        }
        return out;
      }),
      current_proposal: this.state.currentProposal as NegotiationSnapshot["current_proposal"],
      open_issues: [...this.state.openIssues],
      policy_results: [],
    };
    return Promise.resolve(snapshot);
  }

  submitNegotiationDecision(input: {
    decision: NegotiationDecision;
    idempotency_key: string;
  }): Promise<PolicyResult> {
    const replay = this.state.submissions.get(input.idempotency_key);
    if (replay) return Promise.resolve(replay);

    const result = this.evaluate(input.decision);
    this.state.submissions.set(input.idempotency_key, result);
    return Promise.resolve(result);
  }

  /** The fake policy gate. Order follows the design's fixed gate sequence. */
  private evaluate(decision: NegotiationDecision): PolicyResult {
    const denied = (codes: string[], reason: string, retries: number): PolicyResult => {
      this.record("negotiation_policy_denied", { reason_codes: codes });
      return {
        protocol_version: PROTOCOL_VERSION,
        result: retries > 0 ? "rejected_retryable" : "human_required",
        conversation_id: this.conversationId,
        next_actor: this.identity.role,
        reason_codes: codes,
        public_reason: reason,
        retries_remaining: retries,
      };
    };

    // 4. Protocol version, types, enums, lengths, additional fields.
    const schemaErrors = validateAgainst("decision", decision);
    if (schemaErrors.length > 0) {
      return denied(["invalid_schema"], `决策结构不合法: ${schemaErrors[0] ?? "schema error"}`, 0);
    }

    // 2. Conversation, current status and next_actor.
    if (decision.conversation_id !== this.conversationId) {
      return denied(["wrong_conversation"], "会话不匹配。", 0);
    }
    if (this.state.conversationStatus !== this.waitingStatus) {
      return denied(["not_your_turn"], "当前不轮到本方行动。", 0);
    }

    // 3. Claim binding and in_reply_to matching.
    const claim = this.state.claims.get(decision.in_reply_to_message_id);
    if (!claim || claim.status !== "processing") {
      return denied(["claim_required"], "该消息未被当前 Agent 有效 claim。", 0);
    }
    const retriesLeft = Math.max(0, this.maxRetries - (claim.attempts - 1));

    // 5/6. Facts: SKU, quantity, stock observation, policy refs.
    const p = this.config.product;
    const needsProposal =
      decision.action === "propose" ||
      decision.action === "counter" ||
      decision.action === "accept_nonbinding";
    if (needsProposal && !decision.proposal) {
      return denied(
        ["proposal_required"],
        `action=${decision.action} 必须携带 proposal。`,
        retriesLeft,
      );
    }
    if (decision.proposal) {
      const prop = decision.proposal;
      if (prop.sku !== p.sku) {
        return denied(["wrong_sku"], "报价 SKU 不属于本会话商品。", 0);
      }
      if (prop.quantity > p.stock_quantity) {
        return denied(["insufficient_stock"], "数量超过当前可售库存。", retriesLeft);
      }
      const observedAt = Date.parse(prop.stock.observed_at);
      if (Number.isNaN(observedAt) || Date.parse(this.now) - observedAt > this.stockTtlMs) {
        return denied(["stale_inventory"], "库存观察时间已过期，请重新获取快照。", retriesLeft);
      }
      const knownRefs = new Set(p.policies.map((pol) => pol.ref));
      const badRef = prop.after_sales_policy_refs.find((r) => !knownRefs.has(r));
      if (badRef) {
        return denied(["unknown_policy_ref"], `售后政策引用不存在: ${badRef}`, retriesLeft);
      }
      // 8. Merchant floor price (merchant role only; the buyer's private
      // budget lives in the Kiwi profile and is never checked server-side).
      if (
        this.identity.role === "merchant" &&
        p.floor_price !== undefined &&
        prop.unit_price < p.floor_price
      ) {
        this.record("negotiation_human_required", { reason_codes: ["below_floor"] });
        this.state.conversationStatus = "human_required";
        return {
          protocol_version: PROTOCOL_VERSION,
          result: "human_required",
          conversation_id: this.conversationId,
          next_actor: "none",
          reason_codes: ["below_floor"],
          public_reason: "该报价需要人工处理。",
          retries_remaining: 0,
        };
      }
    }

    // 9. Privacy scan (merchant floor leak; merchant role only).
    if (
      this.identity.role === "merchant" &&
      p.floor_price !== undefined &&
      decision.public_message.includes(String(p.floor_price))
    ) {
      return denied(["policy_leak"], "公开文本可能泄露内部价格策略，请改写后重试。", retriesLeft);
    }

    // Escalation: escalate action or explicit human review request.
    if (decision.action === "escalate" || decision.request_human_review) {
      this.appendMessage(this.identity.role, decision.public_message, {
        action: decision.action,
      });
      this.state.conversationStatus = "human_required";
      this.record("negotiation_decision_submitted", { action: decision.action });
      this.record("negotiation_human_required", { reason_codes: decision.reason_codes });
      return {
        protocol_version: PROTOCOL_VERSION,
        result: "human_required",
        conversation_id: this.conversationId,
        next_actor: "none",
        reason_codes: decision.reason_codes.length > 0 ? decision.reason_codes : ["escalated"],
        public_reason: "已转人工处理。",
        retries_remaining: 0,
      };
    }

    // 10/11. Accept: normalize message, advance next_actor, audit. No order,
    // no payment, no reservation — negotiation only.
    const msg = this.appendMessage(this.identity.role, decision.public_message, {
      action: decision.action,
      proposal: (decision.proposal ?? null) as Record<string, unknown> | null,
    });
    if (decision.proposal)
      this.state.currentProposal = decision.proposal as unknown as Record<string, unknown>;
    this.state.openIssues = [...decision.open_issues];
    this.state.conversationStatus =
      decision.action === "decline" ? "closed" : `waiting_${this.counterpart}`;
    this.record("negotiation_decision_submitted", { action: decision.action });
    this.record("negotiation_policy_accepted", { message_id: msg.id });
    return {
      protocol_version: PROTOCOL_VERSION,
      result: "accepted",
      conversation_id: this.conversationId,
      message_id: msg.id,
      next_actor: decision.action === "decline" ? "none" : this.counterpart,
      reason_codes: decision.reason_codes,
      public_reason: "决策已接受并写入会话。",
      retries_remaining: retriesLeft,
    };
  }

  async completeClaim(input: {
    message_id: number;
    idempotency_key: string;
  }): Promise<ProcessResult> {
    const claim = this.requireClaim(input.message_id);
    claim.status = "processed";
    claim.updated_at = this.now;
    this.record("agent_message_processed", { message_id: input.message_id });
    return Promise.resolve({ status: "processed", message_id: input.message_id });
  }

  async failClaim(input: {
    message_id: number;
    idempotency_key: string;
    error: string;
  }): Promise<ProcessResult> {
    const claim = this.requireClaim(input.message_id);
    claim.status = "failed";
    claim.last_error = input.error;
    claim.updated_at = this.now;
    this.record("agent_message_failed", { message_id: input.message_id, error: input.error });
    return Promise.resolve({
      status: "failed",
      message_id: input.message_id,
      last_error: input.error,
    });
  }

  async abandonClaim(input: {
    message_id: number;
    idempotency_key: string;
    error: string;
  }): Promise<ProcessResult> {
    const claim = this.requireClaim(input.message_id);
    claim.status = "abandoned";
    claim.last_error = input.error;
    claim.updated_at = this.now;
    this.record("agent_message_abandoned", {
      message_id: input.message_id,
      error: input.error,
    });
    return Promise.resolve({
      status: "abandoned",
      message_id: input.message_id,
      last_error: input.error,
    });
  }

  heartbeat(input?: { message_id?: number }): Promise<HeartbeatResult> {
    let refreshed = 0;
    if (input?.message_id !== undefined) {
      const claim = this.state.claims.get(input.message_id);
      if (!claim || claim.agent_id !== this.agentId) {
        return Promise.reject(
          new CommerceError(
            "not_found",
            `No claim for message ${input.message_id} by this agent`,
            404,
          ),
        );
      }
      if (claim.status === "processing") {
        claim.updated_at = this.now;
        refreshed = 1;
      }
    } else {
      for (const claim of this.state.claims.values()) {
        if (claim.agent_id === this.agentId && claim.status === "processing") {
          claim.updated_at = this.now;
          refreshed += 1;
        }
      }
    }
    this.record("agent_message_heartbeat", {
      refreshed,
      ...(input?.message_id !== undefined ? { message_id: input.message_id } : {}),
    });
    return Promise.resolve({ status: "ok", refreshed, at: this.now });
  }

  abandonStaleClaims(input?: { ttl_seconds?: number }): Promise<StaleRecoveryResult> {
    const ttl = input?.ttl_seconds ?? 300;
    if (!Number.isInteger(ttl) || ttl <= 0) {
      return Promise.reject(
        new CommerceError("validation", "ttl_seconds must be a positive whole number", 400),
      );
    }
    const cutoff = Date.parse(this.now) - ttl * 1000;
    const abandoned: number[] = [];
    for (const claim of this.state.claims.values()) {
      if (
        claim.agent_id === this.agentId &&
        claim.status === "processing" &&
        Date.parse(claim.updated_at) < cutoff
      ) {
        claim.status = "abandoned";
        claim.last_error = `stale processing claim abandoned after ${ttl} seconds`;
        claim.updated_at = this.now;
        abandoned.push(claim.message_id);
        this.record("agent_message_abandoned", {
          message_id: claim.message_id,
          error: claim.last_error,
          reason: "stale_processing_claim",
        });
      }
    }
    return Promise.resolve({
      abandoned: abandoned.length,
      message_ids: abandoned,
      ttl_seconds: ttl,
      at: this.now,
    });
  }
}
