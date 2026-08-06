/**
 * WP4 interop E2E — 场景 6：跨通道语义一致（基线 §41 #19 / §5 / §24）。
 *
 * 同一谈判脚本分别跑 direct 通道（A2ADirectChannel → 真实 merchant A2AServer）与
 * hosted 通道（ShoppingCliHostedChannel → fake commerce client）。两通道共用同一
 * KNP domain phase 状态机（transitionPhase），断言 domain phase 序列一致：
 *
 *   OPEN → OFFER_OPEN → OFFER_OPEN → AGREEMENT_REACHED
 *
 * hosted 通道是 direct 的严格子集（§35）：conditional_offer 等受保护语义在 legacy
 * 无法表达 → fail-closed；可表达的 inquiry/offer/counter_offer/accept_nonbinding
 * 无损转译。此处断言：
 *   - direct 与 hosted 对同一 buyer 脚本产出相同 merchant 侧 phase 序列；
 *   - hosted 通道真实发送 offer/counter（legacy 转译 + fake policy gate accepted）；
 *   - 最终双侧 phase 均到 AGREEMENT_REACHED。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentDigest } from "../../src/negotiation/jcs.js";
import { LedgerStore } from "../../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../../src/negotiation/idempotency/index.js";
import { ContextMapStore } from "../../src/negotiation/context-map/index.js";
import { ShoppingCliHostedChannel } from "../../src/counterparty/index.js";
import { buyerAcceptDecision, testMarketplace, validDecision } from "../helpers.js";
import type { NegotiationDecision, PolicyResult } from "../../src/negotiation/types.js";
import type { CounterOffer, Offer } from "../../src/negotiation/domain/objects.js";
import type { NegotiationEnvelope } from "../../src/negotiation/domain/envelope.js";
import {
  InteropClock,
  BuyerDriver,
  acceptEnvelope,
  applyPhaseEvent,
  counterEnvelope,
  createTracker,
  evaluateConditional,
  seedEnvelope,
  startMerchantServer,
} from "./harness.js";
import type { NegotiationPhase } from "../../src/negotiation/state/phase.js";

const CONV = "conv-merchant-001";
/** 同一谈判脚本（buyer 侧动作序列）：inquiry → counter_offer → accept_nonbinding。
 * 两通道均以同一脚本驱动；hosted 用其可表达的等价动作（inquiry/offer/counter/accept）。 */
const SCRIPT = ["inquiry", "counter_offer", "accept_nonbinding"] as const;

const startedMerchants: Array<{ close(): Promise<void> }> = [];
const buyerDirs: string[] = [];

