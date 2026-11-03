/**
 * M3 第一片：事实时效、单位/包装、税费/运费表达。
 *
 * - 过期商品事实不报价、不创建审批；
 * - 单位不一致必须命中商家别名，否则澄清，不做“盒=件”猜测；
 * - 税费/运费未知时明确“待确认、标价不等于应付总额”。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import {
  createMerchantReceptionEngine,
  parseChineseQuantity,
} from "../src/a2a/reception/engine.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import type { InquiryInterpreter } from "../src/a2a/server/inquiry-interpreter.js";
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";

const NOW = "2026-11-03T04:00:00.000Z";
const SKU = "VQ-001";
const policy = {
  price_floors: { [SKU]: 100 },
  max_auto_discount_percent: 5,
  delivery_lead_days: 7,
};

interface ProductOverride {
  price?: number;
  currency?: string;
  stock?: number;
  unit?: string;
  valid_until?: string;
  tax_included?: boolean;
  shipping_included?: boolean;
}

describe("merchant reception facts/unit/tax (M3)", () => {
  let dir: string;
  let store: ReceptionConversationStore;
  let outbox: ReceptionReplyOutbox;
  let approvals: NegotiationApprovalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-reception-facts-"));
    store = new ReceptionConversationStore({ file: join(dir, "c.json"), now: () => NOW });
    outbox = new ReceptionReplyOutbox({ file: join(dir, "o.json"), now: () => NOW });
    approvals = new NegotiationApprovalStore(dir, () => NOW);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const interpreter = (unit = "piece"): InquiryInterpreter => ({
    async interpret() {
      return {
        intent: "quote_request",
        topics: ["price", "stock", "delivery"],
        sku: SKU,
        quantity: 2,
        unit,
        language: "zh",
      };
    },
  });

  const engineFor = (
    product: ProductOverride,
    unitAliases?: Record<string, string>,
    buyerUnit = "piece",
    unitPackageFactors?: Record<string, number>,
  ) =>
    createMerchantReceptionEngine({
      store,
      outbox,
      interpreter: interpreter(buyerUnit),
      productSource: {
        async getProduct() {
          return { price: 110, currency: "CNY", stock: 50, unit: "piece", ...product };
        },
      },
      policy: () => policy as never,
      approvals,
      ...(unitAliases !== undefined ? { unitAliases } : {}),
      ...(unitPackageFactors !== undefined ? { unitPackageFactors } : {}),
      now: () => NOW,
    });

  const input = (text: string) => ({
    merchantId: "merchant-1",
    identity: "buyer:1",
    identityVerified: false,
    contextId: "ctx_facts",
    text,
    now: NOW,
    messageId: "msg_facts",
  });

  it("中文数量兜底只解析明确数量，不误把价格当数量", () => {
    expect(parseChineseQuantity("改成十盒吧")).toEqual({ quantity: 10, unit: "盒" });
    expect(parseChineseQuantity("两件")).toEqual({ quantity: 2, unit: "件" });
    expect(parseChineseQuantity("98 一件行不行")).toBeUndefined();
    expect(parseChineseQuantity("多少钱")).toBeUndefined();
  });

  it("过期事实：不报价、不创建审批", async () => {
    const engine = engineFor({ valid_until: "2026-11-01T00:00:00.000Z" });
    const result = await engine.respond(input("来两件"));
    expect(result.text).toContain("商品数据已过期");
    expect(result.text).not.toContain("当前公开标价");
    expect(approvals.list("pending")).toHaveLength(0);
  });

  it("单位不一致且无别名：澄清，不报价", async () => {
    const engine = engineFor({}, undefined, "盒");
    const result = await engine.respond(input("来两盒"));
    expect(result.text).toContain("该商品按 piece 售卖");
    expect(result.text).not.toContain("当前公开标价");
    expect(result.conversation.need.unit).toBeUndefined();
  });

  it("单位命中商家别名：归一化后按事实回答", async () => {
    const engine = engineFor({}, { 盒: "piece" }, "盒");
    const result = await engine.respond(input("来两盒"));
    expect(result.text).toContain("已记录需求：SKU VQ-001，2 piece");
    expect(result.text).toContain("当前公开标价 110.00 CNY");
    expect(result.conversation.need.unit).toBe("piece");
  });

  it("税费/运费未知：明确待确认且标价不等于应付总额", async () => {
    const engine = engineFor({});
    const result = await engine.respond(input("来两件"));
    expect(result.text).toContain("税费信息待确认");
    expect(result.text).toContain("运费信息待确认");
    expect(result.text).toContain("标价不等于应付总额");
    expect(result.text).not.toContain("已含税");
  });

  it("rejects conflicting normalized alias/factor configuration at engine construction", () => {
    expect(() => engineFor({}, { "BOX": "box", "盒": "piece" })).toThrow(
      /conflicting normalized unit alias/,
    );
    expect(() =>
      engineFor({}, undefined, "piece", { "BOX": 12, "盒": 6 }),
    ).toThrow(/conflicting normalized unit package factor/);
  });

  it("box/盒 是明确 1:1 别名：不改变数量、单价或金额", async () => {
    const engine = engineFor({ unit: "box" }, undefined, "盒");
    const result = await engine.respond(input("来两盒"));
    expect(result.text).toContain("已记录需求：SKU VQ-001，2 box");
    expect(result.text).toContain("当前公开标价 110.00 CNY");
    expect(result.conversation.need.quantity).toBe(2);
    expect(result.conversation.need.unit).toBe("box");
  });

  it("box/盒 反向匹配：商品单位为盒、买家写 box", async () => {
    const engine = engineFor({ unit: "盒" }, undefined, "box");
    const result = await engine.respond(input("来两盒"));
    expect(result.text).toContain("已记录需求：SKU VQ-001，2 盒");
    expect(result.conversation.need.quantity).toBe(2);
    expect(result.conversation.need.unit).toBe("盒");
  });

  it.each(["个", "件"])("不把 %s 自动换算成 box", async unit => {
    const engine = engineFor({ unit: "box" }, undefined, unit);
    const result = await engine.respond(input("来两件"));
    expect(result.text).toContain("该商品按 box 售卖");
    expect(result.text).not.toContain("当前公开标价");
    expect(result.conversation.need.unit).toBeUndefined();
  });

  it("商家显式别名优先，内建 box/盒 不覆盖既有配置", async () => {
    const engine = engineFor({ unit: "box" }, { 盒: "piece" }, "盒");
    const result = await engine.respond(input("来两盒"));
    expect(result.text).toContain("该商品按 box 售卖");
    expect(result.conversation.need.unit).toBeUndefined();
  });

  it("全角/大小写包装倍率键先归一，显式倍率优先于 box/盒 1:1", async () => {
    const engine = engineFor({ unit: "盒" }, undefined, "box", { "ＢＯＸ": 12 });
    const result = await engine.respond(input("来两盒"));
    expect(result.text).toContain("24 盒");
    expect(result.text).toContain("原 2 box");
    expect(result.text).toContain("1 box = 12 盒");
    expect(result.conversation.need.quantity).toBe(24);
    expect(result.conversation.need.unit).toBe("盒");
    expect(result.text).toContain("当前公开标价 110.00 CNY");
  });

  it("全角/大小写别名键先归一，仍按原数量报价", async () => {
    const engine = engineFor({ unit: "盒" }, { "ＢＯＸ": "盒" }, "box");
    const result = await engine.respond(input("来两盒"));
    expect(result.text).toContain("已记录需求：SKU VQ-001，2 盒");
    expect(result.text).toContain("当前公开标价 110.00 CNY");
    expect(result.conversation.need.quantity).toBe(2);
  });

  it("包装单位按商家声明倍率换算并保留原数量", async () => {
    const engine = engineFor({}, undefined, "箱", { 箱: 12 });
    const result = await engine.respond(input("来两箱"));
    expect(result.text).toContain("24 piece");
    expect(result.text).toContain("原 2 箱");
    expect(result.text).toContain("1 箱 = 12 piece");
    expect(result.text).toContain("当前公开标价 110.00 CNY");
    expect(result.conversation.need.quantity).toBe(24);
    expect(result.conversation.need.unit).toBe("piece");
    expect(result.conversation.need.inputQuantity).toBe(2);
    expect(result.conversation.need.inputUnit).toBe("箱");
  });

  it("包装单位但没有数量：先问数量，不猜 1 箱=1 件", async () => {
    const engine = createMerchantReceptionEngine({
      store,
      outbox,
      interpreter: {
        async interpret() {
          return {
            intent: "quote_request",
            topics: ["price"],
            sku: SKU,
            unit: "箱",
            language: "zh",
          };
        },
      },
      productSource: {
        async getProduct() {
          return { price: 110, currency: "CNY", stock: 50, unit: "piece" };
        },
      },
      policy: () => policy as never,
      approvals,
      unitPackageFactors: { 箱: 12 },
      now: () => NOW,
    });
    const result = await engine.respond(input("来箱"));
    expect(result.text).toContain("请补充购买数量");
    expect(result.text).not.toContain("当前公开标价");
  });

  it("商品源声明含税/不含运费时按事实表达", async () => {
    const engine = engineFor({ tax_included: true, shipping_included: false });
    const result = await engine.respond(input("来两件"));
    expect(result.text).toContain("标价已含税");
    expect(result.text).toContain("标价未含运费");
  });
});
