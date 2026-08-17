// DeepSeek Harness 运行时插件测试（merchant ReasoningBackend，§6.9）
//
// 覆盖：
//  - MockDecisionBackend 产 schema-valid 决策；
//  - DeepSeekDecisionBackend 请求形状（URL/认证/body）与 fail-safes（非 JSON /
//    schema 不合法 / HTTP 500 / fetch reject / apiKey resolver throw → null）；
//  - sanitizeDecision：多余键剥除、围栏 JSON 解析、role bounds；
//  - createMerchantHandler 硬边界：floor / list 封顶 / max auto discount /
//    backend throw → 确定性基线 / 无 policy 只钳 [0, list]；
//  - 0 写断言：DeepSeek fetchImpl 只命中模型端点。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import type { NegotiationHandler, NegotiationHandlerResult } from "../src/a2a/server/types.js";
import type { MerchantPolicy } from "../src/config/profile.js";
import {
  DeepSeekDecisionBackend,
  MockDecisionBackend,
  extractJson,
  sanitizeDecision,
  type MerchantDecisionBackend,
} from "../src/merchant/decision-backend.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { PROTOCOL_VERSION, type NegotiationDecision } from "../src/negotiation/types.js";

const NOW = "2026-08-17T08:00:00Z";
const NEGOTIATION_ID = "neg_decision_001";
const CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";

/** 构造 schema-valid merchant 决策（unit_price 可注入，major 元）。 */
function validDecision(unitPriceMajor: number, action: "propose" | "counter" = "propose"): NegotiationDecision {
  return {
    protocol_version: PROTOCOL_VERSION,
    conversation_id: "conv-dsh-1",
    in_reply_to_message_id: 1,
    action,
    open_issues: [],
    public_message: "按报价提供。",
    reason_codes: ["within_policy"],
    request_human_review: false,
    confidence: 0.8,
    proposal: {
      sku: "SKU-001",
      quantity: 200,
      unit_price: unitPriceMajor,
      currency: "CNY",
      stock: { status: "available", quantity: 200, observed_at: NOW, reserved: false },
      delivery: { eta_start: NOW, eta_end: NOW, fee: 8 },
      after_sales_policy_refs: [],
      valid_until: "2099-12-31T23:59:59Z",
    },
  };
}

/** 可控建议价的后端（或抛错）。 */
function suggestionBackend(
  unitPriceMajor: number | undefined,
  opts: { throwOnSuggest?: boolean } = {},
): MerchantDecisionBackend {
  return {
    async suggest(input) {
      if (opts.throwOnSuggest) throw new Error("backend boom");
      return validDecision(unitPriceMajor ?? input.product.priceMinor / 100, input.action);
    },
  };
}

async function setupHandler(options: {
  productPrice?: number;
  merchantPolicy?: MerchantPolicy;
  decisionBackend?: MerchantDecisionBackend;
}): Promise<{ handler: NegotiationHandler; stop: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-dsh-"));
  const ledger = new LedgerStore({ dir, now: () => NOW });
  const handler = createMerchantHandler({
    ledger,
    now: () => NOW,
    sender: "merchant:merchant-001",
    counterparty: "buyer:*",
    productSource: {
      getProduct: async () => ({
        price: options.productPrice ?? 850, // major：850 元 → 85000 minor
        currency: "CNY",
        stock: 200,
      }),
    },
    ...(options.merchantPolicy !== undefined ? { merchantPolicy: options.merchantPolicy } : {}),
    ...(options.decisionBackend !== undefined ? { decisionBackend: options.decisionBackend } : {}),
  });
  return { handler, stop: () => rmSync(dir, { recursive: true, force: true }) };
}

let seq = 0;
function envelopeFor(action: string, payload: Record<string, unknown>): NegotiationEnvelope {
  seq += 1;
  return finalizeEnvelope({
    capability: CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: NEGOTIATION_ID,
    exchange_id: `ex_dsh_${seq}`,
    message_id: `msg_dsh_${seq}`,
    in_reply_to: `msg_dsh_${seq - 1}`,
    actor: "buyer",
    action: action as NegotiationEnvelope["action"],
    created_at: NOW,
    payload: payload as never,
  });
}

