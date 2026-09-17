/**
 * 商家实例自助绑定（§8.4 第一期）测试。
 *
 * 覆盖安全设计里的每条缓解：
 * - 探活 = 控制权证明：凭据错/地址不可达/非 MCP 端点/重定向 一律拒绝且不落状态；
 * - URL 策略：公网明文 http、私网字面 IP、保留主机名、非 /mcp 路径、带 userinfo/查询 拒绝；
 * - 绑定写入加密保管库 + 注册表；解绑同时清除两者；
 * - 注册表按 merchant_id 动态路由；缺凭据/地址非法时拒绝，不回退到其他商家；
 * - `/instance` 页面需商家会话，令牌不回显。
 */
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  bindInstance,
  InstanceRegistrationStore,
  probeInstance,
  unbindInstance,
} from "../src/merchant-gateway/instance-registration.js";
import { GatewayCredentialVault } from "../src/merchant-gateway/credential-vault.js";
import {
  TenantBackendError,
  TenantBackendRegistry,
} from "../src/merchant-gateway/tenant-registry.js";

const TOKEN = "instance-internal-token";
const MERCHANT = "mkt_acme_1";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn !== undefined) await fn();
  }
});

interface FakeInstance {
  url: string;
  requests: Array<{ method: string; authorization: string }>;
}

