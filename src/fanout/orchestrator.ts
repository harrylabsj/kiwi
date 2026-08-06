/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * fanout — 多商家 RFQ 编排器（基线 §16 / §19 / §30）。
 *
 * 向 N 个通道并行发 RFQ（每个商家独立 negotiation_id，双边语义不混淆）；
 * 带超时的 Offer 收集；部分失败容忍（单个商家超时/拒绝不影响其他腿）；
 * 结果聚合为比较集（price / delivery / terms 维度结构化）。每腿独立 Ledger
 * 链（以 per-leg negotiation_id 为键）与幂等键（(sender_identity, message_id)，
 * 每腿 message_id 独立生成）。
 *
 * §16 selected_nonbinding：Buyer 可以同时持有多个不同 Merchant 的 Agreement，
 * 在本地选择其中一个 —— Merchant 无需知道 Buyer 是否选择了其他 Merchant。
 * 因此编排器对每腿独立开 negotiation，绝不把跨商家的比较集写回任何一腿。
 *
 * Fail-closed（§4.6 / §4.5）：入站 envelope 在进入 Ledger 前必须过 schema 校验
 * + digest 验签；任何一腿的通道/校验失败都以结构化 leg result 返回，不静默
 * 吞掉，也不影响其他腿。
 */

import type {
  ChannelHandle,
  ChannelOpenInput,
  ChannelSendResult,
  CounterpartyProfile,
  RemoteRef,
  RemoteState,
} from "../counterparty/index.js";
import { ChannelError } from "../counterparty/index.js";
import {
  finalizeEnvelope,
  validateEnvelope,
  verifyEnvelopeDigest,
} from "../negotiation/domain/envelope.js";
import type { NegotiationEnvelope } from "../negotiation/domain/envelope.js";
import {
  newExchangeId,
  newMessageId,
  newNegotiationId,
} from "../negotiation/domain/identifiers.js";
import { validateOffer } from "../negotiation/domain/objects.js";
import type { NegotiationActor, Offer } from "../negotiation/domain/objects.js";
import type { TermSet } from "../negotiation/domain/common.js";
import type { LedgerEventContent, LedgerStore } from "../negotiation/ledger/index.js";
import type { DisclosedRfqPayload } from "./disclosure.js";

export const DEFAULT_FANOUT_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_INTERVAL_MS = 100;
export const DEFAULT_FANOUT_CAPABILITY = "knp.a2a.direct";

/** 编排器依赖：唯一接缝是 ChannelHandle（§33），Ledger 每腿独立链。 */
export interface FanoutOrchestratorDeps {
  /** 本方身份（Ledger identity 的 sender 侧 / 幂等键一半）。 */
  sender_identity: string;
  /** 打开一条绑定到 negotiation 的通道（缺省用 profile 首选候选，失败不降级）。 */
  openChannel: (profile: CounterpartyProfile, input: ChannelOpenInput) => Promise<ChannelHandle>;
  /** 每腿独立 Ledger 链（以 negotiation_id 为键）；缺省不落账。 */
  ledger?: LedgerStore;
  /** envelope capability（缺省 knp.a2a.direct）。 */
  capability?: string;
  /** 从 RemoteState 提取远端最新 KNP envelope（缺省 direct 通道形状）。 */
  extractEnvelope?: (state: RemoteState) => NegotiationEnvelope | null;
  now?: () => string;
  /** 时钟（超时测量；缺省 Date.now）。 */
  clock?: () => number;
  /** 轮询间隔 ms（缺省 100）。 */
  pollIntervalMs?: number;
}

/** 单腿规格：同一 RFQ 意图的某档位 payload 发给一个商家。 */
export interface FanoutLegSpec {
  profile: CounterpartyProfile;
  /** 每腿独立 negotiation_id；缺省由编排器生成（§16：双边语义不混淆）。 */
  negotiation_id?: string;
  /** 该腿披露档位 payload。 */
  payload: DisclosedRfqPayload;
  /** 请求超时 ms（缺省 DEFAULT_FANOUT_TIMEOUT_MS）。 */
  timeoutMs?: number;
}

