/**
 * negotiateWithAgent 参数化测试（买家侧本地 A2A 磋商）：
 * sku / quantity / dealPriceMinor（买方还价）/ deliveryBefore / senderIdentity
 * 必须穿入 RFQ / CounterOffer 信封；缺省值保持原有常量（/negotiate 回归）。
 *
 * 完全离线：生产版 merchant handler + 临时 A2AServer + catalog stub，
 * 零 marketplace。商家侧接 productSource 桩（按 SKU 从"商品库"报价——
 * 折扣/底价等真实数据在商家侧）。capture 包装记录入站信封供断言。
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  NEGOTIATE_DEAL_PRICE_MINOR,
  NEGOTIATE_DELIVERY_BEFORE,
  NEGOTIATE_QUANTITY,
  NEGOTIATE_SKU,
  negotiateWithAgent,
} from "../src/a2a/negotiate.js";
import {
  startTestA2aStack,
  type CapturedInbound,
} from "./helpers.js";

const stacks: Awaited<ReturnType<typeof startTestA2aStack>>[] = [];

afterAll(async () => {
  for (const s of stacks) await s.stop().catch(() => undefined);
});

/** 商家从"商品库"按 SKU 报价（产品源桩）。 */
const productSource = {
  async getProduct(sku: string) {
    const prices: Record<string, { price: number; currency: string }> = {
      "sku-001": { price: 99, currency: "CNY" },
      "sku-007": { price: 120, currency: "CNY" },
    };
    const p = prices[sku];
    if (p === undefined) throw new Error(`no product ${sku}`);
    return p;
  },
};

async function stack(capture?: CapturedInbound[]) {
  const s = await startTestA2aStack({ productSource, ...(capture !== undefined ? { capture } : {}) });
  stacks.push(s);
  return s;
}

/** 从捕获的入站信封里取第一个指定 action。 */
function inbound(capture: CapturedInbound[], action: string): CapturedInbound {
  const hit = capture.find((c) => c.action === action);
  if (hit === undefined) throw new Error(`no captured ${action} envelope`);
  return hit;
}

describe("negotiateWithAgent parameterization", () => {
  it("custom sku/quantity/deliveryBefore reach the merchant's RFQ", async () => {
    const capture: CapturedInbound[] = [];
    const s = await stack(capture);
    const result = await negotiateWithAgent({
      catalog: s.catalogUrl,
      sku: "sku-007",
      quantity: 3,
      deliveryBefore: "2026-09-01T00:00:00Z",
      senderIdentity: "buyer-agent:buyer-001",
    });
    expect(result.ok).toBe(true);
    expect(result.facts?.sku).toBe("sku-007");
    expect(result.facts?.quantity).toBe(3);
    expect(result.facts?.deliveryBefore).toBe("2026-09-01T00:00:00Z");
    // 商家按商品库报价：sku-007 → 120 元 → offer 12000 minor。
    expect(result.facts?.offerPriceMinor).toBe(12_000);

    const rfq = inbound(capture, "rfq");
    const items = (rfq.envelope.payload as { items?: Array<{ sku?: string; quantity?: { value?: number } }> })
      .items;
    expect(items?.[0]?.sku).toBe("sku-007");
    expect(items?.[0]?.quantity?.value).toBe(3);
    const requested = (rfq.envelope.payload as { requested_terms?: { delivery_before?: string } })
      .requested_terms;
    expect(requested?.delivery_before).toBe("2026-09-01T00:00:00Z");
    // 发送方身份经 channel.open 透传（server 的 ctx.senderIdentity 是环回认证身份，
    // 不携带 envelope 身份——该路径由 channel 契约测试覆盖，此处不重复断言）。
  });

  it("the buyer counter price flows into the counter_offer envelope", async () => {
    const capture: CapturedInbound[] = [];
    const s = await stack(capture);
    const result = await negotiateWithAgent({
      catalog: s.catalogUrl,
      sku: "sku-007",
      quantity: 3,
      dealPriceMinor: 9_000, // 90.00 元
      senderIdentity: "buyer-agent:buyer-001",
    });
    expect(result.ok).toBe(true);
    const counter = inbound(capture, "counter_offer");
    const terms = (
      counter.envelope.payload as {
        proposed_terms?: { items?: Array<{ unit_price?: { amount_minor?: number } }> };
      }
    ).proposed_terms?.items?.[0]?.unit_price;
    expect(terms?.amount_minor).toBe(9_000);
  });

  it("defaults keep the /negotiate constants (regression)", async () => {
    const s = await stack();
    const result = await negotiateWithAgent({ catalog: s.catalogUrl });
    expect(result.ok).toBe(true);
    expect(result.facts?.sku).toBe(NEGOTIATE_SKU);
    expect(result.facts?.quantity).toBe(NEGOTIATE_QUANTITY);
    expect(result.facts?.deliveryBefore).toBe(NEGOTIATE_DELIVERY_BEFORE);
    expect(NEGOTIATE_DEAL_PRICE_MINOR).toBe(83_500);
  });

  it("specifying an unknown catalogAgentId returns ok:false without throwing", async () => {
    const s = await stack();
    const result = await negotiateWithAgent({
      catalog: s.catalogUrl,
      catalogAgentId: "cagt_missing",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("找不到");
  });
});
