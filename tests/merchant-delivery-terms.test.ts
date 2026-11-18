/**
 * Merchant 报价交期测试（V2 §8.5 P0-1）：
 * - 配置 merchant_policy.delivery_lead_days 时，offer/counter/conditional 的
 *   terms 含「报价时间 + 天数」动态计算的 delivery_before（不会过期）；
 * - 未配置时 terms 省略 fulfillment_terms.delivery_before（明确未知），
 *   clarification 应答不含具体日期、提示与商家确认；
 * - 任何路径都不得再出现静态/过期日期（2026-08-20 硬编码已移除）。
 *
 * 确定性：临时 Ledger + 注入时钟。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NegotiationHandler, NegotiationHandlerResult } from "../src/a2a/server/types.js";
import {
  createMerchantHandler,
  resolveDeliveryBefore,
  requestedDeliveryDaysOf,
} from "../src/a2a/server/merchant-handler.js";
import { LedgerStore } from "../src/negotiation/ledger/index.js";
import type { NegotiationEnvelope } from "../src/negotiation/domain/envelope.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";

const NOW = "2026-09-14T10:00:00Z";
const NEGOTIATION_ID = "neg_delivery_p0";
const MERCHANT_CAPABILITY = "com.harrylabsj.kiwi.shopping.negotiation";
/** 硬编码静态交期（已移除）——任何输出都不得再包含它。 */
const REMOVED_STATIC_DATE = "2026-08-20";

let dir: string;
let ledger: LedgerStore;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kiwi-delivery-p0-"));
  ledger = new LedgerStore({ dir, now: () => NOW });
  seq = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeHandler(deliveryLeadDays?: number): NegotiationHandler {
  return createMerchantHandler({
    productSource: { async getProduct() { return { price: 850, currency: "CNY", unit: "piece", stock: 1000, source_evidence: { system: "owned-test-fixture" } }; } },
    ledger,
    now: () => NOW,
    sender: "merchant:merchant-001",
    counterparty: "buyer:*",
    ...(deliveryLeadDays !== undefined
      ? { merchantPolicy: { delivery_lead_days: deliveryLeadDays } }
      : {}),
  });
}

function env(action: string, payload: Record<string, unknown>): NegotiationEnvelope {
  seq += 1;
  return finalizeEnvelope({
    capability: MERCHANT_CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: NEGOTIATION_ID,
    exchange_id: `ex_${seq}`,
    message_id: `msg_${seq}`,
    in_reply_to: `msg_${seq - 1}`,
    actor: "buyer",
    action: action as NegotiationEnvelope["action"],
    created_at: NOW,
    payload: payload as never,
  });
}

const runWith = (
  h: NegotiationHandler,
  envelope: NegotiationEnvelope,
): Promise<NegotiationHandlerResult> =>
  h.handle({
    envelope: envelope as never,
    message: { role: "user", parts: [], messageId: envelope.message_id },
    taskId: `task_${envelope.message_id}`,
    senderIdentity: "buyer:buyer-001",
  });

/** 从 handler 回复提取 knp_envelope。 */
function knpEnvelopeOf(result: NegotiationHandlerResult): Record<string, unknown> {
  const env = (
    result.kind === "accepted" && result.message
      ? (
          result.message.parts[0] as unknown as {
            data?: { knp_envelope?: Record<string, unknown> };
          }
        ).data?.knp_envelope
      : undefined
  ) as Record<string, unknown> | undefined;
  expect(env).toBeDefined();
  return env as Record<string, unknown>;
}

