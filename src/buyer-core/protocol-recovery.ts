/** Private buyer recovery using existing Ledger and idempotency formats. */
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
  stage: "rfq" | "counter";
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
      } catch {
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
      if (error instanceof ProtocolOperationConflict) throw error;
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
      const reply = validateWireEnvelope(complete.wire_payload);
      extractKnpEnvelope(
        {
          id: receipt.remote_task_id,
          contextId: receipt.remote_context_id,
          status: {
            state: "completed",
            message: {
              role: "agent",
              messageId: reply.message_id,
              parts: [{ kind: "data", data: { knp_envelope: reply } }],
            },
          },
        },
        wire,
      );
      return finish(reply, complete);
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
      const reply = extractKnpEnvelope(task, wire);
      if (knownContext === undefined && typeof task.contextId === "string")
        this.bindContext(sent, receipt, task.contextId);
      if (reply && reply.message_id !== wire.message_id) {
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
          if (error instanceof ProtocolOperationConflict)
            throw error; /* unknown remains in ledger; no resend */
        }
      }
    return results;
  }
}
