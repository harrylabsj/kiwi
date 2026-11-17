/**
 * 买家还价低于公开价但商家未配置自动折扣时，merchant 必须解释为什么没有降价，
 * 而不是原价重复一次（2026-11-17 生产反馈：250 元商品还价 240，商家仍回 250，
 * 买家无法判断商家是没看懂还是不能降）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";

const NOW = "2026-11-17T01:00:00Z";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const NEGOTIATION_ID = "neg_counter_explanation";

let dir: string;
let ledger: LedgerStore;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kiwi-counter-explanation-"));
  ledger = new LedgerStore({ dir, now: () => NOW });
  seq = 0;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function envelope(action: string, payload: Record<string, unknown>) {
  seq += 1;
  return finalizeEnvelope({
    capability: CAP,
    protocol_version: "1.0",
    negotiation_id: NEGOTIATION_ID,
    exchange_id: `ex_${seq}`,
    message_id: `msg_${seq}`,
    in_reply_to: `msg_${seq - 1}`,
    actor: "buyer",
    action: action as never,
    created_at: NOW,
    payload: payload as never,
  });
}

function handler() {
  return createMerchantHandler({
    productSource: {
      async getProduct() {
        return {
          price: 250,
          currency: "CNY",
          unit: "piece",
          stock: 100,
          source_evidence: { system: "owned-test-fixture" },
          handoff_destination: "https://www.walmart.com/ip/21112256322",
        };
      },
    },
    ledger,
    now: () => NOW,
    sender: "merchant:gaoyonghu",
    counterparty: "buyer:*",
  });
}

async function run(h: ReturnType<typeof handler>, e: ReturnType<typeof envelope>) {
  const result = await h.handle({
    envelope: e as never,
    message: { role: "user", parts: [], messageId: e.message_id },
    taskId: `task_${e.message_id}`,
    senderIdentity: "buyer:test",
  });
  return result.kind === "accepted" && result.message
    ? ((result.message.parts[0] as unknown as { data?: { knp_envelope?: Record<string, unknown> } })
        .data?.knp_envelope)
    : undefined;
}

describe("merchant counter explanation", () => {
  it("未配置自动折扣时明确说明仍按公开价，并回显买家还价", async () => {
    const h = handler();
    await run(h, envelope("rfq", {
      type: "rfq",
      items: [{ sku: "SKU-1", quantity: { value: 1, unit: "piece" } }],
    }));
    const reply = await run(h, envelope("counter_offer", {
      type: "counter_offer",
      offer_id: "offer_x",
      public_message: "240 一件行不行",
      proposed_terms: {
        items: [
          {
            sku: "SKU-1",
            quantity: { value: 1, unit: "piece" },
            unit_price: { currency: "CNY", amount_minor: 24_000 },
          },
        ],
      },
    }));
    expect(reply).toBeDefined();
    expect(reply!.action).toBe("conditional_offer");
    const terms = (reply!.payload as { base_terms?: unknown }).base_terms as {
      items?: { unit_price?: { amount_minor?: number } }[];
    };
    expect(terms.items?.[0]?.unit_price?.amount_minor).toBe(25_000);
    const message = String(reply!.public_message ?? "");
    expect(message).toContain("240.00");
    expect(message).toContain("250.00");
    expect(message).toContain("未配置自动折扣");
    expect(message).toContain("仍按公开价");
  });

  it("买家还价不低于公开价时不加解释文案", async () => {
    const h = handler();
    await run(h, envelope("rfq", {
      type: "rfq",
      items: [{ sku: "SKU-1", quantity: { value: 1, unit: "piece" } }],
    }));
    const reply = await run(h, envelope("counter_offer", {
      type: "counter_offer",
      offer_id: "offer_x",
      proposed_terms: {
        items: [
          {
            sku: "SKU-1",
            quantity: { value: 1, unit: "piece" },
            unit_price: { currency: "CNY", amount_minor: 25_000 },
          },
        ],
      },
    }));
    expect(reply).toBeDefined();
    expect(String(reply!.public_message ?? "")).not.toContain("未配置自动折扣");
  });
});
