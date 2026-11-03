/**
 * P0a：KNP inquiry 与普通 A2A 文本统一走接待引擎。
 *
 * 验证：
 *  - 配置 reception 后，结构化 inquiry（subject.sku）与自由文本 inquiry 都由
 *    接待引擎回答（zh-CN，事实来自商品源与策略）；
 *  - 引擎收到的主体上下文是 merchant + 买家身份 + negotiation 隔离；
 *  - 引擎异常时回退到既有确定性路径，询价不被阻断；
 *  - 未配置 reception 时行为完全不变。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import {
  createMerchantReceptionEngine,
  type ReceptionEngine,
  type ReceptionEngineInput,
  type ReceptionEngineResult,
} from "../src/a2a/reception/engine.js";
import type { ReceptionConversation } from "../src/a2a/reception/types.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import type { NegotiationHandler } from "../src/a2a/server/types.js";
import type { InquiryInterpreter } from "../src/a2a/server/inquiry-interpreter.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";

const NOW = "2026-11-03T04:00:00.000Z";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const SKU = "VQ-001";
const policy = {
  price_floors: { [SKU]: 100 },
  max_auto_discount_percent: 5,
  delivery_lead_days: 7,
};

const conversationStub: ReceptionConversation = {
  merchantId: "merchant-1",
  identity: "buyer:1",
  contextId: "neg",
  need: { revision: 1, updatedAt: NOW },
};

describe("merchant inquiry via reception engine (P0a)", () => {
  let dir: string;
  let ledger: LedgerStore;
  let seq = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-inquiry-reception-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
    seq = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const inquiryEnvelope = (
    payload: Record<string, unknown>,
    negotiationId = "neg_inquiry_r1",
  ): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: CAP,
      protocol_version: "1.0",
      negotiation_id: negotiationId,
      exchange_id: `ex_${seq}`,
      message_id: `msg_${seq}`,
      in_reply_to: `msg_${seq - 1}`,
      actor: "buyer",
      action: "inquiry",
      created_at: NOW,
      payload: payload as never,
    });
  };

  const run = async (
    handler: NegotiationHandler,
    envelope: NegotiationEnvelope,
    buyerText?: string,
  ) => {
    const result = await handler.handle({
      envelope: envelope as never,
      message: {
        role: "user",
        parts: buyerText !== undefined ? [{ kind: "text", text: buyerText }] : [],
        messageId: envelope.message_id,
      },
      taskId: `task_${seq}`,
      senderIdentity: "buyer:buyer-001",
    });
    const text =
      result.kind === "accepted" && result.message
        ? (result.message.parts[0] as { text?: string }).text
        : undefined;
    return { result, text };
  };

  const makeHandler = (reception?: { engine: ReceptionEngine; merchantId: string }): NegotiationHandler =>
    createMerchantHandler({
      productSource: {
        async getProduct(sku: string) {
          if (sku !== SKU) throw new Error(`unknown sku ${sku}`);
          return {
            price: 110,
            currency: "CNY",
            stock: 50,
            unit: "piece",
            source_evidence: { system: "owned-test-fixture" },
          };
        },
      },
      ledger,
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
      merchantPolicy: policy,
      ...(reception !== undefined ? { reception } : {}),
    });

  const realEngine = (interpreter?: InquiryInterpreter) =>
    createMerchantReceptionEngine({
      store: new ReceptionConversationStore({
        file: join(dir, "conversations.json"),
        now: () => NOW,
      }),
      ...(interpreter !== undefined ? { interpreter } : {}),
      productSource: {
        async getProduct(sku: string) {
          if (sku !== SKU) throw new Error(`unknown sku ${sku}`);
          return { price: 110, currency: "CNY", stock: 50 };
        },
      },
      policy: () => policy as never,
      now: () => NOW,
    });

  it("结构化 inquiry 由接待引擎按事实回答（zh-CN）", async () => {
    const handler = makeHandler({ engine: realEngine(), merchantId: "merchant-1" });
    const { result, text } = await run(
      handler,
      inquiryEnvelope({ type: "inquiry", subject: { sku: SKU } }),
    );
    expect(result.kind).toBe("accepted");
    expect(text).toContain("SKU VQ-001");
    expect(text).toContain("当前公开标价 110.00 CNY");
    expect(text).toContain("预计交期不晚于 2026-11-10");
    expect(text).toContain("非约束性信息");
  });

  it("自由文本 inquiry 与接待共用同一引擎与文案", async () => {
    const interpreter: InquiryInterpreter = {
      async interpret() {
        return {
          intent: "quote_request",
          topics: ["price", "stock"],
          sku: SKU,
          quantity: 2,
          unit: "件",
          language: "zh",
        };
      },
    };
    const handler = makeHandler({ engine: realEngine(interpreter), merchantId: "merchant-1" });
    const { text } = await run(handler, inquiryEnvelope({ type: "inquiry" }), "VQ-001 两件多少钱");
    expect(text).toContain("已记录需求：SKU VQ-001，2 件");
    expect(text).toContain("库存可以覆盖本次数量");
    expect(text).toContain("请发送 RFQ");
  });

  it("引擎收到的上下文：merchantId + 买家身份 + negotiation 隔离", async () => {
    const seen: ReceptionEngineInput[] = [];
    const engine: ReceptionEngine = {
      async respond(input) {
        seen.push(input);
        return {
          plan: { locale: "zh-CN", blocks: [] },
          text: "接待回复",
          conversation: conversationStub,
        };
      },
    };
    const handler = makeHandler({ engine, merchantId: "merchant-1" });
    await run(
      handler,
      inquiryEnvelope({ type: "inquiry", subject: { sku: SKU } }, "neg_a"),
      "补充说明",
    );
    await run(handler, inquiryEnvelope({ type: "inquiry" }, "neg_b"));
    expect(seen[0]).toMatchObject({
      merchantId: "merchant-1",
      identity: "buyer:buyer-001",
      contextId: "neg_a",
      text: "补充说明",
      structured: { sku: SKU },
    });
    expect(seen[1]).toMatchObject({ contextId: "neg_b" });
    expect(seen[1]?.structured).toBeUndefined();
  });

  it("引擎异常时回退确定性路径，不阻断询价", async () => {
    const engine: ReceptionEngine = {
      async respond(): Promise<ReceptionEngineResult> {
        throw new Error("provider down");
      },
    };
    const handler = createMerchantHandler({
      productSource: {
        async getProduct(sku: string) {
          if (sku !== SKU) throw new Error(`unknown sku ${sku}`);
          return {
            price: 850,
            currency: "CNY",
            stock: 1_000,
            unit: "piece",
            source_evidence: { system: "owned-test-fixture" },
          };
        },
      },
      ledger,
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
      merchantPolicy: policy,
      reception: { engine, merchantId: "merchant-1" },
      inquiryInterpreter: {
        async interpret() {
          return {
            intent: "quote_request",
            topics: ["price"],
            sku: SKU,
            language: "en",
          };
        },
      },
    });
    const { result, text } = await run(handler, inquiryEnvelope({ type: "inquiry" }), "price?");
    expect(result.kind).toBe("accepted");
    expect(text).toContain("850.00 CNY");
  });

  it("未配置 reception 时保持原固定询问", async () => {
    const { text } = await run(makeHandler(), inquiryEnvelope({ type: "inquiry" }), "hello");
    expect(text).toContain("Please provide a product SKU");
  });
});
