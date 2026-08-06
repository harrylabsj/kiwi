/**
 * WP4 interop E2E — 场景 3：fan-out（基线 §41 #19 / §16 / §19 / §30）。
 *
 * 一个 buyer 对 3 个真实 merchant server 发匿名档 RFQ：2 个回 Offer、1 个超时。
 * 比较集正确（价格升序），对 Top1 发 detailed 档 counter（精确数量 + 交期）。
 *
 * 断言：
 *   - 3 条腿独立 negotiation_id / message_id（幂等键不混淆，§16）；
 *   - 2 offer + 1 timed_out，比较集价格升序（同货币内，§19）；
 *   - 匿名档 RFQ 不含精确数量/交期（渐进披露，§30）——merchant 侧 ledger 的
 *     message_received wire_payload 可证（双侧一致，§19）；
 *   - Top1 detailed 档 counter 到达 merchant 侧，精确数量 42 + delivery_before
 *     进入 merchant ledger（domain semantics 双侧一致，§41 #19）；
 *   - 每腿独立 Ledger 链 verifyChain 有效（§22）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LedgerStore } from "../../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../../src/negotiation/idempotency/index.js";
import { ContextMapStore } from "../../src/negotiation/context-map/index.js";
import { FanoutOrchestrator } from "../../src/fanout/orchestrator.js";
import type { FanoutLegSpec } from "../../src/fanout/orchestrator.js";
import { A2ADirectChannel } from "../../src/counterparty/index.js";
import { buildDisclosedRfq } from "../../src/fanout/index.js";
import { intent } from "../fanout-helpers.js";
import { newOfferId } from "../../src/negotiation/domain/identifiers.js";
import type { NegotiationEnvelope } from "../../src/negotiation/domain/envelope.js";
import {
  InteropClock,
  BuyerDriver,
  profileFor,
  seedEnvelope,
  startMerchantServer,
} from "./harness.js";
import type { NegotiationHandler } from "../../src/a2a/server/index.js";

const BUYER_SENDER = "buyer:interop-buyer";
const ID_A = "merchant-a.example";
const ID_B = "merchant-b.example";
const ID_C = "merchant-c.example";

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

function freshBuyerDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-interop-fanout-"));
  buyerDirs.push(dir);
  return dir;
}

/** 永不回 Offer 的 merchant handler：工作态 task，无 knp_envelope → 超时。 */
function noReplyHandler(): NegotiationHandler {
  return {
    name: "no-reply",
    async handle(): Promise<{
      kind: "accepted";
      taskState: "working";
      message: { role: "agent"; parts: { kind: "text"; text: string }[]; messageId: string };
    }> {
      return {
        kind: "accepted",
        taskState: "working",
        message: {
          role: "agent",
          parts: [{ kind: "text", text: "considering..." }],
          messageId: `msg_${newOfferId()}`,
        },
      };
    },
  };
}

