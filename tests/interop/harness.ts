/**
 * Kiwi A2A v0.7 WP4 interop 端到端测试共享 harness。
 *
 * 用真实 node:http server + A2AClient（经 A2ADirectChannel）构造双侧 Kiwi，
 * 零 mock 网络层。本文件提供：
 *
 *   - InteropClock：确定性推进时钟（避免重复观测触发 ledger_duplicate_content）；
 *   - KNP envelope 构造器（rfq / offer / counter_offer / conditional_offer /
 *     accept_nonbinding / agreement artifact）；
 *   - startMerchantServer：真实 A2AServer + 脚本化 merchant handler
 *     （rfq→offer，counter_offer→conditional_offer，accept→agreement artifact），
 *     内部维护 phase 状态机并落 Ledger；
 *   - BuyerDriver：buyer 侧 client+handler（A2ADirectChannel + Ledger +
 *     ContextMapStore + IdempotencyStore + phase 状态机）；
 *   - 任务视图提取（knp_envelope / agreement artifact）。
 *
 * 该 harness 只使用协议域对象与既有实现，不 mock 网络层。
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentDigest } from "../../src/negotiation/jcs.js";
import { finalizeEnvelope } from "../../src/negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../../src/negotiation/domain/envelope.js";
import {
  newAgreementId,
  newExchangeId,
  newMessageId,
  newNegotiationId,
  newOfferId,
} from "../../src/negotiation/domain/identifiers.js";
import type { LineItem, TermSet } from "../../src/negotiation/domain/common.js";
import type {
  AcceptedNonbindingAgreement,
  ConditionalOffer,
  CounterOffer,
  Offer,
} from "../../src/negotiation/domain/objects.js";
import { evaluateConditionalOffer } from "../../src/negotiation/condition/evaluator.js";
import { LedgerStore } from "../../src/negotiation/ledger/index.js";
import type { LedgerEventContent } from "../../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../../src/negotiation/idempotency/index.js";
import { ContextMapStore } from "../../src/negotiation/context-map/index.js";
import { A2AServer } from "../../src/a2a/server/index.js";
import type {
  A2AServerOptions,
  InboundNegotiationContext,
  NegotiationHandler,
  NegotiationHandlerResult,
} from "../../src/a2a/server/index.js";
import { A2ADirectChannel } from "../../src/counterparty/index.js";
import type { ChannelHandle, CounterpartyProfile } from "../../src/counterparty/index.js";
import { createNegotiationPhase, transitionPhase } from "../../src/negotiation/state/phase.js";
import type { NegotiationPhase, NegotiationPhaseEvent, NegotiationPhaseState } from "../../src/negotiation/state/phase.js";
import type { A2ATask } from "../../src/a2a/client/index.js";

export const CAPABILITY = "knp.a2a.direct";
export const SKU = "SKU-001";
export const CURRENCY = "CNY";
export const DELIVERY_BEFORE = "2026-08-20T18:00:00Z";
export const OFFER_PRICE_MINOR = 85_000; // CNY 850.00
export const DEAL_PRICE_MINOR = 83_500; // CNY 835.00
export const QUANTITY_VALUE = 200;

// ---------------------------------------------------------------------------
// 时钟
// ---------------------------------------------------------------------------

/** 每次调用推进 1ms 的确定性时钟（RFC 3339）。用于所有落账时间戳，避免
 * 同内容事件触发 ledger_duplicate_content（§22 内容寻址去重）。 */
export class InteropClock {
  private readonly base: number;
  private tick = 0;
  constructor(startIso = "2026-08-06T00:00:00.000Z") {
    this.base = Date.parse(startIso);
  }
  now(): string {
    return new Date(this.base + this.tick++).toISOString();
  }
  /** 每个 envelope 的 created_at 也走时钟（保持跨侧时间可比较）。 */
  created(): string {
    return this.now();
  }
}

// ---------------------------------------------------------------------------
// envelope 构造器
// ---------------------------------------------------------------------------

export interface EnvelopeSeed {
  capability?: string;
  negotiation_id: string;
  exchange_id?: string;
  message_id?: string;
  in_reply_to?: string;
  actor: "buyer" | "merchant";
  action: NegotiationEnvelope["action"];
  created_at: string;
  payload: NegotiationEnvelope["payload"];
  public_message?: string;
}

