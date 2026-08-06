/**
 * WP4 interop E2E — 场景 2：多轮恢复（基线 §41 #6/#7/#12，§23 Recovery）。
 *
 * buyer 侧先推进 RFQ → Offer → CounterOffer → ConditionalOffer 后「重启」：
 * 丢弃内存中的 driver，用同一数据目录重建 Ledger / ContextMap / Idempotency
 * store（新进程内存、同目录持久化），经 NegotiationRecovery.recover（§23 八步）
 * 续上，最终仍达成 Agreement。
 *
 * 断言：
 *   - 恢复 status = resumed，phase 重建为 OFFER_OPEN；
 *   - 同 message_id + 同 digest 的 pending 消息安全幂等重放（§23 local pending）；
 *   - 恢复后 Ledger 链仍 valid（重启不破坏 append-only 链，§22/§23）；
 *   - 续跑后双侧到 AGREEMENT_REACHED，agreement 三副作用 flag 全 false（§16）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentDigest } from "../../src/negotiation/jcs.js";
import { LedgerStore } from "../../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../../src/negotiation/idempotency/index.js";
import { ContextMapStore } from "../../src/negotiation/context-map/index.js";
import { NegotiationRecovery } from "../../src/negotiation/recovery/index.js";
import { A2ADirectChannel } from "../../src/counterparty/index.js";
import {
  InteropClock,
  BuyerDriver,
  acceptEnvelope,
  counterEnvelope,
  evaluateConditional,
  extractAgreementFromTask,
  profileFor,
  rfqEnvelope,
  startMerchantServer,
} from "./harness.js";

const BUYER_SENDER = "buyer:interop-buyer";
const MERCHANT_IDENTITY = "merchant:interop-merchant";

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
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-interop-recovery-"));
  buyerDirs.push(dir);
  return dir;
}

describe("场景 2：谈判中途重启 buyer，经 §23 恢复续上", () => {
  it("RFQ→Offer→Counter→Conditional 后重启，恢复续跑到 Agreement", async () => {
    const clock = new InteropClock();
    // taskState "working"：恢复时远端活跃任务非终态（终态会触发
    // reconciliation_required，§23）。
    const merchant = await startMerchantServer({ clock, taskState: "working" });
    startedMerchants.push(merchant);
    const dir = freshBuyerDir();

    // ---- Phase A：buyer 推进到 OFFER_OPEN（已收到 conditional）----
    const phaseA = new BuyerDriver({
      ledger: new LedgerStore({ dir, now: () => clock.now() }),
      contextMap: new ContextMapStore({ dir, now: () => clock.now() }),
      idempotency: new IdempotencyStore({ dir, now: () => clock.now() }),
      clock,
      sender: BUYER_SENDER,
      counterparty: MERCHANT_IDENTITY,
    });
    const negotiationId = phaseA.negotiationId;

    const rfq = rfqEnvelope(negotiationId, () => clock.now());
    const offerReply = await phaseA.sendAndAdvance(rfq, merchant.a2aUrl);
    expect(offerReply?.action).toBe("offer");
    const offerPayload = offerReply!.payload as { type: "offer"; offer_id: string };

    const counter = counterEnvelope(
      negotiationId,
      () => clock.now(),
      offerReply!.message_id,
      offerPayload.offer_id,
    );
    const conditionalReply = await phaseA.sendAndAdvance(counter, merchant.a2aUrl);
    expect(conditionalReply?.action).toBe("conditional_offer");
    expect(phaseA.currentPhase()).toBe("OFFER_OPEN");
    expect(phaseA.ledgerChainValid()).toBe(true);

    // ---- "重启"：丢弃 phaseA driver（内存），同目录重建 store ----
    const ledger = new LedgerStore({ dir, now: () => clock.now() });
    const contextMap = new ContextMapStore({ dir, now: () => clock.now() });
    const idempotency = new IdempotencyStore({ dir, now: () => clock.now() });

    // 重启后 Ledger 链仍 valid（持久化未撕裂）。
    expect(ledger.verifyChain(negotiationId).valid).toBe(true);
    expect(contextMap.has(negotiationId)).toBe(true);

    // ---- §23 恢复八步 ----
    const recovery = new NegotiationRecovery({
      ledger,
      contextMap,
      resolveCounterparty: async () => profileFor(MERCHANT_IDENTITY, merchant.a2aUrl),
      openChannel: async (profile, input) => {
        const url = profile.channel_candidates[0]!.url!;
        const channel = new A2ADirectChannel({
          url,
          ledger,
          idempotency,
          now: () => clock.now(),
        });
        // 恢复通道沿用 buyer 自身身份：pending 消息同 message_id + 同 digest
        // → buyer 本地幂等 store 识别为 replay，不重复落账（§23 local pending）。
        return channel.open({ ...input, sender_identity: BUYER_SENDER });
      },
      now: () => clock.now(),
    });
    const result = await recovery.recover(negotiationId);

    expect(result.status).toBe("resumed");
    expect(result.phase).toBe("OFFER_OPEN");
    // rfq 与 counter 两条 pending 出站消息都被安全重放（幂等，不重复执行）。
    expect(result.replayed_message_ids).toEqual(
      expect.arrayContaining([rfq.message_id, counter.message_id]),
    );
    expect(result.remote_ahead_appended).toBe(0);
    expect(ledger.verifyChain(negotiationId).valid).toBe(true);

    // ---- 续跑：重建 buyer driver（同 negotiation_id + 恢复 phase），发 accept ----
    const buyer2 = new BuyerDriver({
      ledger,
      contextMap,
      idempotency,
      clock,
      sender: BUYER_SENDER,
      counterparty: MERCHANT_IDENTITY,
      negotiationId,
      initialPhase: result.phase,
    });
    const conditional = buyer2.readReceivedEnvelope("conditional_offer");
    expect(conditional).not.toBeNull();
    const conditionalPayload = conditional!.payload as {
      type: "conditional_offer";
      offer_id: string;
    };
    const agreedTerms = evaluateConditional(conditional!.payload as never, 200);
    const accept = acceptEnvelope(
      negotiationId,
      () => clock.now(),
      conditional!.message_id,
      conditionalPayload.offer_id,
      contentDigest(agreedTerms),
    );
    await buyer2.sendAndAdvance(accept, merchant.a2aUrl);

    expect(buyer2.currentPhase()).toBe("AGREEMENT_REACHED");
    const agreement = buyer2.lastTask === null ? null : extractAgreementFromTask(buyer2.lastTask);
    expect(agreement).not.toBeNull();
    expect(agreement!.creates_order).toBe(false);
    expect(agreement!.reserves_inventory).toBe(false);
    expect(agreement!.authorizes_payment).toBe(false);
    expect(agreement!.binding_effect).toBe("nonbinding");

    // 双侧 Ledger 链 valid，双侧 phase 到 AGREEMENT_REACHED。
    expect(buyer2.ledgerChainValid()).toBe(true);
    expect(merchant.ledger.verifyChain(negotiationId).valid).toBe(true);
    expect(merchant.state.tracker?.state.phase).toBe("AGREEMENT_REACHED");
  });
});
