/**
 * review P1-1：buyer HTTP 面的安全中间件回归。
 *
 * 覆盖：Bearer 认证（配置后非 /health 一律要求）、未配置时 loopback-only、
 * Host allowlist（防 DNS rebinding）、请求体超限 413、坏 JSON 400。
 */
import { request, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildBuyerService } from "../src/buyer-core/build-service.js";
import { createBuyerHttpServer } from "../src/http/server.js";

const POLICY = {
  policy_id: "dp-http-sec-test",
  version: "1.0",
  principal: "company:http-sec-test",
  expires_at: "2099-12-31T23:59:59Z",
  actions: {
    discover: { mode: "auto" },
    inquiry_rfq: { mode: "auto" },
    compare_offers: { mode: "auto" },
    counter_offer: { mode: "auto" },
    accept_nonbinding: { mode: "ask" },
    handoff: { mode: "ask" },
    payment: { mode: "never" },
  },
  limits: { max_rounds: 3 },
};

function makeService() {
  return buildBuyerService({
    dbPath: ":memory:",
    principal: "company:http-sec-test",
    buyerAgentId: "buyer-agent:http-sec",
    sessionId: "http-sec-session",
    policy: POLICY,
  });
}

/** fetch 无法自定义 Host 头（undici 禁改），Host 校验用原生请求。 */
function rawRequest(base: string, headers: Record<string, string>): Promise<{ status: number }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path: "/health", method: "GET", headers },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("buyer HTTP 安全中间件（review P1-1）", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createBuyerHttpServer({ service: makeService(), authToken: "sec-token-1" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("/health 豁免认证", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  it("无 Bearer / 错误 Bearer → 401；正确 Bearer → 200", async () => {
    const none = await fetch(`${base}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(none.status).toBe(401);
    const wrong = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sec-token-1" },
      body: JSON.stringify({ intent: { intent_id: "sec-1", intent_type: "purchase", items: [{ query: "x" }] } }),
    });
    expect(ok.status).toBe(201);
  });

  it("Host 头不在 allowlist → 403（DNS rebinding 防护）", async () => {
    const res = await rawRequest(base, { host: "evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("请求体超限 → 413 且不吞成空对象", async () => {
    const res = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sec-token-1" },
      body: JSON.stringify({ pad: "x".repeat(300 * 1024) }),
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("body_too_large");
  });

  it("坏 JSON → 400（不再静默吞成空对象）", async () => {
    const res = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sec-token-1" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_body");
  });

  it("404 不回显请求 path", async () => {
    const res = await fetch(`${base}/no-such-path-xyz`, { headers: { authorization: "Bearer sec-token-1" } });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).not.toContain("no-such-path-xyz");
  });
});

describe("P1-1 返修：鉴权必选 + 作用域分离", () => {
  it("未提供 authToken 时构造即抛错（loopback 不是身份）", () => {
    expect(() =>
      createBuyerHttpServer({ service: makeService() } as never),
    ).toThrow(/requires an explicit authToken/);
  });

  it("merchantOps 未配置 merchantAuthToken 时构造即抛错（作用域分离）", () => {
    expect(() =>
      createBuyerHttpServer({
        service: makeService(),
        authToken: "t1",
        merchantOps: {} as never,
      }),
    ).toThrow(/merchantAuthToken/);
  });

  it("买家令牌不能访问商家裁决面（scope 分离）", async () => {
    const { MerchantOpsService } = await import("../src/merchant/ops.js");
    const server = createBuyerHttpServer({
      service: makeService(),
      authToken: "buyer-token",
      merchantAuthToken: "merchant-token",
      merchantOps: {
        merchant_one: new MerchantOpsService({ baseUrl: "https://mp.example", merchantToken: "x" }),
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const b = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
    try {
      const buyerTokenOnMerchant = await fetch(`${b}/merchant/merchant_one/rfqs`, {
        headers: { authorization: "Bearer buyer-token" },
      });
      expect(buyerTokenOnMerchant.status).toBe(401);
      const merchantTokenOnMerchant = await fetch(`${b}/merchant/merchant_one/rfqs`, {
        headers: { authorization: "Bearer merchant-token" },
      });
      // 作用域正确时通过鉴权层（下游 ops 调用可能失败，但绝不是 401）
      expect(merchantTokenOnMerchant.status).not.toBe(401);
      const merchantTokenOnBuyer = await fetch(`${b}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer merchant-token" },
        body: "{}",
      });
      expect(merchantTokenOnBuyer.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("请求体按字节计量：多字节 UTF-8 超 256KiB 字节限制 → 413", async () => {
    // 100_000 个 3 字节汉字 = 300_000 字节 < 300_000 chars? 反向：字符数 100_000
    // 低于 256*1024=262_144 字符阈值，但字节 300_000 超 262_144 字节阈值——
    // 修复前按 data.length（字符）计量不会拒绝。
    const server = createBuyerHttpServer({ service: makeService(), authToken: "byte-token" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const b = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
    try {
      const res = await fetch(`${b}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer byte-token" },
        body: JSON.stringify({ pad: "汉".repeat(100_000) }),
      });
      expect(res.status).toBe(413);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