export function seedEnvelope(seed: EnvelopeSeed): NegotiationEnvelope {
  return finalizeEnvelope({
    capability: seed.capability ?? CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: seed.negotiation_id,
    exchange_id: seed.exchange_id ?? newExchangeId(),
    message_id: seed.message_id ?? newMessageId(),
    in_reply_to: seed.in_reply_to,
    actor: seed.actor,
    action: seed.action,
    created_at: seed.created_at,
    payload: seed.payload,
    public_message: seed.public_message,
  });
}

export function offerTerms(opts: { priceMinor?: number; quantity?: number } = {}): TermSet {
  const priceMinor = opts.priceMinor ?? OFFER_PRICE_MINOR;
  const quantity = opts.quantity ?? QUANTITY_VALUE;
  const items: LineItem[] = [
    {
      sku: SKU,
      quantity: { value: quantity, unit: "piece" },
      unit_price: { currency: CURRENCY, amount_minor: priceMinor },
    },
  ];
  return {
    items,
    fulfillment_terms: { delivery_before: DELIVERY_BEFORE },
    valid_until: "2026-08-07T00:00:00Z",
  };
}

export function rfqEnvelope(negotiationId: string, created: () => string, quantity = QUANTITY_VALUE): NegotiationEnvelope {
  return seedEnvelope({
    negotiation_id: negotiationId,
    actor: "buyer",
    action: "rfq",
    created_at: created(),
    payload: {
      type: "rfq",
      items: [{ sku: SKU, quantity: { value: quantity, unit: "piece" } }],
      requested_terms: { delivery_before: DELIVERY_BEFORE },
    },
  });
}

export function offerEnvelope(
  negotiationId: string,
  created: () => string,
  inReplyTo: string,
  opts: { priceMinor?: number; offerId?: string } = {},
): NegotiationEnvelope {
  return seedEnvelope({
    negotiation_id: negotiationId,
    in_reply_to: inReplyTo,
    actor: "merchant",
    action: "offer",
    created_at: created(),
    payload: {
      type: "offer",
      offer_id: opts.offerId ?? newOfferId(),
      terms: offerTerms(opts),
    },
  });
}

export function counterEnvelope(
  negotiationId: string,
  created: () => string,
  inReplyTo: string,
  respondingToOfferId: string,
  opts: { priceMinor?: number; quantity?: number; offerId?: string } = {},
): NegotiationEnvelope {
  const priceMinor = opts.priceMinor ?? DEAL_PRICE_MINOR;
  const quantity = opts.quantity ?? QUANTITY_VALUE;
  const items: LineItem[] = [
    {
      sku: SKU,
      quantity: { value: quantity, unit: "piece" },
      unit_price: { currency: CURRENCY, amount_minor: priceMinor },
    },
  ];
  return seedEnvelope({
    negotiation_id: negotiationId,
    in_reply_to: inReplyTo,
    actor: "buyer",
    action: "counter_offer",
    created_at: created(),
    payload: {
      type: "counter_offer",
      offer_id: opts.offerId ?? newOfferId(),
      responding_to_offer_id: respondingToOfferId,
      proposed_terms: { items },
    },
  });
}

export function conditionalOfferEnvelope(
  negotiationId: string,
  created: () => string,
  inReplyTo: string,
  respondingToOfferId: string,
  opts: { basePriceMinor?: number; dealPriceMinor?: number; offerId?: string } = {},
): NegotiationEnvelope {
  const basePriceMinor = opts.basePriceMinor ?? OFFER_PRICE_MINOR;
  const dealPriceMinor = opts.dealPriceMinor ?? DEAL_PRICE_MINOR;
  const conditional: ConditionalOffer = {
    type: "conditional_offer",
    offer_id: opts.offerId ?? newOfferId(),
    responding_to_offer_id: respondingToOfferId,
    base_terms: offerTerms({ priceMinor: basePriceMinor }),
    conditions: [
      {
        when: { all: [{ field: "aggregate.total_quantity", op: "gte", value: 100 }] },
        then_terms: offerTerms({ priceMinor: dealPriceMinor }),
      },
    ],
  };
  return seedEnvelope({
    negotiation_id: negotiationId,
    in_reply_to: inReplyTo,
    actor: "merchant",
    action: "conditional_offer",
    created_at: created(),
    payload: conditional,
  });
}

