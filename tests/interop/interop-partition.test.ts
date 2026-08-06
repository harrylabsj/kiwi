/**
 * §41 #24 — network partition 端到端测试（基线 §41 #24，§23 Recovery，§24.5 远端锚点）。
 *
 * 模拟「网络分区」：谈判进行到中途，merchant 侧 http server 临时停听（端口不可达），
 * buyer 尝试发送 → fail-closed（ChannelError send_failed，绝不自动降级、不挂起）；
 * 分区恢复（同一 server、同一端口重新 listen，内存 handler 状态保留）后，buyer
 * 重发同一语义消息（新 message_id）续跑，最终双侧收敛到 Agreement。
 *
 * 断言：
 *   - 分区期间 send 抛 ChannelError，code = send_failed（fail-closed，§41 #24）；
 *   - 分区未破坏 buyer 已持久化的 Ledger 链（verifyChain 仍 valid）；
 *   - 恢复后同一 negotiation_id 续跑，双侧到 AGREEMENT_REACHED；
 *   - agreement 三副作用 flag 全 false（§16 / §41 #25/#26）。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentDigest } from "../../src/negotiation/jcs.js";
import { LedgerStore } from "../../src/negotiation/ledger/index.js";
import { IdempotencyStore } from "../../src/negotiation/idempotency/index.js";
import { ContextMapStore } from "../../src/negotiation/context-map/index.js";
import {
  InteropClock,
  BuyerDriver,
  acceptEnvelope,
  counterEnvelope,
  extractAgreementFromTask,
  rfqEnvelope,
  startMerchantServer,
  evaluateConditional,
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
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-interop-partition-"));
  buyerDirs.push(dir);
  return dir;
}

describe("§41 #24 network partition：分区失败不降级、恢复后收敛到 Agreement", () => {
  it("RFQ→Offer 后分区；分区期间 send fail-closed；恢复后同一 negotiation 续跑达成", async () => {
    const clock = new InteropClock();
    const merchant = await startMerchantServer({ clock });
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

    // 0. discovery + 1. RFQ → Offer（分区前的正常推进）。
    const card = await fetch(`${merchant.url}/.well-known/agent-card.json`);
    expect(card.status).toBe(200);
    const rfq = rfqEnvelope(buyer.negotiationId, () => clock.now());
    const offerReply = await buyer.sendAndAdvance(rfq, merchant.a2aUrl);
    expect(offerReply).not.toBeNull();
    expect(offerReply!.action).toBe("offer");
    expect(buyer.currentPhase()).toBe("OFFER_OPEN");
    const offerPayload = offerReply!.payload as { type: "offer"; offer_id: string };
    expect(buyer.ledgerChainValid()).toBe(true);

    // ---- 分区开始：merchant http server 停止监听（同一进程、保留内存状态与数据目录）----
    const addr = merchant.httpServer.address() as { port: number };
    const port = addr.port;
    await new Promise<void>((resolve) => merchant.httpServer.close(() => resolve()));

    // 2. 分区期间发送 → fail-closed：ChannelError(send_failed)，不挂起、不自动降级。
    const counterDuringPartition = counterEnvelope(
      buyer.negotiationId,
      () => clock.now(),
      offerReply!.message_id,
      offerPayload.offer_id,
    );
    const error = await buyer
      .sendAndAdvance(counterDuringPartition, merchant.a2aUrl)
      .then(() => null, (e: unknown) => e);
    expect(error).not.toBeNull();
    expect((error as { code?: string }).code).toBe("send_failed");
    // 分区未破坏已持久化的 buyer Ledger 链。
    expect(buyer.ledgerChainValid()).toBe(true);
    expect(buyer.currentPhase()).toBe("OFFER_OPEN");

    // ---- 分区恢复：同一 http server、同一端口重新 listen（内存 handler 状态保留）----
    await new Promise<void>((resolve) =>
      merchant.httpServer.listen(port, "127.0.0.1", () => resolve()),
    );
    // 恢复后端点可达。
    const reachable = await fetch(`${merchant.url}/.well-known/agent-card.json`).then(
      (r) => r.status,
    );
    expect(reachable).toBe(200);

    // 3. 恢复后续跑：重发 CounterOffer（新 message_id）→ ConditionalOffer → Accept → Agreement。
    const counterResumed = counterEnvelope(
      buyer.negotiationId,
      () => clock.now(),
      offerReply!.message_id,
      offerPayload.offer_id,
    );
    const conditionalReply = await buyer.sendAndAdvance(counterResumed, merchant.a2aUrl);
    expect(conditionalReply).not.toBeNull();
    expect(conditionalReply!.action).toBe("conditional_offer");

    const agreedTerms = evaluateConditional(conditionalReply!.payload as never, 200);
    const accept = acceptEnvelope(
      buyer.negotiationId,
      () => clock.now(),
      conditionalReply!.message_id,
      (conditionalReply!.payload as { offer_id: string }).offer_id,
      contentDigest(agreedTerms),
    );
    await buyer.sendAndAdvance(accept, merchant.a2aUrl);
    expect(buyer.currentPhase()).toBe("AGREEMENT_REACHED");

    // 4. 收敛断言：agreement 产生、三副作用 flag 全 false、双侧 Ledger 链有效。
    const agreement = buyer.lastTask === null ? null : extractAgreementFromTask(buyer.lastTask);
    expect(agreement).not.toBeNull();
    expect(agreement).toMatchObject({
      binding_effect: "nonbinding",
      creates_order: false,
      reserves_inventory: false,
      authorizes_payment: false,
    });
    expect(buyer.ledgerChainValid()).toBe(true);
    expect(merchant.ledger.verifyChain(buyer.negotiationId).valid).toBe(true);
  });
});
