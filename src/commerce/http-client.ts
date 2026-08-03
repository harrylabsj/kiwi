/**
 * HttpCommerceClient — CommerceClient over the shopping-cli 2.x
 * shopping.negotiation/0.1 HTTP API (the authoritative Commerce Gateway).
 *
 * This is the only supported way Kiwi talks to a real marketplace. No Python
 * imports, no SQLite, no subprocess calls into shopping-cli business
 * commands. Auth is `Authorization: Bearer <token>`; the API answers with a
 * uniform `{"ok": true, ...}` / `{"ok": false, "error": ...}` envelope.
 *
 * Protocol mapping (references/negotiation-api.md on the shopping-cli side):
 * - GET  /capabilities                  -> getCapabilities (inner `capabilities`
 *                                          object, frozen-schema validated)
 * - GET  /negotiation/pending-messages  -> listPendingMessages (role/owner are
 *                                          derived from the token server-side;
 *                                          the client never sends them)
 * - POST /negotiation/claims            -> claimMessage
 * - GET  /negotiation/snapshot          -> getNegotiationSnapshot (frozen-schema
 *                                          validated, fail closed)
 * - POST /negotiation/decisions         -> submitNegotiationDecision (inner
 *                                          `policy_result`, frozen-schema
 *                                          validated)
 * - POST /negotiation/claims/{complete,fail,abandon} -> claim settlement
 *
 * Every gateway response that carries a frozen-contract object (capabilities,
 * snapshot, policy_result) is validated with the Kiwi Ajv frozen schemas
 * before use: a malformed envelope, a missing inner object, or a wrong field
 * type is classified as a `validation` CommerceError and never trusted.
 */

