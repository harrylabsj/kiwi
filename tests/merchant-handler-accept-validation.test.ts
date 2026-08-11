// merchant accept_nonbinding 的 KNP §15 校验（审查 P2-C/P2-D，2026-08-10）
//
// P2-C：accept 必须引用本磋商活跃的 conditional offer，且 terms_digest 必须
// 等于 agreed terms 的 canonical digest——任一检查失败都不得产出 agreement。
// 历史行为：错误 digest / 从未发出的 offer_id / 无前置 conditional 都照样
// 成交（错误 digest 走基础价回退），agreement 指向不存在的 offer。
// P2-D：终态（AGREEMENT_REACHED/WITHDRAWN/DECLINED/CANCELLED）不得以同一
// negotiation_id 重开——历史行为：连发两份 accept 产出两份 agreement。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NegotiationHandler, NegotiationHandlerResult } from "../src/a2a/server/types.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { contentDigest } from "../src/negotiation/jcs.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";

const NOW = "2026-08-09T10:00:00Z";
const NEGOTIATION_ID = "neg_p2c_001";
const MERCHANT_CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";

describe("merchant accept KNP §15 validation (P2-C/P2-D)", () => {
  let dir: string;
  let ledger: LedgerStore;
  let handler: NegotiationHandler;
  let seq = 0;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-p2c-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
    handler = createMerchantHandler({
      ledger,
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
    });
    seq = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const envelopeFor = (
    action: string,
    payload: Record<string, unknown>,
    inReplyTo?: string,
  ): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: MERCHANT_CAPABILITY,
      protocol_version: "1.0",
      negotiation_id: NEGOTIATION_ID,
      exchange_id: `ex_${seq}`,
      message_id: `msg_${seq}`,
      in_reply_to: inReplyTo ?? `msg_${seq - 1}`,
      actor: "buyer",
      action: action as NegotiationEnvelope["action"],
      created_at: NOW,
      payload: payload as never,
    });
  };

  const run = async (envelope: NegotiationEnvelope): Promise<NegotiationHandlerResult> =>
    handler.handle({
      envelope: envelope as never,
      message: {
        role: "user",
        parts: [],
        messageId: envelope.message_id,
      },
      taskId: `task_${seq}`,
      senderIdentity: "buyer:buyer-001",
    });

  const extractOfferId = (result: NegotiationHandlerResult): string => {
    const reply = result.kind === "accepted" && result.message
      ? (
          result.message.parts[0] as unknown as {
            data?: { knp_envelope?: { payload?: { offer_id?: string } } };
          }
        ).data?.knp_envelope?.payload?.offer_id
      : undefined;
    expect(reply).toBeTruthy();
    return reply as string;
  };

  /** 走 inquiry → counter_offer → conditional_offer 拿到活跃 conditional。 */
  const reachConditional = async (): Promise<{ offerId: string; agreedTerms: unknown }> => {
    await run(envelopeFor("inquiry", {}));
    await run(envelopeFor("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
    await run(envelopeFor("offer", { offer_id: "off_buyer", terms: {} }));
    const cond = await run(
      envelopeFor("counter_offer", { offer_id: "off_counter", proposed_terms: {} }),
    );
    const offerId = extractOfferId(cond);
    // 与 negotiate.ts 相同的确定性求值：quantity=200 命中 conditions
    const conditional = (cond.kind === "accepted" && cond.message
      ? (
          cond.message.parts[0] as unknown as {
            data?: { knp_envelope?: { payload?: unknown } };
          }
        ).data?.knp_envelope?.payload
      : undefined) as { conditions?: unknown };
    const { evaluateConditionalOffer } = await import("../src/negotiation/condition/evaluator.js");
    const agreedTerms = evaluateConditionalOffer(
      conditional as never,
      { "aggregate.total_quantity": 200 },
    );
    return { offerId, agreedTerms };
  };

  it("accept with unknown offer_id is declined, no agreement (P2-C)", async () => {
    await reachConditional();
    const result = await run(
      envelopeFor("accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: "off_never_issued",
        terms_digest: contentDigest({} as never),
      }),
    );
    expect(result.kind).toBe("declined");
    expect(result.kind === "declined" && result.reasonCode).toBe("offer_unknown");
  });

  it("accept with mismatched terms_digest is declined, no agreement (P2-C)", async () => {
    const { offerId } = await reachConditional();
    const result = await run(
      envelopeFor("accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: offerId,
        terms_digest: "sha256:" + "0".repeat(64),
      }),
    );
    expect(result.kind).toBe("declined");
    expect(result.kind === "declined" && result.reasonCode).toBe("terms_digest_mismatch");
  });

  it("accept without prior conditional is declined (P2-C)", async () => {
    const result = await run(
      envelopeFor("accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: "off_x",
        terms_digest: contentDigest({} as never),
      }),
    );
    expect(result.kind).toBe("declined");
    expect(result.kind === "declined" && result.reasonCode).toBe("offer_unknown");
  });

  it("accept with matching digest produces one agreement (P2-C happy path)", async () => {
    const { offerId, agreedTerms } = await reachConditional();
    const result = await run(
      envelopeFor("accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: offerId,
        terms_digest: contentDigest(agreedTerms as never),
      }),
    );
    expect(result.kind).toBe("accepted");
    const artifact =
      result.kind === "accepted" &&
      (result.artifactParts?.[0] as unknown as { data?: { agreement?: Record<string, unknown> } })
        ?.data;
    expect((artifact as { agreement?: { agreement_id?: string } })?.agreement?.agreement_id).toBeTruthy();
    expect((artifact as { agreement?: { accepted_offer_id?: string } })?.agreement?.accepted_offer_id)
      .toBe(offerId);
  });

  it("second accept after agreement is declined — no double agreement (P2-D)", async () => {
    const { offerId, agreedTerms } = await reachConditional();
    const digest = contentDigest(agreedTerms as never);
    const first = await run(
      envelopeFor("accept_nonbinding", { type: "accept_nonbinding", offer_id: offerId, terms_digest: digest }),
    );
    expect(first.kind).toBe("accepted");
    // 同 negotiation 重发 accept（不同 message_id）→ 终态拒绝
    const second = await run(
      envelopeFor("accept_nonbinding", { type: "accept_nonbinding", offer_id: offerId, terms_digest: digest }),
    );
    expect(second.kind).toBe("declined");
    expect(second.kind === "declined" && second.reasonCode).toBe("state_conflict");
  });

  // ── 审查 P1-07：终态后 withdraw/decline/cancel 必须被拒（不只 accept）─────
  it("AGREEMENT_REACHED 后 withdraw/decline/cancel（含 offer 级）→ state_conflict（P1-07）", async () => {
    const { offerId, agreedTerms } = await reachConditional();
    const digest = contentDigest(agreedTerms as never);
    const acc = await run(
      envelopeFor("accept_nonbinding", { type: "accept_nonbinding", offer_id: offerId, terms_digest: digest }),
    );
    expect(acc.kind).toBe("accepted");

    const terminalActions: Array<[string, Record<string, unknown>]> = [
      ["withdraw", { scope: "negotiation" }],
      ["withdraw", { scope: "offer" }],
      ["decline", { scope: "negotiation" }],
      ["decline", { scope: "offer" }],
      ["cancel", {}],
    ];
    for (const [action, payload] of terminalActions) {
      const result = await run(envelopeFor(action, payload));
      expect(result.kind).toBe("declined");
      expect(result.kind === "declined" && result.reasonCode).toBe("state_conflict");
    }
    // 链上无任何后置终局事件（withdraw/decline/cancel 的 state_transition 未落账）
    const transitions = ledger
      .events(NEGOTIATION_ID)
      .filter((e) => e.event_kind === "state_transition")
      .map((e) => e.state_transition);
    expect(transitions.filter((t) => t?.to_phase === "AGREEMENT_REACHED")).toHaveLength(1);
    expect(
      transitions.some((t) => ["WITHDRAWN", "DECLINED", "CANCELLED"].includes(t?.to_phase ?? "")),
    ).toBe(false);
  });

  it("WITHDRAWN 后再 withdraw/cancel → state_conflict；DECLINED 后再 cancel → state_conflict（P1-07）", async () => {
    // WITHDRAWN 终态
    await reachConditional();
    const wd = await run(envelopeFor("withdraw", { scope: "negotiation" }));
    expect(wd.kind).toBe("accepted");

    const wd2 = await run(envelopeFor("withdraw", { scope: "negotiation" }));
    expect(wd2.kind === "declined" && wd2.reasonCode).toBe("state_conflict");
    const cancelAfterWd = await run(envelopeFor("cancel", {}));
    expect(cancelAfterWd.kind === "declined" && cancelAfterWd.reasonCode).toBe("state_conflict");
  });

  it("CANCELLED 后 withdraw / accept → state_conflict（P1-07 终态不可重开）", async () => {
    await reachConditional();
    const cancel = await run(envelopeFor("cancel", {}));
    expect(cancel.kind).toBe("accepted");
    const wdAfterCancel = await run(envelopeFor("withdraw", { scope: "negotiation" }));
    expect(wdAfterCancel.kind === "declined" && wdAfterCancel.reasonCode).toBe("state_conflict");
    const acceptAfterCancel = await run(
      envelopeFor("accept_nonbinding", { type: "accept_nonbinding", offer_id: "off_x", terms_digest: "sha256:" + "0".repeat(64) }),
    );
    expect(acceptAfterCancel.kind === "declined" && acceptAfterCancel.reasonCode).toBe("state_conflict");
  });

  // ── P1-07 独立故障注入：同动作原样重放（原复现形态：双 cancel →
  //    CANCELLED→CANCELLED）不得再被当作新动作接受 ─────────────────────
  it("CANCELLED 后原样重放 cancel → state_conflict，无新转换事件（P1-07 原复现形态）", async () => {
    await reachConditional();
    const first = await run(envelopeFor("cancel", {}));
    expect(first.kind).toBe("accepted");
    const transitionsAfterFirst = ledger
      .events(NEGOTIATION_ID)
      .filter((e) => e.event_kind === "state_transition").length;

    // 同一终态动作原样重放（不同 message_id，绕过协议幂等直达 handler）。
    const replay = await run(envelopeFor("cancel", {}));
    expect(replay.kind).toBe("declined");
    expect(replay.kind === "declined" && replay.reasonCode).toBe("state_conflict");

    // 无新 state_transition 事件；CANCELLED 转换全程恰一条（无 CANCELLED→CANCELLED）。
    const transitions = ledger
      .events(NEGOTIATION_ID)
      .filter((e) => e.event_kind === "state_transition");
    expect(transitions.length).toBe(transitionsAfterFirst);
    expect(transitions.filter((t) => t.state_transition?.to_phase === "CANCELLED")).toHaveLength(1);
  });

  it("DECLINED 后原样重放 decline（scope=negotiation）→ state_conflict，无新转换事件（P1-07）", async () => {
    await reachConditional();
    const first = await run(envelopeFor("decline", { scope: "negotiation" }));
    expect(first.kind).toBe("accepted");
    const transitionsAfterFirst = ledger
      .events(NEGOTIATION_ID)
      .filter((e) => e.event_kind === "state_transition").length;

    const replay = await run(envelopeFor("decline", { scope: "negotiation" }));
    expect(replay.kind).toBe("declined");
    expect(replay.kind === "declined" && replay.reasonCode).toBe("state_conflict");

    const transitions = ledger
      .events(NEGOTIATION_ID)
      .filter((e) => e.event_kind === "state_transition");
    expect(transitions.length).toBe(transitionsAfterFirst);
    expect(transitions.filter((t) => t.state_transition?.to_phase === "DECLINED")).toHaveLength(1);
  });

  it("withdraw scope=negotiation closes the negotiation (P2-D)", async () => {
    await reachConditional();
    const wd = await run(
      envelopeFor("withdraw", { scope: "negotiation" }),
    );
    expect(wd.kind).toBe("accepted");
    // 终态后 accept 被拒
    const result = await run(
      envelopeFor("accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: "off_x",
        terms_digest: contentDigest({} as never),
      }),
    );
    expect(result.kind).toBe("declined");
    expect(result.kind === "declined" && result.reasonCode).toBe("state_conflict");
  });

  it("records state_transition events on terminal transitions (P2-D)", async () => {
    const { offerId, agreedTerms } = await reachConditional();
    await run(
      envelopeFor("accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: offerId,
        terms_digest: contentDigest(agreedTerms as never),
      }),
    );
    const events = ledger.events(NEGOTIATION_ID);
    const transitions = events.filter((e) => e.event_kind === "state_transition");
    expect(transitions.length).toBeGreaterThanOrEqual(1);
    const last = transitions.at(-1);
    expect(last).toBeDefined();
    expect(last?.state_transition?.to_phase).toBe("AGREEMENT_REACHED");
    // 审查 BUG-10：中间相位转换（OPEN→OFFER_OPEN）也落账——终态转换的
    // from_phase 现在是 OFFER_OPEN（此前只记录终态一条、from 恒 OPEN）。
    expect(last?.state_transition?.from_phase).toBe("OFFER_OPEN");
  });
});

