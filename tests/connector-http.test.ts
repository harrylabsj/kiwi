/**
 * ShoppingCliConnector 生产 HTTP 通信层集成测试（评审项 H8：此前该层零覆盖
 * ——所有 agent 集成测试用 FakeCommerceConnector 内存替身，HTTP 线格式
 * （路径/查询参数/认证头/错误映射）无任何回归保护，shopping-cli API 形状
 * 漂移时套件全绿但生产链路断开）。
 *
 * 用真实 node:http server（127.0.0.1 随机端口）模拟 shopping-cli gateway，
 * 逐字节断言请求形状与响应解析。
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ShoppingCliConnector } from "../src/agent/connector/http-connector.js";

interface MockGateway {
  server: http.Server;
  url: string;
  requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: string }>;
}

const servers: http.Server[] = [];

function startGateway(handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<MockGateway> {
  const requests: MockGateway["requests"] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: raw });
      if (handler !== undefined) {
        handler(req, res);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no route" }));
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, requests });
    });
  });
}

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.length = 0;
});

const PRODUCT = {
  sku: "sku-001",
  merchant_id: "merchant-001",
  title: "手写陶瓷杯",
  description: "手工拉坯",
  category: "kitchenware",
  tags: ["手工"],
  price: 99,
  currency: "CNY",
  stock: 12,
  delivery: {
    service_area: "北京市",
    fee: 5,
    currency: "CNY",
    eta_minutes: 1440,
    radius_km: 10,
    notes: "当日达",
  },
  merchant: { id: "merchant-001", name: "拾光手作", city: "北京市", service_area: "海淀区", hours: "10:00-21:00" },
  warnings: [],
};

describe("ShoppingCliConnector HTTP 集成", () => {
  it("searchProducts：查询参数逐项正确 + 读端点不携带 token", async () => {
    const gw = await startGateway((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [PRODUCT] }));
    });
    const connector = new ShoppingCliConnector(gw.url, { buyerBootstrapToken: "secret-token" });

    const products = await connector.searchProducts({
      query: "陶瓷杯",
      city: "北京",
      area: "海淀",
      max_price: 120,
      include_out_of_stock: true,
      limit: 20,
    });
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ sku: "sku-001", price: 99, currency: "CNY" });

    const req = gw.requests[0] as NonNullable<(typeof gw.requests)[number]>;
    expect(req.method).toBe("GET");
    expect(req.path).toContain("/search/products?");
    expect(req.path).toContain("query=%E9%99%B6%E7%93%B7%E6%9D%AF");
    expect(req.path).toContain("city=%E5%8C%97%E4%BA%AC");
    expect(req.path).toContain("area=%E6%B5%B7%E6%B7%80");
    expect(req.path).toContain("max_price=120");
    expect(req.path).toContain("include_out_of_stock=true");
    expect(req.path).toContain("limit=20");
    // 读端点不发 token（网关公开读端点；若误发会泄漏到访问日志）
    expect(req.headers.authorization).toBeUndefined();
  });

  it("getProduct：SKU 编码进路径 + 响应解析", async () => {
    const gw = await startGateway((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ product: PRODUCT }));
    });
    const connector = new ShoppingCliConnector(gw.url);
    const product = await connector.getProduct("sku/001");
    expect(gw.requests[0]?.path).toContain(`/products/${encodeURIComponent("sku/001")}`);
    expect(product.sku).toBe("sku-001");
    expect(gw.requests).toHaveLength(1);
  });

  it("searchMerchants：results 数组解析", async () => {
    const gw = await startGateway((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [PRODUCT.merchant] }));
    });
    const connector = new ShoppingCliConnector(gw.url);
    const merchants = await connector.searchMerchants({ query: "陶瓷", limit: 5 });
    expect(merchants).toHaveLength(1);
    expect(merchants[0]?.id).toBe("merchant-001");
  });

  it("startConsultation：POST /buyer/ask 携带 Bearer + idempotency-key", async () => {
    const gw = await startGateway((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ conversation_id: "conv_01", status: "waiting_merchant" }));
    });
    const connector = new ShoppingCliConnector(gw.url, { buyerBootstrapToken: "secret-token" });
    const result = await connector.startConsultation({
      buyer_id: "buyer-1",
      sku: "sku-001",
      merchant_id: "merchant-001",
      opening_message: "请问有货吗",
    });
    expect(result).toEqual({ conversation_id: "conv_01", status: "waiting_merchant" });
    const req = gw.requests[0] as NonNullable<(typeof gw.requests)[number]>;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/buyer/ask");
    expect(req.headers.authorization).toBe("Bearer secret-token");
    expect(req.headers["idempotency-key"]).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.parse(req.body)).toEqual({ buyer_id: "buyer-1", text: "请问有货吗" });
  });

  it("startConsultation 未配置 token → auth 错误（fail-closed，不裸打网关）", async () => {
    const gw = await startGateway();
    const connector = new ShoppingCliConnector(gw.url);
    await expect(
      connector.startConsultation({ buyer_id: "b", sku: "s", merchant_id: "m", opening_message: "hi" }),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(gw.requests).toHaveLength(0);
  });

  it("错误映射：401 → auth、500 → transient、404 → not_found", async () => {
    const gw = await startGateway((req, res) => {
      res.writeHead(
        req.url?.includes("auth") ? 401 : req.url?.includes("missing") ? 404 : 500,
        { "content-type": "application/json" },
      );
      res.end(JSON.stringify({ error: "boom" }));
    });
    const connector = new ShoppingCliConnector(gw.url);
    await expect(connector.searchProducts({ query: "auth" })).rejects.toMatchObject({ kind: "auth" });
    await expect(connector.searchProducts({ query: "missing" })).rejects.toMatchObject({ kind: "not_found" });
    await expect(connector.searchProducts({ query: "boom" })).rejects.toMatchObject({ kind: "transient" });
  });

  it("畸形响应：缺 results 数组 → validation 错误（fail-closed）", async () => {
    const gw = await startGateway((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ not_results: [] }));
    });
    const connector = new ShoppingCliConnector(gw.url);
    await expect(connector.searchProducts({ query: "x" })).rejects.toMatchObject({ kind: "validation" });
  });

  it("非 JSON 响应 → transient；3xx 重定向拒绝（不跟随）", async () => {
    let mode: "html" | "redirect" = "html";
    const gw = await startGateway((req, res) => {
      if (mode === "redirect") {
        res.writeHead(302, { location: "http://127.0.0.1:1/evil" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>");
    });
    const connector = new ShoppingCliConnector(gw.url);
    await expect(connector.searchProducts({ query: "x" })).rejects.toMatchObject({ kind: "transient" });
    mode = "redirect";
    await expect(connector.searchProducts({ query: "x" })).rejects.toMatchObject({ kind: "transient" });
  });
});
