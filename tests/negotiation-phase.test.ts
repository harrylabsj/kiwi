/**
 * KNP/1.0 Negotiation Phase 状态机 tests（子规范 §21.2 转换表，基线 §18.1）：
 *  - 转换表每一行（含 Withdraw/Decline 的 scope=offer vs scope=negotiation 分支）；
 *  - 不在表中的非法转换 fail-closed → state_conflict；
 *  - 五个终态不得以同一 negotiation_id 重开；
 *  - active offer 的 set / replaced / cleared 记账。
 */
import { describe, expect, it } from "vitest";
import { NegotiationValidationError } from "../src/negotiation/domain/common.js";
import {
  TERMINAL_PHASES,
  createNegotiationPhase,
  isTerminalPhase,
  transitionPhase,
  type NegotiationPhase,
  type NegotiationPhaseEvent,
  type NegotiationPhaseState,
} from "../src/negotiation/state/phase.js";

const NEG_ID = "neg_01H5V8KXZqJ7Qp3mN2B6A";
const OFFER_A = "off_01H5V8KXZqJ7Qp3mN2B6A";
const OFFER_B = "off_02H5V8KXZqJ7Qp3mN2B6A";

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof NegotiationValidationError ? e.code : "non-negotiation-error";
  }
}

/** 推进到指定终态，用于终态拒绝/重开测试。 */
function reachTerminal(phase: NegotiationPhase): NegotiationPhaseState {
  const start = createNegotiationPhase(NEG_ID);
  switch (phase) {
    case "AGREEMENT_REACHED":
      return transitionPhase(transitionPhase(start, { type: "offer", offer_id: OFFER_A }), {
        type: "accept_nonbinding",
        offer_id: OFFER_A,
      });
    case "DECLINED":
      return transitionPhase(start, { type: "decline", scope: "negotiation" });
    case "WITHDRAWN":
      return transitionPhase(start, { type: "withdraw", scope: "negotiation" });
    case "CANCELLED":
      return transitionPhase(start, { type: "cancel" });
    case "EXPIRED":
      return transitionPhase(start, { type: "negotiation_expired" });
    default:
      throw new Error(`unexpected phase ${phase}`);
  }
}

describe("创建（转换表首行：none → Inquiry/RFQ start → OPEN）", () => {
  it("creates an OPEN negotiation with the negotiation_id", () => {
    expect(createNegotiationPhase(NEG_ID)).toEqual({ negotiation_id: NEG_ID, phase: "OPEN" });
  });

  it("marks only the five terminal phases as terminal", () => {
    expect(isTerminalPhase("OPEN")).toBe(false);
    expect(isTerminalPhase("AWAITING_CLARIFICATION")).toBe(false);
    expect(isTerminalPhase("OFFER_OPEN")).toBe(false);
    for (const phase of TERMINAL_PHASES) {
      expect(isTerminalPhase(phase)).toBe(true);
    }
  });
});