// ── 重启恢复（审查 BUG-03，2026-08-10）─────────────────────────────────────

describe("merchant handler 重启恢复（BUG-03）", () => {
  let dir: string;
  let ledger: LedgerStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-bug03-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const makeHandler = (): NegotiationHandler =>
    createMerchantHandler({
      ledger,
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
    });

  const runWith = (
    h: NegotiationHandler,
    envelope: NegotiationEnvelope,
  ): Promise<NegotiationHandlerResult> =>
    h.handle({
      envelope: envelope as never,
      message: { role: "user", parts: [], messageId: envelope.message_id },
      taskId: `task_${envelope.message_id}`,
      senderIdentity: "buyer:buyer-001",
    });

  let seq = 0;
  const env = (
    action: string,
    payload: Record<string, unknown>,
    inReplyTo?: string,
  ): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: MERCHANT_CAPABILITY,
      protocol_version: "1.0",
      negotiation_id: NEGOTIATION_ID,
      exchange_id: `ex_${seq}`,
      message_id: `msg_${seq}`,
      in_reply_to: inReplyTo ?? `msg_${seq - 1}`,
      actor: "buyer",
      action: action as NegotiationEnvelope["action"],
      created_at: NOW,
      payload: payload as never,
    });
  };

  const runNegotiationToConditional = async (h: NegotiationHandler): Promise<{
    offerId: string;
    agreedTerms: unknown;
  }> => {
    await runWith(h, env("inquiry", {}));
    await runWith(h, env("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
    await runWith(h, env("offer", { offer_id: "off_buyer", terms: {} }));
    const cond = await runWith(h, env("counter_offer", { offer_id: "off_counter", proposed_terms: {} }));
    const offerId = (() => {
      const reply = cond.kind === "accepted" && cond.message
        ? (
            cond.message.parts[0] as unknown as {
              data?: { knp_envelope?: { payload?: { offer_id?: string } } };
            }
          ).data?.knp_envelope?.payload?.offer_id
        : undefined;
      expect(reply).toBeTruthy();
      return reply as string;
    })();
    const conditional = (cond.kind === "accepted" && cond.message
      ? (
          cond.message.parts[0] as unknown as {
            data?: { knp_envelope?: { payload?: unknown } };
          }
        ).data?.knp_envelope?.payload
      : undefined) as { conditions?: unknown };
    const { evaluateConditionalOffer } = await import("../src/negotiation/condition/evaluator.js");
    const agreedTerms = evaluateConditionalOffer(conditional as never, {
      "aggregate.total_quantity": 200,
    });
    return { offerId, agreedTerms };
  };

  it("同 Ledger 重建 handler：已发 conditional offer 继续可接受（不返回 offer_unknown）", async () => {
    const first = makeHandler();
    const { offerId, agreedTerms } = await runNegotiationToConditional(first);

    // "重启"：丢弃第一个实例，同 Ledger 重建
    const second = makeHandler();
    const result = await runWith(
      second,
      env("accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: offerId,
        terms_digest: contentDigest(agreedTerms as never),
      }),
    );
    expect(result.kind).toBe("accepted");
  });

  it("重启后终态 negotiation 拒绝重开（state_conflict）", async () => {
    const first = makeHandler();
    const { offerId, agreedTerms } = await runNegotiationToConditional(first);
    const accepted = await runWith(
      first,
      env("accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: offerId,
        terms_digest: contentDigest(agreedTerms as never),
      }),
    );
    expect(accepted.kind).toBe("accepted");

    // "重启"后：同 negotiation 的商业动作被终态守卫拒绝
    const second = makeHandler();
    const reaccept = await runWith(
      second,
      env("accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: offerId,
        terms_digest: contentDigest(agreedTerms as never),
      }),
    );
    expect(reaccept.kind).toBe("declined");
    expect(reaccept.kind === "declined" && reaccept.reasonCode).toBe("state_conflict");
    const rfq = await runWith(second, env("rfq", { items: [{ sku: "SKU-001" }] }));
    expect(rfq.kind).toBe("declined");
    expect(rfq.kind === "declined" && rfq.reasonCode).toBe("state_conflict");
  });

  // ── P1-07 独立故障注入：重启后重放终态动作。终态守卫必须跨重启成立——
  //    恢复路径（createMerchantHandler 构造时从 Ledger 重建）曾只恢复
  //    closedNegotiations 而不恢复终态相位：withdraw/decline/cancel 不在
  //    COMMERCIAL_ACTIONS 内，重启后从全新 OPEN 状态推进、被当作新动作
  //    接受并落幻影转换。修复：恢复循环对终态 negotiation 也按链上
  //    state_transition 事实恢复 phaseStateByNegotiation。 ────────────────
  it("重启后原样重放 cancel → state_conflict，无新 state_transition 事件（P1-07 跨重启）", async () => {
    const first = makeHandler();
    await runNegotiationToConditional(first);
    const cancel = await runWith(first, env("cancel", {}));
    expect(cancel.kind).toBe("accepted");
    const transitionsBefore = ledger
      .events(NEGOTIATION_ID)
      .filter((e) => e.event_kind === "state_transition").length;

    // “重启”后原样重放同一终态动作（不同 message_id，直达 handler）。
    const second = makeHandler();
    const replay = await runWith(second, env("cancel", {}));
    expect(replay.kind).toBe("declined");
    expect(replay.kind === "declined" && replay.reasonCode).toBe("state_conflict");

    // 不得在链上追加第二条终态转换（含 from_phase 伪造的 OPEN→CANCELLED）。
    const transitions = ledger
      .events(NEGOTIATION_ID)
      .filter((e) => e.event_kind === "state_transition");
    expect(transitions.length).toBe(transitionsBefore);
    expect(transitions.filter((t) => t.state_transition?.to_phase === "CANCELLED")).toHaveLength(1);
  });

  it("重启后向 WITHDRAWN 重放兄弟终态动作 cancel → state_conflict（P1-07 跨重启）", async () => {
    const first = makeHandler();
    await runNegotiationToConditional(first);
    const wd = await runWith(first, env("withdraw", { scope: "negotiation" }));
    expect(wd.kind).toBe("accepted");
    const transitionsBefore = ledger
      .events(NEGOTIATION_ID)
      .filter((e) => e.event_kind === "state_transition").length;

    const second = makeHandler();
    const replay = await runWith(second, env("cancel", {}));
    expect(replay.kind).toBe("declined");
    expect(replay.kind === "declined" && replay.reasonCode).toBe("state_conflict");
    expect(
      ledger.events(NEGOTIATION_ID).filter((e) => e.event_kind === "state_transition").length,
    ).toBe(transitionsBefore);
  });
});

