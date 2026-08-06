/**
 * Negotiation tools for the main conversation (design §15.1/§15.2/§15.4).
 *
 * `get_negotiation_snapshot` is a read-only view of an authoritative
 * Marketplace Conversation: it claims the pending message, reads the snapshot
 * and releases the claim so the message stays reclaimable.
 *
 * `submit_negotiation_decision` is a write. It reuses the existing negotiation
 * runtime's claim -> (buyer local policy gate) -> gateway policy gate ->
 * settlement path — it never bypasses the strategy gates. Like every write it
 * is routed through the WriteApprovalCandidate approval gate (§16): supervised
 * requires /approve, autopilot auto-executes within HardPolicy, manual is
 * advice-only. Execution re-reads the marketplace routing state; if the
 * conversation moved on, the old approval is stale.
 *
 * The model only ever sees these tools — never the negotiation token, which
 * lives in the CredentialBroker.
 */

import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentProfile } from "../config/profile.js";
import { idempotencyKey, type CommerceClient } from "../commerce/types.js";
import {
  PROTOCOL_VERSION,
  type NegotiationDecision,
  type PolicyResult,
} from "../negotiation/types.js";
import { checkBuyerLocalPolicy, localBuyerPolicyResult } from "../runtime/buyer-policy.js";
import { submitIdempotencyKey } from "../runtime/tools.js";
import type { AgentMode } from "./mode.js";
import type { WriteApprovalCandidateStore } from "./merchant/action-candidate.js";
import type { CredentialBroker } from "./merchant/credential-broker.js";
import { requireScopeCredential } from "./merchant/credential-broker.js";
import type { NegotiationSnapshot } from "../negotiation/types.js";
import { routeWriteCandidate, type WriteGateDeps } from "./write-gate.js";

type Tool = AgentHarnessTool<undefined>;