export type LegOutcomeKind = "offer_received" | "no_offer" | "declined" | "timed_out" | "failed";

/** 单腿结果。部分失败容忍：失败腿以结构化 outcome 返回，不影响其他腿。 */
export interface FanoutLegResult {
  identity: string;
  negotiation_id: string;
  /** 该腿出站 message_id（幂等键 (sender_identity, message_id) 的另一半）。 */
  message_id: string;
  outcome: LegOutcomeKind;
  /** offer_received 时的 Offer（wire 校验通过）。 */
  offer?: Offer;
  /** failed / timed_out 的结构化错误。 */
  error?: { code: string; message: string };
  /** 消息往返耗时 ms。 */
  elapsed_ms: number;
}

/** 比较集行：price / delivery / terms 结构化维度（§19 比较 → 对 Top N counter）。 */
export interface FanoutComparisonRow {
  identity: string;
  negotiation_id: string;
  offer_id: string;
  price: { currency: string; amount_minor: number } | null;
  delivery_before?: string;
  terms: Record<string, unknown>;
  valid_until?: string;
}

export interface FanoutResult {
  /** 按价格升序（同货币内）排列的 Offer 比较集。 */
  offers: FanoutComparisonRow[];
  /** 每条腿的结果（含失败腿）。 */
  legs: FanoutLegResult[];
  offer_count: number;
  started_at: string;
  completed_at: string;
}

