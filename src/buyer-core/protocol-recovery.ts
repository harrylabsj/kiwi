/** Private buyer recovery using existing Ledger and idempotency formats. */
import { A2AClientError } from "../a2a/client/error.js";
import { contentDigest } from "../negotiation/jcs.js";
import { LedgerStore } from "../negotiation/ledger/store.js";
import type { LedgerEvent, LedgerEventContent } from "../negotiation/ledger/event.js";
import { IdempotencyStore } from "../negotiation/idempotency/store.js";
import {
  finalizeEnvelope,
  validateWireEnvelope,
  type NegotiationEnvelope,
} from "../negotiation/domain/envelope.js";
import { A2A_TASK_STATES, type A2ATask } from "../a2a/client/types.js";
import { extractKnpEnvelope } from "./a2a-knp.js";
import { McpError } from "./errors.js";
import { assertBuyerReplySemantics, BuyerReplyRejected } from "./receive-gate.js";

export interface ProtocolTaskContext {
  taskId: string;
  createdAt: string;
  intentBindingDigest?: string;
}
export class ProtocolOperationUnknown extends McpError {
  constructor() {
    super(
      "internal_error",
      "protocol operation has no confirmed result and may already have executed; only existing receipt polling is allowed",
      { reconciliation_required: true },
    );
  }
}
/**
 * 商家在任务终态里明确拒绝（`data: {decline:true, reason_code}`）。这是终态，
 * 不是"结果未知"：不能再轮询、也不能自动重试。
 */
export class MerchantDeclined extends McpError {
  constructor(readonly reasonCode: string) {
    super("merchant_declined", `merchant declined the request: ${reasonCode}`, {
      decline_reason: reasonCode,
    });
  }
}
export class ProtocolOperationConflict extends McpError {
  constructor() {
    super("idempotency_conflict", "protocol operation is bound to different request content");
  }
}
interface Operation {
  kind: "send_intent";
  operation_id: string;
  task_id: string;
  task_created_at: string;
  stage: "rfq" | "counter" | "clarification";
  round: number;
  merchant_id: string;
  endpoint: string;
  binding_digest: string;
  intent_binding_digest: string;
}
export interface ProtocolExchange {
  context: ProtocolTaskContext;
  stage: Operation["stage"];
  round: number;
  merchantId: string;
  endpoint: string;
  binding: unknown;
  negotiationId?: string;
  build: (negotiationId: string) => NegotiationEnvelope;
  send: (wire: NegotiationEnvelope) => Promise<A2ATask>;
  get: (taskId: string) => Promise<A2ATask>;
  timeoutMs: number;
  pollIntervalMs: number;
}
/** 从任务终态消息里取商家结构化拒绝的 reason_code（无则 null）。 */
function structuredDecline(task: A2ATask): string | null {
  const parts = task?.status?.message?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (part === null || typeof part !== "object" || part.kind !== "data") continue;
    const data = part.data;
    if (data === null || typeof data !== "object") continue;
    const record = data as Record<string, unknown>;
    if (record["decline"] !== true) continue;
    const reason = typeof record["reason_code"] === "string" ? record["reason_code"].trim() : "";
    return reason === "" ? "unspecified" : reason;
  }
  return null;
}

