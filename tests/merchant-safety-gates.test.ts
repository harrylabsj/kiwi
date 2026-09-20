/**
 * T046（商品源过期/失联）+ T048（超范围交易）——M2 业务安全门。
 *
 * T046：设计 §10.1「数据到期后停止相关自动报价或注明需人工确认，不把库存未知
 *       说成有货」；商品源失联 → 明确不可报价；**无演示价回退**。
 * T048：设计 §2.2 / §10.2「买方要求创建订单、付款、锁库存 → 本项目范围内不执行」。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NegotiationHandler, NegotiationHandlerResult } from "../src/a2a/server/types.js";
import { createMerchantHandler } from "../src/a2a/server/merchant-handler.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import { finalizeEnvelope, type NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import type { MerchantPolicy } from "../src/config/profile.js";

const NOW = "2026-09-21T03:00:00Z";
const CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";
const dirs: string[] = [];
let seq = 0;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envelopeFor(action: string, payload: Record<string, unknown>, negotiationId = "neg_gate_001"): NegotiationEnvelope {
  seq += 1;
  return finalizeEnvelope({
    capability: CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: negotiationId,
    exchange_id: `ex_gate_${seq}`,
    message_id: `msg_gate_${seq}`,
    actor: "buyer",
    action,
    created_at: NOW,
    payload: { type: action, ...payload },
  } as never);
}

async function run(handler: NegotiationHandler, envelope: NegotiationEnvelope): Promise<NegotiationHandlerResult> {
  return handler.handle({
    envelope: envelope as never,
    message: { role: "user", parts: [], messageId: envelope.message_id },
    taskId: `task_gate_${seq}`,
    senderIdentity: "buyer:buyer-001",
  });
}

interface ProductFacts {
  price: number;
  currency: string;
  stock?: number;
  valid_until?: string;
}

function setup(options: {
  facts?: ProductFacts;
  fail?: boolean;
  policy?: MerchantPolicy;
  allowDemoPriceFallback?: boolean;
}): NegotiationHandler {
  const dir = mkdtempSync(join(tmpdir(), "kiwi-gate-"));
  dirs.push(dir);
  return createMerchantHandler({
    ledger: new LedgerStore({ dir: join(dir, "ledger"), now: () => NOW }),
    now: () => NOW,
    sender: "merchant:merchant-001",
    counterparty: "buyer:*",
    productSource: {
      getProduct: async () => {
        if (options.fail === true) throw new Error("商品源失联（测试注入）");
        return options.facts ?? { price: 850, currency: "CNY" };
      },
    },
    merchantPolicy: options.policy ?? { max_auto_discount_percent: 10 },
    ...(options.allowDemoPriceFallback === true ? { allowDemoPriceFallback: true } : {}),
  });
}

const rfq = (quantity = 10) => envelopeFor("rfq", { items: [{ sku: "SKU-001", quantity: { value: quantity } }] });

describe("T046：商品数据过期 / 商品源失联 / 库存不足", () => {
  it("数据已过期 → 明确不可报价（temporarily_unavailable），响应里没有任何金额", async () => {
    const handler = setup({
      facts: { price: 850, currency: "CNY", valid_until: "2026-09-20T00:00:00Z" }, // 早于 NOW
    });
    const res = await run(handler, rfq());
    expect(res.kind).toBe("declined");
    expect(res.kind === "declined" && res.reasonCode).toBe("temporarily_unavailable");
    expect(JSON.stringify(res)).not.toMatch(/amount_minor/);
  });

  it("数量超过可得库存 → 不可报价（不把库存未知/不足说成有货）", async () => {
    const handler = setup({ facts: { price: 850, currency: "CNY", stock: 5 } });
    const res = await run(handler, rfq(6));
    expect(res.kind).toBe("declined");
    expect(res.kind === "declined" && res.reasonCode).toBe("temporarily_unavailable");
  });

  it("数量在库存内 → 正常报价（对照组）", async () => {
    const handler = setup({ facts: { price: 850, currency: "CNY", stock: 5, valid_until: "2026-12-31T00:00:00Z" } });
    const res = await run(handler, rfq(5));
    expect(res.kind).toBe("accepted");
    expect(JSON.stringify(res)).toContain('"amount_minor":85000');
  });

  it("商品源失联 → 不可报价；即使显式关闭演示价回退也绝不出现演示价 85000→(demo 价)", async () => {
    const handler = setup({ fail: true });
    const res = await run(handler, rfq());
    expect(res.kind).toBe("declined");
    expect(res.kind === "declined" && res.reasonCode).toBe("temporarily_unavailable");
    expect(JSON.stringify(res)).not.toMatch(/amount_minor/);
  });

  it("开启演示价回退时行为可区分（本地 demo 形态）——但云端配置层会拒绝这种 profile", async () => {
    const handler = setup({ fail: true, allowDemoPriceFallback: true });
    const res = await run(handler, rfq());
    // 演示价回退是**显式配置**的本地形态；响应会带演示价注记，云端不可达此分支
    // （cloud bootstrap 的 assertNoDemoPriceFallback 在启动即拒绝）。
    expect(JSON.stringify(res)).toMatch(/amount_minor/);
  });
});

describe("T048：超范围交易（下单/付款/锁库存）不执行", () => {
  it("KNP 词表内不存在下单/付款/锁库存动作：wire 校验拒绝（schema_invalid），handler 也明确 decline", async () => {
    const handler = setup({});
    const { validateEnvelope } = await import("../src/negotiation/domain/envelope.js");
    for (const action of ["create_order", "authorize_payment", "reserve_inventory"]) {
      const env = envelopeFor(action, {});
      // 1) wire 层：动作不在 KNP 词表内 → 校验直接拒绝（结构上不可能进入磋商）。
      expect(() => validateEnvelope(env as never)).toThrow();
      // 2) 即使绕过 wire 校验直接进 handler（纵深防御），也只有明确的"不支持"拒绝，
      //    不产生任何协议、协议工件或状态推进。
      const res = await run(handler, env);
      expect(res.kind).toBe("declined");
      expect(res.kind === "declined" && res.reasonCode).toBe("unsupported_action");
      expect(JSON.stringify(res)).not.toContain("agreement");
    }
  });

  it("成交后的 agreement 三个副作用 flag 恒为 false（非约束性）", async () => {
    const handler = setup({});
    await run(handler, rfq(200));
    const counter = await run(
      handler,
      envelopeFor("counter_offer", {
        offer_id: "off_buyer",
        proposed_terms: { items: [{ sku: "SKU-001", quantity: { value: 200 }, unit_price: { amount_minor: 84000 } }] },
      }),
    );
    expect(counter.kind).toBe("accepted");
    const counterMessage = counter.kind === "accepted" ? counter.message : undefined;
    const payload = (
      counterMessage?.parts[0] as unknown as { data?: { knp_envelope?: { payload?: Record<string, unknown> } } }
    ).data?.knp_envelope?.payload;
    const { evaluateConditionalOffer } = await import("../src/negotiation/condition/evaluator.js");
    const { contentDigest } = await import("../src/negotiation/jcs.js");
    const agreed = evaluateConditionalOffer(payload as never, { "aggregate.total_quantity": 200 });
    const accepted = await run(
      handler,
      envelopeFor("accept_nonbinding", {
        offer_id: String(payload?.["offer_id"] ?? ""),
        terms_digest: contentDigest(agreed as never),
      }),
    );
    const serialized = JSON.stringify(accepted);
    expect(serialized).toContain('"creates_order":false');
    expect(serialized).toContain('"reserves_inventory":false');
    expect(serialized).toContain('"authorizes_payment":false');
    expect(serialized).toContain('"binding_effect":"nonbinding"');
  });
});
