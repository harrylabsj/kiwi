/**
 * Merchant Ops API 测试（战略 v2.5 §7.6 / §7.7）。
 *
 * 验证商家运营面（RFQ 队列 / human_required / analytics）经 merchant token
 * 作用域访问；命名空间与 buyer 分离（§7.7）。
 */
import { describe, expect, it } from "vitest";
import { MerchantOpsService } from "../src/merchant/ops.js";

describe("MerchantOpsService（§7.6 / §7.7）", () => {
  function makeService() {
    const stubFetch = (async (input: string, init?: { method?: string; headers?: Record<string, string> }): Promise<Response> => {
      const url = String(input);
      // 断言请求带 merchant bearer（命名空间隔离）。
      const auth = init?.headers?.authorization;
      expect(auth).toBe("Bearer merchant-secret-token");
      if (url.includes("/human-review")) {
        return new Response(JSON.stringify({ ok: true, merchant_id: "m1", conversations: [{ id: "CONV-H1", buyer_id: "b1", status: "human_required", reason: "below_floor" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/resolve")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify([{ id: "CONV-1", buyer_id: "b1", sku: "SKU-1", status: "waiting_merchant", next_actor: "merchant_agent", created_at: "2026-08-16T00:00:00Z", updated_at: "2026-08-16T00:00:00Z", last_sender: "buyer" }]), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return new MerchantOpsService({ baseUrl: "http://127.0.0.1:8765", merchantToken: "merchant-secret-token", fetchImpl: stubFetch });
  }

  it("RFQ 队列", async () => {
    const ops = makeService();
    const { rfqs } = await ops.listRfqQueue("merchant-hz-xihu");
    expect(rfqs).toHaveLength(1);
    expect(rfqs[0]?.id).toBe("CONV-1");
    expect(rfqs[0]?.status).toBe("waiting_merchant");
  });

  it("human_required + analytics", async () => {
    const ops = makeService();
    const { conversations } = await ops.listHumanReview("merchant-hz-xihu");
    expect(conversations[0]?.reason).toBe("below_floor");
    const analytics = await ops.analytics("merchant-hz-xihu");
    expect(analytics.total_rfqs).toBe(1);
    expect(analytics.pending_rfqs).toBe(1);
    expect(analytics.human_review_count).toBe(1);
  });

  it("resolve review 提交商家决定", async () => {
    const ops = makeService();
    const result = await ops.resolveReview("merchant-hz-xihu", "CONV-H1", "approve");
    expect(result.ok).toBe(true);
  });
});
