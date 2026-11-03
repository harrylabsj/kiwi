/**
 * P0a：ResponsePlan 发布前校验（设计 §11）。
 *
 * 验证：
 *  - show_commercial_terms 只接受服务端事实引用；引用不存在、版本不匹配、
 *    跨租户、不可见或已过期时拒绝该块，绝不按块内自带数字渲染；
 *  - 校验通过的块从同一快照渲染公开文本；
 *  - 引擎产出的计划不携带字面事实（无 free_text / 数字槽位）；
 *  - 商品数据过期时引擎回复不包装成当前有效报价。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReceptionConversationStore } from "../src/a2a/reception/conversation-store.js";
import { createMerchantReceptionEngine } from "../src/a2a/reception/engine.js";
import { ReceptionReplyOutbox } from "../src/a2a/reception/reply-outbox.js";
import {
  InMemoryFactRegistry,
  publishResponsePlan,
} from "../src/a2a/reception/publish.js";
import type {
  CommercialFactSnapshot,
  ReceptionResponsePlan,
} from "../src/a2a/reception/types.js";
import type { InquiryInterpreter } from "../src/a2a/server/inquiry-interpreter.js";

const NOW = "2026-11-03T04:00:00.000Z";
const SKU = "VQ-001";
const policy = {
  price_floors: { [SKU]: 100 },
  delivery_lead_days: 7,
};

const snapshotFor = (over: Partial<CommercialFactSnapshot> = {}): CommercialFactSnapshot => ({
  merchantId: "m1",
  sku: SKU,
  revision: "rev-1",
  visibility: "public",
  issuedAt: NOW,
  facts: {
    listPrice: 110,
    currency: "CNY",
    stockAvailable: true,
    deliveryBefore: "2026-11-10T00:00:00.000Z",
  },
  ...over,
});

const planWith = (ref: { sku: string; revision: string }): ReceptionResponsePlan => ({
  locale: "zh-CN",
  blocks: [
    { kind: "acknowledge_need", sku: SKU, quantity: 2, unit: "件" },
    { kind: "show_commercial_terms", ref },
    { kind: "next_step", action: "send_rfq" },
  ],
});

describe("publishResponsePlan（发布前校验）", () => {
  it("校验通过：从服务端快照渲染事实", () => {
    const registry = new InMemoryFactRegistry();
    const ref = registry.register(snapshotFor());
    const published = publishResponsePlan({
      plan: planWith(ref),
      registry,
      merchantId: "m1",
      now: NOW,
    });
    expect(published.rejected).toEqual([]);
    expect(published.text).toContain("当前公开标价 110.00 CNY");
    expect(published.text).toContain("库存可以覆盖本次数量");
    expect(published.text).toContain("预计交期不晚于 2026-11-10");
  });

  it("引用不存在：拒绝该块", () => {
    const registry = new InMemoryFactRegistry();
    const published = publishResponsePlan({
      plan: planWith({ sku: "NOPE-1", revision: "rev-1" }),
      registry,
      merchantId: "m1",
      now: NOW,
    });
    expect(published.rejected).toHaveLength(1);
    expect(published.rejected[0]?.reason).toBe("reference_not_found");
    expect(published.text).not.toContain("公开标价");
  });

  it("版本不匹配：拒绝该块", () => {
    const registry = new InMemoryFactRegistry();
    registry.register(snapshotFor());
    const published = publishResponsePlan({
      plan: planWith({ sku: SKU, revision: "rev-stale" }),
      registry,
      merchantId: "m1",
      now: NOW,
    });
    expect(published.rejected[0]?.reason).toBe("version_mismatch");
    expect(published.text).not.toContain("公开标价");
  });

  it("跨租户引用：拒绝该块", () => {
    const registry = new InMemoryFactRegistry();
    const ref = registry.register(snapshotFor({ merchantId: "m2" }));
    const published = publishResponsePlan({
      plan: planWith(ref),
      registry,
      merchantId: "m1",
      now: NOW,
    });
    expect(published.rejected[0]?.reason).toBe("cross_tenant");
    expect(published.text).not.toContain("公开标价");
  });

  it("非公开快照：拒绝该块", () => {
    const registry = new InMemoryFactRegistry();
    const ref = registry.register(snapshotFor({ visibility: "private" }));
    const published = publishResponsePlan({
      plan: planWith(ref),
      registry,
      merchantId: "m1",
      now: NOW,
    });
    expect(published.rejected[0]?.reason).toBe("not_public");
  });

  it("快照已过期：拒绝该块", () => {
    const registry = new InMemoryFactRegistry();
    const ref = registry.register(snapshotFor({ expiresAt: "2026-11-01T00:00:00.000Z" }));
    const published = publishResponsePlan({
      plan: planWith(ref),
      registry,
      merchantId: "m1",
      now: NOW,
    });
    expect(published.rejected[0]?.reason).toBe("expired");
    expect(published.text).not.toContain("公开标价");
  });
});

describe("engine 产出计划的发布约束", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-reception-publish-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const interpreter: InquiryInterpreter = {
    async interpret() {
      return {
        intent: "quote_request",
        topics: ["price", "stock", "delivery"],
        sku: SKU,
        quantity: 2,
        unit: "件",
        language: "zh",
      };
    },
  };

  const engineFor = (product: Record<string, unknown>) =>
    createMerchantReceptionEngine({
      store: new ReceptionConversationStore({
        file: join(dir, "conversations.json"),
        now: () => NOW,
      }),
      outbox: new ReceptionReplyOutbox({ file: join(dir, "reply-outbox.json"), now: () => NOW }),
      interpreter,
      productSource: {
        async getProduct(sku: string) {
          if (sku !== SKU) throw new Error(`unknown sku ${sku}`);
          return product as never;
        },
      },
      policy: () => policy as never,
      now: () => NOW,
    });

  const input = {
    merchantId: "m1",
    identity: "buyer:1",
    identityVerified: false,
    contextId: "ctx_1",
    text: "VQ-001 两件多少钱",
    now: NOW,
  };

  it("计划只携带事实引用，不携带字面商务数字", async () => {
    const engine = engineFor({ price: 110, currency: "CNY", stock: 50 });
    const result = await engine.respond(input);
    const terms = result.plan.blocks.find((block) => block.kind === "show_commercial_terms");
    expect(terms).toBeDefined();
    expect(terms).not.toHaveProperty("facts");
    expect(JSON.stringify(terms)).not.toContain("110");
    expect(result.text).toContain("当前公开标价 110.00 CNY");
  });

  it("商品数据已过期：回复不包装成当前有效报价", async () => {
    const engine = engineFor({
      price: 110,
      currency: "CNY",
      stock: 50,
      valid_until: "2026-11-01T00:00:00.000Z",
    });
    const result = await engine.respond(input);
    expect(result.text).not.toContain("公开标价");
    expect(result.text).not.toContain("库存可以覆盖");
    expect(result.text).toContain("请发送 RFQ");
  });
});
