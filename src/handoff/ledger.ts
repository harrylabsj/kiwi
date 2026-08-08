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
 * HandoffEventStore —— 复用 `LedgerStore` 引擎（append-only / hash-linked /
 * verifyChain / 禁词扫描全部继承）的 KTH 事件存储。
 *
 * 链 key：negotiation_id（来自候选的 agreement 溯源）——handoff 事件落在
 * 产生它的 negotiation 的审计链上；`eventsForCandidate` / `eventsForHandoff`
 * 在链内按 id 过滤。候选生命周期状态由 events 投影（KTH rev0.3 §5.1，
 * 完成定义 #18 Ledger 可审计 Handoff created/delivered/opened/expired）。
 */

import {
  assertNoForbiddenContent,
  type LedgerCapabilitySnapshot,
  type LedgerEvent,
  type LedgerEventContent,
  type LedgerIdentitySnapshot,
  type LedgerOutcome,
  type LedgerVerifyResult,
} from "../negotiation/ledger/event.js";
import { LedgerStore } from "../negotiation/ledger/store.js";
import type { HandoffCandidate } from "./candidate.js";
import {
  HANDOFF_CANDIDATE_EVENT_KINDS,
  type HandoffCandidateEventKind,
} from "./lifecycle.js";
import { deliveryState, transitionDeliveryState } from "./delivery.js";
import { isTerminalLifecycleState, foldCandidateLifecycle } from "./lifecycle.js";
import { HandoffError } from "./errors.js";

/** 交付观察事件 kind（KTH rev0.3 §9；不伪装外部成交，§36-27/28）。 */
export const HANDOFF_DELIVERY_EVENT_KINDS = [
  "handoff_delivered",
  "handoff_launched",
  "handoff_opened_confirmed",
  "handoff_expired",
  "handoff_revoked",
  "handoff_delivery_failed",
] as const;

export type HandoffDeliveryEventKind = (typeof HANDOFF_DELIVERY_EVENT_KINDS)[number];

export interface HandoffEventStoreOptions {
  /** 基础数据目录；事件落在 `<dir>/ledger/`（与 negotiation 同目录布局）。 */
  dir: string;
  /** 可注入时钟（RFC 3339）；缺省 new Date().toISOString()。 */
  now?: () => string;
}

export interface HandoffEventInput {
  kind: HandoffCandidateEventKind | HandoffDeliveryEventKind;
  /** 溯源候选。 */
  candidate: HandoffCandidate;
  /** 交付事件绑定 handoff_id（candidate 事件省略）。 */
  handoff_id?: string;
  identity: LedgerIdentitySnapshot;
  capability: LedgerCapabilitySnapshot;
  /** 可归属证据（OPENED_CONFIRMED 必需；其余可选）。 */
  evidence?: Record<string, unknown>;
  /** 目的地快照（最小化、非秘密）。 */
  destination?: Record<string, unknown>;
  outcome?: LedgerOutcome;
  occurred_at?: string;
}

/** 从目的地补充字段中剥离候选身份字段（type/ref 属于候选，不可被覆盖）。 */
function stripDestinationIdentityFields(
  destination: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...destination };
  delete rest.type;
  delete rest.ref;
  return rest;
}

/** KTH 事件存储（LedgerStore 引擎复用）。 */
export class HandoffEventStore {
  private readonly store: LedgerStore;
  private readonly now: () => string;

