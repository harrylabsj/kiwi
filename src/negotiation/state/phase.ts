/**
 * KNP/1.0 Negotiation Phase 状态机（子规范 §21，基线 §18.1）。
 *
 * 八态：OPEN / AWAITING_CLARIFICATION / OFFER_OPEN / AGREEMENT_REACHED /
 * DECLINED / WITHDRAWN / CANCELLED / EXPIRED。
 *
 * 事件驱动转换严格对应子规范 §21.2 Core Transition Table；表中不存在的转换
 * fail-closed 抛 state_conflict。五个终态（AGREEMENT_REACHED / DECLINED /
 * WITHDRAWN / CANCELLED / EXPIRED）不得以同一 negotiation_id 重开（§17.4 /
 * 基线 §14.4 Reopen）；新谈判必须新建 negotiation_id。
 *
 * 本机只维护 phase 维度的状态（含 AWAITING_CLARIFICATION 的恢复相位与
 * active offer 记账）；TargetRef 一致性（§9.7）、offer 存在性等由 Ledger 负责。
 */

import { NegotiationValidationError } from "../domain/common.js";
import type { TargetScope } from "../domain/objects.js";

/** KNP/1.0 八态（§21.1 / 基线 §18.1）。 */
export const NEGOTIATION_PHASES = [
  "OPEN",
  "AWAITING_CLARIFICATION",
  "OFFER_OPEN",
  "AGREEMENT_REACHED",
  "DECLINED",
  "WITHDRAWN",
  "CANCELLED",
  "EXPIRED",
] as const;
export type NegotiationPhase = (typeof NEGOTIATION_PHASES)[number];

/** 终态：不得重开（§17.4 / 基线 §14.4）。 */
export const TERMINAL_PHASES = [
  "AGREEMENT_REACHED",
  "DECLINED",
  "WITHDRAWN",
  "CANCELLED",
  "EXPIRED",
] as const;
export type TerminalPhase = (typeof TERMINAL_PHASES)[number];

/** AWAITING_CLARIFICATION 的可恢复相位（§21.2 "previous phase / restore"）。 */
export type ResumePhase = "OPEN" | "OFFER_OPEN";

/** Phase 事件（对齐 §21.2 转换表的事件列）。 */
export type NegotiationPhaseEvent =
  | { type: "clarification" }
  | { type: "clarification_response" }
  | { type: "offer"; offer_id: string }
  | { type: "counter_offer"; offer_id: string }
  | { type: "conditional_offer"; offer_id: string }
  | { type: "offer_expired" }
  | { type: "accept_nonbinding"; offer_id: string }
  | { type: "withdraw"; scope: TargetScope }
  | { type: "decline"; scope: TargetScope }
  | { type: "cancel" }
  | { type: "negotiation_expired" };

export interface NegotiationPhaseState {
  negotiation_id: string;
  phase: NegotiationPhase;
  /** 当前 active offer（§21.2 notes：set / replaced / cleared）。 */
  active_offer_id?: string;
  /** AWAITING_CLARIFICATION 时保存的恢复相位（clarification_response 时还原）。 */
  resume_phase?: ResumePhase;
}

export function isTerminalPhase(phase: NegotiationPhase): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(phase);
}

/** 新 negotiation 的初始状态：对应转换表首行 none → Inquiry/RFQ start → OPEN。 */
export function createNegotiationPhase(negotiation_id: string): NegotiationPhaseState {
  return { negotiation_id, phase: "OPEN" };
}

function describeEvent(event: NegotiationPhaseEvent): string {
  switch (event.type) {
    case "withdraw":
      return `withdraw(scope=${event.scope})`;
    case "decline":
      return `decline(scope=${event.scope})`;
    case "offer":
    case "counter_offer":
    case "conditional_offer":
    case "accept_nonbinding":
      return `${event.type}(${event.offer_id})`;
    default:
      return event.type;
  }
}

function stateConflict(
  state: NegotiationPhaseState,
  event: NegotiationPhaseEvent,
): NegotiationValidationError {
  return new NegotiationValidationError(
    "state_conflict",
    `illegal transition: ${state.phase} + ${describeEvent(event)}`,
    "/phase",
  );
}

function applyClarification(
  state: NegotiationPhaseState,
  event: NegotiationPhaseEvent,
): NegotiationPhaseState {
  if (state.phase === "OPEN") {
    return {
      negotiation_id: state.negotiation_id,
      phase: "AWAITING_CLARIFICATION",
      resume_phase: "OPEN",
    };
  }
  if (state.phase === "OFFER_OPEN") {
    return {
      negotiation_id: state.negotiation_id,
      phase: "AWAITING_CLARIFICATION",
      resume_phase: "OFFER_OPEN",
      active_offer_id: state.active_offer_id,
    };
  }
  throw stateConflict(state, event);
}