async function run(
  handler: NegotiationHandler,
  envelope: NegotiationEnvelope,
): Promise<NegotiationHandlerResult> {
  return handler.handle({
    envelope: envelope as never,
    message: { role: "user", parts: [], messageId: envelope.message_id },
    taskId: `task_dsh_${seq}`,
    senderIdentity: "buyer:buyer-001",
  });
}

/** 从 reply envelope 提取 amount_minor（offer→terms / counter_offer→proposed_terms / conditional→conditions[0].then_terms）。 */
function offerPriceMinor(result: NegotiationHandlerResult): number {
  const reply =
    result.kind === "accepted" && result.message
      ? (result.message.parts[0] as unknown as { data?: { knp_envelope?: { payload?: Record<string, unknown> } } })
          .data?.knp_envelope?.payload
      : undefined;
  expect(reply).toBeTruthy();
  // payload 判别字段是 type（envelope 上才是 action）。
  const type = (reply as { type?: string }).type;
  if (type === "offer") {
    return ((reply as { terms?: { items?: Array<{ unit_price?: { amount_minor?: number } }> } }).terms?.items?.[0]
      ?.unit_price?.amount_minor) as number;
  }
  if (type === "counter_offer") {
    return (
      (reply as { proposed_terms?: { items?: Array<{ unit_price?: { amount_minor?: number } }> } }).proposed_terms
        ?.items?.[0]?.unit_price?.amount_minor as number
    );
  }
  // conditional_offer：conditions[0].then_terms（deal 价）
  return (
    (reply as {
      conditions?: Array<{ then_terms?: { items?: Array<{ unit_price?: { amount_minor?: number } }> } }>;
    }).conditions?.[0]?.then_terms?.items?.[0]?.unit_price?.amount_minor as number
  );
}

describe("MockDecisionBackend", () => {
  it("返回 schema-valid 决策，unit_price = priceMinor/100，action 匹配输入", async () => {
    const backend = new MockDecisionBackend();
    const decision = await backend.suggest({
      action: "propose",
      sku: "SKU-001",
      quantity: 200,
      product: { priceMinor: 85000, currency: "CNY", stock: 200 },
      conversationId: "conv-1",
    });
    expect(decision).not.toBeNull();
    expect(decision?.action).toBe("propose");
    expect(decision?.proposal?.unit_price).toBe(850);
    expect(decision?.proposal?.stock.reserved).toBe(false);
    expect(sanitizeDecision(decision)).not.toBeNull();
  });
});

