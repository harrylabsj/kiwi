/**
 * 第 1 版实例路由测试（商家连接器 → 商家自托管 MCP 实例）。
 *
 * 覆盖：
 * - 工具清单从实例现取（不硬编码）并按 scope 收敛，TTL 内命中缓存；
 * - 未配对实例 / 内部凭据缺失 → 第 1 版工具对调用方不可见（返回 undefined）；
 * - 调用经 mcp-proxy 转发，路由只由已验证 token 的 merchant_id 决定（A/B 隔离）；
 * - 实例报错/不可达 → 可解释 isError，不伪造结果；
 * - 租户配置解析与工具束组合的边界。
 */
import { describe, expect, it } from "vitest";

import type { MerchantAuthorization } from "../src/auth/merchant-authorization.js";
import {
  buildInstanceTools,
  InstanceToolListCache,
  parseCallResult,
  parseToolList,
} from "../src/merchant-gateway/instance-tools.js";
import {
  loadTenantBackendConfigs,
  TenantBackendError,
  TenantBackendRegistry,
} from "../src/merchant-gateway/tenant-registry.js";
import { combineScopedTools } from "../src/merchant-gateway/tool-bundle.js";

const A = {
  merchantId: "mkt_acme",
  mcpUrl: "https://merchant.acme.example/mcp",
  tokenEnv: "ACME_TOKEN",
};
const B = {
  merchantId: "mkt_rival",
  mcpUrl: "http://127.0.0.1:9102/mcp",
  tokenEnv: "RIVAL_TOKEN",
};

const ENV = { ACME_TOKEN: "internal-acme", RIVAL_TOKEN: "internal-rival" };

function auth(merchantId: string, scopes: string[] = ["merchant:read"]): MerchantAuthorization {
  return { principal_id: `merchant:${merchantId}`, merchant_id: merchantId, scopes };
}

interface FakeUpstream {
  calls: Array<{ url: string; method: string; authorization: string; body: string }>;
  fetchImpl: typeof fetch;
}

function fakeUpstream(
  handler: (
    url: string,
    rpc: { method: string; params?: Record<string, unknown> },
  ) => {
    status?: number;
    body: unknown;
  },
): FakeUpstream {
  const calls: FakeUpstream["calls"] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: { body?: unknown; headers?: Record<string, string> },
  ) => {
    const body = String(init?.body ?? "");
    const rpc = JSON.parse(body) as { method: string; params?: Record<string, unknown> };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: rpc.method,
      authorization: headers.authorization ?? "",
      body,
    });
    const result = handler(String(url), rpc);
    return new Response(JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const TOOLS_PAYLOAD = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [
      {
        name: "kiwi_merchant_list_products",
        description: "列商品",
        inputSchema: { type: "object" },
      },
      {
        name: "kiwi_merchant_prepare_product_change",
        description: "变更候选",
        inputSchema: { type: "object" },
      },
      { name: "not_a_kiwi_tool", description: "外部工具" },
    ],
  },
};

describe("解析实例返回结果", () => {
  it("tools/list：逐条解析（allowlist 由 mcp-proxy 负责），畸形条目丢弃", () => {
    const tools = parseToolList(TOOLS_PAYLOAD);
    expect(tools.map((t) => t.name)).toEqual([
      "kiwi_merchant_list_products",
      "kiwi_merchant_prepare_product_change",
      "not_a_kiwi_tool",
    ]);
    expect(parseToolList({ result: { tools: "not-an-array" } })).toEqual([]);
    expect(parseToolList(null)).toEqual([]);
  });

  it("经 mcp-proxy 后，非 allowlist 工具不会出现在清单里", async () => {
    const upstream = fakeUpstream(() => ({ body: TOOLS_PAYLOAD }));
    const registry = new TenantBackendRegistry([A], ENV);
    const tools = buildInstanceTools({
      registry,
      authorization: auth("mkt_acme", ["merchant:read", "merchant:write"]),
      fetchImpl: upstream.fetchImpl,
    });
    const names = (await tools!.listTools(["merchant:read", "merchant:write"])).map((t) => t.name);
    expect(names).toEqual(["kiwi_merchant_list_products", "kiwi_merchant_prepare_product_change"]);
    expect(names).not.toContain("not_a_kiwi_tool");
  });

  it("tools/call：文本内容原样返回，错误可解释", () => {
    const ok = parseCallResult({
      result: { content: [{ type: "text", text: '{"products":[]}' }] },
    });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]?.text).toBe('{"products":[]}');

    const errored = parseCallResult({ result: { content: [], isError: true } });
    expect(errored.isError).toBe(true);

    const rpcError = parseCallResult({ error: { message: "boom" } });
    expect(rpcError.isError).toBe(true);
    expect(rpcError.content[0]?.text).toContain("boom");
  });
});

