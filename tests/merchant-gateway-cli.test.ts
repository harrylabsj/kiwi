/**
 * `kiwi merchant gateway serve` 启动校验测试（fail-closed 边界）。
 *
 * 覆盖部署形态与凭据分工的硬边界：
 * - 公网入口必须 https（loopback http 仅限开发）；
 * - 监听非 loopback 必须有 TLS 材料或显式 `--trusted-proxy`，否则拒绝启动；
 * - connector token 缺失即拒绝启动；
 * - 凭据加密密钥缺失**不**拒绝启动，但关闭依赖加密存储的功能并给出警告；
 * - 回调地址按 source 派生，可显式覆盖；租户配置畸形即拒绝。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseGatewayServeArgs,
  validateGatewayServeOptions,
  type GatewayServeOptions,
  type GatewayServeReadiness,
} from "../src/merchant-gateway/cli.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-gateway-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

const TOKEN_ENV = { KIWI_CATALOG_CONNECTOR_TOKEN: "connector-token" };

function opts(overrides: Partial<GatewayServeOptions> = {}): GatewayServeOptions {
  return { ...parseGatewayServeArgs(["--public-url", "https://merchant.example"]), ...overrides };
}

function expectOk(
  options: GatewayServeOptions,
  env: Record<string, string | undefined> = TOKEN_ENV,
): GatewayServeReadiness {
  const result = validateGatewayServeOptions(options, env);
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.readiness;
}

function expectError(
  options: GatewayServeOptions,
  env: Record<string, string | undefined> = TOKEN_ENV,
): string {
  const result = validateGatewayServeOptions(options, env);
  if (result.ok) throw new Error("expected validation error, got ok");
  return result.error;
}

describe("参数解析", () => {
  it("缺省值：loopback 监听、缺省 source、需要显式 --public-url", () => {
    const parsed = parseGatewayServeArgs([]);
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.source).toBe("kiwi-merchant");
    expect(parsed.publicUrl).toBeUndefined();
    expect(parsed.trustedProxy).toBe(false);
    expect(parsed.allowLoopbackCallback).toBe(true);
    expect(parsed.connectorTokenEnv).toBe("KIWI_CATALOG_CONNECTOR_TOKEN");
    expect(parsed.credentialKeyEnv).toBe("KIWI_GATEWAY_CREDENTIAL_KEY");
    // 未给 --public-url → 拒绝（fail-closed，没有默认公网入口）。
    expect(expectError(parsed, { KIWI_CATALOG_CONNECTOR_TOKEN: "t" })).toContain("--public-url");
  });

  it("显式 flag 覆盖缺省（含布尔开关）", () => {
    const parsed = parseGatewayServeArgs([
      "--public-url",
      "https://entry.example",
      "--catalog-url",
      "http://127.0.0.1:8600",
      "--source",
      "kiwi-merchant-next",
      "--host",
      "0.0.0.0",
      "--port",
      "9500",
      "--data-dir",
      "/tmp/gateway",
      "--connector-token-env",
      "MY_CONNECTOR_TOKEN",
      "--credential-key-env",
      "MY_KEY",
      "--trusted-proxy",
      "--no-loopback-callback",
      "--callback-uri",
      "workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback",
      "--check",
    ]);
    expect(parsed.catalogUrl).toBe("http://127.0.0.1:8600");
    expect(parsed.source).toBe("kiwi-merchant-next");
    expect(parsed.host).toBe("0.0.0.0");
    expect(parsed.port).toBe(9500);
    expect(parsed.dataDir).toBe("/tmp/gateway");
    expect(parsed.connectorTokenEnv).toBe("MY_CONNECTOR_TOKEN");
    expect(parsed.credentialKeyEnv).toBe("MY_KEY");
    expect(parsed.trustedProxy).toBe(true);
    expect(parsed.allowLoopbackCallback).toBe(false);
    expect(parsed.callbackUri).toContain("kiwi-merchant");
    expect(parsed.checkOnly).toBe(true);
  });
});

describe("公网入口与 TLS 边界", () => {
  it("loopback 反向代理形态：http 监听 + https 公网入口通过（nginx/caddy 终止 TLS）", () => {
    const readiness = expectOk(opts({ host: "127.0.0.1" }));
    expect(readiness.publicUrl).toBe("https://merchant.example");
    expect(readiness.directTls).toBe(false);
    expect(readiness.nonLoopback).toBe(false);
  });

  it("开发用 loopback http 公网入口通过但带警告", () => {
    const readiness = expectOk(opts({ publicUrl: "http://127.0.0.1:9200" }));
    expect(readiness.warnings.some((w) => w.includes("不可用于生产"))).toBe(true);
  });

  it("非 loopback 公网入口必须是 https", () => {
    expect(expectError(opts({ publicUrl: "http://merchant.example" }))).toContain("https");
  });

  it("监听非 loopback 时：无 TLS 且未声明受信代理 → 拒绝启动", () => {
    const error = expectError(opts({ host: "0.0.0.0" }));
    expect(error).toContain("--trusted-proxy");
    expect(error).toContain("--tls-cert");
  });

  it("监听非 loopback + 显式 --trusted-proxy → 通过并提示代理要求", () => {
    const readiness = expectOk(opts({ host: "0.0.0.0", trustedProxy: true }));
    expect(readiness.nonLoopback).toBe(true);
    expect(readiness.warnings.some((w) => w.includes("反向代理"))).toBe(true);
  });

  it("直接终止 TLS：证书与私钥必须成对且文件存在", () => {
    const cert = tmpFile("cert.pem", "cert");
    const key = tmpFile("key.pem", "key");
    expect(expectError(opts({ host: "0.0.0.0", tlsCertPath: cert }))).toContain("成对");
    expect(
      expectError(opts({ host: "0.0.0.0", tlsCertPath: cert, tlsKeyPath: "/nope/key.pem" })),
    ).toContain("不存在");
    const readiness = expectOk(opts({ host: "0.0.0.0", tlsCertPath: cert, tlsKeyPath: key }));
    expect(readiness.directTls).toBe(true);
  });

  it("公网入口不得内嵌凭据或携带查询串", () => {
    expect(expectError(opts({ publicUrl: "https://user:pass@merchant.example" }))).toContain(
      "userinfo",
    );
    expect(expectError(opts({ publicUrl: "https://merchant.example/?x=1" }))).toContain("查询串");
  });
});

describe("凭据分工与功能开关", () => {
  it("connector token 缺失 → 拒绝启动（入口无法建立商家身份）", () => {
    expect(expectError(opts(), {})).toContain("KIWI_CATALOG_CONNECTOR_TOKEN");
    expect(expectError(opts(), { OTHER: "x" })).toContain("KIWI_CATALOG_CONNECTOR_TOKEN");
  });

  it("凭据加密密钥缺失 → 可启动，但依赖加密存储的功能关闭并告警", () => {
    const readiness = expectOk(opts());
    expect(readiness.encryptedFeaturesEnabled).toBe(false);
    expect(readiness.warnings.some((w) => w.includes("KIWI_GATEWAY_CREDENTIAL_KEY"))).toBe(true);
  });

  it("配置加密密钥后启用加密相关功能", () => {
    const readiness = expectOk(opts(), { ...TOKEN_ENV, KIWI_GATEWAY_CREDENTIAL_KEY: "k" });
    expect(readiness.encryptedFeaturesEnabled).toBe(true);
    expect(readiness.warnings).toHaveLength(0);
  });

  it("自定义 env 名生效（不再读取默认名）", () => {
    const parsed = parseGatewayServeArgs(
      ["--public-url", "https://merchant.example", "--connector-token-env", "MY_TOKEN"],
      {},
    );
    expect(expectError(parsed, { KIWI_CATALOG_CONNECTOR_TOKEN: "x" })).toContain("MY_TOKEN");
    expect(expectOk(parsed, { MY_TOKEN: "x" }).connectorTokenConfigured).toBe(true);
  });
});

describe("source、回调与租户配置", () => {
  it("OAuth 回调按 source 派生，可显式覆盖；不含买方 source", () => {
    const readiness = expectOk(opts());
    expect(readiness.callbackUri).toBe(
      "workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback",
    );
    expect(readiness.callbackUri).not.toContain("kiwi-sourcing");

    const custom = expectOk(
      opts({ callbackUri: "workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback" }),
    );
    expect(custom.callbackUri).toContain("kiwi-merchant");
  });

  it("source 非法即拒绝", () => {
    expect(expectError(opts({ source: "Kiwi Merchant" }))).toContain("--source");
    expect(expectError(opts({ source: "-bad" }))).toContain("--source");
  });

  it("端口非法即拒绝", () => {
    expect(expectError(opts({ port: 0 }))).toContain("--port");
    expect(expectError(opts({ port: 70_000 }))).toContain("--port");
  });

  it("租户配置：缺省无实例；文件缺失/畸形即拒绝；合法则计数", () => {
    expect(expectOk(opts()).registeredInstances).toBe(0);

    expect(expectError(opts({ tenantConfigPath: "/nope/tenants.json" }))).toContain("不存在");

    const bad = tmpFile("bad.json", "{ not json }");
    expect(expectError(opts({ tenantConfigPath: bad }))).toContain("JSON");

    const badUrl = tmpFile(
      "bad-url.json",
      JSON.stringify({
        tenants: [{ merchant_id: "mkt_a", mcp_url: "http://10.0.0.1/mcp", token_env: "A_TOKEN" }],
      }),
    );
    expect(expectError(opts({ tenantConfigPath: badUrl }))).toContain("出站策略拒绝");

    const good = tmpFile(
      "good.json",
      JSON.stringify({
        tenants: [
          { merchant_id: "mkt_a", mcp_url: "https://a.example/mcp", token_env: "A_TOKEN" },
          { merchant_id: "mkt_b", mcp_url: "https://b.example/mcp", token_env: "B_TOKEN" },
        ],
      }),
    );
    const readiness = expectOk(opts({ tenantConfigPath: good }));
    expect(readiness.registeredInstances).toBe(2);
  });
});
