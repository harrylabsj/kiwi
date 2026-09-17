import { describe, expect, it } from "vitest";
import {
  TenantBackendRegistry,
  TenantBackendError,
} from "../src/merchant-gateway/tenant-registry.js";

const configs = [
  { merchantId: "merchant-A", mcpUrl: "http://127.0.0.1:9101/mcp", tokenEnv: "BACKEND_A_TOKEN" },
  { merchantId: "merchant-B", mcpUrl: "http://127.0.0.1:9102/mcp", tokenEnv: "BACKEND_B_TOKEN" },
];

describe("通用 Merchant Gateway 商家后端注册表", () => {
  it("只按已认证 token 的 merchant_id 选择 A/B 后端和内部凭据", () => {
    const registry = new TenantBackendRegistry(configs, {
      BACKEND_A_TOKEN: "internal-A",
      BACKEND_B_TOKEN: "internal-B",
    });
    const a = registry.resolve({
      principal_id: "account:A",
      merchant_id: "merchant-A",
      scopes: ["merchant:read"],
    });
    const b = registry.resolve({
      principal_id: "account:B",
      merchant_id: "merchant-B",
      scopes: ["merchant:read"],
    });
    expect(a).toEqual({
      merchantId: "merchant-A",
      mcpUrl: "http://127.0.0.1:9101/mcp",
      bearerToken: "internal-A",
    });
    expect(b).toEqual({
      merchantId: "merchant-B",
      mcpUrl: "http://127.0.0.1:9102/mcp",
      bearerToken: "internal-B",
    });
    expect(a.bearerToken).not.toBe(b.bearerToken);
  });

  it("无实例的第0版商家、空主体与内部凭据缺失均拒绝，不回退到其他商家", () => {
    const registry = new TenantBackendRegistry(configs, { BACKEND_A_TOKEN: "internal-A" });
    expect(() =>
      registry.resolve({ principal_id: "account:C", merchant_id: "merchant-C", scopes: [] }),
    ).toThrowError(TenantBackendError);
    expect(() =>
      registry.resolve({ principal_id: "", merchant_id: "merchant-A", scopes: [] }),
    ).toThrow(/未认证/);
    expect(() =>
      registry.resolve({ principal_id: "account:B", merchant_id: "merchant-B", scopes: [] }),
    ).toThrow(/凭据未配置/);
  });

  it("拒绝明文远端、私网字面 IP、凭据 URL、任意路径和重复商家注册", () => {
    for (const url of [
      "http://merchant.example.com/mcp", // 非 loopback 的明文 http
      "http://10.0.0.1:9101/mcp", // 私网字面 IP
      "https://10.0.0.1/mcp", // 私网字面 IP（https 也不放行）
      "http://metadata.internal/mcp", // 保留主机名
      "http://127.0.0.1:9101/admin", // 路径不是 /mcp
      "https://merchant.example.com/mcp?merchant=other", // 查询串
      "https://user:pass@merchant.example.com/mcp", // userinfo
      "http://127.0.0.1/mcp", // loopback 未显式指定端口
    ]) {
      expect(() => new TenantBackendRegistry([{ ...configs[0]!, mcpUrl: url }], {})).toThrowError(
        TenantBackendError,
      );
    }
    expect(() => new TenantBackendRegistry([configs[0]!, configs[0]!], {})).toThrow(/重复/);
  });

  it("接受异地自托管 HTTPS 实例（自托管 V1 的目标形态）", () => {
    const registry = new TenantBackendRegistry(
      [
        {
          merchantId: "merchant-A",
          mcpUrl: "https://merchant.acme.example/mcp",
          tokenEnv: "BACKEND_A_TOKEN",
        },
      ],
      { BACKEND_A_TOKEN: "internal-A" },
    );
    expect(
      registry.resolve({
        principal_id: "merchant:mkt_acme_1",
        merchant_id: "merchant-A",
        scopes: ["merchant:read"],
      }).mcpUrl,
    ).toBe("https://merchant.acme.example/mcp");
  });

  it("凭据可来自加密保管库（vault），来源只能二选一", () => {
    const stored = new Map<string, { token: string; expiresAt: string }>([
      ["instance:merchant-A", { token: "vault-A", expiresAt: "2099-01-01T00:00:00Z" }],
    ]);
    const registry = new TenantBackendRegistry(
      [
        {
          merchantId: "merchant-A",
          mcpUrl: "https://merchant.acme.example/mcp",
          credentialKind: "vault",
        },
      ],
      {},
      {
        credentials: {
          put: () => undefined,
          get: (key) => stored.get(key),
          delete: () => undefined,
        },
      },
    );
    expect(
      registry.resolve({
        principal_id: "merchant:mkt_acme_1",
        merchant_id: "merchant-A",
        scopes: [],
      }).bearerToken,
    ).toBe("vault-A");

    // 保管库缺条目 → 明确报凭据未配置（不回退到环境变量或其它商家）。
    const empty = new TenantBackendRegistry(
      [
        {
          merchantId: "merchant-B",
          mcpUrl: "https://merchant.b.example/mcp",
          credentialKind: "vault",
        },
      ],
      { BACKEND_B_TOKEN: "should-not-be-used" },
      { credentials: { put: () => undefined, get: () => undefined, delete: () => undefined } },
    );
    expect(() =>
      empty.resolve({
        principal_id: "merchant:mkt_b",
        merchant_id: "merchant-B",
        scopes: [],
      }),
    ).toThrow(/凭据未配置/);

    // 两种来源同时给出 → 配置错误。
    expect(
      () =>
        new TenantBackendRegistry([
          {
            merchantId: "merchant-C",
            mcpUrl: "https://merchant.c.example/mcp",
            tokenEnv: "BACKEND_C_TOKEN",
            credentialKind: "vault",
          },
        ]),
    ).toThrowError(TenantBackendError);
  });

  it("has() 反映该商家是否已注册实例", () => {
    const registry = new TenantBackendRegistry(configs, {});
    expect(registry.has("merchant-A")).toBe(true);
    expect(registry.has("merchant-Z")).toBe(false);
  });
});
