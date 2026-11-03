/**
 * P0a 商家接待最小闭环：
 *  - 买家原文经模型只提取候选，价格/库存/交期全部来自商品源与策略；
 *  - 未知 SKU、非中文、缺 SKU 都回中文澄清，不编造事实；
 *  - 每买家每 context 独立会话，多轮保留已确认的 SKU；
 *  - generic responder 输出 1.0 wire 形状，异常回固定兜底文案。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import { createMerchantReceptionEngine } from "../src/a2a/reception/engine.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import { createReceptionResponder, textPartsOf } from "../src/a2a/reception/responder.js";
import { declineHandler } from "../src/a2a/server/handler.js";
import type { InquiryInterpreter } from "../src/a2a/server/inquiry-interpreter.js";
import { InboundPipeline } from "../src/a2a/server/pipeline.js";
import { TaskRegistry } from "../src/a2a/server/task-registry.js";
import { IdempotencyStore } from "../src/negotiation/idempotency/index.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";

const NOW = "2026-11-03T04:00:00.000Z";
const SKU = "VQ-001";
const policy = {
  price_floors: { [SKU]: 100 },
  max_auto_discount_percent: 5,
  delivery_lead_days: 7,
};

describe("merchant reception (P0a)", () => {
  let dir: string;
  let store: ReceptionConversationStore;
  let outbox: ReceptionReplyOutbox;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-reception-"));
    store = new ReceptionConversationStore({
      file: join(dir, "conversations.json"),
      now: () => NOW,
    });
    outbox = new ReceptionReplyOutbox({ file: join(dir, "reply-outbox.json"), now: () => NOW });
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

  const engineFor = (
    interpreter?: InquiryInterpreter,
    product: { price: number; currency: string; stock?: number } = {
      price: 110,
      currency: "CNY",
      stock: 50,
    },
    productPolicy: Record<string, unknown> = policy,
  ) =>
    createMerchantReceptionEngine({
      store,
      outbox,
      ...(interpreter !== undefined ? { interpreter } : {}),
      productSource: {
        async getProduct(sku: string) {
          if (sku !== SKU) throw new Error(`unknown sku ${sku}`);
          return product;
        },
      },
      policy: () => productPolicy as never,
      now: () => NOW,
    });

  const input = (text: string, identity = "buyer:1", contextId = "ctx_1") => ({
    merchantId: "merchant-1",
    identity,
    identityVerified: false,
    contextId,
    text,
    now: NOW,
  });

  it("按商品源事实回复价格/库存/交期", async () => {
    const engine = engineFor(
      interpreterFor({
        intent: "quote_request",
        topics: ["price", "stock", "delivery"],
        sku: SKU,
        quantity: 2,
        unit: "件",
        language: "zh",
      }),
    );
    const result = await engine.respond(input("我想买 2 件 VQ-001"));
    expect(result.text).toContain("已记录需求：SKU VQ-001，2 件");
    expect(result.text).toContain("当前公开标价 110.00 CNY");
    expect(result.text).toContain("库存可以覆盖本次数量");
    expect(result.text).toContain("预计交期不晚于 2026-11-10");
    expect(result.text).toContain("非约束性信息");
    expect(result.conversation.need.sku).toBe(SKU);
    expect(result.conversation.need.revision).toBe(1);
  });

  it("多轮：第二轮只给数量时沿用第一轮 SKU", async () => {
    const first = engineFor(
      interpreterFor({ intent: "product_question", topics: ["stock"], sku: SKU, language: "zh" }),
    );
    await first.respond(input("VQ-001 有货吗"));
    const second = engineFor(
      interpreterFor({
        intent: "quote_request",
        topics: ["price"],
        quantity: 3,
        unit: "件",
        language: "zh",
      }),
    );
    const result = await second.respond(input("要三件"));
    expect(result.text).toContain("已记录需求：SKU VQ-001，3 件");
    expect(result.conversation.need.revision).toBe(2);
  });

  it("缺 SKU 时澄清，不猜商品", async () => {
    const engine = engineFor(
      interpreterFor({ intent: "other", topics: [], language: "zh" }),
    );
    const result = await engine.respond(input("想买两盒试试"));
    expect(result.text).toContain("请提供商品 SKU");
    expect(result.text).not.toContain("CNY");
  });

  it("未知 SKU 不编造价格", async () => {
    const engine = engineFor(
      interpreterFor({ intent: "quote_request", topics: ["price"], sku: "NOPE-1", language: "zh" }),
    );
    const result = await engine.respond(input("NOPE-1 多少钱"));
    expect(result.text).toContain("无法从商品源确认该 SKU");
    expect(result.text).not.toContain("CNY");
  });

  it("非中文请求只回中文范围提示", async () => {
    const engine = engineFor();
    const result = await engine.respond(input("Do you have VQ-001?"));
    expect(result.text).toContain("目前仅支持中文接待");
  });

  it("公开价低于私有底价时不报价", async () => {
    const engine = engineFor(
      interpreterFor({ intent: "quote_request", topics: ["price"], sku: SKU, language: "zh" }),
      { price: 80, currency: "CNY", stock: 10 },
      { ...policy, price_floors: { [SKU]: 100 } },
    );
    const result = await engine.respond(input("VQ-001 多少钱"));
    expect(result.text).not.toContain("公开标价");
  });

  it("会话按 buyer + context 隔离", async () => {
    const engine = engineFor(
      interpreterFor({ intent: "product_question", topics: ["stock"], sku: SKU, language: "zh" }),
    );
    await engine.respond(input("VQ-001 有货吗", "buyer:1", "ctx_1"));
    const otherEngine = engineFor(
      interpreterFor({
        intent: "quote_request",
        topics: ["price"],
        quantity: 3,
        unit: "件",
        language: "zh",
      }),
    );
    const other = await otherEngine.respond(input("要三件", "buyer:2", "ctx_1"));
    expect(other.text).toContain("请提供商品 SKU");
    expect(other.conversation.need.sku).toBeUndefined();
  });

  it("结构化 SKU（KNP inquiry）无需模型也按事实回答", async () => {
    const engine = engineFor();
    const result = await engine.respond({ ...input(""), structured: { sku: SKU } });
    expect(result.text).toContain("SKU VQ-001");
    expect(result.text).toContain("当前公开标价 110.00 CNY");
    expect(result.text).toContain("预计交期不晚于 2026-11-10");
    expect(result.conversation.need.sku).toBe(SKU);
  });

  it("结构化 SKU 优先于模型候选（协议数据权威）", async () => {
    const engine = engineFor(
      interpreterFor({ intent: "quote_request", topics: ["price"], sku: "NOPE-1", language: "zh" }),
    );
    const result = await engine.respond({ ...input("NOPE-1 多少钱"), structured: { sku: SKU } });
    expect(result.text).toContain("当前公开标价 110.00 CNY");
    expect(result.text).not.toContain("无法从商品源确认该 SKU");
  });

  it("结构化 SKU 存在时不触发空消息/非中文澄清", async () => {
    const engine = engineFor();
    const empty = await engine.respond({ ...input(""), structured: { sku: SKU } });
    expect(empty.text).not.toContain("请说明需要的商品");
    const nonChinese = await engine.respond({ ...input("price?", "buyer:1", "ctx_2"), structured: { sku: SKU } });
    expect(nonChinese.text).not.toContain("目前仅支持中文接待");
    expect(nonChinese.text).toContain("当前公开标价 110.00 CNY");
  });
});

describe("pipeline generic responder", () => {
  it("await 异步响应器并把可信主体交给接待层", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-pipeline-reception-"));
    try {
      let seenIdentity: string | undefined;
      const pipeline = new InboundPipeline({
        handler: declineHandler(),
        idempotency: new IdempotencyStore({ dir, now: () => NOW }),
        ledger: new LedgerStore({ dir, now: () => NOW }),
        tasks: new TaskRegistry(),
        now: () => NOW,
        logError: () => {},
        genericResponder: async (input) => {
          seenIdentity = input.identity;
          return {
            message: { role: "ROLE_AGENT", parts: [{ text: "异步接待" }], messageId: "msg_1" },
          };
        },
      });
      const result = await pipeline.sendGenericMessage(
        { role: "ROLE_USER", parts: [{ text: "你好" }], messageId: "m1" },
        { identity: "buyer:42", identityVerified: true },
      );
      expect(seenIdentity).toBe("buyer:42");
      expect(JSON.stringify(result)).toContain("异步接待");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reception responder", () => {
  it("解析 1.0 text parts 并返回 ROLE_AGENT", async () => {
    expect(
      textPartsOf({ role: "ROLE_USER", parts: [{ text: "你好" }, { kind: "text", text: "在吗" }] }),
    ).toBe("你好\n在吗");

    const responder = createReceptionResponder(
      {
        async respond() {
          return {
            text: "已记录需求。",
            plan: { locale: "zh-CN", blocks: [] },
            conversation: {
              merchantId: "m",
              identity: "buyer",
              contextId: "ctx",
              need: { revision: 1, updatedAt: NOW },
            },
            reply: { response_id: "resp_1", reply_seq: 1 },
          };
        },
      },
      "m",
    );
    const result = await responder({
      message: { role: "ROLE_USER", parts: [{ text: "你好" }] },
      taskId: "t",
      contextId: "ctx",
      identity: "buyer:1",
      now: () => NOW,
    });
    expect(result.message).toMatchObject({ role: "ROLE_AGENT" });
    expect(JSON.stringify(result.message)).toContain("已记录需求。");
  });

  it("引擎异常时返回固定兜底，不回显原文", async () => {
    const responder = createReceptionResponder(
      {
        async respond() {
          throw new Error("provider down");
        },
      },
      "m",
    );
    const result = await responder({
      message: { role: "ROLE_USER", parts: [{ text: "buyer secret" }] },
      taskId: "t",
      contextId: "ctx",
      now: () => NOW,
    });
    const serialized = JSON.stringify(result.message);
    expect(serialized).toContain("当前无法处理这条消息");
    expect(serialized).not.toContain("buyer secret");
    expect(serialized).not.toContain("provider down");
  });
});