function applyClarificationResponse(
  state: NegotiationPhaseState,
  event: NegotiationPhaseEvent,
): NegotiationPhaseState {
  if (state.phase === "AWAITING_CLARIFICATION" && state.resume_phase !== undefined) {
    return {
      negotiation_id: state.negotiation_id,
      phase: state.resume_phase,
      active_offer_id: state.active_offer_id,
    };
  }
  throw stateConflict(state, event);
}

function applyOffer(
  state: NegotiationPhaseState,
  event: Extract<NegotiationPhaseEvent, { type: "offer" }>,
): NegotiationPhaseState {
  if (state.phase === "OPEN") {
    return {
      negotiation_id: state.negotiation_id,
      phase: "OFFER_OPEN",
      active_offer_id: event.offer_id,
    };
  }
  throw stateConflict(state, event);
}

function applyOfferReplacement(
  state: NegotiationPhaseState,
  event: Extract<NegotiationPhaseEvent, { type: "counter_offer" | "conditional_offer" }>,
): NegotiationPhaseState {
  if (state.phase === "OFFER_OPEN") {
    return {
      negotiation_id: state.negotiation_id,
      phase: "OFFER_OPEN",
      active_offer_id: event.offer_id,
    };
  }
  throw stateConflict(state, event);
}

function applyOfferExpiry(
  state: NegotiationPhaseState,
  event: NegotiationPhaseEvent,
): NegotiationPhaseState {
  if (state.phase === "OFFER_OPEN") {
    return { negotiation_id: state.negotiation_id, phase: "OPEN" };
  }
  throw stateConflict(state, event);
}

function applyAccept(
  state: NegotiationPhaseState,
  event: NegotiationPhaseEvent,
): NegotiationPhaseState {
  if (state.phase === "OFFER_OPEN") {
    return {
      negotiation_id: state.negotiation_id,
      phase: "AGREEMENT_REACHED",
      active_offer_id: state.active_offer_id,
    };
  }
  throw stateConflict(state, event);
}

function applyWithdraw(
  state: NegotiationPhaseState,
  event: Extract<NegotiationPhaseEvent, { type: "withdraw" }>,
): NegotiationPhaseState {
  if (event.scope === "offer") {
    if (state.phase === "OFFER_OPEN") {
      return { negotiation_id: state.negotiation_id, phase: "OPEN" };
    }
    throw stateConflict(state, event);
  }
  // scope=negotiation：OPEN/OFFER_OPEN → WITHDRAWN（terminal）。
  if (state.phase === "OPEN" || state.phase === "OFFER_OPEN") {
    return { negotiation_id: state.negotiation_id, phase: "WITHDRAWN" };
  }
  throw stateConflict(state, event);
}

function applyDecline(
  state: NegotiationPhaseState,
  event: Extract<NegotiationPhaseEvent, { type: "decline" }>,
): NegotiationPhaseState {
  if (event.scope === "offer") {
    if (state.phase === "OFFER_OPEN") {
      return { negotiation_id: state.negotiation_id, phase: "OPEN" };
    }
    throw stateConflict(state, event);
  }
  // scope=negotiation：OPEN/OFFER_OPEN → DECLINED（terminal）。
  if (state.phase === "OPEN" || state.phase === "OFFER_OPEN") {
    return { negotiation_id: state.negotiation_id, phase: "DECLINED" };
  }
  throw stateConflict(state, event);
}

/**
 * 按 §21.2 转换表推进 phase。终态拒绝一切事件（不可重开）；表中不存在的
 * 组合抛 state_conflict。返回新状态，不改动输入。
 */
export function transitionPhase(
  state: NegotiationPhaseState,
  event: NegotiationPhaseEvent,
): NegotiationPhaseState {
  // 终态不可重开：任何事件一律 state_conflict（§17.4 / 基线 §14.4）。
  if (isTerminalPhase(state.phase)) {
    throw stateConflict(state, event);
  }

  switch (event.type) {
    case "clarification":
      return applyClarification(state, event);
    case "clarification_response":
      return applyClarificationResponse(state, event);
    case "offer":
      return applyOffer(state, event);
    case "counter_offer":
    case "conditional_offer":
      return applyOfferReplacement(state, event);
    case "offer_expired":
      return applyOfferExpiry(state, event);
    case "accept_nonbinding":
      return applyAccept(state, event);
    case "withdraw":
      return applyWithdraw(state, event);
    case "decline":
      return applyDecline(state, event);
    case "cancel":
      // 非终态（顶层守卫已保证）→ CANCELLED（terminal）。
      return { negotiation_id: state.negotiation_id, phase: "CANCELLED" };
    case "negotiation_expired":
      // 非终态 → EXPIRED（terminal）。
      return { negotiation_id: state.negotiation_id, phase: "EXPIRED" };
  }
}