/** rfq → offer，返回 offer terms。 */
async function offerTermsOf(h: NegotiationHandler): Promise<Record<string, unknown>> {
  const result = await runWith(
    h,
    env("rfq", { items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" } }] }),
  );
  const reply = knpEnvelopeOf(result);
  expect(reply.action).toBe("offer");
  const terms = (reply.payload as { terms?: Record<string, unknown> }).terms;
  expect(terms).toBeDefined();
  return terms as Record<string, unknown>;
}

/** rfq（可带买家到货时限）→ 完整 merchant 回复。 */
async function rfqReplyOf(
  h: NegotiationHandler,
  requestedBefore?: string,
): Promise<Record<string, unknown>> {
  const result = await runWith(
    h,
    env("rfq", {
      items: [{ sku: "SKU-001", quantity: { value: 200, unit: "piece" } }],
      ...(requestedBefore !== undefined
        ? { requested_terms: { delivery_before: requestedBefore } }
        : {}),
    }),
  );
  const reply = knpEnvelopeOf(result);
  expect(reply.action).toBe("offer");
  return reply;
}

describe("resolveDeliveryBefore", () => {
  it("配置 lead days → now + 天数；未配置 → undefined", () => {
    expect(resolveDeliveryBefore({ delivery_lead_days: 7 }, NOW)).toBe(
      new Date(Date.parse(NOW) + 7 * 86_400_000).toISOString(),
    );
    expect(resolveDeliveryBefore({}, NOW)).toBeUndefined();
    expect(resolveDeliveryBefore(undefined, NOW)).toBeUndefined();
  });
});

describe("merchant 报价交期（P0-1）", () => {
  it("配置 delivery_lead_days：offer terms 含 now+lead 的动态交期", async () => {
    const terms = await offerTermsOf(makeHandler(7));
    expect(terms.fulfillment_terms).toEqual({
      delivery_before: new Date(Date.parse(NOW) + 7 * 86_400_000).toISOString(),
    });
  });

  it("未配置 delivery_lead_days：terms 省略 delivery_before（不报静态/过期日期）", async () => {
    const terms = await offerTermsOf(makeHandler());
    expect(terms.fulfillment_terms).toBeUndefined();
    expect(JSON.stringify(terms)).not.toContain("delivery_before");
    expect(JSON.stringify(terms)).not.toContain(REMOVED_STATIC_DATE);
  });

  it("clarification 应答：配置 lead days 时报动态日期", async () => {
    const h = makeHandler(10);
    await offerTermsOf(h); // OFFER_OPEN
    const result = await runWith(
      h,
      env("clarification", { questions: [{ field: "delivery_before" }] }),
    );
    const reply = knpEnvelopeOf(result);
    expect(reply.action).toBe("clarification_response");
    const expected = new Date(Date.parse(NOW) + 10 * 86_400_000).toISOString();
    expect(String(reply.public_message)).toContain(expected.slice(0, 10));
    expect(JSON.stringify(reply)).not.toContain(REMOVED_STATIC_DATE);
  });

  it("clarification 应答：未配置时提示与商家确认，不含硬编码日期", async () => {
    const h = makeHandler();
    await offerTermsOf(h); // OFFER_OPEN
    const result = await runWith(
      h,
      env("clarification", { questions: [{ field: "delivery_before" }] }),
    );
    const reply = knpEnvelopeOf(result);
    expect(reply.action).toBe("clarification_response");
    expect(String(reply.public_message)).toContain("尚未配置可承诺的交期");
    expect(JSON.stringify(reply)).not.toContain("delivery before 20");
    expect(JSON.stringify(reply)).not.toContain(REMOVED_STATIC_DATE);
  });

  it("RFQ 带 7 天到货时限但未配置交期：明确回答无法确认，不只回价格", async () => {
    const h = makeHandler();
    const reply = await rfqReplyOf(h, "2026-09-21T10:00:00Z");
    expect(reply.public_message).toContain("2026-09-21");
    expect(reply.public_message).toContain("尚未配置");
    expect(reply.public_message).toContain("无法确认");
    const terms = (reply.payload as { terms?: Record<string, unknown> }).terms;
    expect(JSON.stringify(terms)).not.toContain("delivery_before");
  });

  it("RFQ 时限早于已配置交期：回答无法承诺", async () => {
    const h = makeHandler(10);
    const reply = await rfqReplyOf(h, "2026-09-18T10:00:00Z");
    expect(reply.public_message).toContain("无法承诺");
  });

  it("RFQ 时限晚于已配置交期：回答可以满足", async () => {
    const h = makeHandler(10);
    const reply = await rfqReplyOf(h, "2026-09-30T10:00:00Z");
    expect(reply.public_message).toContain("可以满足");
  });

  it("自然语言绝对日期不会误作相对期限，明确相对期限仍可识别", () => {
    for (const text of ["11月18日到货", "十一月二十日送达", "18日前到货", "18日到货", "2026-11-18 到货", "11月18日前，7天内送达"]) {
      expect(requestedDeliveryDaysOf(text)).toBeUndefined();
    }
    expect(requestedDeliveryDaysOf("7天到中国")).toBe(7);
    expect(requestedDeliveryDaysOf("七个工作日送达")).toBe(7);
    expect(requestedDeliveryDaysOf("18日以内送达")).toBe(18);
  });

  it("clarification 绝对日期不误报能够满足", async () => {
    const h = makeHandler(10);
    await offerTermsOf(h);
    const result = await runWith(h, env("clarification", {
      questions: [{ field: "general", reason: "能否9月18日到货？" }],
    }));
    const message = String(knpEnvelopeOf(result).public_message);
    expect(message).not.toContain("18 天");
    expect(message).not.toContain("可以满足");
    expect(message).toContain("2026-09-24");
  });

  it("clarification 的 general 问题带“7天到中国”时仍按交期作答", async () => {
    const h = makeHandler();
    await offerTermsOf(h); // OFFER_OPEN
    const result = await runWith(
      h,
      env("clarification", {
        questions: [{ field: "general", reason: "能不能7天到中国" }],
      }),
    );
    const reply = knpEnvelopeOf(result);
    expect(reply.action).toBe("clarification_response");
    const message = String(reply.public_message);
    expect(message).toContain("7 天");
    expect(message).toContain("无法确认");
    expect(message).toContain("。");
  });
});
