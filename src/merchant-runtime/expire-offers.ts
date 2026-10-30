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
 * 过期报价自动终止：扫描 A2A Ledger，把「OFFER_OPEN 且 active offer 的
 * valid_until 已过」的磋商追加一条 `state_transition`（OFFER_OPEN → EXPIRED）。
 *
 * - 只写账本事实，不改写历史；重复运行幂等（相位已是 EXPIRED 即跳过）。
 * - 24h 是兜底：优先取最后一条 offer-like 消息的 `terms.valid_until`；缺失时
 *   用该消息落账时间 + 24h。
 * - 身份/能力快照取自该磋商最后一条商家出站事件，保证审计可追溯。
 */

import path from "node:path";

import { LedgerStore, type LedgerEvent } from "../negotiation/ledger/index.js";
import type { NegotiationPhase } from "../negotiation/state/phase.js";
import { isTerminalPhase } from "../negotiation/state/phase.js";

export const DEFAULT_OFFER_VALIDITY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";

interface EnvelopeShape {
  action?: string;
  payload?: {
    terms?: { valid_until?: unknown };
    proposed_terms?: { valid_until?: unknown };
    base_terms?: { valid_until?: unknown };
  };
}

function isOfferAction(action: string | undefined): boolean {
  return action === "offer" || action === "counter_offer" || action === "conditional_offer";
}

function validUntilFrom(event: LedgerEvent): number | undefined {
  const wire = event.wire_payload as EnvelopeShape | undefined;
  if (!isOfferAction(wire?.action)) return undefined;
  const terms = wire?.payload?.terms ?? wire?.payload?.proposed_terms ?? wire?.payload?.base_terms;
  const raw = terms?.valid_until;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  const recorded = Date.parse(event.recorded_at);
  return Number.isFinite(recorded) ? recorded + DEFAULT_OFFER_VALIDITY_MS : undefined;
}

export interface ExpireOverdueOffersOptions {
  dataDir: string;
  now?: () => string;
  log?: (line: string) => void;
}

export interface ExpireOverdueOffersResult {
  expired: number;
  scanned: number;
}

/**
 * 扫描并终止过期报价；返回本次追加的 EXPIRED 数量。
 * 账本不可读时抛出——由 runtime job 记录错误，不静默假装成功。
 */
export async function expireOverdueOffers(
  options: ExpireOverdueOffersOptions,
): Promise<ExpireOverdueOffersResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const nowIso = now();
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) throw new Error("expireOverdueOffers: invalid clock");
  const ledger = new LedgerStore({ dir: path.join(options.dataDir, "a2a"), now });
  let expired = 0;
  let scanned = 0;

  for (const negotiationId of ledger.listNegotiations()) {
    const events = ledger.events(negotiationId).map((event) => ledger.resolvePayload(event));
    if (events.length === 0) continue;
    scanned += 1;

    let phase: NegotiationPhase = "OPEN";
    let deadline: number | undefined;
    let lastMerchantEvent: LedgerEvent | undefined;
    let lastEvent: LedgerEvent | undefined;
    for (const event of events) {
      lastEvent = event;
      if (event.identity.actor === "merchant") lastMerchantEvent = event;
      if (event.state_transition?.to_phase !== undefined) {
        phase = event.state_transition.to_phase;
      }
      const offerDeadline = validUntilFrom(event);
      if (offerDeadline !== undefined) deadline = offerDeadline;
    }

    if (phase !== "OFFER_OPEN" || isTerminalPhase(phase)) continue;
    if (deadline === undefined || nowMs < deadline) continue;

    const identitySource = lastMerchantEvent ?? lastEvent;
    if (identitySource === undefined) continue;
    const capability = identitySource.capability ?? {
      capability: DEFAULT_CAPABILITY,
      protocol_version: "1.0",
    };
    const counterparty = [...events]
      .reverse()
      .find((event) => event.identity.counterparty_identity !== "")?.identity.counterparty_identity;

    await ledger.append({
      event_kind: "state_transition",
      negotiation_id: negotiationId,
      state_transition: { from_phase: "OFFER_OPEN", to_phase: "EXPIRED" },
      identity: {
        sender_identity: identitySource.identity.sender_identity,
        counterparty_identity: counterparty ?? identitySource.identity.counterparty_identity,
        actor: "merchant",
      },
      capability,
      outcome: { kind: "ok" },
      occurred_at: nowIso,
    });
    expired += 1;
    options.log?.(`[kiwi] expired negotiation ${negotiationId} (offer valid_until passed)`);
  }

  return { expired, scanned };
}