describe("实例工具：路由与隔离", () => {
  it("未配对实例或凭据缺失时不提供第 1 版工具", () => {
    const registry = new TenantBackendRegistry([A], ENV);
    expect(buildInstanceTools({ registry, authorization: auth("mkt_other") })).toBeUndefined();
    expect(buildInstanceTools({ registry, authorization: auth("") })).toBeUndefined();
    const withoutCredential = new TenantBackendRegistry([A], {});
    expect(
      buildInstanceTools({ registry: withoutCredential, authorization: auth("mkt_acme") }),
    ).toBeUndefined();
  });

  it("工具清单从实例现取并按 scope 收敛；TTL 内不重复请求", async () => {
    const upstream = fakeUpstream(() => ({ body: TOOLS_PAYLOAD }));
    const registry = new TenantBackendRegistry([A], ENV);
    let nowMs = 1_000;
    const cache = new InstanceToolListCache(60_000);
    const tools = buildInstanceTools({
      registry,
      authorization: auth("mkt_acme", ["merchant:read", "merchant:write"]),
      fetchImpl: upstream.fetchImpl,
      cache,
      now: () => nowMs,
    });
    expect(tools).toBeDefined();

    // 清单已由 mcp-proxy 按令牌 scope 过滤：读令牌看不到 prepare_* 工具。
    const listed = await tools!.listTools(["merchant:read", "merchant:write"]);
    expect(listed.map((t) => t.name)).toEqual([
      "kiwi_merchant_list_products",
      "kiwi_merchant_prepare_product_change",
    ]);
    const readOnly = buildInstanceTools({
      registry,
      authorization: auth("mkt_acme", ["merchant:read"]),
      fetchImpl: upstream.fetchImpl,
      cache: new InstanceToolListCache(60_000),
      now: () => nowMs,
    });
    expect((await readOnly!.listTools(["merchant:read"])).map((t) => t.name)).toEqual([
      "kiwi_merchant_list_products",
    ]);
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[0]?.url).toBe(A.mcpUrl);
    expect(upstream.calls[0]?.authorization).toBe("Bearer internal-acme");

    // TTL 过期后重新拉取。
    nowMs += 61_000;
    await tools!.listTools(["merchant:read", "merchant:write"]);
    expect(upstream.calls).toHaveLength(3);
  });

  it("调用转发到该商家的实例，A 的授权不会打到 B", async () => {
    const upstream = fakeUpstream(() => ({
      body: { result: { content: [{ type: "text", text: "ok" }] } },
    }));
    const registry = new TenantBackendRegistry([A, B], ENV);
    const toolsA = buildInstanceTools({
      registry,
      authorization: auth("mkt_acme"),
      fetchImpl: upstream.fetchImpl,
    });
    const toolsB = buildInstanceTools({
      registry,
      authorization: auth("mkt_rival"),
      fetchImpl: upstream.fetchImpl,
    });
    await toolsA!.call("kiwi_merchant_list_products", {}, ["merchant:read"]);
    await toolsB!.call("kiwi_merchant_list_products", {}, ["merchant:read"]);
    expect(upstream.calls.map((c) => c.url)).toEqual([A.mcpUrl, B.mcpUrl]);
    expect(upstream.calls.map((c) => c.authorization)).toEqual([
      "Bearer internal-acme",
      "Bearer internal-rival",
    ]);
  });

  it("实例不可达/报错时返回可解释错误，不伪造业务结果", async () => {
    const upstream = fakeUpstream(() => ({
      status: 503,
      body: { error: "service_not_connected" },
    }));
    const registry = new TenantBackendRegistry([A], ENV);
    const tools = buildInstanceTools({
      registry,
      authorization: auth("mkt_acme"),
      fetchImpl: upstream.fetchImpl,
    });
    expect(await tools!.listTools(["merchant:read"])).toEqual([]);
    const result = await tools!.call("kiwi_merchant_list_products", {}, ["merchant:read"]);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("service_not_connected");
  });

  it("缓存已知工具清单时，未提供的工具名直接拒绝", async () => {
    const upstream = fakeUpstream(() => ({ body: TOOLS_PAYLOAD }));
    const registry = new TenantBackendRegistry([A], ENV);
    const tools = buildInstanceTools({
      registry,
      authorization: auth("mkt_acme"),
      fetchImpl: upstream.fetchImpl,
    });
    await tools!.listTools(["merchant:read"]);
    const result = await tools!.call("kiwi_merchant_unknown_tool", {}, ["merchant:read"]);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("未提供工具");
    // 只有 tools/list 打了实例，可疑调用没有到达实例。
    expect(upstream.calls.map((c) => c.method)).toEqual(["tools/list"]);
  });
});