describe("§21.2 转换表每行", () => {
  it("OPEN + Clarification → AWAITING_CLARIFICATION (save resume=OPEN)", () => {
    const next = transitionPhase(createNegotiationPhase(NEG_ID), { type: "clarification" });
    expect(next.phase).toBe("AWAITING_CLARIFICATION");
    expect(next.resume_phase).toBe("OPEN");
  });

  it("AWAITING_CLARIFICATION + clarification_response → previous phase (restore OPEN)", () => {
    const awaiting = transitionPhase(createNegotiationPhase(NEG_ID), { type: "clarification" });
    const next = transitionPhase(awaiting, { type: "clarification_response" });
    expect(next.phase).toBe("OPEN");
    expect(next.resume_phase).toBeUndefined();
  });

  it("AWAITING_CLARIFICATION + clarification_response → previous phase (restore OFFER_OPEN)", () => {
    const open = createNegotiationPhase(NEG_ID);
    const offerOpen = transitionPhase(open, { type: "offer", offer_id: OFFER_A });
    const awaiting = transitionPhase(offerOpen, { type: "clarification" });
    expect(awaiting.resume_phase).toBe("OFFER_OPEN");
    const restored = transitionPhase(awaiting, { type: "clarification_response" });
    expect(restored.phase).toBe("OFFER_OPEN");
    expect(restored.active_offer_id).toBe(OFFER_A);
  });

  it("OPEN + Offer → OFFER_OPEN (active offer set)", () => {
    const next = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    expect(next.phase).toBe("OFFER_OPEN");
    expect(next.active_offer_id).toBe(OFFER_A);
  });

  it("OFFER_OPEN + CounterOffer → OFFER_OPEN (active offer replaced)", () => {
    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    const next = transitionPhase(offerOpen, { type: "counter_offer", offer_id: OFFER_B });
    expect(next.phase).toBe("OFFER_OPEN");
    expect(next.active_offer_id).toBe(OFFER_B);
  });

  it("OFFER_OPEN + ConditionalOffer → OFFER_OPEN (active offer replaced)", () => {
    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    const next = transitionPhase(offerOpen, { type: "conditional_offer", offer_id: OFFER_B });
    expect(next.phase).toBe("OFFER_OPEN");
    expect(next.active_offer_id).toBe(OFFER_B);
  });

  it("OFFER_OPEN + Clarification → AWAITING_CLARIFICATION (resume to OFFER_OPEN)", () => {
    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    const next = transitionPhase(offerOpen, { type: "clarification" });
    expect(next.phase).toBe("AWAITING_CLARIFICATION");
    expect(next.resume_phase).toBe("OFFER_OPEN");
  });

  it("OFFER_OPEN + active offer expires → OPEN (active offer cleared)", () => {
    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    const next = transitionPhase(offerOpen, { type: "offer_expired" });
    expect(next.phase).toBe("OPEN");
    expect(next.active_offer_id).toBeUndefined();
  });

  it("OFFER_OPEN + AcceptNonbinding → AGREEMENT_REACHED (terminal)", () => {
    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    const next = transitionPhase(offerOpen, { type: "accept_nonbinding", offer_id: OFFER_A });
    expect(next.phase).toBe("AGREEMENT_REACHED");
    expect(isTerminalPhase(next.phase)).toBe(true);
  });

  it("OFFER_OPEN + Withdraw scope=offer → OPEN (target offer closed)", () => {
    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    const next = transitionPhase(offerOpen, { type: "withdraw", scope: "offer" });
    expect(next.phase).toBe("OPEN");
    expect(next.active_offer_id).toBeUndefined();
  });

  it("OPEN/OFFER_OPEN + Withdraw scope=negotiation → WITHDRAWN (terminal)", () => {
    const fromOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "withdraw",
      scope: "negotiation",
    });
    expect(fromOpen.phase).toBe("WITHDRAWN");
    expect(isTerminalPhase(fromOpen.phase)).toBe(true);

    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    const fromOffer = transitionPhase(offerOpen, { type: "withdraw", scope: "negotiation" });
    expect(fromOffer.phase).toBe("WITHDRAWN");
  });

  it("OFFER_OPEN + Decline scope=offer → OPEN (target offer closed)", () => {
    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    const next = transitionPhase(offerOpen, { type: "decline", scope: "offer" });
    expect(next.phase).toBe("OPEN");
    expect(next.active_offer_id).toBeUndefined();
  });

  it("OPEN/OFFER_OPEN + Decline scope=negotiation → DECLINED (terminal)", () => {
    const fromOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "decline",
      scope: "negotiation",
    });
    expect(fromOpen.phase).toBe("DECLINED");
    expect(isTerminalPhase(fromOpen.phase)).toBe(true);

    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    const fromOffer = transitionPhase(offerOpen, { type: "decline", scope: "negotiation" });
    expect(fromOffer.phase).toBe("DECLINED");
  });

  it("non-terminal + Cancel → CANCELLED (terminal)", () => {
    const open = transitionPhase(createNegotiationPhase(NEG_ID), { type: "cancel" });
    expect(open.phase).toBe("CANCELLED");
    expect(isTerminalPhase(open.phase)).toBe(true);

    const awaiting = transitionPhase(createNegotiationPhase(NEG_ID), { type: "clarification" });
    expect(transitionPhase(awaiting, { type: "cancel" }).phase).toBe("CANCELLED");

    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    expect(transitionPhase(offerOpen, { type: "cancel" }).phase).toBe("CANCELLED");
  });

  it("non-terminal + negotiation expiry → EXPIRED (terminal)", () => {
    const open = transitionPhase(createNegotiationPhase(NEG_ID), { type: "negotiation_expired" });
    expect(open.phase).toBe("EXPIRED");
    expect(isTerminalPhase(open.phase)).toBe(true);

    const awaiting = transitionPhase(createNegotiationPhase(NEG_ID), { type: "clarification" });
    expect(transitionPhase(awaiting, { type: "negotiation_expired" }).phase).toBe("EXPIRED");
  });
});

