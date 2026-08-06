/**
 * WP4 interop E2E — 场景 1：双边完整谈判流（基线 §41 #1/#2/#6/#7/#10/#11/#16/#25/#26/#27）。
 *
 * buyer 侧 client+handler（A2ADirectChannel + 本地 Ledger/ContextMap/Idempotency +
 * phase 状态机）与 merchant 侧 server+handler（真实 node:http A2AServer + 脚本化
 * merchant handler），零 mock 网络层：
 *
 *   discovery（agent card 拉取）→ RFQ → Offer → CounterOffer → ConditionalOffer
 *   → AcceptNonbinding → Agreement。
 *
 * 断言：
 *   - 双侧 Ledger verifyChain 有效（append-only / hash-linked，§22）；
 *   - envelope digest 双侧一致（内容寻址，同一 envelope 两侧 wire_digest 相同，§17/§19）；
 *   - agreement 三副作用 flag 全 false（§16 / §41 #25/#26/#27）；
 *   - 状态机双侧到 AGREEMENT_REACHED（§18.1 / §21 转换表）。
 *
 * 不依赖共同 Kiwi Gateway：buyer 与 merchant 各持自己的 server/client + 本地
 * 持久化，经 A2A wire 通信（§41 #2）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentDigest } from "../../src/negotiation/jcs.js";
import { LedgerStore } from "../../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../../src/negotiation/idempotency/index.js";
import { ContextMapStore } from "../../src/negotiation/context-map/index.js";
import type { LedgerEvent } from "../../src/negotiation/ledger/index.js";
import type { NegotiationEnvelope } from "../../src/negotiation/domain/envelope.js";
import {
  InteropClock,
  BuyerDriver,
  acceptEnvelope,
  counterEnvelope,
  extractAgreementFromTask,
  rfqEnvelope,
  startMerchantServer,
  evaluateConditional,
  DEAL_PRICE_MINOR,
} from "./harness.js";

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
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-interop-buyer-"));
  buyerDirs.push(dir);
  return dir;
}

/** 从一组 Ledger 事件中按 message_id 找 wire_digest。 */
function digestFor(events: LedgerEvent[], messageId: string): string | undefined {
  for (const event of events) {
    if (event.message_id === messageId && event.wire_digest !== undefined) {
      return event.wire_digest;
    }
  }
  return undefined;
}

/** 断言某 envelope 在 buyer/merchant 两侧 wire_digest 一致（内容寻址双侧一致）。 */
function assertBilateralDigest(envelope: NegotiationEnvelope, buyerEvents: LedgerEvent[], merchantEvents: LedgerEvent[]): void {
  const buyerDigest = digestFor(buyerEvents, envelope.message_id);
  const merchantDigest = digestFor(merchantEvents, envelope.message_id);
  expect(buyerDigest).toBeDefined();
  expect(merchantDigest).toBeDefined();
  expect(buyerDigest).toBe(envelope.digest);
  expect(merchantDigest).toBe(envelope.digest);
  expect(buyerDigest).toBe(merchantDigest);
}

