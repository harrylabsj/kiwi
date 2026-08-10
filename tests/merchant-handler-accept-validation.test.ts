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
    expect(last?.state_transition?.from_phase).toBe("OPEN");
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
});