export interface ProtocolReply {
  reply: NegotiationEnvelope;
  wire: NegotiationEnvelope;
  endpoint: string;
  merchantId: string;
}
function metadata(event: LedgerEvent): Operation | undefined {
  return event.outcome.kind === "ok"
    ? (event.outcome.result?.buyer_operation as Operation | undefined)
    : undefined;
}
export class BuyerProtocolRecovery {
  readonly ledger: LedgerStore;
  readonly idempotency: IdempotencyStore;
  constructor(
    readonly dir: string,
    readonly buyerId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (!dir || !buyerId.trim())
      throw new McpError("invalid_params", "protocol persistence and buyer identity are required");
    this.ledger = new LedgerStore({ dir });
    this.idempotency = new IdempotencyStore({ dir });
  }
  private slot(
    context: ProtocolTaskContext,
    stage: Operation["stage"],
    round: number,
    merchantId: string,
  ): string {
    return `buyer-op-${contentDigest([this.buyerId, context.taskId, stage, round, stage === "rfq" ? merchantId : null])}`;
  }
  private requireContext(
    context: ProtocolTaskContext | undefined,
  ): asserts context is ProtocolTaskContext {
    if (
      !context?.taskId ||
      !Number.isFinite(Date.parse(context.createdAt)) ||
      !context.intentBindingDigest
    ) {
      throw new McpError(
        "invalid_params",
        "persisted task context and intent binding are required",
      );
    }
  }
  hasCounterClaim(taskId: string, round: number): boolean {
    return (
      this.idempotency.readInFlight(
        this.buyerId,
        this.slot({ taskId, createdAt: "" }, "counter", round, ""),
      ) !== null
    );
  }
  private events(id: string): LedgerEvent[] {
    if (!this.ledger.verifyChain(id).valid) throw new ProtocolOperationUnknown();
    return this.ledger.events(id);
  }
  /** Read price only from a journaled reply and its original outbound request. */
  validatedQuote(input: {
    context: ProtocolTaskContext;
    negotiationId: string;
    merchantId: string;
    endpoint: string;
    replyId: string;
    offerId: string;
  }): ProtocolReply | undefined {
    const events = this.events(input.negotiationId);
    const complete = events.find((event) => event.event_kind === "message_received" && event.message_id === input.replyId);
    if (!complete) return undefined; // Legacy prose is not authoritative price evidence.
    const op = metadata(complete);
    if (!op || op.task_id !== input.context.taskId || op.task_created_at !== input.context.createdAt ||
        op.merchant_id !== input.merchantId || op.endpoint !== input.endpoint)
      throw new ProtocolOperationConflict();
    const sent = events.find((event) => event.event_kind === "message_sent" && metadata(event)?.operation_id === op.operation_id);
    if (!sent || sent.identity.sender_identity !== this.buyerId) throw new ProtocolOperationUnknown();
    const wire = validateWireEnvelope(sent.wire_payload);
    const receipt = events.find((event) => event.event_kind === "system" &&
      metadata(event)?.operation_id === op.operation_id &&
      (metadata(event) as unknown as { kind: string }).kind === "receipt");
    if (!receipt?.remote_task_id) throw new ProtocolOperationUnknown();
    const reply = this.completedReply(complete, receipt, wire);
    const payload = reply.payload;
    if ((payload.type !== "offer" && payload.type !== "counter_offer") || payload.offer_id !== input.offerId)
      throw new ProtocolOperationConflict();
    return { reply, wire, endpoint: op.endpoint, merchantId: op.merchant_id };
  }
  private completedReply(complete: LedgerEvent, receipt: LedgerEvent, wire: NegotiationEnvelope): NegotiationEnvelope {
    let reply: NegotiationEnvelope;
    try {
      reply = validateWireEnvelope(complete.wire_payload);
      extractKnpEnvelope({ id: receipt.remote_task_id!, contextId: receipt.remote_context_id,
        status: { state: "completed", message: { role: "agent", messageId: reply.message_id,
          parts: [{ kind: "data", data: { knp_envelope: reply } }] } } }, wire);
    } catch {
      throw new BuyerReplyRejected("wire_invalid");
    }
    if (reply.message_id === wire.message_id) throw new BuyerReplyRejected("wire_invalid");
    assertBuyerReplySemantics(reply, wire, this.now);
    return reply;
  }
  async exchange(input: ProtocolExchange): Promise<ProtocolReply> {
    this.requireContext(input.context);
    const slot = this.slot(input.context, input.stage, input.round, input.merchantId);
    const opId = `msg_${contentDigest([slot, input.merchantId])}`;
    const negotiationId = input.negotiationId ?? `neg_${contentDigest([slot, input.merchantId])}`;
    const bindingDigest = contentDigest({
      context: input.context,
      merchant: input.merchantId,
      endpoint: input.endpoint,
      binding: input.binding,
    });
    const prior = this.events(negotiationId).find(
      (e) => e.event_kind === "message_sent" && e.message_id === opId,
    );
    if (prior !== undefined) {
      const op = metadata(prior);
      if (
        !op ||
        op.binding_digest !== bindingDigest ||
        op.intent_binding_digest !== input.context.intentBindingDigest
      )
        throw new ProtocolOperationConflict();
      try {
        return await this.resume(prior, input.get, input.timeoutMs, input.pollIntervalMs);
      } catch (error) {
        if (error instanceof BuyerReplyRejected || error instanceof MerchantDeclined) throw error;
        throw new ProtocolOperationUnknown();
      }
    }
    const marker = this.idempotency.readInFlight(this.buyerId, slot);
    if (marker !== null) {
      if (marker.digest && marker.digest !== bindingDigest) throw new ProtocolOperationConflict();
      throw new ProtocolOperationUnknown();
    }
    try {
      this.idempotency.markInFlight({
        sender_identity: this.buyerId,
        message_id: slot,
        digest: bindingDigest,
      });
    } catch {
      throw new ProtocolOperationUnknown();
    }
    const built = input.build(negotiationId);
    const { digest: _digest, ...unsigned } = built;
    const payload =
      built.action === "counter_offer"
        ? { ...built.payload, offer_id: `off_${contentDigest(opId)}` }
        : built.payload;
    const wire = finalizeEnvelope({
      ...unsigned,
      payload,
      message_id: opId,
      exchange_id: `ex_${contentDigest(opId)}`,
    });
    const op: Operation = {
      kind: "send_intent",
      operation_id: slot,
      task_id: input.context.taskId,
      task_created_at: input.context.createdAt,
      stage: input.stage,
      round: input.round,
      merchant_id: input.merchantId,
      endpoint: input.endpoint,
      binding_digest: bindingDigest,
      intent_binding_digest: input.context.intentBindingDigest!,
    };
    let sent: LedgerEvent;
    try {
      sent = this.ledger.append(this.content(wire, "message_sent", op));
    } catch {
      throw new ProtocolOperationUnknown();
    }
    try {
      const task = await input.send(wire);
      this.validateTask(task);
      this.ledger.append({
        ...this.content(wire, "system", { ...op, kind: "receipt" }),
        remote_task_id: task.id,
        ...(typeof task.contextId === "string" ? { remote_context_id: task.contextId } : {}),
      });
      return await this.resume(sent, input.get, input.timeoutMs, input.pollIntervalMs, task);
    } catch (error) {
      if (
        error instanceof ProtocolOperationConflict ||
        error instanceof BuyerReplyRejected ||
        error instanceof MerchantDeclined
      )
        throw error;
      // 401/403 是**发送前**的拒绝（平台门禁/认证），消息没有到达商家；把它
      // 归为"结果未知"会让上层误判并隐去过期/错码的真实原因（B-07）。
      if (
        error instanceof A2AClientError &&
        (error.httpStatus === 401 || error.httpStatus === 403)
      ) {
        throw error;
      }
      throw new ProtocolOperationUnknown();
    }
  }
  private content(
    wire: NegotiationEnvelope,
    kind: LedgerEventContent["event_kind"],
    op: unknown,
  ): LedgerEventContent {
    const merchant = (op as Operation).merchant_id;
    return {
      event_kind: kind,
      negotiation_id: wire.negotiation_id,
      message_id: wire.message_id,
      exchange_id: wire.exchange_id,
      ...(wire.in_reply_to ? { in_reply_to: wire.in_reply_to } : {}),
      identity: {
        sender_identity: kind === "message_received" ? merchant : this.buyerId,
        counterparty_identity: kind === "message_received" ? this.buyerId : merchant,
        actor: wire.actor,
      },
      capability: { capability: wire.capability, protocol_version: wire.protocol_version },
      wire_digest: wire.digest,
      wire_payload: wire as unknown as Record<string, unknown>,
      outcome: { kind: "ok", result: { buyer_operation: op } },
      occurred_at: wire.created_at,
    };
  }
  private validateTask(task: A2ATask, receipt?: LedgerEvent, knownContext?: string): void {
    const context = task?.contextId ?? undefined;
    if (
      !task ||
      typeof task.id !== "string" ||
      !task.id ||
      !task.status ||
      !A2A_TASK_STATES.includes(task.status.state) ||
      (context !== undefined && (typeof context !== "string" || !context)) ||
      (receipt && task.id !== receipt.remote_task_id) ||
      (knownContext !== undefined && context !== knownContext) ||
      (task.status.message?.taskId !== undefined && task.status.message.taskId !== task.id) ||
      (task.status.message?.contextId !== undefined && task.status.message.contextId !== context)
    )
      throw new ProtocolOperationUnknown();
  }
  /** Learn an actually returned opaque context once; a separate existing wx marker arbitrates concurrent pollers. */
  private bindContext(sent: LedgerEvent, receipt: LedgerEvent, context: string): void {
    const op = metadata(sent)!;
    const key = `context-${op.operation_id}`;
    const digest = contentDigest([receipt.remote_task_id, context]);
    let marker = this.idempotency.readInFlight(this.buyerId, key);
    if (marker === null) {
      try {
        marker = this.idempotency.markInFlight({
          sender_identity: this.buyerId,
          message_id: key,
          digest,
        });
      } catch {
        marker = this.idempotency.readInFlight(this.buyerId, key);
      }
    }
    if (marker?.digest !== digest) throw new ProtocolOperationUnknown();
    const content = {
      ...this.content(validateWireEnvelope(sent.wire_payload), "system", {
        ...op,
        kind: "context_bound",
      }),
      remote_task_id: receipt.remote_task_id,
      remote_context_id: context,
    };
    try {
      this.ledger.append(content);
    } catch (error) {
      if ((error as { code?: string }).code !== "ledger_duplicate_content")
        throw new ProtocolOperationUnknown();
      const existing = this.events(sent.negotiation_id).find(
        (e) =>
          e.event_kind === "system" &&
          metadata(e)?.operation_id === op.operation_id &&
          (metadata(e) as unknown as { kind: string }).kind === "context_bound",
      );
      if (existing?.remote_context_id !== context) throw new ProtocolOperationUnknown();
    }
  }
  private async resume(
    sent: LedgerEvent,
    get: (id: string) => Promise<A2ATask>,
    timeout: number,
    interval: number,
    initial?: A2ATask,
  ): Promise<ProtocolReply> {
    const op = metadata(sent)!;
    const wire = validateWireEnvelope(sent.wire_payload);
    const events = this.events(sent.negotiation_id);
    const complete = events.find(
      (e) => e.event_kind === "message_received" && metadata(e)?.operation_id === op.operation_id,
    );
    const receipt = events.find(
      (e) =>
        e.event_kind === "system" &&
        metadata(e)?.operation_id === op.operation_id &&
        (metadata(e) as unknown as { kind: string })?.kind === "receipt",
    );
    if (!receipt?.remote_task_id) throw new ProtocolOperationUnknown();
    const finish = (reply: NegotiationEnvelope, event: LedgerEvent): ProtocolReply => {
      try {
        this.idempotency.commit({
          sender_identity: this.buyerId,
          message_id: op.operation_id,
          digest: op.binding_digest,
          negotiation_id: wire.negotiation_id,
          outcome: { kind: "ok", result: { reply } },
          ledger_event_id: event.event_id,
          ledger_event_digest: event.event_digest,
        });
      } catch {
        throw new ProtocolOperationUnknown();
      }
      return { reply, wire, endpoint: op.endpoint, merchantId: op.merchant_id };
    };
    if (complete) {
      return finish(this.completedReply(complete, receipt, wire), complete);
    }
    const deadline = Date.now() + timeout;
    let task = initial;
    for (;;) {
      if (!task) task = await get(receipt.remote_task_id);
      const bound = this.events(sent.negotiation_id).find(
        (e) =>
          e.event_kind === "system" &&
          metadata(e)?.operation_id === op.operation_id &&
          (metadata(e) as unknown as { kind: string }).kind === "context_bound",
      );
      const knownContext = receipt.remote_context_id ?? bound?.remote_context_id;
      this.validateTask(task, receipt, knownContext);
      // 商家的结构化拒绝（`data: {decline: true, reason_code}`）不是 KNP 信封：
      // 此前 extractKnpEnvelope 返回 null，恢复/发送路径会一直轮询到超时，最后
      // 报"结果未知"——商家明明已经明确拒绝了。这里先认出来，交给上层投影成
      // `rejected` 候选（带 reason_code），别再等 20 秒。
      const decline = structuredDecline(task);
      if (decline !== null) throw new MerchantDeclined(decline);
      let reply: NegotiationEnvelope | null;
      try {
        reply = extractKnpEnvelope(task, wire);
      } catch {
        throw new BuyerReplyRejected("wire_invalid");
      }
      if (knownContext === undefined && typeof task.contextId === "string")
        this.bindContext(sent, receipt, task.contextId);
      if (reply && reply.message_id !== wire.message_id) {
        assertBuyerReplySemantics(reply, wire, this.now);
        let event: LedgerEvent;
        try {
          event = this.ledger.append({
            ...this.content(reply, "message_received", { ...op, kind: "complete" }),
            remote_task_id: receipt.remote_task_id,
            ...(typeof (knownContext ?? task.contextId) === "string"
              ? { remote_context_id: knownContext ?? task.contextId }
              : {}),
          });
        } catch (error) {
          if ((error as { code?: string }).code !== "ledger_duplicate_content")
            throw new ProtocolOperationUnknown();
          const existing = this.events(sent.negotiation_id).find(
            (e) =>
              e.event_kind === "message_received" &&
              e.wire_digest === reply.digest &&
              metadata(e)?.operation_id === op.operation_id,
          );
          if (!existing) throw new ProtocolOperationUnknown();
          event = existing;
        }
        return finish(reply, event);
      }
      if (Date.now() >= deadline) throw new ProtocolOperationUnknown();
      await new Promise((r) => setTimeout(r, interval));
      task = undefined;
    }
  }
  async recover(
    context: ProtocolTaskContext,
    get: (endpoint: string, id: string) => Promise<A2ATask>,
    timeout: number,
    interval: number,
  ): Promise<ProtocolReply[]> {
    this.requireContext(context);
    const results: ProtocolReply[] = [];
    for (const id of this.ledger.listNegotiations())
      for (const sent of this.events(id)) {
        const op = metadata(sent);
        if (
          sent.event_kind !== "message_sent" ||
          !op ||
          op.stage !== "rfq" ||
          op.task_id !== context.taskId
        )
          continue;
        if (
          op.task_created_at !== context.createdAt ||
          op.intent_binding_digest !== context.intentBindingDigest ||
          sent.identity.sender_identity !== this.buyerId
        )
          throw new ProtocolOperationConflict();
        try {
          results.push(
            await this.resume(sent, (taskId) => get(op.endpoint, taskId), timeout, interval),
          );
        } catch (error) {
          if (
            error instanceof ProtocolOperationConflict ||
            error instanceof BuyerReplyRejected ||
            error instanceof MerchantDeclined
          )
            throw error; /* unknown remains in ledger; no resend */
        }
      }
    return results;
  }
}
