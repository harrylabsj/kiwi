import { describe, expect, it } from "vitest";
import type { MerchantAuthorization } from "../src/auth/merchant-authorization.js";
import { proxyTenantMcp } from "../src/merchant-gateway/mcp-proxy.js";
import { TenantBackendRegistry } from "../src/merchant-gateway/tenant-registry.js";

const registry = new TenantBackendRegistry(
  [
    { merchantId: "merchant-A", mcpUrl: "http://127.0.0.1:9101/mcp", tokenEnv: "BACKEND_A" },
    { merchantId: "merchant-B", mcpUrl: "http://127.0.0.1:9102/mcp", tokenEnv: "BACKEND_B" },
  ],
  { BACKEND_A: "secret-A", BACKEND_B: "secret-B" },
);
const auth = (merchant_id: string, scopes = ["merchant:read", "merchant:write"]): MerchantAuthorization => ({
  principal_id: `account:${merchant_id}`,
  merchant_id,
  scopes,
});
const call = (name: string, args: Record<string, unknown> = {}): string =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

describe("Merchant Gateway MCP 代理的路由和工具门", () => {
  it("只能按已验证商家 token 选择后端，忽略工具参数中的其他商家", async () => {
    const seen: Array<{ url: string; authorization: string }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), authorization: headers.get("authorization") ?? "" });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await proxyTenantMcp(
      { method: "POST", body: call("kiwi_merchant_get_product", { sku: "A-001", merchant_id: "merchant-B" }), authorization: auth("merchant-A") },
      registry,
      fakeFetch,
    );
    await proxyTenantMcp(
      { method: "POST", body: call("kiwi_merchant_get_product", { sku: "B-001" }), authorization: auth("merchant-B") },
      registry,
      fakeFetch,
    );
    expect(seen).toEqual([
      { url: "http://127.0.0.1:9101/mcp", authorization: "Bearer secret-A" },
      { url: "http://127.0.0.1:9102/mcp", authorization: "Bearer secret-B" },
    ]);
  });

  it("读 scope 不可调用写工具；未知工具/方法不发往后端", async () => {
    let count = 0;
    const fakeFetch = (async () => {
      count += 1;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const write = await proxyTenantMcp(
      { method: "POST", body: call("kiwi_merchant_prepare_inventory_update", { sku: "A-001", stock: 0 }), authorization: auth("merchant-A", ["merchant:read"]) },
      registry,
      fakeFetch,
    );
    expect(write.status).toBe(403);
    expect(write.body).toContain("merchant:write");
    const unknown = await proxyTenantMcp(
      { method: "POST", body: call("kiwi_merchant_future_write"), authorization: auth("merchant-A") },
      registry,
      fakeFetch,
    );
    expect(unknown.status).toBe(403);
    expect(count).toBe(0);
  });

  it("只读授权的 tools/list 不暴露写工具", async () => {
    const fakeFetch = (async () => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [
        { name: "kiwi_merchant_list_products" },
        { name: "kiwi_merchant_prepare_inventory_update" },
      ] } }),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
    const result = await proxyTenantMcp(
      { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), authorization: auth("merchant-A", ["merchant:read"]) },
      registry,
      fakeFetch,
    );
    const body = JSON.parse(result.body) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(["kiwi_merchant_list_products"]);
  });

  it("后端重定向和非 JSON 响应 fail-closed", async () => {
    const request = { method: "POST" as const, body: call("kiwi_merchant_list_products"), authorization: auth("merchant-A") };
    const redirect = await proxyTenantMcp(request, registry, (async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1:9999/other" },
    })) as typeof fetch);
    expect(redirect.status).toBe(502);
    const sse = await proxyTenantMcp(request, registry, (async () => new Response("data: secret\n\n", {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch);
    expect(sse.status).toBe(502);
  });

  it("未连接商家不回退到任何默认后端", async () => {
    let called = false;
    const result = await proxyTenantMcp(
      { method: "POST", body: call("kiwi_merchant_list_products"), authorization: auth("merchant-C") },
      registry,
      (async () => { called = true; throw new Error("不应发起请求"); }) as typeof fetch,
    );
    expect(result.status).toBe(503);
    expect(result.body).toContain("service_not_connected");
    expect(called).toBe(false);
  });

  it("拒绝 JSON-RPC batch/空值，避免绕过单工具授权检查", async () => {
    let called = false;
    const fakeFetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    for (const body of ["null", "[]", JSON.stringify([{
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kiwi_merchant_prepare_inventory_update" },
    }])]) {
      const result = await proxyTenantMcp(
        { method: "POST", body, authorization: auth("merchant-A", ["merchant:read"]) },
        registry,
        fakeFetch,
      );
      expect(result.status).toBe(400);
    }
    expect(called).toBe(false);
  });

  it("分块响应超过上限时停止读取并拒绝返回", async () => {
    const fakeFetch = (async () => new Response("x".repeat(1_048_577), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const result = await proxyTenantMcp(
      { method: "POST", body: call("kiwi_merchant_list_products"), authorization: auth("merchant-A") },
      registry,
      fakeFetch,
    );
    expect(result.status).toBe(502);
    expect(result.body).toContain("backend_response_too_large");
  });
});