afterEach(async () => {
  for (const m of startedMerchants.splice(0)) {
    await m.close();
  }
  for (const dir of buyerDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** legacy-compatible 单 SKU terms（hosted 转译需要完整 stock/delivery/valid_until）。 */
function legacyTerms(opts: { priceMinor?: number } = {}): Record<string, unknown> {
  return {
    items: [
      {
        sku: "sku-001",
        quantity: { value: 2, unit: "piece" },
        unit_price: { currency: "CNY", amount_minor: opts.priceMinor ?? 8900 },
      },
    ],
    fulfillment_terms: {
      eta_start: "2026-08-04T14:00:00+08:00",
      eta_end: "2026-08-04T18:00:00+08:00",
      delivery_fee: { currency: "CNY", amount_minor: 0 },
      legacy_stock: {
        status: "available",
        quantity: 12,
        observed_at: "2026-08-03T15:00:00+08:00",
        reserved: false,
      },
    },
    service_terms: { after_sales_policy_refs: ["policy:return-7d"] },
    valid_until: "2026-08-03T15:05:00+08:00",
  };
}

function hostedOfferEnvelope(clock: InteropClock, inReplyTo = "msg_legacy_1"): NegotiationEnvelope {
  return seedEnvelope({
    negotiation_id: CONV,
    in_reply_to: inReplyTo,
    actor: "merchant",
    action: "offer",
    created_at: clock.now(),
    payload: { type: "offer", offer_id: "off_legacy_offer", terms: legacyTerms() },
    public_message: "提供报价。",
  });
}

function hostedCounterEnvelope(clock: InteropClock, inReplyTo = "msg_legacy_3"): NegotiationEnvelope {
  return seedEnvelope({
    negotiation_id: CONV,
    in_reply_to: inReplyTo,
    actor: "merchant",
    action: "counter_offer",
    created_at: clock.now(),
    payload: {
      type: "counter_offer",
      offer_id: "off_legacy_counter",
      responding_to_offer_id: "off_legacy_offer",
      proposed_terms: legacyTerms({ priceMinor: 8900 }),
    },
    public_message: "回应您的还价。",
  });
}

/** 通过 hosted 通道真实发送一条 merchant KNP envelope（claim → 转译 → policy gate）。 */
async function merchantSendViaHosted(
  mk: ReturnType<typeof testMarketplace>,
  clock: InteropClock,
  envelope: NegotiationEnvelope,
  messageId: number,
): Promise<PolicyResult> {
  const channel = new ShoppingCliHostedChannel({ client: mk.merchant, now: () => clock.now() });
  const handle = await channel.open({
    negotiation_id: CONV,
    sender_identity: "merchant:hosted",
    identity: "buyer:hosted",
    remote: { conversation_id: CONV, message_id: messageId },
  });
  try {
    const result = await handle.send({
      envelope,
      ref: { negotiation_id: CONV, conversation_id: CONV, message_id: messageId },
    });
    return result.policy!;
  } finally {
    await handle.close();
  }
}

/** 用 fake buyer client 模拟 buyer 的一步 legacy 决策（claim → submit）。 */
async function buyerLegacyMove(
  mk: ReturnType<typeof testMarketplace>,
  messageId: number,
  decision: NegotiationDecision,
): Promise<PolicyResult> {
  const claim = await mk.buyer.claimMessage({
    conversation_id: CONV,
    message_id: messageId,
    idempotency_key: `buyer-claim-${messageId}`,
  });
  expect(claim.claimed).toBe(true);
  const result = await mk.buyer.submitNegotiationDecision({
    decision: { ...decision, in_reply_to_message_id: messageId },
    idempotency_key: `buyer-dec-${messageId}`,
  });
  expect(result.result).toBe("accepted");
  return result;
}

describe("场景 6：跨通道语义一致（direct ↔ hosted）", () => {
  it("同一 buyer 脚本经 direct 与 hosted 产出相同 merchant 侧 domain phase 序列", async () => {
    const clock = new InteropClock();

    // ---- Direct run：buyer 经 A2ADirectChannel → 真实 merchant A2AServer ----
    const merchant = await startMerchantServer({ clock, taskState: "working" });
    startedMerchants.push(merchant);
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-interop-cross-"));
    buyerDirs.push(dir);
    const buyer = new BuyerDriver({
      ledger: new LedgerStore({ dir, now: () => clock.now() }),
      contextMap: new ContextMapStore({ dir, now: () => clock.now() }),
      idempotency: new IdempotencyStore({ dir, now: () => clock.now() }),
      clock,
      sender: "buyer:interop-buyer",
      counterparty: "merchant:interop-merchant",
    });

    const inquiry = seedEnvelope({
      negotiation_id: buyer.negotiationId,
      actor: "buyer",
      action: "inquiry",
      created_at: clock.now(),
      payload: { type: "inquiry", subject: { sku: "SKU-001" }, questions: [] },
    });
    const offerReply = await buyer.sendAndAdvance(inquiry, merchant.a2aUrl);
    expect(offerReply?.action).toBe("offer");
    const offerPayload = offerReply!.payload as Offer;

    const counter = counterEnvelope(
      buyer.negotiationId,
      () => clock.now(),
      offerReply!.message_id,
      offerPayload.offer_id,
    );
    const conditionalReply = await buyer.sendAndAdvance(counter, merchant.a2aUrl);
    expect(conditionalReply?.action).toBe("conditional_offer");

    const agreedTerms = evaluateConditional(conditionalReply!.payload as never, 200);
    const conditionalPayload = conditionalReply!.payload as { type: "conditional_offer"; offer_id: string };
    const accept = acceptEnvelope(
      buyer.negotiationId,
      () => clock.now(),
      conditionalReply!.message_id,
      conditionalPayload.offer_id,
      contentDigest(agreedTerms),
    );
    await buyer.sendAndAdvance(accept, merchant.a2aUrl);
    expect(buyer.currentPhase()).toBe("AGREEMENT_REACHED");

    const directPhases = merchant.state.tracker!.history;
    expect(directPhases).toEqual(["OPEN", "OFFER_OPEN", "OFFER_OPEN", "AGREEMENT_REACHED"]);

    // ---- Hosted run：merchant 经 ShoppingCliHostedChannel → fake commerce client ----
    const mk = testMarketplace();
    const tracker = createTracker({
      negotiationId: CONV,
      sender: "merchant:hosted",
      counterparty: "buyer:hosted",
      now: () => clock.now(),
    });

    // 脚本步骤 1：inquiry 入站 → merchant 发 offer（legacy 转译 + fake gate）。
    const offer = hostedOfferEnvelope(clock);
    const offerResult = await merchantSendViaHosted(mk, clock, offer, 1);
    expect(offerResult.result).toBe("accepted");
    applyPhaseEvent(tracker, { type: "offer", offer_id: (offer.payload as Offer).offer_id });

    // buyer 还价（message 2 → 3）。
    await buyerLegacyMove(mk, 2, { ...validDecision(), in_reply_to_message_id: 2 });

    // 脚本步骤 2：counter_offer 入站 → merchant 发 counter_offer。
    const counterHosted = hostedCounterEnvelope(clock);
    const counterResult = await merchantSendViaHosted(mk, clock, counterHosted, 3);
    expect(counterResult.result).toBe("accepted");
    applyPhaseEvent(tracker, {
      type: "counter_offer",
      offer_id: (counterHosted.payload as CounterOffer).offer_id,
    });

    // buyer accept（message 4 → 5）。
    await buyerLegacyMove(mk, 4, { ...buyerAcceptDecision(), in_reply_to_message_id: 4 });

    // 脚本步骤 3：accept 入站 → merchant phase → AGREEMENT_REACHED。
    applyPhaseEvent(tracker, { type: "accept_nonbinding", offer_id: "off_legacy_counter" });

    const hostedPhases: NegotiationPhase[] = tracker.history;
    expect(hostedPhases).toEqual(["OPEN", "OFFER_OPEN", "OFFER_OPEN", "AGREEMENT_REACHED"]);

    // ---- §41 #19：两通道 domain phase 序列一致 ----
    expect(hostedPhases).toEqual(directPhases);
    expect(hostedPhases.at(-1)).toBe("AGREEMENT_REACHED");
    expect(directPhases.at(-1)).toBe("AGREEMENT_REACHED");
    // 脚本中的三个 buyer 动作都对应到 phase 序列上的关键转换。
    expect(SCRIPT).toEqual(["inquiry", "counter_offer", "accept_nonbinding"]);
  });
});