import { validateAgainst } from "../contracts/schemas.js";
import type {
  CommerceCapabilities,
  NegotiationDecision,
  NegotiationSnapshot,
  PolicyResult,
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

export interface HttpCommerceClientOptions {
  baseUrl: string;
  token: string;
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
}

type JsonObject = Record<string, unknown>;

const PROCESS_STATUSES: readonly ProcessStatus[] = [
  "processing",
  "processed",
  "failed",
  "abandoned",
];

export class HttpCommerceClient implements CommerceClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpCommerceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async request(method: string, path: string, body?: JsonObject): Promise<JsonObject> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new CommerceError(
        "transient",
        `Commerce API request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    let payload: JsonObject = {};
    try {
      payload = (await response.json()) as JsonObject;
    } catch {
      // Non-JSON body; handled via status mapping below.
    }

    if (!response.ok || payload.ok === false) {
      const message = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
      const kind =
        response.status === 401 || response.status === 403
          ? "auth"
          : response.status === 404
            ? "not_found"
            : response.status === 409
              ? "conflict"
              : response.status === 429
                ? "rate_limit"
                : response.status >= 400 && response.status < 500
                  ? "validation"
                  : "transient";
      throw new CommerceError(kind, message, response.status);
    }
    return payload;
  }

  /** Fail-closed shape check for envelope fields that carry typed data. */
  private static badShape(what: string, detail: string): CommerceError {
    return new CommerceError("validation", `Commerce API ${what} response invalid: ${detail}`);
  }

  private static requireObject(value: unknown, what: string): JsonObject {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw HttpCommerceClient.badShape(what, "expected an object");
    }
    return value as JsonObject;
  }

  async health(): Promise<CommerceHealth> {
    const payload = await this.request("GET", "/health");
    return {
      ok: payload.ok === true,
      service: typeof payload.service === "string" ? payload.service : undefined,
      version: typeof payload.version === "string" ? payload.version : undefined,
      details:
        typeof payload.checks === "object" && payload.checks !== null
          ? (payload.checks as Record<string, unknown>)
          : undefined,
    };
  }

  async getCapabilities(): Promise<CommerceCapabilities> {
    const payload = await this.request("GET", "/capabilities");
    const inner = HttpCommerceClient.requireObject(payload.capabilities, "capabilities");
    const errors = validateAgainst("capabilities", inner);
    if (errors.length > 0) {
      throw HttpCommerceClient.badShape("capabilities", errors.join("; "));
    }
    return inner as unknown as CommerceCapabilities;
  }

  async listPendingMessages(): Promise<PendingMessage[]> {
    const payload = await this.request("GET", "/negotiation/pending-messages");
    if (!Array.isArray(payload.pending)) {
      throw HttpCommerceClient.badShape("pending-messages", "pending must be an array");
    }
    return payload.pending.map((item: unknown, index: number): PendingMessage => {
      const what = `pending-messages[${index}]`;
      const m = HttpCommerceClient.requireObject(item, what);
      if (
        typeof m.conversation_id !== "string" ||
        !Number.isInteger(m.message_id) ||
        typeof m.conversation_status !== "string" ||
        (m.sender_role !== "buyer" && m.sender_role !== "merchant") ||
        typeof m.preview !== "string" ||
        typeof m.created_at !== "string"
      ) {
        throw HttpCommerceClient.badShape(what, "field types do not match the protocol");
      }
      return {
        conversation_id: m.conversation_id,
        message_id: m.message_id as number,
        conversation_status: m.conversation_status,
        sender_role: m.sender_role,
        preview: m.preview,
        created_at: m.created_at,
      };
    });
  }

  async claimMessage(input: {
    conversation_id: string;
    message_id: number;
    idempotency_key: string;
  }): Promise<ClaimResult> {
    const payload = await this.request("POST", "/negotiation/claims", {
      conversation_id: input.conversation_id,
      message_id: input.message_id,
      idempotency_key: input.idempotency_key,
    });
    const claim = HttpCommerceClient.requireObject(payload.claim, "claim");
    if (
      typeof claim.claimed !== "boolean" ||
      typeof claim.status !== "string" ||
      typeof claim.attempts !== "number" ||
      typeof claim.idempotency_key !== "string"
    ) {
      throw HttpCommerceClient.badShape("claim", "field types do not match the protocol");
    }
    return {
      claimed: claim.claimed,
      status: claim.status,
      attempts: claim.attempts,
      idempotency_key: claim.idempotency_key,
    };
  }

  async getNegotiationSnapshot(input: {
    conversation_id: string;
    message_id: number;
  }): Promise<NegotiationSnapshot> {
    const query =
      `conversation_id=${encodeURIComponent(input.conversation_id)}` +
      `&message_id=${encodeURIComponent(String(input.message_id))}`;
    const payload = await this.request("GET", `/negotiation/snapshot?${query}`);
    const inner = HttpCommerceClient.requireObject(payload.snapshot, "snapshot");
    const errors = validateAgainst("snapshot", inner);
    if (errors.length > 0) {
      throw HttpCommerceClient.badShape("snapshot", errors.join("; "));
    }
    return inner as unknown as NegotiationSnapshot;
  }

  async submitNegotiationDecision(input: {
    decision: NegotiationDecision;
    idempotency_key: string;
  }): Promise<PolicyResult> {
    const payload = await this.request("POST", "/negotiation/decisions", {
      idempotency_key: input.idempotency_key,
      decision: input.decision as unknown as JsonObject,
    });
    const inner = HttpCommerceClient.requireObject(payload.policy_result, "policy_result");
    const errors = validateAgainst("policy-result", inner);
    if (errors.length > 0) {
      throw HttpCommerceClient.badShape("policy_result", errors.join("; "));
    }
    return inner as unknown as PolicyResult;
  }

  async completeClaim(input: {
    message_id: number;
    idempotency_key: string;
  }): Promise<ProcessResult> {
    return this.processVerb("complete", input.message_id);
  }

  async failClaim(input: {
    message_id: number;
    idempotency_key: string;
    error: string;
  }): Promise<ProcessResult> {
    return this.processVerb("fail", input.message_id, input.error);
  }

  async abandonClaim(input: {
    message_id: number;
    idempotency_key: string;
    error: string;
  }): Promise<ProcessResult> {
    return this.processVerb("abandon", input.message_id, input.error);
  }

  async heartbeat(input?: { message_id?: number }): Promise<HeartbeatResult> {
    const body: JsonObject = {};
    if (input?.message_id !== undefined) body.message_id = input.message_id;
    const payload = await this.request("POST", "/negotiation/claims/heartbeat", body);
    const inner = HttpCommerceClient.requireObject(payload.heartbeat, "heartbeat");
    if (
      typeof inner.status !== "string" ||
      !Number.isInteger(inner.refreshed) ||
      typeof inner.at !== "string"
    ) {
      throw HttpCommerceClient.badShape("heartbeat", "field types do not match the protocol");
    }
    return { status: inner.status, refreshed: inner.refreshed as number, at: inner.at };
  }

  async abandonStaleClaims(input?: { ttl_seconds?: number }): Promise<StaleRecoveryResult> {
    const body: JsonObject = {};
    if (input?.ttl_seconds !== undefined) body.ttl_seconds = input.ttl_seconds;
    const payload = await this.request("POST", "/negotiation/claims/abandon-stale", body);
    const inner = HttpCommerceClient.requireObject(payload.stale, "abandon-stale");
    if (
      !Number.isInteger(inner.abandoned) ||
      !Array.isArray(inner.message_ids) ||
      !inner.message_ids.every((id: unknown) => Number.isInteger(id)) ||
      !Number.isInteger(inner.ttl_seconds) ||
      typeof inner.at !== "string"
    ) {
      throw HttpCommerceClient.badShape("abandon-stale", "field types do not match the protocol");
    }
    return {
      abandoned: inner.abandoned as number,
      message_ids: inner.message_ids as number[],
      ttl_seconds: inner.ttl_seconds as number,
      at: inner.at,
    };
  }

  private async processVerb(
    verb: "complete" | "fail" | "abandon",
    messageId: number,
    error?: string,
  ): Promise<ProcessResult> {
    const payload = await this.request("POST", `/negotiation/claims/${verb}`, {
      message_id: messageId,
      ...(error !== undefined ? { error } : {}),
    });
    const process = HttpCommerceClient.requireObject(payload.process, `claims/${verb}`);
    if (
      typeof process.status !== "string" ||
      !PROCESS_STATUSES.includes(process.status as ProcessStatus)
    ) {
      throw HttpCommerceClient.badShape(`claims/${verb}`, "process.status invalid");
    }
    const result: ProcessResult = {
      status: process.status as ProcessStatus,
      message_id: messageId,
    };
    if (typeof process.last_error === "string") result.last_error = process.last_error;
    return result;
  }
}
