/**
 * AC09 / D03：一次会话只服务一个商品。
 *
 *  - 买家一条消息提到多个 SKU：明确提示并请买家选择，不静默只取第一项、
 *    不报任何价格、不创建审批；
 *  - KNP RFQ / offer / counter_offer 携带两行商品：decline field_unsupported，
 *    要求分别发起，不静默只处理 items[0]；
 *  - 结构化字段（协议数据）权威：有结构化 SKU 时不受模型多候选影响。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import { createMerchantReceptionEngine } from "../src/a2a/reception/engine.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import { validateInquiryInterpretation } from "../src/a2a/server/inquiry-interpreter.js";
import type { InquiryInterpreter } from "../src/a2a/server/inquiry-interpreter.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";

const NOW = "2026-11-03T04:00:00.000Z";

describe("validateInquiryInterpretation：skus 候选列表", () => {
  const base = { intent: "quote_request", topics: ["price"], language: "zh" };

  it("接受多个 SKU 候选，sku 取第一项", () => {
    const value = validateInquiryInterpretation({ ...base, skus: ["VQ-001", "VQ-002"] });
    expect(value?.skus).toEqual(["VQ-001", "VQ-002"]);
    expect(value?.sku).toBe("VQ-001");
  });

  it("去重并丢弃非法条目", () => {
    const value = validateInquiryInterpretation({
      ...base,
      skus: ["VQ-001", "VQ-001", "bad sku!", "VQ-002"],
    });
    expect(value?.skus).toEqual(["VQ-001", "VQ-002"]);
  });

  it("只有单 sku 字段时 skus 归一化为单元素列表", () => {
    const value = validateInquiryInterpretation({ ...base, sku: "VQ-001" });
    expect(value?.skus).toEqual(["VQ-001"]);
  });

  it("sku 与 skus 同时存在时合并去重", () => {
    const value = validateInquiryInterpretation({
      ...base,
      sku: "VQ-001",
      skus: ["VQ-002", "VQ-001"],
    });
    expect(value?.skus).toEqual(["VQ-001", "VQ-002"]);
  });

  it("候选数量有上限，超出截断", () => {
    const many = Array.from({ length: 12 }, (_, i) => `VQ-${String(i).padStart(3, "0")}`);
    const value = validateInquiryInterpretation({ ...base, skus: many });
    expect(value?.skus).toHaveLength(8);
  });
});

describe("reception 多商品请求（AC09/D03）", () => {
  let dir: string;
  let store: ReceptionConversationStore;
  let outbox: ReceptionReplyOutbox;
  let approvals: NegotiationApprovalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-reception-multi-"));
    store = new ReceptionConversationStore({
      file: join(dir, "conversations.json"),
      now: () => NOW,
    });
    outbox = new ReceptionReplyOutbox({ file: join(dir, "reply-outbox.json"), now: () => NOW });
    approvals = new NegotiationApprovalStore(dir, () => NOW);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const interpreterFor = (
    value: Awaited<ReturnType<InquiryInterpreter["interpret"]>>,
  ): InquiryInterpreter => ({
    async interpret() {
      return value;
    },
  });

  const engineFor = (interpreter: InquiryInterpreter) =>
    createMerchantReceptionEngine({
      store,
      outbox,
      interpreter,
      productSource: {
        async getProduct(sku: string) {
          if (sku !== "VQ-001" && sku !== "VQ-002") throw new Error(`unknown sku ${sku}`);
          return { price: 110, currency: "CNY", stock: 50 };
        },
      },
      approvals,
      now: () => NOW,
    });

  const input = (text: string, structured?: { sku?: string }) => ({
    merchantId: "merchant-1",
    identity: "buyer:1",
    identityVerified: false,
    contextId: "ctx_1",
    text,
    now: NOW,
    ...(structured !== undefined ? { structured } : {}),
  });

  it("一条消息提到两个 SKU：提示选择，不取第一项、不报价、不审批", async () => {
    const engine = engineFor(
      interpreterFor({
        intent: "quote_request",
        topics: ["price"],
        skus: ["VQ-001", "VQ-002"],
        sku: "VQ-001",
        language: "zh",
      }),
    );
    const result = await engine.respond(input("VQ-001 和 VQ-002 各来两盒，多少钱？"));
    expect(result.plan.blocks).toHaveLength(1);
    const block = result.plan.blocks[0]!;
    expect(block.kind).toBe("ask_clarification");
    if (block.kind === "ask_clarification") expect(block.reason).toBe("multiple_skus");
    expect(result.text).toContain("一次只能咨询一个商品");
    expect(result.text).toContain("VQ-001");
    expect(result.text).toContain("VQ-002");
    expect(result.text).not.toContain("110.00");
    expect(approvals.list("pending")).toHaveLength(0);
    // 多商品请求不落成会话需求（没有选择就什么都不记）。
    expect(result.conversation.need.sku).toBeUndefined();
  });

  it("买家随后选择一个 SKU：正常按事实回答", async () => {
    let interpretation: Awaited<ReturnType<InquiryInterpreter["interpret"]>> = {
      intent: "quote_request",
      topics: ["price"],
      skus: ["VQ-001", "VQ-002"],
      sku: "VQ-001",
      language: "zh",
    };
    const engine = engineFor({ async interpret() { return interpretation; } });
    await engine.respond(input("VQ-001 和 VQ-002 各两盒"));
    interpretation = {
      intent: "quote_request",
      topics: ["price"],
      skus: ["VQ-001"],
      sku: "VQ-001",
      quantity: 2,
      language: "zh",
    };
    const second = await engine.respond(input("先确认 VQ-001 两盒"));
    expect(second.text).toContain("当前公开标价 110.00 CNY");
    expect(second.conversation.need.sku).toBe("VQ-001");
  });

  it("单元素 skus 列表按单商品处理", async () => {
    const engine = engineFor(
      interpreterFor({
        intent: "quote_request",
        topics: ["price"],
        skus: ["VQ-002"],
        sku: "VQ-002",
        language: "zh",
      }),
    );
    const result = await engine.respond(input("VQ-002 多少钱？"));
    expect(result.text).toContain("SKU VQ-002");
    expect(result.text).toContain("110.00");
  });

  it("多商品澄清后可用“第一个”选择候选", async () => {
    let interpretation: Awaited<ReturnType<InquiryInterpreter["interpret"]>> = {
      intent: "quote_request",
      topics: ["price"],
      skus: ["VQ-001", "VQ-002"],
      sku: "VQ-001",
      language: "zh",
    };
    const engine = engineFor({
      async interpret() {
        return interpretation;
      },
    });
    await engine.respond(input("VQ-001 和 VQ-002 各两盒"));
    expect(store.get("merchant-1", "buyer:1", "ctx_1")?.need.pendingSkus).toEqual([
      "VQ-001",
      "VQ-002",
    ]);

    interpretation = { intent: "quote_request", topics: ["price"], language: "zh" };
    const second = await engine.respond(input("第一个"));
    expect(second.text).toContain("SKU VQ-001");
    expect(second.text).toContain("当前公开标价 110.00 CNY");
    expect(second.conversation.need.pendingSkus).toBeUndefined();
  });

  it("结构化 SKU 是协议数据：不受模型多候选影响", async () => {
    const engine = engineFor(
      interpreterFor({
        intent: "quote_request",
        topics: ["price"],
        skus: ["VQ-001", "VQ-002"],
        sku: "VQ-001",
        language: "zh",
      }),
    );
    const result = await engine.respond(input("", { sku: "VQ-002" }));
    expect(result.text).toContain("SKU VQ-002");
    expect(result.text).toContain("110.00");
    expect(result.text).not.toContain("一次只能咨询一个商品");
  });
});

describe("KNP 多行商品（AC09：不静默只处理 items[0]）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-multi-item-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const handlerFor = () =>
    createMerchantHandler({
      ledger: new LedgerStore({ dir, now: () => NOW }),
      now: () => NOW,
      sender: "merchant:merchant-001",
      counterparty: "buyer:*",
      productSource: {
        async getProduct() {
          return {
            price: 100,
            currency: "CNY",
            unit: "piece",
            stock: 1000,
            source_evidence: { system: "owned-test-fixture" },
          };
        },
      },
    });

  const envelopeOf = (
    action: string,
    payload: Record<string, unknown>,
    negotiationId: string,
  ) =>
    finalizeEnvelope({
      capability: "com.harrylabsj.kiwi.shopping.negotiation",
      protocol_version: "1.0",
      negotiation_id: negotiationId,
      exchange_id: `ex_${Math.random().toString(16).slice(2)}`,
      message_id: `msg_${Math.random().toString(16).slice(2)}`,
      in_reply_to: "msg_previous",
      actor: "buyer",
      action,
      created_at: NOW,
      payload,
    } as never) as never;

  const call = (
    handler: ReturnType<typeof handlerFor>,
    envelope: never,
  ) =>
    handler.handle({
      envelope,
      message: { role: "user", parts: [], messageId: "msg_input" },
      taskId: "task-multi",
      senderIdentity: "buyer:buyer-001",
    } as never);

  const twoItems = [
    { sku: "SKU-001", quantity: { value: 2, unit: "piece" } },
    { sku: "SKU-002", quantity: { value: 3, unit: "piece" } },
  ];

  it("RFQ 携带两行商品：decline field_unsupported 并说明分别发起", async () => {
    const handler = handlerFor();
    const result = await call(
      handler,
      envelopeOf("rfq", { items: twoItems }, "neg_multi_rfq"),
    );
    expect(result.kind).toBe("declined");
    if (result.kind === "declined") {
      expect(result.reasonCode).toBe("field_unsupported");
      expect(result.message).toContain("一个 SKU");
    }
  });

  it("RFQ 单行商品：正常报价（回归基线）", async () => {
    const handler = handlerFor();
    const result = await call(
      handler,
      envelopeOf(
        "rfq",
        { items: [{ sku: "SKU-001", quantity: { value: 2, unit: "piece" } }] },
        "neg_single_rfq",
      ),
    );
    expect(result.kind).toBe("accepted");
  });

  it("offer 携带两行商品：decline field_unsupported", async () => {
    const handler = handlerFor();
    const result = await call(
      handler,
      envelopeOf(
        "offer",
        { offer_id: "off_buyer", terms: { items: twoItems } },
        "neg_multi_offer",
      ),
    );
    expect(result.kind).toBe("declined");
    if (result.kind === "declined") expect(result.reasonCode).toBe("field_unsupported");
  });

  it("无前置报价时多行 counter 也先校验：field_unsupported 而非 state_conflict", async () => {
    const handler = handlerFor();
    const result = await call(
      handler,
      envelopeOf(
        "counter_offer",
        { offer_id: "off_missing", proposed_terms: { items: twoItems } },
        "neg_multi_no_phase",
      ),
    );
    expect(result.kind).toBe("declined");
    if (result.kind === "declined") expect(result.reasonCode).toBe("field_unsupported");
  });

  it("counter_offer 携带两行商品：decline field_unsupported", async () => {
    const handler = handlerFor();
    const rfq = await call(
      handler,
      envelopeOf(
        "rfq",
        { items: [{ sku: "SKU-001", quantity: { value: 2, unit: "piece" } }] },
        "neg_multi_counter",
      ),
    );
    expect(rfq.kind).toBe("accepted");
    const result = await call(
      handler,
      envelopeOf(
        "counter_offer",
        {
          offer_id: "off_previous",
          proposed_terms: { items: twoItems },
        },
        "neg_multi_counter",
      ),
    );
    expect(result.kind).toBe("declined");
    if (result.kind === "declined") {
      expect(result.reasonCode).toBe("field_unsupported");
    }
  });
});