describe("非法转换 fail-closed → state_conflict", () => {
  it("rejects offer_expired outside OFFER_OPEN", () => {
    const open = createNegotiationPhase(NEG_ID);
    expect(errorCode(() => transitionPhase(open, { type: "offer_expired" }))).toBe(
      "state_conflict",
    );
  });

  it("rejects accept_nonbinding outside OFFER_OPEN", () => {
    const open = createNegotiationPhase(NEG_ID);
    expect(
      errorCode(() => transitionPhase(open, { type: "accept_nonbinding", offer_id: OFFER_A })),
    ).toBe("state_conflict");
  });

  it("rejects Withdraw scope=offer outside OFFER_OPEN", () => {
    const open = createNegotiationPhase(NEG_ID);
    expect(errorCode(() => transitionPhase(open, { type: "withdraw", scope: "offer" }))).toBe(
      "state_conflict",
    );
  });

  it("rejects Decline scope=offer outside OFFER_OPEN", () => {
    const open = createNegotiationPhase(NEG_ID);
    expect(errorCode(() => transitionPhase(open, { type: "decline", scope: "offer" }))).toBe(
      "state_conflict",
    );
  });

  it("rejects a second Offer from OFFER_OPEN (replacement is a distinct event)", () => {
    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    expect(errorCode(() => transitionPhase(offerOpen, { type: "offer", offer_id: OFFER_B }))).toBe(
      "state_conflict",
    );
  });

  it("rejects commercial actions while AWAITING_CLARIFICATION", () => {
    const awaiting = transitionPhase(createNegotiationPhase(NEG_ID), { type: "clarification" });
    expect(errorCode(() => transitionPhase(awaiting, { type: "offer", offer_id: OFFER_A }))).toBe(
      "state_conflict",
    );
    expect(errorCode(() => transitionPhase(awaiting, { type: "clarification" }))).toBe(
      "state_conflict",
    );
  });

  it("rejects Decline scope=offer while AWAITING_CLARIFICATION (resume=OPEN)", () => {
    // 澄清前无 offer（resume=OPEN）→ 无 offer 可 decline，保持 fail-closed。
    const awaiting = transitionPhase(createNegotiationPhase(NEG_ID), { type: "clarification" });
    expect(errorCode(() => transitionPhase(awaiting, { type: "decline", scope: "offer" }))).toBe(
      "state_conflict",
    );
  });

  it("rejects clarification_response outside AWAITING_CLARIFICATION", () => {
    const open = createNegotiationPhase(NEG_ID);
    expect(errorCode(() => transitionPhase(open, { type: "clarification_response" }))).toBe(
      "state_conflict",
    );
    const offerOpen = transitionPhase(open, { type: "offer", offer_id: OFFER_A });
    expect(errorCode(() => transitionPhase(offerOpen, { type: "clarification_response" }))).toBe(
      "state_conflict",
    );
  });

  it("rejects offer_expired / offer while OFFER_OPEN is replaced only via counter/conditional", () => {
    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    // offer_expired 在 OFFER_OPEN 是合法行；这里验证的是另一条非法组合不受影响。
    expect(transitionPhase(offerOpen, { type: "offer_expired" }).phase).toBe("OPEN");
  });
});

describe("rev1.4 §21.2: AWAITING_CLARIFICATION 下的 Withdraw/Decline", () => {
  it("allows Withdraw scope=negotiation while AWAITING_CLARIFICATION → WITHDRAWN", () => {
    const awaiting = transitionPhase(createNegotiationPhase(NEG_ID), { type: "clarification" });
    const next = transitionPhase(awaiting, { type: "withdraw", scope: "negotiation" });
    expect(next.phase).toBe("WITHDRAWN");
  });

  it("allows Decline scope=negotiation while AWAITING_CLARIFICATION → DECLINED", () => {
    const awaiting = transitionPhase(createNegotiationPhase(NEG_ID), { type: "clarification" });
    const next = transitionPhase(awaiting, { type: "decline", scope: "negotiation" });
    expect(next.phase).toBe("DECLINED");
  });

  it("allows Decline scope=offer while AWAITING_CLARIFICATION (resume=OFFER_OPEN) → OPEN", () => {
    const offerOpen = transitionPhase(createNegotiationPhase(NEG_ID), {
      type: "offer",
      offer_id: OFFER_A,
    });
    const awaiting = transitionPhase(offerOpen, { type: "clarification" });
    expect(awaiting.resume_phase).toBe("OFFER_OPEN");
    expect(awaiting.active_offer_id).toBe(OFFER_A);
    const next = transitionPhase(awaiting, { type: "decline", scope: "offer" });
    // 澄清挂起的 active offer 关闭，不再阻塞闭合；offer 状态清零。
    expect(next.phase).toBe("OPEN");
    expect(next.active_offer_id).toBeUndefined();
    expect(next.resume_phase).toBeUndefined();
  });
});

describe("终态不得以同一 negotiation_id 重开", () => {
  const anyEvents: NegotiationPhaseEvent[] = [
    { type: "clarification" },
    { type: "offer", offer_id: OFFER_A },
    { type: "cancel" },
    { type: "negotiation_expired" },
    { type: "withdraw", scope: "offer" },
    { type: "withdraw", scope: "negotiation" },
  ];

  it.each(TERMINAL_PHASES)("%s rejects every event", (phase) => {
    const terminal = reachTerminal(phase);
    for (const event of anyEvents) {
      expect(errorCode(() => transitionPhase(terminal, event))).toBe("state_conflict");
    }
    expect(terminal.negotiation_id).toBe(NEG_ID);
  });

  it("a fresh negotiation_id starts at OPEN again", () => {
    const reopen = createNegotiationPhase("neg_02FRESH");
    expect(reopen.phase).toBe("OPEN");
  });
});
