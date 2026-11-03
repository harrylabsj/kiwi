/**
 * P2：询价自由文本 → 结构化候选 → 按商品源事实回复。
 *
 * 验证：
 *  - 模型只提供候选（SKU/数量/语言/主题），回复里的价格/库存/交期来自数据；
 *  - 未知 SKU 不编造事实，只要求核对 SKU；
 *  - 未配置解析器时行为不变；
 *  - 结构化 inquiry（subject.sku + questions.code）无需模型也能按事实回答。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import type { NegotiationHandler } from "../src/a2a/server/types.js";
import type {
  InquiryInterpretation,
  InquiryInterpreter,
} from "../src/a2a/server/inquiry-interpreter.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";

const NOW = "2026-10-29T10:00:00Z";
const NEGOTIATION_ID = "neg_inquiry_001";
const CAP = "com.harrylabsj.kiwi.shopping.negotiation";
const SKU = "SKU-001";
const policy = {
  price_floors: { [SKU]: 800 },
  max_auto_discount_percent: 5,
  delivery_lead_days: 7,
};

describe("merchant inquiry interpretation (P2)", () => {
  let dir: string;
  let ledger: LedgerStore;
  let seq = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-p2-"));
    ledger = new LedgerStore({ dir, now: () => NOW });
    seq = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const makeHandler = (
    interpreter?: InquiryInterpreter,
    product: { price: number; stock?: number; unit?: string } = { price: 850, stock: 1_000, unit: "piece" },
  ): NegotiationHandler =>
    createMerchantHandler({
      productSource: {
        async getProduct(sku: string) {
          if (sku !== SKU) throw new Error(`unknown sku ${sku}`);
          return {
            ...product,
            currency: "CNY",
            source_evidence: { system: "owned-test-fixture" },
          };
        },
      },
      ledger,
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
      merchantPolicy: policy,
      ...(interpreter !== undefined ? { inquiryInterpreter: interpreter } : {}),
    });

  const inquiryEnvelope = (payload: Record<string, unknown>): NegotiationEnvelope => {
    seq += 1;
    return finalizeEnvelope({
      capability: CAP,
      protocol_version: "1.0",
      negotiation_id: NEGOTIATION_ID,
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

  it("按买家原文回答价格/库存/交期，事实全部来自数据", async () => {
    const seen: string[] = [];
    const interpreter: InquiryInterpreter = {
      async interpret({ buyer_message }) {
        seen.push(buyer_message);
        return {
          intent: "quote_request",
          topics: ["price", "stock", "delivery"],
          sku: SKU,
          quantity: 10,
          unit: "piece",
          language: "en",
        } satisfies InquiryInterpretation;
      },
    };
    const { result, text } = await run(
      makeHandler(interpreter),
      inquiryEnvelope({ type: "inquiry" }),
      "Do you have 10 pieces of SKU-001? What is the price and delivery date?",
    );
    expect(result.kind).toBe("accepted");
    expect(seen[0]).toContain("Do you have 10 pieces");
    expect(text).toContain("850.00 CNY");
    expect(text).toContain("Stock is available for 10 units");
    expect(text).toContain("2026-11-05");
    expect(text).toContain("non-binding");
  });

  it("中文买家得到中文回复", async () => {
    const interpreter: InquiryInterpreter = {
      async interpret() {
        return {
          intent: "product_question",
          topics: ["stock"],
          sku: SKU,
          language: "zh",
        };
      },
    };
    const { text } = await run(makeHandler(interpreter), inquiryEnvelope({ type: "inquiry" }), "VQ有货吗");
    expect(text).toContain("库存可以覆盖");
    expect(text).toContain("非约束性");
  });

  it("未知 SKU 不编造，只要求核对", async () => {
    const interpreter: InquiryInterpreter = {
      async interpret() {
        return { intent: "quote_request", topics: ["price"], sku: "NOPE-999", language: "en" };
      },
    };
    const { result, text } = await run(
      makeHandler(interpreter),
      inquiryEnvelope({ type: "inquiry" }),
      "price for NOPE-999?",
    );
    expect(result.kind).toBe("accepted");
    expect(text).toContain("could not confirm SKU NOPE-999");
    expect(text).not.toContain("CNY");
  });

  it("未配置解析器时保持原固定询问", async () => {
    const { text } = await run(makeHandler(), inquiryEnvelope({ type: "inquiry" }), "hello");
    expect(text).toContain("Please provide a product SKU");
  });

  it("结构化 inquiry 不依赖模型也能按事实回答", async () => {
    const { text } = await run(
      makeHandler(),
      inquiryEnvelope({
        type: "inquiry",
        subject: { sku: SKU },
        questions: [{ code: "delivery.estimated_date" }, { code: "price.list" }],
      }),
    );
    expect(text).toContain("850.00 CNY");
    expect(text).toContain("2026-11-05");
    expect(text).not.toContain("Stock is available");
  });
});