  constructor(options: HandoffEventStoreOptions) {
    this.store = new LedgerStore({ dir: options.dir, now: options.now });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** 追加一条 handoff 事件（candidate 生命周期或交付观察）。 */
  append(input: HandoffEventInput): LedgerEvent {
    // evidence / destination 是自由对象字段（LedgerStore 的禁词扫描只覆盖
    // wire_payload / outcome.result）——本地补扫，保证秘密永不落链（§36-5）。
    if (input.evidence !== undefined) assertNoForbiddenContent(input.evidence, "evidence");
    if (input.destination !== undefined) assertNoForbiddenContent(input.destination, "destination");
    const isCandidateEvent = (HANDOFF_CANDIDATE_EVENT_KINDS as readonly string[]).includes(input.kind);
    const content: LedgerEventContent = {
      event_kind: input.kind,
      negotiation_id: input.candidate.negotiation_id,
      handoff_candidate_id: input.candidate.handoff_candidate_id,
      ...(input.handoff_id !== undefined ? { handoff_id: input.handoff_id } : {}),
      agreement_id: input.candidate.agreement_id,
      terms_digest: input.candidate.terms_digest,
      ...(input.destination !== undefined
        ? {
            destination: {
              type: input.candidate.destination_type,
              ref: input.candidate.destination_ref,
              // 调用方只可补充展示字段（如 final_url）；type/ref 是候选的审计
              // 事实，不得被覆盖（否则落链目的地与候选内容不一致）。
              ...stripDestinationIdentityFields(input.destination),
            },
          }
        : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      identity: input.identity,
      capability: input.capability,
      // 候选生命周期事件携带完整候选文档（KTH rev0.3 §5.1/§18-13：
      // lifecycle 从事件重建且不 mutate 候选内容）。
      outcome:
        input.outcome ??
        (isCandidateEvent
          ? { kind: "ok", result: { candidate: input.candidate } }
          : { kind: "ok", result: {} }),
      occurred_at: input.occurred_at ?? this.now(),
    };
    return this.store.append(content);
  }

  /** 候选生命周期事件（kind 限定 candidate 域）。 */
  appendCandidateEvent(input: Omit<HandoffEventInput, "kind"> & { kind: HandoffCandidateEventKind }): LedgerEvent {
    return this.append(input);
  }

  /**
   * 交付观察事件（kind 限定 delivery 域）。
   *
   * 落链前做交付状态机迁移校验（delivery.ts 的 DELIVERY_TRANSITIONS，
   * 与 candidate lifecycle 的迁移校验对称）：交付事件必须绑定 handoff_id，
   * 且 (none)→DELIVERED 必须是首个事件；REVOKED/EXPIRED/OPENED_CONFIRMED
   * 之后不再接受任何事件。校验按同 handoff_id 折叠（同一 negotiation 链上
   * 可并存多个 handoff 的交付事件，互不干扰）。
   */
  appendDeliveryEvent(input: Omit<HandoffEventInput, "kind"> & { kind: HandoffDeliveryEventKind }): LedgerEvent {
    if (input.handoff_id === undefined) {
      throw new HandoffError("invalid_input", "delivery event requires handoff_id", "handoff_id");
    }
    const chain = this.store.events(input.candidate.negotiation_id);
    const current = deliveryState(chain.filter((e) => e.handoff_id === input.handoff_id));
    transitionDeliveryState(current, input.kind);
    return this.append(input);
  }

  /** 某 negotiation 链上的全部事件。 */
  events(negotiationId: string): LedgerEvent[] {
    return this.store.events(negotiationId);
  }

  /** 全部已落账的 negotiation_id（/handoff 列表用）。 */
  listNegotiations(): string[] {
    return this.store.listNegotiations();
  }

  /** 某候选的全部生命周期 + 交付事件（按记录时间序；链 key = negotiation_id）。 */
  eventsForCandidate(negotiationId: string, candidateId: string): LedgerEvent[] {
    return this.store
      .events(negotiationId)
      .filter((e) => e.handoff_candidate_id === candidateId);
  }

  /** 某 handoff 的交付观察事件。 */
  eventsForHandoff(negotiationId: string, handoffId: string): LedgerEvent[] {
    return this.store.events(negotiationId).filter((e) => e.handoff_id === handoffId);
  }

  /** 链完整性校验（篡改 / 断链 / 重复检出）。 */
  verifyChain(negotiationId: string): LedgerVerifyResult {
    return this.store.verifyChain(negotiationId);
  }

  /**
   * 惰性过期清扫（评审项 L1）：handoff_candidate_expired 此前只在
   * executeHandoff 的过期门内落链——到期未执行的候选在 TUI /handoff 列表
   * 永远显示 PROPOSED/READY"从未获批/从未执行"，指标失真。本方法遍历全部
   * 链，对未终态且 expires_at 已过的候选落 expired 事件。幂等：已终态
   * （EXPIRED/REJECTED/STALE/CONSUMED）候选不重复处理。调用方挂载在 kernel
   * 的周期性入口（schedulerTick）与 /handoff 渲染前。
   */
  sweepExpiredCandidates(now: string): number {
    let swept = 0;
    for (const negotiationId of this.store.listNegotiations()) {
      const events = this.store.events(negotiationId);
      const seen = new Set<string>();
      for (const event of events) {
        const candidateId = event.handoff_candidate_id;
        if (candidateId === undefined || seen.has(candidateId)) continue;
        seen.add(candidateId);
        const candidateEvents = events.filter((e) => e.handoff_candidate_id === candidateId);
        const state = foldCandidateLifecycle(candidateEvents);
        if (state === undefined || isTerminalLifecycleState(state)) continue;
        // 过期判定：候选内嵌文档的 expires_at（created 事件携带完整候选）。
        const created = candidateEvents.find((e) => e.event_kind === "handoff_candidate_created");
        const embedded =
          created?.outcome.kind === "ok"
            ? (created.outcome.result?.candidate as { expires_at?: unknown } | undefined)
            : undefined;
        const expiresAt = typeof embedded?.expires_at === "string" ? embedded.expires_at : "";
        // NaN 防护与 executeHandoff 的过期门一致：不可解析视为未过期（不误杀）。
        if (expiresAt === "" || !Number.isFinite(Date.parse(expiresAt))) continue;
        if (Date.parse(expiresAt) >= Date.parse(now)) continue;
        const candidate = created?.outcome.kind === "ok"
          ? (created.outcome.result?.candidate as HandoffCandidate)
          : undefined;
        if (candidate === undefined) continue;
        try {
          this.appendCandidateEvent({
            kind: "handoff_candidate_expired",
            candidate,
            identity: { sender_identity: candidate.buyer_identity_ref, counterparty_identity: candidate.merchant_identity_ref, actor: "buyer" },
            capability: { capability: "com.harrylabsj.kiwi.shopping.negotiation", protocol_version: "1.0" },
            occurred_at: now,
          });
          swept += 1;
        } catch {
          // 单候选失败不影响整体清扫（fail-closed 但继续其他链）。
        }
      }
    }
    return swept;
  }
}