// ── 相位机接线（审查 BUG-10，2026-08-10）───────────────────────────────────

describe("merchant handler 相位机接线（BUG-10）", () => {
  let dir: string;
  let ledger: LedgerStore;
  let handler: NegotiationHandler;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-bug10-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
    handler = createMerchantHandler({
      ledger,
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  let seq = 0;
  const env = (action: string, payload: Record<string, unknown>): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: MERCHANT_CAPABILITY,
      protocol_version: "1.0",
      negotiation_id: NEGOTIATION_ID,
      exchange_id: `ex_${seq}`,
      message_id: `msg_${seq}`,
      in_reply_to: `msg_${seq - 1}`,
      actor: "buyer",
      action: action as NegotiationEnvelope["action"],
      created_at: NOW,
      payload: payload as never,
    });
  };

  const run = (envelope: NegotiationEnvelope): Promise<NegotiationHandlerResult> =>
    handler.handle({
      envelope: envelope as never,
      message: { role: "user", parts: [], messageId: envelope.message_id },
      taskId: `task_${seq}`,
      senderIdentity: "buyer:buyer-001",
    });

  it("无前置 offer 的 counter_offer → state_conflict 拒绝（非法转换 fail-closed）", async () => {
    const result = await run(
      env("counter_offer", { offer_id: "off_illegal", proposed_terms: {} }),
    );
    expect(result.kind).toBe("declined");
    expect(result.kind === "declined" && result.reasonCode).toBe("state_conflict");
  });

  it("正常磋商序列（rfq→counter→conditional）相位逐级推进并落账", async () => {
    await run(env("inquiry", {}));
    await run(env("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
    // 真实 buyer 流程：merchant 的 offer 回复推进相位到 OFFER_OPEN 后，
    // buyer 的下一个商业动作是 counter_offer（OFFER_OPEN 替换边）
    const cond = await run(
      env("counter_offer", { offer_id: "off_counter", proposed_terms: {} }),
    );
    expect(cond.kind).toBe("accepted");

    // 相位事件链：OPEN→OFFER_OPEN（rfq 回复的 offer）→ OFFER_OPEN 替换
    // （conditional_offer 回复）——中间相位可重建
    const transitions = ledger
      .events(NEGOTIATION_ID)
      .filter((e) => e.event_kind === "state_transition")
      .map((e) => e.state_transition);
    const openToOfferOpen = transitions.find(
      (t) => t?.from_phase === "OPEN" && t.to_phase === "OFFER_OPEN",
    );
    expect(openToOfferOpen).toBeDefined();
    // 相位替换边（OFFER_OPEN→OFFER_OPEN）不落账；至少 OPEN→OFFER_OPEN 一条
    expect(transitions.length).toBeGreaterThanOrEqual(1);
  });
});


// ── accept 相位机权威守卫（审查 P1-C，2026-08-11）───────────────────────────
//
// P1-C：accept 分支此前先 buildAgreement 再 advancePhase 且忽略返回值——
// 相位机拒绝推进时协议照发，重启恢复后可二次 accept 产出重复协议。修复：
// 构建协议前先推进相位，推进失败 decline state_conflict 且无任何终态副作用。
//
// 同轮恢复（2026-08-12 跟进）：clarification 的商家文本应答即 §8.2 的
// clarification_response——handler 同轮把相位从 AWAITING_CLARIFICATION
// 弹回 resume_phase，「问一句再 accept」的 happy path 不再被卡死（此前
// 入站 clarification 后相位永远挂起，后续合法 accept 被 state_conflict 误拒）。

describe("merchant accept 相位机权威守卫（P1-C）", () => {
  let dir: string;
  let ledger: LedgerStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-p1c-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const makeHandler = (): NegotiationHandler =>
    createMerchantHandler({
      ledger,
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
    });

  let seq = 0;
  const env = (action: string, payload: Record<string, unknown>): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: MERCHANT_CAPABILITY,
      protocol_version: "1.0",
      negotiation_id: NEGOTIATION_ID,
      exchange_id: `ex_${seq}`,
      message_id: `msg_${seq}`,
      in_reply_to: `msg_${seq - 1}`,
      actor: "buyer",
      action: action as NegotiationEnvelope["action"],
      created_at: NOW,
      payload: payload as never,
    });
  };

  const runWith = (
    h: NegotiationHandler,
    envelope: NegotiationEnvelope,
  ): Promise<NegotiationHandlerResult> =>
    h.handle({
      envelope: envelope as never,
      message: { role: "user", parts: [], messageId: envelope.message_id },
      taskId: `task_${envelope.message_id}`,
      senderIdentity: "buyer:buyer-001",
    });

  /** 走 inquiry → rfq → offer → counter_offer 拿到活跃 conditional。 */
  const reachConditional = async (
    h: NegotiationHandler,
  ): Promise<{ offerId: string; agreedTerms: unknown }> => {
    await runWith(h, env("inquiry", {}));
    await runWith(h, env("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
    await runWith(h, env("offer", { offer_id: "off_buyer", terms: {} }));
    const cond = await runWith(h, env("counter_offer", { offer_id: "off_counter", proposed_terms: {} }));
    const offerId = (() => {
      const reply = cond.kind === "accepted" && cond.message
        ? (
            cond.message.parts[0] as unknown as {
              data?: { knp_envelope?: { payload?: { offer_id?: string } } };
            }
          ).data?.knp_envelope?.payload?.offer_id
        : undefined;
      expect(reply).toBeTruthy();
      return reply as string;
    })();
    const conditional = (cond.kind === "accepted" && cond.message
      ? (
          cond.message.parts[0] as unknown as {
            data?: { knp_envelope?: { payload?: unknown } };
          }
        ).data?.knp_envelope?.payload
      : undefined) as { conditions?: unknown };
    const { evaluateConditionalOffer } = await import("../src/negotiation/condition/evaluator.js");
    const agreedTerms = evaluateConditionalOffer(conditional as never, {
      "aggregate.total_quantity": 200,
    });
    return { offerId, agreedTerms };
  };

  const agreementTransitions = (): unknown[] =>
    ledger
      .events(NEGOTIATION_ID)
      .filter((e) => e.event_kind === "state_transition")
      .filter((e) => e.state_transition?.to_phase === "AGREEMENT_REACHED");

  it("clarification 文本应答后相位同轮恢复，随后 accept 正常成交（P1-C happy path）", async () => {
    const h = makeHandler();
    const { offerId, agreedTerms } = await reachConditional(h);
    // 买家在 conditional_offer 后发 clarification → 顶层推进 OFFER_OPEN →
    // AWAITING_CLARIFICATION；商家文本应答即 clarification_response，同轮
    // 弹回 OFFER_OPEN（条件 offer 仍存）。
    const clar = await runWith(h, env("clarification", { questions: [{ field: "delivery_before" }] }));
    expect(clar.kind).toBe("accepted");

    // 澄清已应答 → accept 走正常 OFFER_OPEN → AGREEMENT_REACHED 边。
    const result = await runWith(
      h,
      env("accept_nonbinding", {
        type: "accept_nonbinding",
        offer_id: offerId,
        terms_digest: contentDigest(agreedTerms as never),
      }),
    );
    expect(result.kind).toBe("accepted");
    expect(agreementTransitions()).toHaveLength(1);
  });

  it("成交后重启恢复：二次 accept 被终态守卫拒绝，不产重复协议（P1-C 跨重启）", async () => {
    const first = makeHandler();
    const { offerId, agreedTerms } = await reachConditional(first);
    await runWith(first, env("clarification", { questions: [{ field: "delivery_before" }] }));
    const digest = contentDigest(agreedTerms as never);
    const attempt1 = await runWith(
      first,
      env("accept_nonbinding", { type: "accept_nonbinding", offer_id: offerId, terms_digest: digest }),
    );
    expect(attempt1.kind).toBe("accepted");
    expect(agreementTransitions()).toHaveLength(1);

    // “重启”：同 Ledger 重建 handler——恢复按链上 state_transition 把相位
    // 重建为 AGREEMENT_REACHED（终态 → closedNegotiations），conditional 不再恢复。
    const second = makeHandler();
    const attempt2 = await runWith(
      second,
      env("accept_nonbinding", { type: "accept_nonbinding", offer_id: offerId, terms_digest: digest }),
    );
    expect(attempt2.kind).toBe("declined");
    expect(attempt2.kind === "declined" && attempt2.reasonCode).toBe("state_conflict");
    // 二次 accept 未落第二条 AGREEMENT_REACHED（无重复协议的事实来源）。
    expect(agreementTransitions()).toHaveLength(1);
  });

  // (b) 防过修：无 clarification 的正常 accept 仍返回协议——由上文
  // "accept with matching digest produces one agreement (P2-C happy path)"
  // 与 "records state_transition events on terminal transitions (P2-D)"
  // 锁定（agreement artifact + AGREEMENT_REACHED 转换）。
});
