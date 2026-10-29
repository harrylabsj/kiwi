/**
 * C：协商顾问只改措辞，不改价格。验证：
 *  - 合法建议成为 public_message；
 *  - 输出里出现私有底价（或任何非公开数字）→ 整条丢弃并回退；
 *  - 顾问抛错不影响报价；
 *  - 未配置顾问时行为不变。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NegotiationHandler } from "../src/a2a/server/types.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import type { NegotiationAdvisor } from "../src/a2a/server/negotiation-advisor.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";

const NOW = "2026-10-29T10:00:00Z";
const NEGOTIATION_ID = "neg_c_001";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const SKU = "SKU-001";
/** 850 元；公开折扣 5% → 807.50；底价 800 元。 */
const merchantPolicy = { price_floors: { [SKU]: 800 }, max_auto_discount_percent: 5 };

describe("merchant negotiation advisor (C)", () => {
  let dir: string;
  let ledger: LedgerStore;
  let seq = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-c-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
    seq = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const makeHandler = (advisor?: NegotiationAdvisor): NegotiationHandler =>
    createMerchantHandler({
      productSource: {
        async getProduct() {
          return {
            price: 850,
            currency: "CNY",
            unit: "piece",
            stock: 1_000,
            source_evidence: { system: "owned-test-fixture" },
          };
        },
      },
      ledger,
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
      merchantPolicy,
      ...(advisor !== undefined ? { negotiationAdvisor: advisor } : {}),
    });

  const envelopeFor = (
    action: string,
    payload: Record<string, unknown>,
  ): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: CAP,
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

  const run = async (handler: NegotiationHandler, envelope: NegotiationEnvelope) =>
    handler.handle({
      envelope: envelope as never,
      message: { role: "user", parts: [], messageId: envelope.message_id },
      taskId: `task_${seq}`,
      senderIdentity: "buyer:buyer-001",
    });

  const rfq = () =>
    envelopeFor("rfq", { type: "rfq", items: [{ sku: SKU, quantity: { value: 10, unit: "piece" } }] });

  const counter = (unitPriceMinor: number) =>
    envelopeFor("counter_offer", {
      type: "counter_offer",
      offer_id: `off_${seq}`,
      proposed_terms: {
        currency: "CNY",
        items: [
          {
            sku: SKU,
            quantity: { value: 10, unit: "piece" },
            unit_price: { currency: "CNY", amount_minor: unitPriceMinor },
          },
        ],
      },
    });

  const publicMessage = (result: Awaited<ReturnType<NegotiationHandler["handle"]>>): string | undefined =>
    result.kind === "accepted" && result.message
      ? (
          result.message.parts[0] as unknown as {
            data?: { knp_envelope?: { public_message?: string } };
          }
        ).data?.knp_envelope?.public_message
      : undefined;

  it("合法建议成为 public_message，价格仍是确定性响应价", async () => {
    const handler = makeHandler({
      async message(input) {
        expect(input.response_price_minor).toBe(80_750);
        // 只引用公开事实：list 850、响应价 807.50、数量 10。
        return "list price 850 CNY; for 10 pieces the best automatic price is 807.50 CNY; delivery terms can be discussed.";
      },
    });
    await run(handler, rfq());
    const result = await run(handler, counter(80_000));
    expect(publicMessage(result)).toContain("807.50");
  });

  it("泄露私有底价（800）→ 整条丢弃并回退", async () => {
    const handler = makeHandler({
      async message() {
        return "our absolute floor is 800 CNY, take it or leave it";
      },
    });
    await run(handler, rfq());
    const result = await run(handler, counter(80_000));
    expect(publicMessage(result)).toBeUndefined();
  });

  it("顾问抛错不影响报价", async () => {
    const handler = makeHandler({
      async message() {
        throw new Error("model unavailable");
      },
    });
    await run(handler, rfq());
    const result = await run(handler, counter(80_000));
    expect(result.kind).toBe("accepted");
    expect(publicMessage(result)).toBeUndefined();
  });

  it("未配置顾问时行为不变", async () => {
    const handler = makeHandler();
    await run(handler, rfq());
    const result = await run(handler, counter(80_000));
    expect(result.kind).toBe("accepted");
    expect(publicMessage(result)).toBeUndefined();
  });
});

describe("createDeepSeekNegotiationAdvisor", () => {
  it("prompt 只带公开事实（无底价），非 200 返回 undefined", async () => {
    const { createDeepSeekNegotiationAdvisor } = await import("../src/a2a/server/negotiation-advisor.js");
    let body: Record<string, unknown> | undefined;
    const advisor = createDeepSeekNegotiationAdvisor({
      apiKey: "synthetic",
      fetchImpl: (async (_url: string, init?: { body?: unknown }) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("denied", { status: 403 });
      }) as typeof fetch,
    });
    const message = await advisor.message({
      sku: SKU,
      quantity: 10,
      currency: "CNY",
      list_price_minor: 85_000,
      public_bound_minor: 80_750,
      response_price_minor: 80_750,
    });
    expect(message).toBeUndefined();
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("807.5");
    expect(serialized).not.toContain("800");
  });

  it("模型返回文本 → 原样交给 handler 做安全校验", async () => {
    const { createDeepSeekNegotiationAdvisor } = await import("../src/a2a/server/negotiation-advisor.js");
    const advisor = createDeepSeekNegotiationAdvisor({
      apiKey: "synthetic",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "best price 807.50 CNY" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    await expect(
      advisor.message({
        sku: SKU,
        quantity: 10,
        currency: "CNY",
        list_price_minor: 85_000,
        response_price_minor: 80_750,
      }),
    ).resolves.toBe("best price 807.50 CNY");
  });
});
