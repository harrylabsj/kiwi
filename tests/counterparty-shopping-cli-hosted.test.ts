/**
 * ShoppingCliHostedChannel 集成测试（基线 §21 Authority Model / §24 Hosted Reliability）。
 *
 * 覆盖：
 *   - open 内部 claim；getState 返回 shopping-cli 权威快照（§21）；
 *   - send 走 KNP→legacy 转译 → submitNegotiationDecision → 结算 claim；出站落 Ledger；
 *   - 受保护语义（conditional_offer）无法在 legacy 表达 → fail-closed（unsupported_action）
 *     且 release claim（可重claim）；
 *   - 同消息已被 claim → claim denied（fail-closed）；
 *   - claim 结算后 getState 不可读（权威快照以活跃 claim 为锚）；
 *   - close 未结算 claim 转 abandon。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { ShoppingCliHostedChannel } from "../src/counterparty/index.js";
import { createFakeMarketplace } from "../src/commerce/fake-client.js";
import { CAPABILITY, validConditionalOffer } from "./negotiation-helpers.js";

const NOW = "2026-08-06T10:00:00.000Z";
const CONV = "conv-merchant-001";

function marketplace() {
  return createFakeMarketplace({
    merchant_id: "merchant-001",
    buyer_id: "buyer-001",
    product: {
      sku: "SKU-001",
      title: "widget",
      currency: "CNY",
      list_price: 100,
      stock_quantity: 10,
      delivery: { eta_start: "2026-08-10T00:00:00Z", eta_end: "2026-08-11T00:00:00Z", fee: 5 },
      policies: [{ ref: "POL-1", summary: "7-day returns" }],
    },
    now: NOW,
  });
}

function declineEnvelope(messageId = "msg_hosted_1") {
  return finalizeEnvelope({
    capability: CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: CONV,
    exchange_id: "ex_hosted",
    message_id: messageId,
    actor: "merchant",
    action: "decline",
    created_at: NOW,
    payload: {
      type: "decline",
      target_message_id: "msg_legacy_1",
      target_offer_id: "off_legacy_1",
      scope: "offer",
    },
    public_message: "declining this offer",
  });
}

function openInput() {
  return {
    negotiation_id: CONV,
    sender_identity: "kiwi-merchant",
    identity: "buyer-remote",
    remote: { conversation_id: CONV, message_id: 1 },
  };
}

describe("ShoppingCliHostedChannel: 权威快照（§21）", () => {
  it("open 后 getState 返回 shopping-cli authoritative snapshot", async () => {
    const mk = marketplace();
    const channel = new ShoppingCliHostedChannel({ client: mk.merchant, now: () => NOW });
    const handle = await channel.open(openInput());

    // open 已 claim 消息 1（内部机制）。
    expect(mk.merchant.claimStatus(1)).toBe("processing");

    const state = await handle.getState({
      negotiation_id: CONV,
      conversation_id: CONV,
      message_id: 1,
    });
    expect(state.channel).toBe("shopping-cli-hosted");
    expect(state.snapshot).toBeDefined();
    expect(state.snapshot?.conversation.id).toBe(CONV);
    expect(state.snapshot?.conversation.status).toBe("waiting_merchant");
    expect(state.state).toBe("waiting_merchant");
    expect(state.message_ids).toContain("msg_legacy_1");

    await handle.close();
  });
});

describe("ShoppingCliHostedChannel: send（claim 内部机制 + 结算）", () => {
  it("claim 结算失败 → best-effort abandon 释放 + 向外抛错（审查 P2-R）", async () => {
    const mk = marketplace();
    const channel = new ShoppingCliHostedChannel({ client: mk.merchant, now: () => NOW });
    const handle = await channel.open(openInput());

    const abandons: Array<{ message_id: number; idempotency_key: string; error: string }> = [];
    const realAbandon = mk.merchant.abandonClaim.bind(mk.merchant);
    mk.merchant.completeClaim = async () => {
      throw new Error("simulated complete failure");
    };
    mk.merchant.abandonClaim = async (
      input: { message_id: number; idempotency_key: string; error: string },
    ) => {
      abandons.push(input);
      return realAbandon(input);
    };

    // 决策已 accepted、completeClaim 瞬断：此前 .catch(() => undefined)
    // 静默吞错 + settled=true，claim 滞留 processing 直到 300s TTL。
    await expect(handle.send({ envelope: declineEnvelope() })).rejects.toThrow(
      /simulated complete failure/,
    );
    // claim 被 abandon 释放（消息立即可被重 claim；内容寻址幂等保证
    // 重处理无重复效果），而非滞留 processing
    expect(abandons.length).toBeGreaterThanOrEqual(1);
    expect(abandons[0]?.message_id).toBe(1);
    expect(abandons[0]?.error).toContain("claim settle failed");
    expect(mk.merchant.claimStatus(1)).toBe("abandoned");

    // close() 兜底路径不抛错（claim 已 abandoned，幂等）
    await handle.close();
  });

  it("send 转译 KNP→legacy，policy accepted，claim 结算为 processed，落 Ledger", async () => {
    const mk = marketplace();
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-hosted-ledger-"));
    try {
      const ledger = new LedgerStore({ dir, now: () => NOW });
      const channel = new ShoppingCliHostedChannel({ client: mk.merchant, ledger, now: () => NOW });
      const handle = await channel.open(openInput());

      const result = await handle.send({ envelope: declineEnvelope() });
      expect(result.channel).toBe("shopping-cli-hosted");
      expect(result.policy?.result).toBe("accepted");
      expect(result.ref.conversation_id).toBe(CONV);

      // 结算：claim 变 processed（不是 processing）。
      expect(mk.merchant.claimStatus(1)).toBe("processed");

      // 出站落账：message_sent 事件（negotiation_id = open 绑定的 CONV）。
      const sent = ledger.events(CONV).filter((e) => e.event_kind === "message_sent");
      expect(sent).toHaveLength(1);

      await handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("受保护语义 conditional_offer → unsupported_action，claim 被 release", async () => {
    const mk = marketplace();
    const channel = new ShoppingCliHostedChannel({ client: mk.merchant, now: () => NOW });
    const handle = await channel.open(openInput());

    const envelope = finalizeEnvelope({
      capability: CAPABILITY,
      protocol_version: "1.0",
      negotiation_id: CONV,
      exchange_id: "ex_cond",
      message_id: "msg_cond_1",
      actor: "merchant",
      action: "conditional_offer",
      created_at: NOW,
      payload: validConditionalOffer(),
      public_message: "conditioned offer",
    });

    await expect(handle.send({ envelope })).rejects.toMatchObject({
      channel: "shopping-cli-hosted",
      code: "unsupported_action",
    });
    // 受保护语义：claim 被 fail（release，可重claim）。
    expect(mk.merchant.claimStatus(1)).toBe("failed");

    await handle.close();
  });

  it("同消息已被 claim → claim denied（fail-closed）", async () => {
    const mk = marketplace();
    const first = new ShoppingCliHostedChannel({ client: mk.merchant, now: () => NOW });
    const second = new ShoppingCliHostedChannel({ client: mk.merchant, now: () => NOW });

    const h1 = await first.open(openInput());
    await expect(second.open(openInput())).rejects.toMatchObject({
      channel: "shopping-cli-hosted",
      code: "send_failed",
    });
    await h1.close();
  });

  it("claim 结算后 getState 不可读（权威快照以活跃 claim 为锚）", async () => {
    const mk = marketplace();
    const channel = new ShoppingCliHostedChannel({ client: mk.merchant, now: () => NOW });
    const handle = await channel.open(openInput());
    await handle.send({ envelope: declineEnvelope() });

    await expect(
      handle.getState({ negotiation_id: CONV, conversation_id: CONV, message_id: 1 }),
    ).rejects.toMatchObject({ channel: "shopping-cli-hosted", code: "send_failed" });
  });
});

describe("ShoppingCliHostedChannel: close 生命周期", () => {
  it("close 未结算 claim → abandon（release，可重claim）", async () => {
    const mk = marketplace();
    const channel = new ShoppingCliHostedChannel({ client: mk.merchant, now: () => NOW });
    const handle = await channel.open(openInput());
    expect(mk.merchant.claimStatus(1)).toBe("processing");

    await handle.close();
    expect(mk.merchant.claimStatus(1)).toBe("abandoned");

    // 被 release 的 claim 可被新通道重claim。
    const again = new ShoppingCliHostedChannel({ client: mk.merchant, now: () => NOW });
    const h2 = await again.open(openInput());
    expect(mk.merchant.claimStatus(1)).toBe("processing");
    await h2.close();
  });

  it("close 后 send fail-closed（channel_closed）", async () => {
    const mk = marketplace();
    const channel = new ShoppingCliHostedChannel({ client: mk.merchant, now: () => NOW });
    const handle = await channel.open(openInput());
    await handle.close();
    await expect(handle.send({ envelope: declineEnvelope() })).rejects.toMatchObject({
      code: "channel_closed",
    });
  });
});

