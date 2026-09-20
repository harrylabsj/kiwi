/**
 * 商家连接器（「Kiwi 商家运营」）包 ↔ 实现 的契约锁定。
 *
 * 平台解析以运行时 tools/list 为准，包里的 tools 只是声明；但声明必须与实现
 * 全等，否则会出现「文档/声明里有的工具实际没有」。同 source 的回调策略、
 * 入口域名与买方连接器分离也在这里锁死。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildCatalogTools } from "../src/merchant-gateway/catalog-tools.js";
import {
  DEFAULT_MERCHANT_CONNECTOR_SOURCE,
  defaultGatewayDataDir,
} from "../src/merchant-gateway/cli.js";
import { workbuddyCallbackUri } from "../src/auth/merchant-oauth.js";

const bundleDir = path.join(
  process.cwd(),
  "integrations/hosts/workbuddy/kiwi-merchant-gateway-connector",
);

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(bundleDir, relative), "utf8")) as Record<
    string,
    unknown
  >;
}

/** 从实现取工具声明（与入口 tools/list 同源）。 */
function implementedTools() {
  return buildCatalogTools("mkt_placeholder", {
    client: {} as never,
    credentials: { get: () => undefined, put: () => undefined, delete: () => undefined },
    portalBaseUrl: "https://catalog.kiwi.harrylabsj.com",
  }).listTools(undefined);
}

describe("商家连接器包：声明与实现一致", () => {
  it("mcp.json 声明的工具与 catalog-tools.ts 实现全等（名称/描述/参数）", () => {
    const mcp = readJson("mcp.json") as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    const implemented = (
      implementedTools() as Array<{
        name: string;
        description: string;
        inputSchema: unknown;
      }>
    )
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const declared = mcp.tools.slice().sort((a, b) => a.name.localeCompare(b.name));
    expect(declared.map((t) => t.name)).toEqual(implemented.map((t) => t.name));
    expect(declared).toEqual(implemented);
    expect(declared.length).toBeGreaterThan(0);
  });

  it("一个连接器一个 MCP Server；OAuth 包不带 Authorization 头", () => {
    const mcp = readJson("mcp.json") as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const servers = Object.entries(mcp.mcpServers);
    expect(servers).toHaveLength(1);
    const [, server] = servers[0]!;
    expect(server.type).toBe("streamableHttp");
    expect(server.timeout).toBe(30_000);
    expect("headers" in server).toBe(false);
    expect("auth_mode" in server).toBe(false);
  });

  it("入口地址是 https 网关地址，不是商家自有实例域名", () => {
    const mcp = readJson("mcp.json") as { mcpServers: Record<string, { url: string }> };
    const url = new URL(Object.values(mcp.mcpServers)[0]!.url);
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/mcp");
    expect(url.hostname === "veyquo.com" || url.hostname.endsWith(".veyquo.com")).toBe(false);
  });
});

describe("商家连接器包：身份与回调与买方分离", () => {
  it("六工具版本不沿用已提交的 v1.0.0 标识，也不宣传实例能力", () => {
    const meta = readJson("connector-meta.json") as {
      version: string;
      description_zh: string;
      description_en: string;
    };
    const mcp = readJson("mcp.json") as { tools: unknown[] };
    expect(mcp.tools).toHaveLength(6);
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+$/);
    const [major = 0, minor = 0] = meta.version.split(".").map(Number);
    expect(major > 1 || (major === 1 && minor >= 1)).toBe(true);
    expect(meta.description_zh).not.toMatch(/绑定自有.*服务后|查看商品与库存|跟进买家询价/);
    expect(meta.description_en).not.toMatch(/after connecting your own|follow buyer inquiries/);
  });

  it("source 与入口 CLI 的缺省 source 一致", () => {
    const meta = readJson("connector-meta.json");
    expect(meta.source).toBe(DEFAULT_MERCHANT_CONNECTOR_SOURCE);
    expect(meta.source).toBe("kiwi-merchant");
  });

  it("OAuth 回调按该 source 派生，且与买方 kiwi-sourcing 不同", () => {
    const merchantCallback = workbuddyCallbackUri(String(readJson("connector-meta.json").source));
    expect(merchantCallback).toBe(
      "workbuddy://workbuddy/mcp/connector%3Akiwi-merchant/oauth/callback",
    );
    expect(merchantCallback).not.toBe(workbuddyCallbackUri("kiwi-sourcing"));
  });

  it("包内不含凭据形态的字符串", () => {
    for (const file of ["connector-meta.json", "mcp.json", "icon.svg"]) {
      const text = readFileSync(path.join(bundleDir, file), "utf8");
      expect(text).not.toMatch(/cmt_[A-Za-z0-9_-]{16,}/);
      expect(text).not.toMatch(/mcp_at_[A-Za-z0-9_-]{16,}/);
      expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/);
    }
  });
});

describe("网关数据目录约定", () => {
  it("缺省在 <cwd>/.kiwi/gateway（与部署说明一致）", () => {
    expect(defaultGatewayDataDir("/opt/kiwi-gateway")).toBe("/opt/kiwi-gateway/.kiwi/gateway");
  });
});
