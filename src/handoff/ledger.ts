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
        ? { destination: { type: input.candidate.destination_type, ref: input.candidate.destination_ref, ...input.destination } }
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

  /** 交付观察事件（kind 限定 delivery 域）。 */
  appendDeliveryEvent(input: Omit<HandoffEventInput, "kind"> & { kind: HandoffDeliveryEventKind }): LedgerEvent {
    return this.append(input);
  }

  /** 某 negotiation 链上的全部事件。 */
  events(negotiationId: string): LedgerEvent[] {
    return this.store.events(negotiationId);
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
}