type WaitOutcome =
  | { kind: "envelope"; envelope: NegotiationEnvelope }
  | { kind: "timeout" }
  | { kind: "task_failed"; state: string }
  | { kind: "terminal_no_offer"; reason: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 缺省入站提取器：从 A2A task.status.message 的 data part 取 `knp_envelope`
 * （§24.3 约定）。hosted 通道的调用方注入自己的 extractEnvelope。
 */
export function extractKnpEnvelopeFromState(state: RemoteState): NegotiationEnvelope | null {
  const message = state.task?.status?.message;
  if (message === undefined) return null;
  for (const part of message.parts) {
    if (part.kind === "data") {
      const data = part.data;
      if (data !== null && typeof data === "object" && "knp_envelope" in data) {
        const candidate = data["knp_envelope"];
        if (candidate !== null && typeof candidate === "object") {
          return candidate as NegotiationEnvelope;
        }
      }
    }
  }
  return null;
}

/** 入站 envelope fail-closed（§4.5 Remote Content Is Untrusted）：schema + digest。 */
function validateIncoming(envelope: NegotiationEnvelope): NegotiationEnvelope {
  const validated = validateEnvelope(envelope);
  if (!verifyEnvelopeDigest(validated)) {
    throw new Error("incoming KNP envelope digest mismatch (integrity failure)");
  }
  return validated;
}

function errorCode(err: unknown): string {
  if (err instanceof ChannelError) return err.code;
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    return "leg_error";
  }
  return "unknown";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Offer 维度提取与比较集聚合
// ---------------------------------------------------------------------------

/** 从 Offer terms 提取 unit price（items[0].unit_price 优先，其次 price_terms.unit_price）。 */
export function extractUnitPrice(
  terms: TermSet,
): { currency: string; amount_minor: number } | null {
  const first = terms.items?.[0];
  if (first?.unit_price !== undefined) return first.unit_price;
  const price = terms.price_terms;
  if (price !== undefined && typeof price === "object") {
    const up = price["unit_price"];
    if (up !== null && typeof up === "object") {
      const candidate = up as Record<string, unknown>;
      if (
        typeof candidate["currency"] === "string" &&
        typeof candidate["amount_minor"] === "number"
      ) {
        return { currency: candidate["currency"], amount_minor: candidate["amount_minor"] };
      }
    }
  }
  return null;
}

/** 从 Offer terms 提取交期维度。 */
export function extractDelivery(terms: TermSet): { delivery_before?: string } {
  const fulfillment = terms.fulfillment_terms;
  if (fulfillment === undefined || typeof fulfillment !== "object") return {};
  const out: { delivery_before?: string } = {};
  if (typeof fulfillment["delivery_before"] === "string") {
    out.delivery_before = fulfillment["delivery_before"];
  }
  return out;
}

/**
 * 比较集排序（确定性）：
 *   1. 有价格在前；2. 货币分组（不同货币不做数值比较，按货币码排序）；
 *   3. 同货币价格升序；4. 交期早优先（ISO 字符串排序 = 时间排序）；
 *   5. identity 升序 tie-break。
 */
export function compareRows(a: FanoutComparisonRow, b: FanoutComparisonRow): number {
  const aHasPrice = a.price !== null;
  const bHasPrice = b.price !== null;
  if (aHasPrice !== bHasPrice) return aHasPrice ? -1 : 1;
  const aPrice = a.price;
  const bPrice = b.price;
  if (aPrice !== null && bPrice !== null) {
    if (aPrice.currency !== bPrice.currency) {
      return aPrice.currency < bPrice.currency ? -1 : 1;
    }
    const amountDelta = aPrice.amount_minor - bPrice.amount_minor;
    if (amountDelta !== 0) return amountDelta;
  }
  const aDelivery = a.delivery_before ?? "";
  const bDelivery = b.delivery_before ?? "";
  if (aDelivery !== bDelivery) return aDelivery < bDelivery ? -1 : 1;
  return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
}

/** 把各腿结果聚合为比较集（price / delivery / terms 结构化；无 Offer 的腿不进入）。 */
export function buildComparisonSet(legs: FanoutLegResult[]): FanoutComparisonRow[] {
  const rows: FanoutComparisonRow[] = [];
  for (const leg of legs) {
    if (leg.offer === undefined) continue;
    const price = extractUnitPrice(leg.offer.terms);
    const delivery = extractDelivery(leg.offer.terms);
    rows.push({
      identity: leg.identity,
      negotiation_id: leg.negotiation_id,
      offer_id: leg.offer.offer_id,
      price,
      delivery_before: delivery.delivery_before,
      terms: leg.offer.terms as unknown as Record<string, unknown>,
      valid_until: leg.offer.terms.valid_until,
    });
  }
  rows.sort(compareRows);
  return rows;
}

// ---------------------------------------------------------------------------
// 编排器
// ---------------------------------------------------------------------------

export class FanoutOrchestrator {
  private readonly deps: FanoutOrchestratorDeps;

  constructor(deps: FanoutOrchestratorDeps) {
    this.deps = deps;
  }

  private clock(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private capability(): string {
    return this.deps.capability ?? DEFAULT_FANOUT_CAPABILITY;
  }

  private identitySnapshot(
    counterparty: string,
    actor?: NegotiationActor,
  ): LedgerEventContent["identity"] {
    return {
      sender_identity: this.deps.sender_identity,
      counterparty_identity: counterparty,
      actor,
    };
  }

  private capabilitySnapshot(): LedgerEventContent["capability"] {
    return { capability: this.capability(), protocol_version: "1.0" };
  }

  /** 每腿独立落账；缺省 Ledger 为 no-op。append 失败向上抛（audit trail 损坏 = fail-closed）。 */
  private appendLedger(content: LedgerEventContent): void {
    if (this.deps.ledger === undefined) return;
    this.deps.ledger.append(content);
  }

  /**
   * 向 N 个通道并行发 RFQ。Promise.allSettled 保证单腿崩溃不吞掉其他腿结果
   * （部分失败容忍，§19）。每腿独立 negotiation_id / message_id。
   */
  async fanout(legs: FanoutLegSpec[]): Promise<FanoutResult> {
    const started_at = this.now();
    const settled = await Promise.allSettled(legs.map((leg) => this.runLeg(leg)));
    const legResults: FanoutLegResult[] = settled.map((result, i) => {
      if (result.status === "fulfilled") return result.value;
      const spec = legs[i];
      return {
        identity: spec?.profile.identity ?? "unknown",
        negotiation_id: spec?.negotiation_id ?? "",
        message_id: "",
        outcome: "failed" as const,
        error: { code: "leg_crash", message: errorMessage(result.reason) },
        elapsed_ms: 0,
      };
    });
    return {
      offers: buildComparisonSet(legResults),
      legs: legResults,
      offer_count: legResults.filter((leg) => leg.offer !== undefined).length,
      started_at,
      completed_at: this.now(),
    };
  }

  private async runLeg(spec: FanoutLegSpec): Promise<FanoutLegResult> {
    const identity = spec.profile.identity;
    const negotiation_id = spec.negotiation_id ?? newNegotiationId();
    const messageId = newMessageId();
    const timeoutMs = spec.timeoutMs ?? DEFAULT_FANOUT_TIMEOUT_MS;
    const started = this.clock();
    const occurredAt = this.now();

    const envelope = finalizeEnvelope({
      capability: this.capability(),
      protocol_version: "1.0",
      negotiation_id,
      exchange_id: newExchangeId(),
      message_id: messageId,
      actor: "buyer",
      action: "rfq",
      created_at: occurredAt,
      payload: spec.payload.rfq,
    });

    // 落账 fan-out 起点（每腿独立链）。失败 fail-closed。
    try {
      this.appendLedger({
        event_kind: "system",
        negotiation_id,
        message_id: messageId,
        identity: this.identitySnapshot(identity, "buyer"),
        capability: this.capabilitySnapshot(),
        wire_digest: envelope.digest,
        wire_payload: envelope as unknown as Record<string, unknown>,
        outcome: { kind: "ok", result: { phase: "fanout_round_send", tier: spec.payload.tier } },
        occurred_at: occurredAt,
      });
    } catch (err) {
      return {
        identity,
        negotiation_id,
        message_id: messageId,
        outcome: "failed",
        error: { code: "ledger_append_failed", message: errorMessage(err) },
        elapsed_ms: this.clock() - started,
      };
    }

    let handle: ChannelHandle | null = null;
    try {
      handle = await this.deps.openChannel(spec.profile, {
        negotiation_id,
        sender_identity: this.deps.sender_identity,
        identity,
        timeoutMs,
      });
      const sendResult: ChannelSendResult = await handle.send({
        envelope,
        ref: { negotiation_id },
      });
      const wait = await this.waitForOffer(handle, sendResult.ref, timeoutMs, messageId);
      return this.resolveWait(identity, negotiation_id, messageId, started, wait);
    } catch (err) {
      return {
        identity,
        negotiation_id,
        message_id: messageId,
        outcome: "failed",
        error: { code: errorCode(err), message: errorMessage(err) },
        elapsed_ms: this.clock() - started,
      };
    } finally {
      if (handle !== null) {
        await handle.close().catch(() => undefined);
      }
    }
  }

  /** 带超时的 Offer 收集：轮询 getState 直到 deadline / 收到新 envelope / 终态。 */
  private async waitForOffer(
    handle: ChannelHandle,
    ref: RemoteRef,
    timeoutMs: number,
    sentMessageId: string,
  ): Promise<WaitOutcome> {
    const deadline = this.clock() + timeoutMs;
    const pollInterval = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const extract = this.deps.extractEnvelope ?? extractKnpEnvelopeFromState;
    for (;;) {
      if (this.clock() >= deadline) {
        return { kind: "timeout" };
      }
      const state = await handle.getState(ref);
      if (state.state === "failed") {
        return { kind: "task_failed", state: state.state };
      }
      if (state.state === "canceled") {
        return { kind: "terminal_no_offer", reason: "canceled" };
      }
      const envelope = extract(state);
      if (envelope !== null && envelope.message_id !== sentMessageId) {
        return { kind: "envelope", envelope };
      }
      if (state.stable) {
        return { kind: "terminal_no_offer", reason: "stable_without_envelope" };
      }
      await sleep(pollInterval);
    }
  }

  /** 把 wait 结果解析为 leg outcome，并落账该腿结果（fail-closed）。 */
  private resolveWait(
    identity: string,
    negotiation_id: string,
    messageId: string,
    started: number,
    wait: WaitOutcome,
  ): FanoutLegResult {
    const elapsed = this.clock() - started;
    const occurredAt = this.now();
    const identitySnapshot = this.identitySnapshot(identity, "buyer");
    const capability = this.capabilitySnapshot();
    const record = (
      content: Omit<LedgerEventContent, "negotiation_id" | "identity" | "capability">,
    ) => {
      this.appendLedger({ ...content, negotiation_id, identity: identitySnapshot, capability });
    };

    switch (wait.kind) {
      case "envelope": {
        // 入站 envelope fail-closed：schema + digest（§4.5）。
        const incoming = validateIncoming(wait.envelope);
        if (incoming.action === "offer") {
          const offer = validateOffer(incoming.payload);
          record({
            event_kind: "system",
            message_id: messageId,
            wire_digest: incoming.digest,
            wire_payload: incoming as unknown as Record<string, unknown>,
            outcome: {
              kind: "ok",
              result: { leg_outcome: "offer_received", offer_id: offer.offer_id },
            },
            occurred_at: occurredAt,
          });
          return {
            identity,
            negotiation_id,
            message_id: messageId,
            outcome: "offer_received",
            offer,
            elapsed_ms: elapsed,
          };
        }
        if (incoming.action === "decline") {
          record({
            event_kind: "system",
            message_id: messageId,
            wire_digest: incoming.digest,
            wire_payload: incoming as unknown as Record<string, unknown>,
            outcome: { kind: "ok", result: { leg_outcome: "declined" } },
            occurred_at: occurredAt,
          });
          return {
            identity,
            negotiation_id,
            message_id: messageId,
            outcome: "declined",
            elapsed_ms: elapsed,
          };
        }
        record({
          event_kind: "system",
          message_id: messageId,
          wire_digest: incoming.digest,
          wire_payload: incoming as unknown as Record<string, unknown>,
          outcome: { kind: "ok", result: { leg_outcome: "no_offer", action: incoming.action } },
          occurred_at: occurredAt,
        });
        return {
          identity,
          negotiation_id,
          message_id: messageId,
          outcome: "no_offer",
          elapsed_ms: elapsed,
        };
      }
      case "timeout": {
        record({
          event_kind: "error",
          message_id: messageId,
          outcome: { kind: "error", code: "timeout", message: "no offer received within timeout" },
          occurred_at: occurredAt,
        });
        return {
          identity,
          negotiation_id,
          message_id: messageId,
          outcome: "timed_out",
          error: { code: "timeout", message: "no offer received within timeout" },
          elapsed_ms: elapsed,
        };
      }
      case "task_failed": {
        record({
          event_kind: "error",
          message_id: messageId,
          outcome: { kind: "error", code: "remote_task_failed", message: wait.state },
          occurred_at: occurredAt,
        });
        return {
          identity,
          negotiation_id,
          message_id: messageId,
          outcome: "failed",
          error: { code: "remote_task_failed", message: wait.state },
          elapsed_ms: elapsed,
        };
      }
      case "terminal_no_offer": {
        record({
          event_kind: "system",
          message_id: messageId,
          outcome: { kind: "ok", result: { leg_outcome: "no_offer", reason: wait.reason } },
          occurred_at: occurredAt,
        });
        return {
          identity,
          negotiation_id,
          message_id: messageId,
          outcome: "no_offer",
          elapsed_ms: elapsed,
        };
      }
    }
  }
}