export function acceptEnvelope(
  negotiationId: string,
  created: () => string,
  inReplyTo: string,
  offerId: string,
  termsDigest: string,
): NegotiationEnvelope {
  return seedEnvelope({
    negotiation_id: negotiationId,
    in_reply_to: inReplyTo,
    actor: "buyer",
    action: "accept_nonbinding",
    created_at: created(),
    payload: { type: "accept_nonbinding", offer_id: offerId, terms_digest: termsDigest },
  });
}

export function buildAgreement(input: {
  negotiation_id: string;
  accepted_offer_id: string;
  agreed_terms: TermSet;
  accepted_by: ("buyer" | "merchant")[];
  created_at: string;
}): AcceptedNonbindingAgreement {
  return {
    type: "accepted_nonbinding_agreement",
    agreement_id: newAgreementId(),
    negotiation_id: input.negotiation_id,
    accepted_offer_id: input.accepted_offer_id,
    agreed_terms: input.agreed_terms,
    terms_digest: contentDigest(input.agreed_terms),
    accepted_by: input.accepted_by,
    created_at: input.created_at,
    binding_effect: "nonbinding",
    creates_order: false,
    reserves_inventory: false,
    authorizes_payment: false,
  };
}

/** 从 ConditionalOffer envelope 求值事实（aggregate.total_quantity 取 counter 数量）。 */
export function evaluateConditional(conditional: ConditionalOffer, quantity: number): TermSet {
  return evaluateConditionalOffer(conditional, { "aggregate.total_quantity": quantity });
}

// ---------------------------------------------------------------------------
// 任务视图提取
// ---------------------------------------------------------------------------

/** 从 A2A task.status.message 的 data part 提取 `knp_envelope`（§24.3 约定）。 */
export function extractKnpEnvelopeFromTask(task: A2ATask): NegotiationEnvelope | null {
  const message = task.status.message;
  if (message === undefined) return null;
  for (const part of message.parts) {
    if (part.kind === "data") {
      const raw = part.data["knp_envelope"];
      if (raw !== null && typeof raw === "object") return raw as NegotiationEnvelope;
    }
  }
  return null;
}