function textResult(text: string, details?: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function errorText(err: unknown): string {
  return `磋商操作失败：${err instanceof Error ? err.message : String(err)}`;
}

export interface NegotiationChatDeps {
  profile: AgentProfile;
  commerceClient: CommerceClient;
  broker: CredentialBroker;
  approvals: WriteApprovalCandidateStore;
  mode: () => AgentMode;
  now: () => string;
  /** Register /approve execution hooks for pending candidates. */
  registerPending?: WriteGateDeps["registerPending"];
  /** Buyer-side hook to update consultation_links after a decision settles. */
  afterSettle?: (info: { conversation_id: string; result: PolicyResult; settlement: "completed" | "failed" }) => void;
}

interface PendingTarget {
  conversation_id: string;
  message_id: number;
  conversation_status: string;
}

async function findPending(
  commerceClient: CommerceClient,
  conversationId: string,
): Promise<PendingTarget | undefined> {
  const pending = await commerceClient.listPendingMessages();
  const target = pending.find((m) => m.conversation_id === conversationId);
  if (target === undefined) return undefined;
  return {
    conversation_id: target.conversation_id,
    message_id: target.message_id,
    conversation_status: target.conversation_status,
  };
}

function buildDecision(target: PendingTarget, args: Record<string, unknown>): NegotiationDecision {
  const action = String(args.action ?? "ask");
  const decision: NegotiationDecision = {
    protocol_version: PROTOCOL_VERSION,
    conversation_id: target.conversation_id,
    in_reply_to_message_id: target.message_id,
    action: action as NegotiationDecision["action"],
    ...(args.proposal !== undefined ? { proposal: args.proposal as NegotiationDecision["proposal"] } : {}),
    open_issues: Array.isArray(args.open_issues) ? (args.open_issues as string[]) : [],
    public_message: String(args.public_message ?? ""),
    reason_codes: Array.isArray(args.reason_codes) ? (args.reason_codes as string[]) : [],
    request_human_review: args.request_human_review === true,
  };
  return decision;
}

/** Autopilot escalation: negotiation messages outside HardPolicy need a human.
 * The reason never contains the private number. */
function negotiationEscalation(profile: AgentProfile, args: Record<string, unknown>): string | undefined {
  if (args.request_human_review === true) {
    return "请求了人工处理，必须由人确认后再提交。";
  }
  const reviewOn =
    profile.role === "buyer"
      ? (profile.buyer_policy?.human_review_on ?? [])
      : (profile.merchant_policy?.human_review_on ?? []);
  const codes = Array.isArray(args.reason_codes) ? (args.reason_codes as string[]) : [];
  if (codes.some((c) => reviewOn.includes(c))) {
    return `命中需人工确认的策略码（${codes.join(",")}）。`;
  }
  // Local HardPolicy envelope (design §7.1): a merchant quote below the
  // private floor, or a buyer proposal over the private budget, must never
  // auto-submit in autopilot — the gateway would reject it with human_required
  // and poison the conversation state.
  const proposal = args.proposal as
    | { unit_price?: unknown; quantity?: unknown; delivery?: { fee?: unknown } }
    | undefined;
  const unitPrice = typeof proposal?.unit_price === "number" ? proposal.unit_price : undefined;
  if (unitPrice === undefined) return undefined;
  if (profile.role === "merchant") {
    const floor = profile.merchant_policy?.min_unit_price_private;
    if (floor !== undefined && unitPrice < floor) {
      return "报价低于私有底价，需要人工批准后再提交。";
    }
  }
  if (profile.role === "buyer") {
    const budget = profile.buyer_policy?.max_total_price_private;
    if (budget !== undefined) {
      const qty = typeof proposal?.quantity === "number" ? proposal.quantity : 1;
      const fee = typeof proposal?.delivery?.fee === "number" ? proposal.delivery.fee : 0;
      if (unitPrice * qty + fee > budget) {
        return "提案总价超出私有预算，需要人工批准后再提交。";
      }
    }
  }
  return undefined;
}

/** Submit an approved decision through the existing claim + gate + settle path. */
async function executeNegotiationSubmit(
  profile: AgentProfile,
  commerceClient: CommerceClient,
  args: Record<string, unknown>,
  afterSettle?: NegotiationChatDeps["afterSettle"],
): Promise<{ result: PolicyResult; settlement: "completed" | "failed" }> {
  const conversationId = String(args.conversation_id);
  const target = await findPending(commerceClient, conversationId);
  if (target === undefined) {
    throw new Error("该会话当前没有可回复的待处理消息（可能已结算或轮次不匹配）。");
  }
  const idem = idempotencyKey(profile.agent_id, target.message_id, PROTOCOL_VERSION);
  const claim = await commerceClient.claimMessage({
    conversation_id: target.conversation_id,
    message_id: target.message_id,
    idempotency_key: idem,
  });
  if (!claim.claimed) {
    throw new Error(`该消息已被其他 worker 处理（${claim.status}），不会重复提交。`);
  }
  const decision = buildDecision(target, args);

  // Buyer local private policy gate BEFORE the gateway — same as the headless
  // turn. A violation never reaches the marketplace and never leaks numbers.
  if (profile.role === "buyer" && profile.buyer_policy) {
    const violation = checkBuyerLocalPolicy(decision, profile.buyer_policy);
    if (violation) {
      const local = localBuyerPolicyResult(conversationId, violation, 0);
      await commerceClient.failClaim({
        message_id: target.message_id,
        idempotency_key: idem,
        error: `local policy rejected: ${violation.reason_codes.join(", ")}`,
      });
      afterSettle?.({ conversation_id: conversationId, result: local, settlement: "failed" });
      return { result: local, settlement: "failed" };
    }
  }

  // Merchant local floor gate BEFORE the gateway (design §7.1, §16): a quote
  // below the private floor never reaches the marketplace and never leaks the
  // number — the gateway would otherwise flip the conversation to human_required.
  const floor = profile.merchant_policy?.min_unit_price_private;
  if (profile.role === "merchant" && floor !== undefined && decision.proposal) {
    if (decision.proposal.unit_price < floor) {
      const local: PolicyResult = {
        protocol_version: PROTOCOL_VERSION,
        result: "rejected_retryable",
        conversation_id: conversationId,
        next_actor: "merchant",
        reason_codes: ["local_floor_violation"],
        public_reason: "该报价低于你的私有底价，请上调后再提交。",
        retries_remaining: 0,
      };
      await commerceClient.failClaim({
        message_id: target.message_id,
        idempotency_key: idem,
        error: "local policy rejected: local_floor_violation",
      });
      afterSettle?.({ conversation_id: conversationId, result: local, settlement: "failed" });
      return { result: local, settlement: "failed" };
    }
  }

  const result = await commerceClient.submitNegotiationDecision({
    decision,
    idempotency_key: submitIdempotencyKey(idem, decision),
  });
  if (result.result === "accepted" || result.result === "human_required") {
    await commerceClient.completeClaim({
      message_id: target.message_id,
      idempotency_key: idem,
    });
  } else {
    await commerceClient.failClaim({
      message_id: target.message_id,
      idempotency_key: idem,
      error: `policy rejected: ${result.public_reason}`,
    });
  }
  afterSettle?.({
    conversation_id: conversationId,
    result,
    settlement: result.result === "accepted" || result.result === "human_required" ? "completed" : "failed",
  });
  return {
    result,
    settlement: result.result === "accepted" || result.result === "human_required" ? "completed" : "failed",
  };
}

export function buildNegotiationChatTools(deps: NegotiationChatDeps): Tool[] {
  const { profile, commerceClient, broker, approvals, mode, now } = deps;

  const getSnapshot: Tool = {
    name: "get_negotiation_snapshot",
    label: "读取磋商快照",
    description:
      "读取某个 Marketplace Conversation 的权威磋商快照（只读）。要求会话有你的待处理消息；" +
      "读取后立即释放该消息，仍可被磋商运行时处理。",
    parameters: {
      type: "object",
      properties: { conversation_id: { type: "string" } },
      required: ["conversation_id"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const credential = requireScopeCredential(broker, "negotiation");
      if (!credential.ok) return textResult(credential.reason);
      try {
        const conversationId = String((params as { conversation_id: string }).conversation_id);
        const target = await findPending(commerceClient, conversationId);
        if (target === undefined) {
          return textResult("该会话当前没有你的待处理消息。");
        }
        const idem = idempotencyKey(profile.agent_id, target.message_id, PROTOCOL_VERSION);
        const claim = await commerceClient.claimMessage({
          conversation_id: target.conversation_id,
          message_id: target.message_id,
          idempotency_key: idem,
        });
        if (!claim.claimed) return textResult("该消息已被其他 worker 处理，暂时无法读取快照。");
        try {
          const snapshot: NegotiationSnapshot = await commerceClient.getNegotiationSnapshot({
            conversation_id: target.conversation_id,
            message_id: target.message_id,
          });
          return textResult(JSON.stringify(snapshot));
        } finally {
          await commerceClient.abandonClaim({
            message_id: target.message_id,
            idempotency_key: idem,
            error: "read-only snapshot view",
          });
        }
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  const submitDecision: Tool = {
    name: "submit_negotiation_decision",
    label: "提交磋商决策",
    description:
      "对一个待回复的 Marketplace Conversation 提交磋商决策。这是正式写意图，走现有策略门（buyer 私有预算门 + 网关权威门）。" +
      "supervised 模式需要 /approve 批准后才真正提交。proposal 字段必须与 get_negotiation_snapshot 的结构一致：顶层是 sku/quantity/unit_price/currency/stock/delivery/after_sales_policy_refs/valid_until（不要嵌套 items）。",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string" },
        action: {
          type: "string",
          enum: ["ask", "propose", "counter", "accept_nonbinding", "decline", "escalate"],
        },
        public_message: { type: "string" },
        proposal: {
          type: "object",
          description: "propose/counter/accept 时的完整 proposal（必须含这些顶层字段）",
          properties: {
            sku: { type: "string" },
            quantity: { type: "integer" },
            unit_price: { type: "number" },
            currency: { type: "string" },
            stock: {
              type: "object",
              properties: {
                status: { type: "string" },
                quantity: { type: "integer" },
                observed_at: { type: "string" },
                reserved: { type: "boolean" },
              },
              required: ["status", "quantity", "observed_at", "reserved"],
            },
            delivery: {
              type: "object",
              properties: {
                eta_start: { type: "string" },
                eta_end: { type: "string" },
                fee: { type: "number" },
              },
              required: ["eta_start", "eta_end", "fee"],
            },
            after_sales_policy_refs: { type: "array", items: { type: "string" } },
            valid_until: { type: "string", description: "报价有效期（RFC3339）" },
          },
          required: ["sku", "quantity", "unit_price", "currency", "stock", "delivery", "after_sales_policy_refs", "valid_until"],
        },
        open_issues: { type: "array", items: { type: "string" } },
        reason_codes: { type: "array", items: { type: "string" }, description: "本决策的理由代码，用于命中 human_review_on 策略" },
        request_human_review: { type: "boolean" },
      },
      required: ["conversation_id", "action", "public_message"],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const credential = requireScopeCredential(broker, "negotiation");
      if (!credential.ok) return textResult(credential.reason);
      try {
        const args = params as Record<string, unknown>;
        const preconditions = await readNegotiationPreconditions(commerceClient, String(args.conversation_id));
        if (preconditions.message_id === null) {
          return textResult("该会话当前没有可回复的待处理消息，无法创建磋商候选。");
        }
        const outcome = await routeWriteCandidate(
          { mode, approvals, profile, now, registerPending: deps.registerPending },
          {
            tool: "submit_negotiation_decision",
            arguments: args,
            preconditions,
            risk: "send_negotiation_message",
            execute: (approvedArgs) =>
              executeNegotiationSubmit(profile, commerceClient, approvedArgs, deps.afterSettle).then((r) => r),
            readPreconditions: () => readNegotiationPreconditions(commerceClient, String(args.conversation_id)),
            autopilotEscalation: (a) => negotiationEscalation(profile, a),
          },
        );
        return writeGateText(outcome);
      } catch (err) {
        return textResult(errorText(err));
      }
    },
  };

  return [getSnapshot, submitDecision];
}

async function readNegotiationPreconditions(
  commerceClient: CommerceClient,
  conversationId: string,
): Promise<{ conversation_status: string | null; message_id: number | null }> {
  const pending = await commerceClient.listPendingMessages();
  const target = pending.find((m) => m.conversation_id === conversationId);
  return {
    conversation_status: target?.conversation_status ?? null,
    message_id: target?.message_id ?? null,
  };
}

/** Render a write-gate outcome for the model and operator (no secrets). */
export function writeGateText(
  outcome:
    | { kind: "executed"; candidate: { candidate_id: string }; output: unknown }
    | { kind: "pending_approval"; candidate: { candidate_id: string } }
    | { kind: "advice_only"; candidate: { candidate_id: string } }
    | { kind: "forbidden"; reason: string },
): AgentToolResult<unknown> {
  switch (outcome.kind) {
    case "executed":
      return textResult(
        `操作已执行（候选 ${outcome.candidate.candidate_id}）。结果：${JSON.stringify(outcome.output)}`,
        { candidate_id: outcome.candidate.candidate_id, executed: true },
      );
    case "pending_approval":
      return textResult(
        `该写操作已生成审批候选 ${outcome.candidate.candidate_id}，等待批准（supervised）。` +
          "请告知操作者用 /approve <candidate_id> 批准，或 /reject <candidate_id> 驳回。",
        { candidate_id: outcome.candidate.candidate_id, status: "pending_approval" },
      );
    case "advice_only":
      return textResult(
        `manual 模式下写操作不执行。已生成候选 ${outcome.candidate.candidate_id} 仅供查看。`,
        { candidate_id: outcome.candidate.candidate_id, status: "advice_only" },
      );
    case "forbidden":
      return textResult(outcome.reason);
  }
}
