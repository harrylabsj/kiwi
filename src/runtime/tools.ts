/**
 * Tool surface and beforeToolCall guard.
 *
 * The Pi agent for any role (buyer or merchant) sees exactly two tools:
 * get_negotiation_snapshot (read-only, bound conversation) and
 * submit_negotiation_decision (the single write intent, terminal).
 * No file, shell, edit, arbitrary HTTP, search, or dynamic-install tools
 * exist — nothing else is ever constructed, and the guard blocks anything
 * unknown even if a model emits a forged call.
 *
 * For buyer profiles the submit tool additionally runs the LOCAL private
 * policy gate (runtime/buyer-policy.ts) before the gateway is called, so
 * the private budget never leaves this process.
 *
 * The guard is a last line of defense only; the authoritative policy gate
 * remains the Commerce API.
 */

import { createHash } from "node:crypto";
import type {
  AgentTool,
  AgentToolResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import type { BuyerPolicy } from "../config/profile.js";
import { dereferenceSchema, loadSchema } from "../contracts/schemas.js";
import {
  PROTOCOL_VERSION,
  type NegotiationDecision,
  type PolicyResult,
  type Role,
} from "../negotiation/types.js";
import type { CommerceClient } from "../commerce/types.js";
import { checkBuyerLocalPolicy, localBuyerPolicyResult } from "./buyer-policy.js";

export const TOOL_GET_SNAPSHOT = "get_negotiation_snapshot";
export const TOOL_SUBMIT_DECISION = "submit_negotiation_decision";

/** Both roles share the same minimal surface: snapshot read + decision write. */
export const NEGOTIATION_TOOL_ALLOWLIST: readonly string[] = [
  TOOL_GET_SNAPSHOT,
  TOOL_SUBMIT_DECISION,
];

/** Back-compat alias for the M1 name. */
export const MERCHANT_TOOL_ALLOWLIST: readonly string[] = NEGOTIATION_TOOL_ALLOWLIST;

export function toolAllowlistForRole(role: Role): readonly string[] {
  // search_products is deliberately not exposed: conversations are bound to
  // a single SKU by the marketplace, so both roles get the same two tools.
  void role;
  return NEGOTIATION_TOOL_ALLOWLIST;
}

/** Hard cap on tool argument size, checked before execution. */
export const MAX_TOOL_ARGS_BYTES = 32 * 1024;

/**
 * Content-addressed submit idempotency: resubmitting byte-identical
 * arguments replays the stored gateway result, while a repaired decision
 * gets a fresh key. This survives process restarts without local state.
 */
export function submitIdempotencyKey(claimKey: string, decision: unknown): string {
  const canonical = stableStringify(decision);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${claimKey}:submit:${hash}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface ConversationBinding {
  conversation_id: string;
  message_id: number;
  idempotency_key: string;
}

export interface ToolOutcomeTracker {
  /** The latest policy result returned by the gateway, if any. */
  decisionResult?: PolicyResult;
  /** Number of submissions that reached the gateway (first + repairs). */
  submissions: number;
  /** Set when a submission was blocked by the max_retries budget. */
  submissionLimitExceeded?: boolean;
}

export interface NegotiationToolOptions {
  /**
   * Buyer profiles only: the local private policy gate evaluated BEFORE the
   * gateway is called. Private thresholds never leave this process.
   */
  buyerPolicy?: BuyerPolicy;
}

export function buildNegotiationTools(
  client: CommerceClient,
  binding: ConversationBinding,
  tracker: ToolOutcomeTracker,
  maxSubmissions: number,
  options?: NegotiationToolOptions,
): AgentTool<TSchema, unknown>[] {
  const decisionParameters = dereferenceSchema(loadSchema("decision")) as unknown as TSchema;

  const snapshotTool: AgentTool<TSchema, unknown> = {
    name: TOOL_GET_SNAPSHOT,
    label: "Get negotiation snapshot",
    description:
      "Read the authoritative, role-trimmed negotiation snapshot for the currently claimed " +
      "conversation. Takes no arguments; the conversation is bound by the runtime.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    } as unknown as TSchema,
    execute: async (): Promise<AgentToolResult<unknown>> => {
      const snapshot = await client.getNegotiationSnapshot({
        conversation_id: binding.conversation_id,
        message_id: binding.message_id,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
        details: snapshot,
      };
    },
  };

  const submitTool: AgentTool<TSchema, unknown> = {
    name: TOOL_SUBMIT_DECISION,
    label: "Submit negotiation decision",
    description:
      "Submit the single structured negotiation decision for this turn. This is the only " +
      "write intent and ends the turn when accepted. The marketplace policy gate is " +
      "authoritative and may reject with a repairable reason.",
    parameters: decisionParameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<unknown>> => {
      // max_retries semantics: the number of repair attempts allowed beyond
      // the first submission. Total gateway submissions per turn never exceed
      // max_retries + 1; exceeding the budget is blocked here (the gateway is
      // never called) and settles the turn as an auditable failure.
      if (tracker.submissions >= maxSubmissions) {
        tracker.submissionLimitExceeded = true;
        return {
          content: [
            {
              type: "text",
              text:
                `Submission budget exhausted: profile runtime.max_retries allows ` +
                `${maxSubmissions} submission(s) this turn (first attempt plus repairs). ` +
                "The turn is ending; do not resubmit.",
            },
          ],
          details: {
            error: "submission_limit_exceeded",
            submissions: tracker.submissions,
            max_submissions: maxSubmissions,
          },
          terminate: true,
        };
      }
      const decision = params as NegotiationDecision;
      // Buyer local private policy gate: evaluated before the gateway call.
      // A violation never reaches the server and its reason never contains
      // private threshold values.
      if (options?.buyerPolicy) {
        const violation = checkBuyerLocalPolicy(decision, options.buyerPolicy);
        if (violation) {
          tracker.submissions += 1;
          const result = localBuyerPolicyResult(
            binding.conversation_id,
            violation,
            maxSubmissions - tracker.submissions,
          );
          tracker.decisionResult = result;
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: { ...result, local: true },
            terminate: false,
          };
        }
      }
      const result = await client.submitNegotiationDecision({
        decision,
        idempotency_key: submitIdempotencyKey(binding.idempotency_key, decision),
      });
      tracker.decisionResult = result;
      tracker.submissions += 1;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
        details: result,
        // Stop the loop after a terminal result; retryable rejections let the
        // model repair and resubmit within the remaining step budget.
        terminate: result.result !== "rejected_retryable",
      };
    },
  };

  return [snapshotTool, submitTool];
}

/** Back-compat alias: merchant tools are the negotiation tools without a buyer gate. */
export function buildMerchantTools(
  client: CommerceClient,
  binding: ConversationBinding,
  tracker: ToolOutcomeTracker,
  maxSubmissions: number,
): AgentTool<TSchema, unknown>[] {
  return buildNegotiationTools(client, binding, tracker, maxSubmissions);
}

/**
 * beforeToolCall factory: allowlist enforcement, argument size cap, and
 * conversation/message binding checks. Runs after Pi's own schema
 * validation of the arguments.
 */
export function createToolGuard(
  allowlist: readonly string[],
  binding: ConversationBinding,
): (context: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined> {
  return async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const name = context.toolCall.name;
    if (!allowlist.includes(name)) {
      return {
        block: true,
        reason:
          `Tool "${name}" is not in the ${allowlist.join("/")} allowlist. ` +
          "No file, shell, edit, HTTP, or install tools exist.",
      };
    }

    const args = context.args;
    let size: number;
    try {
      // UTF-8 byte length, not string length: multibyte characters count
      // fully against the cap.
      size = Buffer.byteLength(JSON.stringify(args ?? {}), "utf8");
    } catch {
      return { block: true, reason: "Tool arguments are not serializable." };
    }
    if (size > MAX_TOOL_ARGS_BYTES) {
      return { block: true, reason: `Tool arguments exceed the ${MAX_TOOL_ARGS_BYTES} byte cap.` };
    }

    if (name === TOOL_GET_SNAPSHOT) {
      if (args !== null && typeof args === "object" && Object.keys(args as object).length > 0) {
        return {
          block: true,
          reason:
            "get_negotiation_snapshot takes no arguments; the conversation is bound by the runtime.",
        };
      }
    }

    if (name === TOOL_SUBMIT_DECISION) {
      const decision = args as Partial<NegotiationDecision> | null;
      if (!decision || typeof decision !== "object") {
        return { block: true, reason: "Decision arguments must be an object." };
      }
      if (decision.protocol_version !== PROTOCOL_VERSION) {
        return {
          block: true,
          reason: `protocol_version must be ${PROTOCOL_VERSION}.`,
        };
      }
      if (decision.conversation_id !== binding.conversation_id) {
        return {
          block: true,
          reason: `conversation_id must be the claimed conversation ${binding.conversation_id}; cross-conversation access is not allowed.`,
        };
      }
      if (decision.in_reply_to_message_id !== binding.message_id) {
        return {
          block: true,
          reason: `in_reply_to_message_id must be the claimed message ${binding.message_id}.`,
        };
      }
    }

    return undefined;
  };
}