async function startFakeInstance(
  behavior: { token?: string; status?: number; redirectTo?: string; body?: unknown } = {},
): Promise<FakeInstance> {
  const requests: FakeInstance["requests"] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let rpc: { method?: string } = {};
      try {
        rpc = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { method?: string };
      } catch {
        rpc = {};
      }
      requests.push({
        method: String(rpc.method ?? ""),
        authorization: String(req.headers.authorization ?? ""),
      });
      if (behavior.redirectTo !== undefined) {
        res.writeHead(302, { location: behavior.redirectTo });
        res.end();
        return;
      }
      if (behavior.status !== undefined && behavior.status !== 200) {
        res.writeHead(behavior.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
        return;
      }
      if (String(req.headers.authorization ?? "") !== `Bearer ${behavior.token ?? TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (behavior.body !== undefined) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(behavior.body));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          rpc.method === "tools/list"
            ? {
                jsonrpc: "2.0",
                id: 1,
                result: { tools: [{ name: "kiwi_merchant_list_products" }] },
              }
            : { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "fake" } } },
        ),
      );
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return { url: `http://127.0.0.1:${port}/mcp`, requests };
}

function stack() {
  const db = new DatabaseSync(":memory:");
  cleanups.push(() => db.close());
  const registrations = new InstanceRegistrationStore({ db });
  const credentials = new GatewayCredentialVault({ db, secret: "test-secret" });
  return { db, registrations, credentials };
}

describe("探活（控制权证明）", () => {
  it("地址可达 + 凭据正确 + 是 MCP 实例才算通过", async () => {
    const instance = await startFakeInstance();
    const result = await probeInstance(instance.url, TOKEN);
    expect(result.toolCount).toBe(1);
    expect(instance.requests.map((r) => r.method)).toEqual(["initialize", "tools/list"]);
    expect(instance.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("凭据错误 / 非 MCP 端点 / 重定向 一律拒绝", async () => {
    const wrongToken = await startFakeInstance({ token: "other-token" });
    await expect(probeInstance(wrongToken.url, TOKEN)).rejects.toThrowError(/401\/403/);

    const notMcp = await startFakeInstance({ body: { hello: "world" } });
    await expect(probeInstance(notMcp.url, TOKEN)).rejects.toThrowError(/不是支持工具的 MCP 实例/);

    const redirecting = await startFakeInstance({ redirectTo: "https://evil.example/mcp" });
    await expect(probeInstance(redirecting.url, TOKEN)).rejects.toThrowError(/重定向/);

    const broken = await startFakeInstance({ status: 500 });
    await expect(probeInstance(broken.url, TOKEN)).rejects.toThrowError(/HTTP 500/);

    await expect(probeInstance("http://127.0.0.1:1/mcp", TOKEN)).rejects.toThrowError(
      /实例不可达|超时/,
    );
  });

  it("URL 策略：明文公网 / 私网字面 IP / 保留主机名 / 路径 / userinfo 全拒绝", async () => {
    for (const url of [
      "http://merchant.example.com/mcp",
      "https://10.0.0.1/mcp",
      "https://metadata.internal/mcp",
      "https://merchant.example.com/admin",
      "https://user:pass@merchant.example.com/mcp",
      "https://merchant.example.com/mcp?x=1",
      "http://127.0.0.1/mcp", // loopback 必须显式端口
    ]) {
      await expect(probeInstance(url, TOKEN)).rejects.toThrowError(TenantBackendError);
    }
    await expect(probeInstance("http://127.0.0.1:9100/mcp", "")).rejects.toThrowError(/不能为空/);
  });
});

describe("绑定与解绑", () => {
  it("绑定写入加密凭据 + 注册表；解绑同时清除", async () => {
    const instance = await startFakeInstance();
    const { registrations, credentials } = stack();
    await bindInstance(
      { registrations, credentials },
      {
        merchantId: MERCHANT,
        mcpUrl: instance.url,
        token: TOKEN,
      },
    );
    expect(registrations.get(MERCHANT)?.mcpUrl).toBe(instance.url);
    expect(credentials.get(`instance:${MERCHANT}`)?.token).toBe(TOKEN);

    // 重新绑定覆盖（同一商家单值）
    const second = await startFakeInstance();
    await bindInstance(
      { registrations, credentials },
      {
        merchantId: MERCHANT,
        mcpUrl: second.url,
        token: TOKEN,
      },
    );
    expect(registrations.get(MERCHANT)?.mcpUrl).toBe(second.url);

    expect(unbindInstance({ registrations, credentials }, MERCHANT)).toBe(true);
    expect(registrations.get(MERCHANT)).toBeUndefined();
    expect(credentials.get(`instance:${MERCHANT}`)).toBeUndefined();
  });

  it("探活失败不留下任何状态", async () => {
    const instance = await startFakeInstance({ token: "other-token" });
    const { registrations, credentials } = stack();
    await expect(
      bindInstance(
        { registrations, credentials },
        {
          merchantId: MERCHANT,
          mcpUrl: instance.url,
          token: TOKEN,
        },
      ),
    ).rejects.toThrowError(TenantBackendError);
    expect(registrations.get(MERCHANT)).toBeUndefined();
    expect(credentials.get(`instance:${MERCHANT}`)).toBeUndefined();
  });

  it("注册表写入失败时回滚刚写入的凭据（不留半绑定）", async () => {
    const instance = await startFakeInstance();
    const { credentials } = stack();
    const exploding = {
      get: () => undefined,
      upsert: () => {
        throw new Error("db write failed");
      },
      delete: () => false,
    };
    // 注入探针也必须过 URL 策略（不因测试替身而放宽）
    await expect(
      bindInstance(
        { registrations: exploding, credentials },
        { merchantId: MERCHANT, mcpUrl: "http://merchant.example.com/mcp", token: TOKEN },
      ),
    ).rejects.toThrowError(/出站策略拒绝/);
    expect(credentials.get(`instance:${MERCHANT}`)).toBeUndefined();

    await expect(
      bindInstance(
        { registrations: exploding, credentials },
        { merchantId: MERCHANT, mcpUrl: instance.url, token: TOKEN },
      ),
    ).rejects.toThrowError(/db write failed/);
    expect(credentials.get(`instance:${MERCHANT}`)).toBeUndefined();
  });
});

describe("注册表动态路由", () => {
  it("自助绑定后按 merchant_id 解析到该商家的实例与凭据", async () => {
    const instance = await startFakeInstance();
    const { registrations, credentials } = stack();
    await bindInstance(
      { registrations, credentials },
      {
        merchantId: MERCHANT,
        mcpUrl: instance.url,
        token: TOKEN,
      },
    );
    const registry = new TenantBackendRegistry(
      [],
      {},
      {
        credentials,
        dynamic: { lookup: (id) => registrations.get(id) },
      },
    );
    expect(registry.has(MERCHANT)).toBe(true);
    expect(registry.has("mkt_other")).toBe(false);
    expect(
      registry.resolve({ principal_id: `merchant:${MERCHANT}`, merchant_id: MERCHANT, scopes: [] }),
    ).toEqual({ merchantId: MERCHANT, mcpUrl: instance.url, bearerToken: TOKEN });
  });

  it("凭据缺失/地址非法时拒绝，不回退到其他商家", async () => {
    const instance = await startFakeInstance();
    const { registrations, credentials } = stack();
    registrations.upsert(MERCHANT, instance.url); // 只登记地址、没有凭据
    const registry = new TenantBackendRegistry(
      [],
      {},
      {
        credentials,
        dynamic: { lookup: (id) => registrations.get(id) },
      },
    );
    expect(() =>
      registry.resolve({ principal_id: `merchant:${MERCHANT}`, merchant_id: MERCHANT, scopes: [] }),
    ).toThrowError(/凭据未配置/);

    registrations.upsert(MERCHANT, "http://merchant.example.com/mcp"); // 地址被改坏
    credentials.put(`instance:${MERCHANT}`, TOKEN, "9999-12-31T23:59:59.999Z");
    expect(() =>
      registry.resolve({ principal_id: `merchant:${MERCHANT}`, merchant_id: MERCHANT, scopes: [] }),
    ).toThrowError(/出站策略拒绝/);

    expect(() =>
      registry.resolve({ principal_id: "merchant:x", merchant_id: "mkt_unknown", scopes: [] }),
    ).toThrowError(/尚未连接/);
  });
});
