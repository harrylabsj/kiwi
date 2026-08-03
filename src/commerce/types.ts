/**
 * CommerceGateway / CommerceClient — the stable boundary between Kiwi and
 * shopping-cli. All business access goes through this interface; Kiwi never
 * touches Python modules, SQLite, or platform databases directly.
 *
 * Implementations:
 * - HttpCommerceClient  (commerce/http-client.ts) — shopping-cli 2.x HTTP API
 * - FakeCommerceClient  (commerce/fake-client.ts) — deterministic in-memory
 *   LocalMarketplace semantics for tests and offline development
 */

import type {
  CommerceCapabilities,
  NegotiationDecision,
  NegotiationSnapshot,
  PolicyResult,
  Role,
} from "../negotiation/types.js";

/** A conversation message that is waiting for this agent to act. */
export interface PendingMessage {
  conversation_id: string;
  message_id: number;
  /** e.g. "waiting_merchant" — authoritative routing state. */
  conversation_status: string;
  sender_role: Role;
  preview: string;
  created_at: string;
}

export interface ClaimResult {
  claimed: boolean;
  status: string;
  attempts: number;
  idempotency_key: string;
}

export type ProcessStatus = "processing" | "processed" | "failed" | "abandoned";

export interface ProcessResult {
  status: ProcessStatus;
  message_id: number;
  last_error?: string;
}

export interface CommerceHealth {
  ok: boolean;
  service?: string;
  version?: string;
  details?: Record<string, unknown>;
}

export interface CommerceClient {
  /** Service liveness/version. Used by `kiwi doctor`. */
  health(): Promise<CommerceHealth>;

  /**
   * Protocol and capability advertisement. Kiwi fails closed when
   * shopping.negotiation/0.1 or a required capability is missing.
   */
  getCapabilities(): Promise<CommerceCapabilities>;

  /**
   * Messages routed to this agent and not yet replied to. The gateway
   * derives role and owner from the Bearer token; the client never sends
   * and never trusts a claimed role/owner_id.
   */
  listPendingMessages(): Promise<PendingMessage[]>;

  /**
   * Claim a message for processing. Idempotent: the same idempotency key
   * returns the same outcome; a non-retryable existing claim returns
   * claimed=false without an error.
   */
  claimMessage(input: {
    conversation_id: string;
    message_id: number;
    idempotency_key: string;
  }): Promise<ClaimResult>;

  /**
   * Authoritative, role-trimmed negotiation snapshot. Only available for a
   * conversation/message this agent has claimed.
   */
  getNegotiationSnapshot(input: {
    conversation_id: string;
    message_id: number;
  }): Promise<NegotiationSnapshot>;

  /**
   * The single write intent. The server-side policy gate is authoritative:
   * identity, turn (next_actor), claim binding, facts, private thresholds
   * and privacy are all re-checked there.
   */
  submitNegotiationDecision(input: {
    decision: NegotiationDecision;
    idempotency_key: string;
  }): Promise<PolicyResult>;

  completeClaim(input: { message_id: number; idempotency_key: string }): Promise<ProcessResult>;
  failClaim(input: {
    message_id: number;
    idempotency_key: string;
    error: string;
  }): Promise<ProcessResult>;
  abandonClaim(input: {
    message_id: number;
    idempotency_key: string;
    error: string;
  }): Promise<ProcessResult>;

  /**
   * Liveness for this identity's own processing claims. With message_id,
   * refreshes only that claim (and only while it is still processing);
   * without, refreshes all of the actor's processing claims. Never touches
   * settled or other identities' claims and never revives stale work.
   */
  heartbeat(input?: { message_id?: number }): Promise<HeartbeatResult>;

  /**
   * Crash recovery: abandon this identity's OWN stale processing claims
   * (updated_at older than ttl_seconds). Must run before any heartbeat on a
   * fresh runtime. Abandoned claims stay reclaimable.
   */
  abandonStaleClaims(input?: { ttl_seconds?: number }): Promise<StaleRecoveryResult>;
}

export interface HeartbeatResult {
  status: string;
  refreshed: number;
  at: string;
}

export interface StaleRecoveryResult {
  abandoned: number;
  message_ids: number[];
  ttl_seconds: number;
  at: string;
}

export type CommerceErrorKind =
  "auth" | "not_found" | "conflict" | "rate_limit" | "validation" | "transient";

export class CommerceError extends Error {
  readonly kind: CommerceErrorKind;
  readonly status?: number;

  constructor(kind: CommerceErrorKind, message: string, status?: number) {
    super(message);
    this.name = "CommerceError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** Idempotency key convention: agent_id + message_id + protocol version. */
export function idempotencyKey(
  agentId: string,
  messageId: number,
  protocolVersion: string,
): string {
  return `${agentId}:${messageId}:${protocolVersion}`;
}