describe("场景 1：双边完整谈判流（零共同网关）", () => {
  it("discovery → RFQ → Offer → CounterOffer → ConditionalOffer → Accept → Agreement", async () => {
    const clock = new InteropClock();
    const merchant = await startMerchantServer({ clock, taskState: "completed" });
    startedMerchants.push(merchant);

    const buyerDir = freshBuyerDir();
    const buyer = new BuyerDriver({
      ledger: new LedgerStore({ dir: buyerDir, now: () => clock.now() }),
      contextMap: new ContextMapStore({ dir: buyerDir, now: () => clock.now() }),
      idempotency: new IdempotencyStore({ dir: buyerDir, now: () => clock.now() }),
      clock,
      sender: "buyer:interop-buyer",
      counterparty: "merchant:interop-merchant",
    });

    // 0. discovery：拉取 merchant agent card（真实 HTTP well-known）。
    const card = await fetch(`${merchant.url}/.well-known/agent-card.json`);
    expect(card.status).toBe(200);
    const cardBody = (await card.json()) as { name?: string; supportedInterfaces?: unknown[] };
    expect(cardBody.name).toBe("Interop Merchant");
    expect(Array.isArray(cardBody.supportedInterfaces)).toBe(true);

    // 1. RFQ → Offer。
    const rfq = rfqEnvelope(buyer.negotiationId, () => clock.now());
    const offerReply = await buyer.sendAndAdvance(rfq, merchant.a2aUrl);
    expect(offerReply).not.toBeNull();
    expect(offerReply!.action).toBe("offer");
    expect(buyer.currentPhase()).toBe("OFFER_OPEN");
    const offerPayload = offerReply!.payload as { type: "offer"; offer_id: string; terms: { items: { unit_price?: { amount_minor: number } }[] } };
    expect(offerPayload.terms.items[0]?.unit_price?.amount_minor).toBe(85_000);

    // 2. CounterOffer → ConditionalOffer。
    const counter = counterEnvelope(
      buyer.negotiationId,
      () => clock.now(),
      offerReply!.message_id,
      offerPayload.offer_id,
    );
    const conditionalReply = await buyer.sendAndAdvance(counter, merchant.a2aUrl);
    expect(conditionalReply).not.toBeNull();
    expect(conditionalReply!.action).toBe("conditional_offer");
    expect(buyer.currentPhase()).toBe("OFFER_OPEN");
    const conditionalPayload = conditionalReply!.payload as {
      type: "conditional_offer";
      offer_id: string;
      conditions: { then_terms: { items: { unit_price?: { amount_minor: number } }[] } }[];
    };
    expect(conditionalPayload.conditions.length).toBeGreaterThan(0);

    // 3. ConditionalOffer 确定性求值（§12）：披露事实 aggregate.total_quantity=200 命中。
    const agreedTerms = evaluateConditional(conditionalReply!.payload as never, 200);
    const agreedPrice = agreedTerms.items?.[0]?.unit_price?.amount_minor;
    expect(agreedPrice).toBe(DEAL_PRICE_MINOR);

    // 4. AcceptNonbinding → Agreement（agreement 为 task artifact，非 envelope）。
    const accept = acceptEnvelope(
      buyer.negotiationId,
      () => clock.now(),
      conditionalReply!.message_id,
      conditionalPayload.offer_id,
      contentDigest(agreedTerms),
    );
    await buyer.sendAndAdvance(accept, merchant.a2aUrl);
    expect(buyer.currentPhase()).toBe("AGREEMENT_REACHED");

    const agreement = buyer.lastTask === null ? null : extractAgreementFromTask(buyer.lastTask);
    expect(agreement).not.toBeNull();

    // 5. 断言：双侧 Ledger verifyChain 有效。
    expect(buyer.ledgerChainValid()).toBe(true);
    expect(merchant.ledger.verifyChain(buyer.negotiationId).valid).toBe(true);

    // 6. 断言：envelope digest 双侧一致（rfq / offer / counter / conditional / accept）。
    const buyerEvents = buyer.ledger.events(buyer.negotiationId);
    const merchantEvents = merchant.ledger.events(buyer.negotiationId);
    for (const envelope of [rfq, offerReply!, counter, conditionalReply!, accept]) {
      assertBilateralDigest(envelope, buyerEvents, merchantEvents);
    }

    // 7. 断言：agreement 三副作用 flag 全 false（§16 / §41 #25/#26/#27）。
    expect(agreement!.creates_order).toBe(false);
    expect(agreement!.reserves_inventory).toBe(false);
    expect(agreement!.authorizes_payment).toBe(false);
    expect(agreement!.binding_effect).toBe("nonbinding");
    // agreement 的 terms_digest 与 buyer 发送 accept 时的 terms_digest 一致。
    expect(agreement!.terms_digest).toBe(contentDigest(agreedTerms));

    // 8. 断言：状态机双侧到 AGREEMENT_REACHED。
    expect(buyer.tracker.history).toEqual([
      "OPEN",
      "OFFER_OPEN",
      "OFFER_OPEN",
      "AGREEMENT_REACHED",
    ]);
    expect(merchant.state.tracker?.history).toEqual([
      "OPEN",
      "OFFER_OPEN",
      "OFFER_OPEN",
      "AGREEMENT_REACHED",
    ]);
    expect(merchant.state.tracker?.state.phase).toBe("AGREEMENT_REACHED");

    // 9. 断言：无订单/库存/支付副作用 —— ledger 上没有任何带订单语义的 event_kind。
    const allKinds = new Set<string>([...buyerEvents, ...merchantEvents].map((e) => e.event_kind));
    expect(allKinds.has("order_created")).toBe(false);
    expect(allKinds.has("inventory_reserved")).toBe(false);
    expect(allKinds.has("payment_authorized")).toBe(false);
  });
});
