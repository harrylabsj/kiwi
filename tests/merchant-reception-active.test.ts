/**
 * P0a：active 边界（D01/D15）与回复序号/outbox（§16.1）。
 *
 * 验证：
 *  - 买家目标价在公开折扣边界内：正常按事实回答，不创建审批；
 *  - 目标价低于公开边界：创建审批候选（15 分钟待批），回复"需要商家确认"，
 *    不泄露公开边界与私有底价；
 *  - 审批 store：pending 到期后 approve 失败并置 expired（§17.1/§17.2）；
 *  - 回复按会话分配严格递增 reply_seq，outbox 记录持久化、跨买家隔离。
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
import { NegotiationApprovalStore } from "../src/a2a/server/negotiation-approvals.js";

const NOW = "2026-11-03T04:00:00.000Z";
const SKU = "VQ-001";
// list 110，公开边界 = 110 × (1 - 5%) = 104.50；底价 100（私有）。
const policy = {
  price_floors: { [SKU]: 100 },
  max_auto_discount_percent: 5,
  delivery_lead_days: 7,
};

describe("validateInquiryInterpretation：target_price 候选", () => {
  const base = { intent: "quote_request", topics: ["price"], language: "zh" };

  it("接受买家明确提出的正数目标价", () => {
    const value = validateInquiryInterpretation({ ...base, target_price: 98.5 });
    expect(value?.target_price).toBe(98.5);
  });

  it("拒绝非正数/非数值目标价", () => {
    expect(validateInquiryInterpretation({ ...base, target_price: 0 })?.target_price).toBeUndefined();
    expect(validateInquiryInterpretation({ ...base, target_price: -5 })?.target_price).toBeUndefined();
    expect(
      validateInquiryInterpretation({ ...base, target_price: "100" })?.target_price,
    ).toBeUndefined();
  });
});

describe("reception active 边界（公开折扣边界内自动，越界转审批）", () => {
  let dir: string;
  let store: ReceptionConversationStore;
  let outbox: ReceptionReplyOutbox;
  let approvals: NegotiationApprovalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-reception-active-"));
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

  const engineFor = (interpreter?: InquiryInterpreter) =>
    createMerchantReceptionEngine({
      store,
      outbox,
      ...(interpreter !== undefined ? { interpreter } : {}),
      productSource: {
        async getProduct(sku: string) {
          if (sku !== SKU) throw new Error(`unknown sku ${sku}`);
          return { price: 110, currency: "CNY", stock: 50 };
        },
      },
      policy: () => policy as never,
      approvals,
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

  it("目标价在公开边界内：正常回答，不创建审批", async () => {
    const engine = engineFor(
      interpreterFor({
        intent: "quote_request",
        topics: ["price"],
        sku: SKU,
        quantity: 2,
        target_price: 105,
        language: "zh",
      }),
    );
    const result = await engine.respond(input("105 一件卖吗"));
    expect(result.text).toContain("当前公开标价 110.00 CNY");
    expect(result.text).not.toContain("商家确认");
    expect(approvals.list("pending")).toHaveLength(0);
  });

  it("目标价低于公开边界：创建审批候选，回复不含边界与底价", async () => {
    const engine = engineFor(
      interpreterFor({
        intent: "quote_request",
        topics: ["price"],
        sku: SKU,
        quantity: 2,
        target_price: 98,
        language: "zh",
      }),
    );
    const result = await engine.respond(input("98 一件行不行"));
    expect(result.text).toContain("需要商家确认");
    expect(result.text).toContain("尚未批准");
    expect(result.text).not.toContain("104.5");
    expect(result.text).not.toContain("100");
    const pending = approvals.list("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      negotiation_id: "ctx_1",
      sku: SKU,
      currency: "CNY",
      quantity: 2,
      buyer_offer_minor: 9_800,
      public_bound_minor: 10_450,
      floor_minor: 10_000,
    });
    // D08：审批等待 15 分钟（服务端权威时间，创建时固化）。
    expect(pending[0]?.expires_at).toBe("2026-11-03T04:15:00.000Z");
  });

  it("无目标价：不创建审批", async () => {
    const engine = engineFor(
      interpreterFor({ intent: "product_question", topics: ["stock"], sku: SKU, language: "zh" }),
    );
    await engine.respond(input("有货吗"));
    expect(approvals.list("pending")).toHaveLength(0);
  });

  it("商家批准后买家下一轮消费批准价，且只生效一次", async () => {
    const engine = engineFor(
      interpreterFor({
        intent: "quote_request",
        topics: ["price"],
        sku: SKU,
        quantity: 2,
        target_price: 98,
        language: "zh",
      }),
    );
    await engine.respond(input("98 一件行不行"));
    const pending = approvals.list("pending");
    expect(pending).toHaveLength(1);
    approvals.approve({ approval_id: pending[0]!.approval_id, approved_minor: 10_000 });

    const second = await engine.respond(input("刚才的价格可以吗"));
    expect(second.text).toContain("商家确认价 100.00 CNY（仅本次）");
    expect(second.text).not.toContain("尚未批准");
    expect(approvals.list("approved")).toHaveLength(0);
    expect(approvals.list("consumed")).toHaveLength(1);

    // 一次性授权：再问一次不会继续给批准价，而是重新进入待确认。
    const third = await engine.respond(input("再确认一次"));
    expect(third.text).toContain("尚未批准");
    expect(third.text).not.toContain("商家确认价");
  });

  it("买家改数量后旧批准失效，不被消费", async () => {
    let interpretation = {
      intent: "quote_request" as const,
      topics: ["price" as const],
      sku: SKU,
      quantity: 2,
      target_price: 98,
      language: "zh" as const,
    };
    const engine = engineFor({
      async interpret() {
        return interpretation;
      },
    });
    await engine.respond(input("98 两件行不行"));
    const pending = approvals.list("pending");
    approvals.approve({ approval_id: pending[0]!.approval_id, approved_minor: 10_000 });
    expect(approvals.list("approved")).toHaveLength(1);

    interpretation = { ...interpretation, quantity: 5 };
    const second = await engine.respond(input("改成五件"));
    expect(second.text).not.toContain("商家确认价");
    expect(approvals.list("approved")).toHaveLength(0);
    const next = approvals.list("pending");
    expect(next).toHaveLength(1);
    expect(next[0]?.quantity).toBe(5);
  });

  it("批准后底价上调：旧批准不再消费", async () => {
    let policyNow = {
      price_floors: { [SKU]: 100 },
      max_auto_discount_percent: 5,
      delivery_lead_days: 7,
    };
    const engine = createMerchantReceptionEngine({
      store,
      outbox,
      interpreter: interpreterFor({
        intent: "quote_request",
        topics: ["price"],
        sku: SKU,
        quantity: 2,
        target_price: 98,
        language: "zh",
      }),
      productSource: {
        async getProduct() {
          return { price: 110, currency: "CNY", stock: 50 };
        },
      },
      policy: () => policyNow as never,
      approvals,
      now: () => NOW,
    });
    await engine.respond(input("98 两件行不行"));
    const pending = approvals.list("pending");
    approvals.approve({ approval_id: pending[0]!.approval_id, approved_minor: 10_000 });
    expect(approvals.list("approved")).toHaveLength(1);

    policyNow = { ...policyNow, price_floors: { [SKU]: 105 } };
    const second = await engine.respond(input("还是要两件"));
    expect(second.text).not.toContain("商家确认价");
    expect(approvals.list("approved")).toHaveLength(0);
  });

  it("审批 pending 到期后 approve 失败并置 expired（超时只失效）", async () => {
    let now = NOW;
    const expiring = new NegotiationApprovalStore(dir, () => now);
    const record = expiring.recordPending({
      negotiation_id: "neg_1",
      sku: SKU,
      currency: "CNY",
      quantity: 1,
      buyer_offer_minor: 9_800,
      ttl_seconds: 900,
    });
    expect(record.expires_at).toBe("2026-11-03T04:15:00.000Z");
    now = "2026-11-03T04:16:00.000Z";
    expect(() =>
      expiring.approve({ approval_id: record.approval_id, approved_minor: 9_800 }),
    ).toThrow(/expired/);
    const listed = expiring.list();
    expect(listed.find((item) => item.approval_id === record.approval_id)?.status).toBe("expired");
  });

  it("回复按会话严格递增 reply_seq，outbox 持久化", async () => {
    const engine = engineFor(
      interpreterFor({ intent: "product_question", topics: ["stock"], sku: SKU, language: "zh" }),
    );
    const first = await engine.respond(input("有货吗"));
    const second = await engine.respond(input("有货吗"));
    expect(first.reply.reply_seq).toBe(1);
    expect(second.reply.reply_seq).toBe(2);
    expect(second.reply.response_id).not.toBe(first.reply.response_id);

    const records = outbox.list("merchant-1", "buyer:1", "ctx_1");
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.reply_seq)).toEqual([1, 2]);
    expect(records.every((record) => record.status === "dispatched")).toBe(true);
    expect(records.every((record) => record.dispatch_class === "automatic")).toBe(true);

    // 持久化：重开文件后记录仍在。
    const reopened = new ReceptionReplyOutbox({
      file: join(dir, "reply-outbox.json"),
      now: () => NOW,
    });
    expect(reopened.list("merchant-1", "buyer:1", "ctx_1")).toHaveLength(2);
  });

  it("不同买家的 reply_seq 各自独立", async () => {
    const engine = engineFor(
      interpreterFor({ intent: "product_question", topics: ["stock"], sku: SKU, language: "zh" }),
    );
    await engine.respond(input("有货吗", "buyer:1"));
    const other = await engine.respond(input("有货吗", "buyer:2"));
    expect(other.reply.reply_seq).toBe(1);
    expect(outbox.list("merchant-1", "buyer:2", "ctx_1")).toHaveLength(1);
  });
});