describe("租户配置解析与工具束组合", () => {
  it("接受 env 与 vault 两种凭据来源", () => {
    const configs = loadTenantBackendConfigs(
      JSON.stringify({
        tenants: [
          { merchant_id: "mkt_a", mcp_url: "https://a.example/mcp", token_env: "A_TOKEN" },
          { merchant_id: "mkt_b", mcp_url: "http://127.0.0.1:9100/mcp", credential_kind: "vault" },
        ],
      }),
    );
    expect(configs).toHaveLength(2);
    expect(new TenantBackendRegistry(configs, {}).size).toBe(2);
  });

  it("配置畸形一律拒绝（不默认填充）", () => {
    for (const raw of [
      "not json",
      JSON.stringify({}),
      JSON.stringify({ tenants: {} }),
      JSON.stringify({ tenants: [{ merchant_id: "mkt_a" }] }),
      JSON.stringify({
        tenants: [{ merchant_id: "mkt_a", mcp_url: "https://a/mcp", credential_kind: "env" }],
      }),
      JSON.stringify({
        tenants: [
          {
            merchant_id: "mkt_a",
            mcp_url: "https://a/mcp",
            token_env: "A",
            credential_kind: "vault",
          },
        ],
      }),
    ]) {
      // 解析 + 构造注册表任一环节都必须拒绝（不默认填充、不静默降级）。
      expect(() => new TenantBackendRegistry(loadTenantBackendConfigs(raw))).toThrowError(
        TenantBackendError,
      );
    }
  });

  it("组合工具束：按名去重、按名路由、空束返回 undefined", async () => {
    const catalog = {
      listTools: () => [
        { name: "kiwi_catalog_get_merchant_profile", description: "", inputSchema: {} },
      ],
      call: async (name: string) => ({
        content: [{ type: "text" as const, text: `catalog:${name}` }],
      }),
    };
    const instance = {
      listTools: async () => [
        { name: "kiwi_merchant_list_products", description: "", inputSchema: {} },
      ],
      call: async (name: string) => ({
        content: [{ type: "text" as const, text: `instance:${name}` }],
      }),
    };
    const combined = combineScopedTools([catalog, instance])!;
    expect((await combined.listTools(undefined)).map((t) => t.name)).toEqual([
      "kiwi_catalog_get_merchant_profile",
      "kiwi_merchant_list_products",
    ]);
    expect(
      (await combined.call("kiwi_merchant_list_products", {}, undefined)).content[0]?.text,
    ).toBe("instance:kiwi_merchant_list_products");
    expect(
      (await combined.call("kiwi_catalog_get_merchant_profile", {}, undefined)).content[0]?.text,
    ).toBe("catalog:kiwi_catalog_get_merchant_profile");
    const unknown = await combined.call("nope", {}, undefined);
    expect(unknown.isError).toBe(true);

    expect(combineScopedTools([undefined, undefined])).toBeUndefined();
    const single = combineScopedTools([catalog, undefined]);
    expect(single).toBe(catalog);
  });
});