describe("DeepSeekDecisionBackend", () => {
  it("请求形状：URL/认证/body(model+thinking+response_format+双 message)，返回解析决策", async () => {
    const seen: Array<{ url: string; init?: { headers?: Record<string, string>; body?: unknown } }> = [];
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string>; body?: unknown }): Promise<Response> => {
      seen.push({ url, init: init ?? {} });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(validDecision(170)) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const backend = new DeepSeekDecisionBackend({
      apiKey: "sk-test",
      model: "deepseek-v4-flash",
      fetchImpl,
    });
    const decision = await backend.suggest({
      action: "propose",
      sku: "SKU-001",
      quantity: 200,
      product: { priceMinor: 85000, currency: "CNY", stock: 200 },
      conversationId: "conv-1",
    });
    expect(decision?.proposal?.unit_price).toBe(170);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(req.init?.headers?.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(req.init?.body ?? "")) as {
      model?: string;
      thinking?: { type: string };
      response_format?: { type: string };
      messages?: Array<{ role: string }>;
    };
    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toHaveLength(2);
  });

  it("fail-safes：非 JSON / schema 不合法 / role bound / HTTP 500 / fetch reject / apiKey throw → null", async () => {
    const cases: Array<{ content?: string; status?: number; reject?: boolean }> = [
      { content: "not json at all" },
      { content: JSON.stringify({ ...validDecision(170), action: "accept_nonbinding" }) }, // role bound 外
      { content: JSON.stringify({ ...validDecision(170), proposal: { ...validDecision(170).proposal, stock: { status: "available", quantity: 1, observed_at: NOW, reserved: true } } }) }, // reserved:true 违反 schema
      { status: 500 },
      { reject: true },
    ];
    for (const c of cases) {
      const fetchImpl = (async (): Promise<Response> => {
        if (c.reject === true) throw new Error("network down");
        return new Response(c.content !== undefined ? c.content : "", {
          status: c.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
      const backend = new DeepSeekDecisionBackend({ apiKey: "sk-test", fetchImpl });
      const decision = await backend.suggest({
        action: "propose",
        sku: "SKU-001",
        quantity: 200,
        product: { priceMinor: 85000, currency: "CNY" },
        conversationId: "conv-1",
      });
      expect(decision).toBeNull();
    }

    // apiKey resolver throw
    const throwKey = new DeepSeekDecisionBackend({ apiKey: () => { throw new Error("no key"); } });
    expect(
      await throwKey.suggest({ action: "propose", sku: "s", quantity: 1, product: { priceMinor: 100, currency: "CNY" }, conversationId: "c" }),
    ).toBeNull();
  });

  it("0 写断言：fetchImpl 只被调用模型端点", async () => {
    const touched: string[] = [];
    const fetchImpl = (async (url: string): Promise<Response> => {
      touched.push(String(url));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(validDecision(170)) } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const backend = new DeepSeekDecisionBackend({ apiKey: "sk-test", fetchImpl });
    await backend.suggest({ action: "propose", sku: "s", quantity: 1, product: { priceMinor: 100, currency: "CNY" }, conversationId: "c" });
    expect(touched.length).toBeGreaterThan(0);
    for (const url of touched) {
      expect(url).toContain("/v1/chat/completions");
    }
  });
});

describe("sanitizeDecision", () => {
  it("剥除多余键（模型加 thinking/注释）仍被接受；围栏 JSON 可解析", () => {
    const raw = {
      ...validDecision(170),
      thinking: "extra",
      proposal: { ...validDecision(170).proposal, notes: "leak" },
    };
    expect(sanitizeDecision(raw)).not.toBeNull();
    expect(extractJson('```json\n{"protocol_version":"shopping.negotiation/0.1"}\n```')).toEqual({
      protocol_version: "shopping.negotiation/0.1",
    });
  });

  it("role bound：非 propose/counter 的 merchant 候选被拒", () => {
    expect(sanitizeDecision(validDecision(170, "propose"))).not.toBeNull();
    expect(sanitizeDecision({ ...validDecision(170), action: "decline" })).toBeNull();
    expect(sanitizeDecision({ ...validDecision(170), proposal: undefined })).toBeNull();
  });
});

describe("createMerchantHandler 硬边界（DeepSeek Harness 运行时插件）", () => {
  it("rfq→offer：backend 建议低于 floor → 钳到 floor（80.00 → 8000 minor）", async () => {
    const { handler, stop } = await setupHandler({
      merchantPolicy: { min_unit_price_private: 80 },
      decisionBackend: suggestionBackend(50), // 50 元 → 5000 minor，低于 floor 8000
    });
    try {
      const res = await run(handler, envelopeFor("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
      expect(offerPriceMinor(res)).toBe(8000);
    } finally {
      stop();
    }
  });

  it("rfq→offer：backend 建议高于 list → 封顶 list（85000 minor）", async () => {
    const { handler, stop } = await setupHandler({
      merchantPolicy: { min_unit_price_private: 80 },
      decisionBackend: suggestionBackend(900), // 900 元 > list 850 元
    });
    try {
      const res = await run(handler, envelopeFor("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
      expect(offerPriceMinor(res)).toBe(85000);
    } finally {
      stop();
    }
  });

  it("counter_offer→conditional：建议过低 → then_terms = max(floor, applyDiscount(base, maxAutoDiscount))", async () => {
    const { handler, stop } = await setupHandler({
      merchantPolicy: { min_unit_price_private: 80, max_auto_discount_percent: 10 },
      decisionBackend: suggestionBackend(50),
    });
    try {
      await run(handler, envelopeFor("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
      const res = await run(handler, envelopeFor("counter_offer", { offer_id: "off_b", proposed_terms: {} }));
      // base 85000，10% 折扣 → 76500；floor 8000；建议 5000 → max(8000, 76500)=76500
      expect(offerPriceMinor(res)).toBe(76500);
    } finally {
      stop();
    }
  });

  it("backend throw → 确定性基线（offer=list，conditional=5% 折扣）", async () => {
    const { handler, stop } = await setupHandler({
      merchantPolicy: { min_unit_price_private: 80 },
      decisionBackend: suggestionBackend(50, { throwOnSuggest: true }),
    });
    try {
      const offer = await run(handler, envelopeFor("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
      expect(offerPriceMinor(offer)).toBe(85000); // 基线 = list
      await run(handler, envelopeFor("offer", { offer_id: "off_b", terms: {} }));
      const cond = await run(handler, envelopeFor("counter_offer", { offer_id: "off_c", proposed_terms: {} }));
      // 确定性 deal = applyDiscountPercentMinor(85000, 5) = floor((85000*95+50)/100) = 80750
      expect(offerPriceMinor(cond)).toBe(80750);
    } finally {
      stop();
    }
  });

  it("有 backend 无 policy → 只钳 [0, list]（floor 0）", async () => {
    const { handler, stop } = await setupHandler({ decisionBackend: suggestionBackend(50) });
    try {
      const res = await run(handler, envelopeFor("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
      expect(offerPriceMinor(res)).toBe(5000);
    } finally {
      stop();
    }
  });

  it("无 backend → 今日确定性行为（offer = list）", async () => {
    const { handler, stop } = await setupHandler({ merchantPolicy: { min_unit_price_private: 80 } });
    try {
      const res = await run(handler, envelopeFor("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
      expect(offerPriceMinor(res)).toBe(85000);
    } finally {
      stop();
    }
  });

  it("per-SKU floor：price_floors 覆盖全局默认", async () => {
    // 全局 floor 0，但 SKU-001 的 per-SKU floor 80 → 建议 50 元被钳到 8000 minor。
    const { handler, stop } = await setupHandler({
      merchantPolicy: { min_unit_price_private: 0, price_floors: { "SKU-001": 80 } },
      decisionBackend: suggestionBackend(50),
    });
    try {
      const res = await run(handler, envelopeFor("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
      expect(offerPriceMinor(res)).toBe(8000);
    } finally {
      stop();
    }
  });

  it("per-SKU 折扣：sku_max_discount_percent 生效（覆盖全局默认）", async () => {
    // 全局默认 0（不允许折扣），SKU-001 per-SKU 10% → deal 可到 76500。
    const { handler, stop } = await setupHandler({
      merchantPolicy: { max_auto_discount_percent: 0, sku_max_discount_percent: { "SKU-001": 10 } },
      decisionBackend: suggestionBackend(50),
    });
    try {
      await run(handler, envelopeFor("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200 } }] }));
      const res = await run(handler, envelopeFor("counter_offer", { offer_id: "off_b", proposed_terms: {} }));
      expect(offerPriceMinor(res)).toBe(76500);
    } finally {
      stop();
    }
  });

  it("per-SKU 未列出 → 回落全局默认 floor/discount", async () => {
    // SKU-OTHER 不在 price_floors/sku_max_discount_percent → 用全局 min_unit_price_private。
    const { handler, stop } = await setupHandler({
      merchantPolicy: { min_unit_price_private: 80, price_floors: { "SKU-001": 100 } },
      decisionBackend: suggestionBackend(50),
    });
    try {
      const res = await run(handler, envelopeFor("rfq", { items: [{ sku: "SKU-OTHER", quantity: { value: 200 } }] }));
      expect(offerPriceMinor(res)).toBe(8000); // 全局 floor 80（非 per-SKU 100）
    } finally {
      stop();
    }
  });
});
