/**
 * shopping-cli 私有订单/成本读取客户端（v0.2 §17.2）。
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShoppingCliOrderSource } from "../src/merchant-core/orders/shopping-cli-source.js";
import { OrderFactError } from "../src/merchant-core/orders/model.js";

interface Captured {
  method: string;
  url: string;
  authorization: string;
  body?: Record<string, unknown>;
}

let server: Server;
let base = "";
let captured: Captured[] = [];

beforeEach(async () => {
  captured = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw === "" ? undefined : (JSON.parse(raw) as Record<string, unknown>);
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: String(req.headers.authorization ?? ""),
        ...(body !== undefined ? { body } : {}),
      });
      res.setHeader("content-type", "application/json");
      if (req.url?.includes("/missing")) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "not_found", message: "order not found" } }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, items: [], total: 0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("address");
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function source() {
  return new ShoppingCliOrderSource({
    baseUrl: base,
    merchantId: "merchant-1",
    token: "token-1",
    timeoutMs: 2_000,
  });
}

describe("ShoppingCliOrderSource", () => {
  it("列表/详情带 Bearer 与 merchant_id，不把商家写进路径以外的地方", async () => {
    await source().listOrders({ limit: 10, offset: 20 });
    expect(captured[0]?.method).toBe("GET");
    expect(captured[0]?.authorization).toBe("Bearer token-1");
    expect(captured[0]?.url).toContain("/v1/merchant/orders?");
    expect(captured[0]?.url).toContain("merchant_id=merchant-1");
    expect(captured[0]?.url).toContain("limit=10");
    expect(captured[0]?.url).toContain("offset=20");

    await source().getOrder("order-1");
    expect(captured[1]?.url).toContain("/v1/merchant/orders/order-1");
    expect(captured[1]?.url).toContain("merchant_id=merchant-1");
  });

  it("退款/成本/来源契约写入时注入商家身份", async () => {
    const client = source();
    await client.recordRefund("order-1", { external_refund_id: "r1", amount_minor: 200, version: 1 });
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.body).toMatchObject({ merchant_id: "merchant-1", external_refund_id: "r1" });

    await client.saveCostSnapshot({
      ref_kind: "order",
      ref_id: "order-1",
      currency: "CNY",
      completeness: "COMPLETE",
      costs: { goods_cost_minor: 600 },
      missing_items: [],
      version: 1,
    });
    expect(captured[1]?.body?.["merchant_id"]).toBe("merchant-1");

    await client.registerSourceContract({
      source_namespace: "jd",
      source_account_id: "acc-1",
      ordering: "monotonic",
      version_scope: "payment",
      event_id_scope: "order",
      supports_watermark: true,
    });
    expect(captured[2]?.body?.["merchant_id"]).toBe("merchant-1");
  });

  it("非 2xx 映射为带 code 的失败，不伪装成空结果", async () => {
    await expect(source().getOrder("missing")).rejects.toMatchObject({
      name: "OrderFactError",
      code: "validation",
      message: expect.stringContaining("not_found"),
    });
    expect(base.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("配置校验：缺 token/非法 baseUrl 直接拒绝", () => {
    expect(
      () =>
        new ShoppingCliOrderSource({
          baseUrl: base,
          merchantId: "merchant-1",
          token: " ",
        }),
    ).toThrowError(OrderFactError);
    expect(
      () =>
        new ShoppingCliOrderSource({
          baseUrl: "ftp://example.com",
          merchantId: "merchant-1",
          token: "t",
        }),
    ).toThrowError(OrderFactError);
  });
});