describe("场景 3：1 buyer → 3 merchant，2 offer + 1 超时，Top1 detailed counter", () => {
  it("匿名档 RFQ fan-out → 比较集 → detailed 档 counter 双侧一致", async () => {
    const clock = new InteropClock();

    // 3 个真实 merchant server。
    const merchantA = await startMerchantServer({
      clock,
      name: "Merchant A",
      offerPriceMinor: 85_000,
      taskState: "working",
    });
    const merchantB = await startMerchantServer({
      clock,
      name: "Merchant B",
      offerPriceMinor: 83_000,
      taskState: "working",
    });
    const merchantC = await startMerchantServer({ clock, name: "Merchant C", handler: noReplyHandler() });
    startedMerchants.push(merchantA, merchantB, merchantC);

    const dir = freshBuyerDir();
    const ledger = new LedgerStore({ dir, now: () => clock.now() });
    const idempotency = new IdempotencyStore({ dir, now: () => clock.now() });

    const anonymous = buildDisclosedRfq({
      intent: intent(),
      tier: "anonymous",
      allowed_attributes: ["purchase_quantity"],
    });

    const orchestrator = new FanoutOrchestrator({
      sender_identity: BUYER_SENDER,
      openChannel: async (profile, input) => {
        const url = profile.channel_candidates[0]!.url!;
        return new A2ADirectChannel({ url, ledger, idempotency, now: () => clock.now() }).open(input);
      },
      ledger,
      pollIntervalMs: 20,
      now: () => clock.now(),
    });

    const legs: FanoutLegSpec[] = [
      {
        profile: profileFor(ID_A, merchantA.a2aUrl),
        payload: anonymous,
        timeoutMs: 2000,
      },
      {
        profile: profileFor(ID_B, merchantB.a2aUrl),
        payload: anonymous,
        timeoutMs: 2000,
      },
      {
        profile: profileFor(ID_C, merchantC.a2aUrl),
        payload: anonymous,
        timeoutMs: 300,
      },
    ];

    const result = await orchestrator.fanout(legs);

    // ---- 2 offer + 1 timeout ----
    expect(result.offer_count).toBe(2);
    const outcomes = result.legs.map((l) => l.outcome).sort();
    expect(outcomes).toEqual(["offer_received", "offer_received", "timed_out"]);
    const c = result.legs.find((l) => l.identity === ID_C);
    expect(c?.error?.code).toBe("timeout");

    // ---- 比较集：价格升序（B 83000 < A 85000）----
    expect(result.offers.map((o) => o.identity)).toEqual([ID_B, ID_A]);
    expect(result.offers[0]?.price).toEqual({ currency: "CNY", amount_minor: 83_000 });
    expect(result.offers[1]?.price).toEqual({ currency: "CNY", amount_minor: 85_000 });

    // ---- 每腿独立 negotiation_id / message_id（幂等键不混淆，§16）----
    const legIds = result.legs.map((l) => l.negotiation_id);
    expect(new Set(legIds).size).toBe(3);
    for (const leg of result.legs) {
      expect(ledger.verifyChain(leg.negotiation_id).valid).toBe(true);
    }

    // ---- 匿名档 RFQ 到达 merchant 侧：不含精确数量/交期（渐进披露，§30）----
    const aOfferLeg = result.legs.find((l) => l.identity === ID_A)!;
    const aEvents = merchantA.ledger.events(aOfferLeg.negotiation_id);
    const aRfqReceived = aEvents.find(
      (e) => e.event_kind === "message_received" && e.wire_payload !== undefined,
    );
    const aWire = aRfqReceived!.wire_payload as unknown as NegotiationEnvelope;
    const aRfqPayload = aWire.payload as {
      type: "rfq";
      items: { quantity: { value: number } }[];
      requested_terms?: { quantity_range?: unknown; delivery_before?: unknown };
    };
    expect(aWire.action).toBe("rfq");
    // 区间中点 30，而非精确数量 42。
    expect(aRfqPayload.items[0]?.quantity.value).toBe(30);
    // 匿名档只带 quantity_range，绝无 delivery_before。
    expect(aRfqPayload.requested_terms?.quantity_range).toBeDefined();
    expect(aRfqPayload.requested_terms?.delivery_before).toBeUndefined();
    expect(JSON.stringify(aRfqPayload)).not.toContain("delivery_before");

    // ---- Top1（B）detailed 档 counter ----
    const top1 = result.offers[0]!;
    expect(top1.identity).toBe(ID_B);
    const bEvents = merchantB.ledger.events(top1.negotiation_id);
    const offerSent = bEvents.find(
      (e) =>
        e.event_kind === "message_sent" &&
        e.wire_payload !== undefined &&
        (e.wire_payload as unknown as NegotiationEnvelope).action === "offer",
    );
    const offerEnvelope = offerSent!.wire_payload as unknown as NegotiationEnvelope;

    const contextMap = new ContextMapStore({ dir, now: () => clock.now() });
    const buyer = new BuyerDriver({
      ledger,
      contextMap,
      idempotency,
      clock,
      sender: BUYER_SENDER,
      counterparty: ID_B,
      negotiationId: top1.negotiation_id,
      initialPhase: "OFFER_OPEN",
    });

    const detailedCounter: NegotiationEnvelope = seedEnvelope({
      negotiation_id: top1.negotiation_id,
      in_reply_to: offerEnvelope.message_id,
      actor: "buyer",
      action: "counter_offer",
      created_at: clock.now(),
      payload: {
        type: "counter_offer",
        offer_id: newOfferId(),
        responding_to_offer_id: top1.offer_id,
        proposed_terms: {
          items: [
            {
              sku: "SKU-001",
              quantity: { value: 42, unit: "piece" },
              unit_price: { currency: "CNY", amount_minor: 80_000 },
            },
          ],
          fulfillment_terms: { delivery_before: "2026-08-20T18:00:00Z" },
        },
      },
    });
    const counterReply = await buyer.sendAndAdvance(detailedCounter, merchantB.a2aUrl);
    expect(counterReply?.action).toBe("conditional_offer");

    // ---- detailed 档 counter 到达 merchant B 侧：精确数量 42 + delivery_before ----
    // （重新读取 ledger：counter 事件在 send 之后才落账。）
    const bEventsAfter = merchantB.ledger.events(top1.negotiation_id);
    const bCounterReceived = bEventsAfter.find(
      (e) =>
        e.event_kind === "message_received" &&
        e.wire_payload !== undefined &&
        (e.wire_payload as unknown as NegotiationEnvelope).message_id === detailedCounter.message_id,
    );
    expect(bCounterReceived).toBeDefined();
    const bCounterWire = bCounterReceived!.wire_payload as unknown as NegotiationEnvelope;
    const bCounterPayload = bCounterWire.payload as {
      type: "counter_offer";
      proposed_terms: {
        items: { quantity: { value: number } }[];
        fulfillment_terms?: { delivery_before?: string };
      };
    };
    expect(bCounterPayload.proposed_terms.items[0]?.quantity.value).toBe(42);
    expect(bCounterPayload.proposed_terms.fulfillment_terms?.delivery_before).toBe(
      "2026-08-20T18:00:00Z",
    );

    // buyer 侧 ledger 链仍 valid（含 detailed counter 腿）。
    expect(ledger.verifyChain(top1.negotiation_id).valid).toBe(true);
    expect(merchantB.ledger.verifyChain(top1.negotiation_id).valid).toBe(true);
  });
});