/** 从 A2A task.artifacts 的 data part 提取 `agreement` artifact。 */
export function extractAgreementFromTask(task: A2ATask): AcceptedNonbindingAgreement | null {
  for (const artifact of task.artifacts ?? []) {
    for (const part of artifact.parts) {
      if (part.kind === "data") {
        const raw = part.data["agreement"];
        if (raw !== null && typeof raw === "object") return raw as AcceptedNonbindingAgreement;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// phase 工具
// ---------------------------------------------------------------------------

export interface PhaseTracker {
  state: NegotiationPhaseState;
  /** 记录的 phase 序列（每次 transition 后 push）。 */
  history: NegotiationPhase[];
  ledger?: LedgerStore;
  negotiationId: string;
  identity: LedgerEventContent["identity"];
  capability: LedgerEventContent["capability"];
  now: () => string;
}

export function createTracker(input: {
  negotiationId: string;
  ledger?: LedgerStore;
  sender: string;
  counterparty: string;
  capability?: string;
  now: () => string;
}): PhaseTracker {
  return {
    state: createNegotiationPhase(input.negotiationId),
    history: [createNegotiationPhase(input.negotiationId).phase],
    ledger: input.ledger,
    negotiationId: input.negotiationId,
    identity: { sender_identity: input.sender, counterparty_identity: input.counterparty },
    capability: { capability: input.capability ?? CAPABILITY, protocol_version: "1.0" },
    now: input.now,
  };
}

/** 应用一次 phase 事件并记录 state_transition 证据（如果传入 ledger）。 */
export function applyPhaseEvent(tracker: PhaseTracker, event: NegotiationPhaseEvent): NegotiationPhase {
  const next = transitionPhase(tracker.state, event);
  const changed = next.phase !== tracker.state.phase;
  tracker.state = next;
  tracker.history.push(next.phase);
  if (changed && tracker.ledger !== undefined) {
    tracker.ledger.append({
      event_kind: "state_transition",
      negotiation_id: tracker.negotiationId,
      state_transition: { to_phase: next.phase },
      identity: tracker.identity,
      capability: tracker.capability,
      outcome: { kind: "ok" },
      occurred_at: tracker.now(),
    });
  }
  return next.phase;
}

/** 记录一条已接收的远端 envelope（message_received 证据）。 */
export function recordReceived(
  tracker: PhaseTracker,
  envelope: NegotiationEnvelope,
  remote: { context_id?: string; task_id?: string },
): void {
  if (tracker.ledger === undefined) return;
  tracker.ledger.append({
    event_kind: "message_received",
    negotiation_id: tracker.negotiationId,
    exchange_id: envelope.exchange_id,
    message_id: envelope.message_id,
    in_reply_to: envelope.in_reply_to,
    remote_context_id: remote.context_id,
    remote_task_id: remote.task_id,
    identity: { ...tracker.identity, actor: envelope.actor },
    capability: { capability: envelope.capability, protocol_version: envelope.protocol_version },
    wire_digest: envelope.digest,
    wire_payload: envelope as unknown as Record<string, unknown>,
    outcome: { kind: "ok" },
    occurred_at: envelope.created_at,
  });
}

/** 入站 action → buyer 侧 phase 事件（收到 offer/counter/conditional → OFFER_OPEN 系）。 */
export function inboundPhaseEvent(envelope: NegotiationEnvelope): NegotiationPhaseEvent | null {
  switch (envelope.action) {
    case "offer": {
      const offer = envelope.payload as Offer;
      return { type: "offer", offer_id: offer.offer_id };
    }
    case "counter_offer": {
      const counter = envelope.payload as CounterOffer;
      return { type: "counter_offer", offer_id: counter.offer_id };
    }
    case "conditional_offer": {
      const conditional = envelope.payload as ConditionalOffer;
      return { type: "conditional_offer", offer_id: conditional.offer_id };
    }
    case "decline":
      return { type: "decline", scope: "offer" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 脚本化 merchant handler
// ---------------------------------------------------------------------------

export interface MerchantStrategyState {
  /** negotiation_id → 最近发出的 conditional_offer（accept 时求值用）。 */
  conditionalByNegotiation: Map<string, { conditional: ConditionalOffer; quantity: number }>;
  /** 暴露给测试的 phase tracker（只跟踪单 negotiation；fanout 场景不使用）。 */
  tracker?: PhaseTracker;
  /** 每次 handle 收到的 inbound envelope（测试可断言 payload 语义）。 */
  received: NegotiationEnvelope[];
}

/** merchant 回复的 taskState 选择。`working` 用于恢复测试（终态会触发
 * reconciliation_required）；`completed` 用于普通闭环断言。 */
export type MerchantReplyTaskState = "working" | "completed";

export interface MerchantHandlerOptions {
  ledger: LedgerStore;
  now: () => string;
  sender: string;
  counterparty: string;
  taskState?: MerchantReplyTaskState;
  /** rfq→offer 回复的报价（amount_minor）；缺省 OFFER_PRICE_MINOR。 */
  offerPriceMinor?: number;
}

/** 构造一个脚本化 merchant handler：rfq→offer，counter_offer→conditional_offer，
 * accept_nonbinding→agreement artifact。同时维护 merchant 侧 phase 状态机。 */
export function createMerchantHandler(
  options: MerchantHandlerOptions,
): { handler: NegotiationHandler; state: MerchantStrategyState } {
  const state: MerchantStrategyState = {
    conditionalByNegotiation: new Map(),
    received: [],
  };
  const handler: NegotiationHandler = {
    name: "interop-scripted-merchant",
    async handle(ctx: InboundNegotiationContext): Promise<NegotiationHandlerResult> {
      const envelope = ctx.envelope;
      state.received.push(envelope);
      const negotiationId = envelope.negotiation_id;
      if (state.tracker === undefined || state.tracker.negotiationId !== negotiationId) {
        state.tracker = createTracker({
          negotiationId,
          ledger: options.ledger,
          sender: options.sender,
          counterparty: options.counterparty,
          now: options.now,
        });
      }

      const replyTaskState = options.taskState ?? "working";
      switch (envelope.action) {
        case "rfq":
        case "inquiry": {
          // merchant 决定发 offer → phase OFFER_OPEN。
          applyPhaseEvent(state.tracker, {
            type: "offer",
            offer_id: newOfferId(),
          });
          const reply = offerEnvelope(negotiationId, () => options.now(), envelope.message_id, {
            priceMinor: options.offerPriceMinor,
          });
          options.ledger.append({
            event_kind: "message_sent",
            negotiation_id: negotiationId,
            exchange_id: reply.exchange_id,
            message_id: reply.message_id,
            in_reply_to: reply.in_reply_to,
            identity: { sender_identity: options.sender, counterparty_identity: options.counterparty, actor: reply.actor },
            capability: { capability: reply.capability, protocol_version: reply.protocol_version },
            wire_digest: reply.digest,
            wire_payload: reply as unknown as Record<string, unknown>,
            outcome: { kind: "ok" },
            occurred_at: reply.created_at,
          });
          return {
            kind: "accepted",
            taskState: replyTaskState,
            message: {
              role: "agent",
              parts: [{ kind: "data", data: { knp_envelope: reply as unknown as Record<string, unknown> } }],
              // A2A 约定（§24.3）：携带 KNP envelope 的消息 messageId 即 envelope.message_id。
              messageId: reply.message_id,
            },
          };
        }
        case "counter_offer": {
          const counter = envelope.payload as CounterOffer;
          const quantity =
            counter.proposed_terms.items?.[0]?.quantity?.value ?? QUANTITY_VALUE;
          applyPhaseEvent(state.tracker, {
            type: "conditional_offer",
            offer_id: newOfferId(),
          });
          const reply = conditionalOfferEnvelope(
            negotiationId,
            () => options.now(),
            envelope.message_id,
            counter.offer_id,
          );
          state.conditionalByNegotiation.set(negotiationId, {
            conditional: reply.payload as ConditionalOffer,
            quantity,
          });
          options.ledger.append({
            event_kind: "message_sent",
            negotiation_id: negotiationId,
            exchange_id: reply.exchange_id,
            message_id: reply.message_id,
            in_reply_to: reply.in_reply_to,
            identity: { sender_identity: options.sender, counterparty_identity: options.counterparty, actor: reply.actor },
            capability: { capability: reply.capability, protocol_version: reply.protocol_version },
            wire_digest: reply.digest,
            wire_payload: reply as unknown as Record<string, unknown>,
            outcome: { kind: "ok" },
            occurred_at: reply.created_at,
          });
          return {
            kind: "accepted",
            taskState: replyTaskState,
            message: {
              role: "agent",
              parts: [{ kind: "data", data: { knp_envelope: reply as unknown as Record<string, unknown> } }],
              messageId: reply.message_id,
            },
          };
        }
        case "accept_nonbinding": {
          const accept = envelope.payload as { type: "accept_nonbinding"; offer_id: string };
          const stored = state.conditionalByNegotiation.get(negotiationId);
          applyPhaseEvent(state.tracker, { type: "accept_nonbinding", offer_id: accept.offer_id });
          const agreed_terms =
            stored === undefined
              ? offerTerms()
              : evaluateConditional(stored.conditional, stored.quantity);
          const agreement = buildAgreement({
            negotiation_id: negotiationId,
            accepted_offer_id: accept.offer_id,
            agreed_terms,
            accepted_by: ["buyer", "merchant"],
            created_at: options.now(),
          });
          return {
            kind: "accepted",
            taskState: replyTaskState,
            artifactParts: [{ kind: "data", data: { agreement } }],
            message: {
              role: "agent",
              parts: [{ kind: "text", text: "Agreement reached (nonbinding)." }],
              messageId: `msg_${newMessageId()}`,
            },
          };
        }
        default:
          return { kind: "declined", reasonCode: "unsupported_action" };
      }
    },
  };
  return { handler, state };
}

// ---------------------------------------------------------------------------
// merchant server
// ---------------------------------------------------------------------------

export interface MerchantHarness {
  /** base URL（agent card well-known）。 */
  url: string;
  /** A2A JSON-RPC endpoint URL。 */
  a2aUrl: string;
  httpServer: http.Server;
  ledger: LedgerStore;
  idempotency: IdempotencyStore;
  dir: string;
  state: MerchantStrategyState;
  clock: InteropClock;
  close(): Promise<void>;
}

export interface StartMerchantOptions {
  name?: string;
  taskState?: MerchantReplyTaskState;
  clock?: InteropClock;
  handler?: NegotiationHandler;
  authVerifier?: A2AServerOptions["authVerifier"];
  /** rfq→offer 回复报价（amount_minor）；缺省 OFFER_PRICE_MINOR。 */
  offerPriceMinor?: number;
}

export async function startMerchantServer(options: StartMerchantOptions = {}): Promise<MerchantHarness> {
  const clock = options.clock ?? new InteropClock();
  const dir = mkdtempSync(path.join(tmpdir(), `kiwi-interop-merchant-`));
  const ledger = new LedgerStore({ dir, now: () => clock.now() });
  const idempotency = new IdempotencyStore({ dir, now: () => clock.now() });

  let handler: NegotiationHandler;
  let state: MerchantStrategyState;
  if (options.handler !== undefined) {
    handler = options.handler;
    state = { conditionalByNegotiation: new Map(), received: [] };
  } else {
    const built = createMerchantHandler({
      ledger,
      now: () => clock.now(),
      sender: `merchant:${options.name ?? "merchant"}`,
      counterparty: "buyer:interop",
      taskState: options.taskState,
      ...(options.offerPriceMinor !== undefined ? { offerPriceMinor: options.offerPriceMinor } : {}),
    });
    handler = built.handler;
    state = built.state;
  }

  const holder = { baseUrl: "http://127.0.0.1:0" };
  const server = new A2AServer({
    card: () => ({
      name: options.name ?? "Interop Merchant",
      description: "Kiwi interop E2E merchant",
      providerOrganization: "Kiwi Test Org",
      version: "0.7.0",
      baseUrl: holder.baseUrl,
      a2aPath: "/",
    }),
    ledger,
    idempotency,
    handler,
    now: () => clock.now(),
    ...(options.authVerifier !== undefined ? { authVerifier: options.authVerifier } : {}),
  });
  const httpServer = server.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  holder.baseUrl = `http://127.0.0.1:${addr.port}`;

  const harness: MerchantHarness = {
    url: holder.baseUrl,
    a2aUrl: `${holder.baseUrl}/`,
    httpServer,
    ledger,
    idempotency,
    dir,
    state,
    clock,
    async close(): Promise<void> {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------
// buyer driver
// ---------------------------------------------------------------------------

export interface BuyerDriverOptions {
  ledger: LedgerStore;
  contextMap: ContextMapStore;
  idempotency: IdempotencyStore;
  clock: InteropClock;
  sender: string;
  counterparty: string;
  /** 复用既有 negotiation_id（恢复续跑）；缺省新建。 */
  negotiationId?: string;
  /** 初始 phase（恢复续跑时由 recovery 结果注入）；缺省 OPEN。 */
  initialPhase?: NegotiationPhase;
}

/** buyer 侧 client+handler：A2ADirectChannel 出站 + Ledger/ContextMap/Idempotency
 * 本地持久化 + phase 状态机。sendAndAdvance 记录证据并推进 phase。 */
export class BuyerDriver {
  readonly ledger: LedgerStore;
  readonly contextMap: ContextMapStore;
  readonly idempotency: IdempotencyStore;
  readonly clock: InteropClock;
  readonly sender: string;
  readonly counterparty: string;
  readonly negotiationId: string;
  readonly tracker: PhaseTracker;
  /** 已发送的 envelope（含证据）。 */
  sent: NegotiationEnvelope[] = [];
  /** 已收到的 merchant reply envelope。 */
  received: NegotiationEnvelope[] = [];
  /** 最近一次 send 返回的 task（含 agreement artifact 等）。 */
  lastTask: A2ATask | null = null;

  constructor(options: BuyerDriverOptions) {
    this.ledger = options.ledger;
    this.contextMap = options.contextMap;
    this.idempotency = options.idempotency;
    this.clock = options.clock;
    this.sender = options.sender;
    this.counterparty = options.counterparty;
    this.negotiationId = options.negotiationId ?? newNegotiationId();
    const tracker = createTracker({
      negotiationId: this.negotiationId,
      ledger: this.ledger,
      sender: options.sender,
      counterparty: options.counterparty,
      now: () => this.clock.now(),
    });
    if (options.initialPhase !== undefined) {
      tracker.state = { ...tracker.state, phase: options.initialPhase };
      tracker.history.push(options.initialPhase);
    }
    this.tracker = tracker;
  }

  private channelFor(url: string): A2ADirectChannel {
    return new A2ADirectChannel({
      url,
      ledger: this.ledger,
      idempotency: this.idempotency,
      now: () => this.clock.now(),
    });
  }

  /** 发送一条 outbound envelope，记录 context map + phase 事件，返回 merchant reply
   * envelope（如有）。发送 accept 时 buyer 侧 phase → AGREEMENT_REACHED。 */
  async sendAndAdvance(
    envelope: NegotiationEnvelope,
    merchantUrl: string,
  ): Promise<NegotiationEnvelope | null> {
    const channel = this.channelFor(merchantUrl);
    let handle: ChannelHandle | null = null;
    try {
      const openRemote = this.contextMap.get(this.negotiationId);
      handle = await channel.open({
        negotiation_id: this.negotiationId,
        sender_identity: this.sender,
        identity: this.counterparty,
        remote: {
          context_id: openRemote?.remote_context_id,
          task_id: openRemote?.task_ids.at(-1),
        },
      });

      const result = await handle.send({ envelope, ref: { negotiation_id: this.negotiationId } });
      this.lastTask = result.task ?? null;
      this.sent.push(envelope);

      // context map：远端锚点（§9.2 / §24.5）。
      if (result.ref.context_id !== undefined) {
        this.contextMap.set(this.negotiationId, { remote_context_id: result.ref.context_id });
      }
      if (result.ref.task_id !== undefined) {
        this.contextMap.addTask(this.negotiationId, result.ref.task_id);
      }

      // outbound 自身驱动的 phase 事件：accept → AGREEMENT_REACHED。
      if (envelope.action === "accept_nonbinding") {
        const payload = envelope.payload as { type: "accept_nonbinding"; offer_id: string };
        applyPhaseEvent(this.tracker, { type: "accept_nonbinding", offer_id: payload.offer_id });
      }

      const reply = result.task === undefined ? null : extractKnpEnvelopeFromTask(result.task);
      if (reply !== null) {
        this.received.push(reply);
        recordReceived(this.tracker, reply, {
          context_id: result.ref.context_id,
          task_id: result.ref.task_id,
        });
        const event = inboundPhaseEvent(reply);
        if (event !== null) applyPhaseEvent(this.tracker, event);
      }
      return reply;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** 读取 Ledger 中最近一条指定 action 的 message_received envelope（恢复后续用）。 */
  readReceivedEnvelope(action: NegotiationEnvelope["action"]): NegotiationEnvelope | null {
    for (const event of this.ledger.events(this.negotiationId)) {
      if (event.event_kind !== "message_received" || event.wire_payload === undefined) continue;
      const env = event.wire_payload as unknown as NegotiationEnvelope;
      if (env.action === action) return env;
    }
    return null;
  }

  currentPhase(): NegotiationPhase {
    return this.tracker.state.phase;
  }

  ledgerChainValid(): boolean {
    return this.ledger.verifyChain(this.negotiationId).valid;
  }
}

// ---------------------------------------------------------------------------
// CounterpartyProfile 构造
// ---------------------------------------------------------------------------

export function profileFor(identity: string, a2aUrl: string): CounterpartyProfile {
  return {
    identity,
    source: `card:${a2aUrl}`,
    agent_card: {
      name: identity,
      description: `${identity} agent card`,
      provider: { organization: identity },
      version: "1.0",
      supportedInterfaces: [{ url: a2aUrl, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    },
    intersection: {
      compatible: true,
      candidates: [{ url: a2aUrl, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      incompatible: [],
      unknownShared: [],
      oneSided: [],
    },
    channel_candidates: [{ kind: "a2a-direct", url: a2aUrl }],
  };
}
