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
 * KTH 指标（架构 rev1.4.1 §35A.8 / 完成定义 #21：Negotiation-to-Handoff
 * Rate 可观测）。纯函数：从 Ledger 事件计算，审计即观测源（零新存储）。
 *
 * 口径注记：
 * - "agreements" 以产生 handoff_candidate_created 的候选数为代理
 *   （候选创建以 agreement 存在为前提；Ledger 没有独立的 agreement 事件）；
 * - `reported_external_conversion` 必须标注为外部报告——Kiwi 没有权威
 *   交易集成时恒为 null（KTH rev0.3 §17：MUST be labeled externally
 *   reported unless authoritative integration exists）。
 */

import type { LedgerEvent } from "../negotiation/ledger/event.js";

export interface HandoffMetrics {
  /** 产生过 handoff 候选的 negotiation 数（= 已达成协议的代理口径）。 */
  negotiations_with_candidates: number;
  /** handoff_candidate_created 总数。 */
  candidates_created: number;
  /** handoff_delivered 总数（成功交接的协议数）。 */
  handoffs_delivered: number;
  /** handoff_launched 总数。 */
  launches: number;
  /** handoff_opened_confirmed 总数（仅计有可归属证据的确认）。 */
  opened_confirmed: number;
  /** agreement → handoff 率（delivered / created；无候选时 0）。 */
  agreement_to_handoff_rate: number;
  /** handoff → launch 率（launched / delivered）。 */
  handoff_launch_rate: number;
  /** launch → opened_confirmed 率（opened / delivered）。 */
  opened_confirmed_rate: number;
  /** negotiation → handoff 率（delivered / 有候选的 negotiation 数）。 */
  negotiation_to_handoff_rate: number;
  /** created → delivered 中位时长（秒）；无样本时 null。 */
  time_to_handoff_seconds: number | null;
  /**
   * 外部报告的外部转化率。Kiwi 无权威交易集成 → 恒 null
   * （绝不从 delivered/opened 推断外部成功，§36-27）。
   */
  reported_external_conversion: null;
}

/** 全部 handoff 相关事件 → 指标（跨 negotiation 聚合）。 */
export function computeHandoffMetrics(eventsByNegotiation: ReadonlyMap<string, readonly LedgerEvent[]>): HandoffMetrics {
  let candidatesCreated = 0;
  let delivered = 0;
  let launches = 0;
  let openedConfirmed = 0;
  const negotiationsWithCandidates = new Set<string>();
  const timeToHandoff: number[] = [];

  for (const [negotiationId, events] of eventsByNegotiation) {
    const createdAt = new Map<string, number>();
    const deliveredAt = new Map<string, number>();
    for (const event of events) {
      switch (event.event_kind) {
        case "handoff_candidate_created":
          candidatesCreated += 1;
          negotiationsWithCandidates.add(negotiationId);
          if (event.handoff_candidate_id !== undefined) {
            createdAt.set(event.handoff_candidate_id, Date.parse(event.occurred_at));
          }
          break;
        case "handoff_delivered":
          delivered += 1;
          if (event.handoff_candidate_id !== undefined) {
            deliveredAt.set(event.handoff_candidate_id, Date.parse(event.occurred_at));
          }
          break;
        case "handoff_launched":
          launches += 1;
          break;
        case "handoff_opened_confirmed":
          openedConfirmed += 1;
          break;
        default:
          break;
      }
    }
    for (const [candidateId, created] of createdAt) {
      const deliveredTs = deliveredAt.get(candidateId);
      if (deliveredTs !== undefined && Number.isFinite(created) && Number.isFinite(deliveredTs)) {
        timeToHandoff.push(Math.max(0, deliveredTs - created) / 1000);
      }
    }
  }

  const timeToHandoffSeconds =
    timeToHandoff.length > 0
      ? [...timeToHandoff].sort((a, b) => a - b)[Math.floor(timeToHandoff.length / 2)] ?? null
      : null;

  return {
    negotiations_with_candidates: negotiationsWithCandidates.size,
    candidates_created: candidatesCreated,
    handoffs_delivered: delivered,
    launches,
    opened_confirmed: openedConfirmed,
    agreement_to_handoff_rate: candidatesCreated > 0 ? delivered / candidatesCreated : 0,
    handoff_launch_rate: delivered > 0 ? launches / delivered : 0,
    opened_confirmed_rate: delivered > 0 ? openedConfirmed / delivered : 0,
    negotiation_to_handoff_rate:
      negotiationsWithCandidates.size > 0 ? delivered / negotiationsWithCandidates.size : 0,
    time_to_handoff_seconds: timeToHandoffSeconds,
    reported_external_conversion: null,
  };
}
