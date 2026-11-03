/**
 * M2 第一片：买家只说需求、不说 SKU 时的本店商品搜索与候选澄清。
 *
 * - 唯一命中：直接进入事实回答；
 * - 多命中：列出候选并持久化，买家可继续用“第一个”选择；
 * - 零命中/搜索失败：回固定追问，不编造商品；
 * - 搜索只返回候选，价格仍由被选中 SKU 的事实快照给出。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import { createMerchantReceptionEngine } from "../src/a2a/reception/engine.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import type { InquiryInterpreter } from "../src/a2a/server/inquiry-interpreter.js";

const NOW = "2026-11-03T04:00:00.000Z";
const policy = {
  price_floors: { "VQ-001": 100, "VQ-002": 80 },
  max_auto_discount_percent: 5,
  delivery_lead_days: 7,
};

describe("merchant reception product search (M2)", () => {
  let dir: string;
  let store: ReceptionConversationStore;
  let outbox: ReceptionReplyOutbox;
  let queries: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-reception-search-"));
    store = new ReceptionConversationStore({ file: join(dir, "c.json"), now: () => NOW });
    outbox = new ReceptionReplyOutbox({ file: join(dir, "o.json"), now: () => NOW });
    queries = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const interpreter: InquiryInterpreter = {
    async interpret() {
      return {
        intent: "quote_request",
        topics: ["price"],
        quantity: 2,
        unit: "盒",
        language: "zh",
      };
    },
  };

  const engineFor = (
    searchProducts: (query: string) => Promise<
      Array<{ sku: string; title?: string; price: number; currency: string; stock?: number }>
    >,
  ) =>
    createMerchantReceptionEngine({
      store,
      outbox,
      interpreter,
      productSource: {
        searchProducts,
        async getProduct(sku: string) {
          if (sku !== "VQ-001" && sku !== "VQ-002") throw new Error(`unknown ${sku}`);
          return { price: sku === "VQ-001" ? 110 : 90, currency: "CNY", stock: 50 };
        },
      },
      policy: () => policy as never,
      now: () => NOW,
    });

  const input = (text: string) => ({
    merchantId: "merchant-1",
    identity: "buyer:1",
    identityVerified: false,
    contextId: "ctx_search",
    text,
    now: NOW,
  });

  it("唯一命中：直接按选中 SKU 的事实回答", async () => {
    const engine = engineFor(async (query) => {
      queries.push(query);
      return [{ sku: "VQ-001", title: "办公款", price: 110, currency: "CNY", stock: 50 }];
    });
    const result = await engine.respond(input("给办公室用的那款，来两盒"));
    expect(queries[0]).toContain("办公室");
    expect(result.text).toContain("SKU VQ-001");
    expect(result.text).toContain("当前公开标价 110.00 CNY");
    expect(result.conversation.need.sku).toBe("VQ-001");
  });

  it("多命中：列出候选并持久化，可用“第一个”继续", async () => {
    const engine = engineFor(async () => [
      { sku: "VQ-001", title: "A款", price: 110, currency: "CNY", stock: 50 },
      { sku: "VQ-002", title: "B款", price: 90, currency: "CNY", stock: 50 },
    ]);
    const first = await engine.respond(input("办公用的两款都可以"));
    expect(first.text).toContain("VQ-001、VQ-002");
    expect(first.text).toContain("请告诉我要咨询哪一个");
    expect(first.text).not.toContain("CNY");
    expect(first.conversation.need.pendingSkus).toEqual(["VQ-001", "VQ-002"]);

    const second = await engine.respond(input("第一个"));
    expect(second.text).toContain("SKU VQ-001");
    expect(second.text).toContain("当前公开标价 110.00 CNY");
  });

  it("零命中：回固定追问，不编造商品", async () => {
    const engine = engineFor(async () => []);
    const result = await engine.respond(input("有没有办公室套装"));
    expect(result.text).toContain("请提供商品 SKU");
    expect(result.text).not.toContain("CNY");
  });

  it("搜索失败：回固定追问，不阻断接待", async () => {
    const engine = engineFor(async () => {
      throw new Error("source down");
    });
    const result = await engine.respond(input("有没有办公用品"));
    expect(result.text).toContain("请提供商品 SKU");
  });
});
