/**
 * 云端单实例启动（M1 薄切片）：单端口里同时提供 A2A 面、商家面与探针。
 *
 * 覆盖：
 *   - T013 端口占用 → 启动失败，不换端口；
 *   - T014 缺持久状态目录 / 状态目录被制品覆盖 → 拒绝启动；
 *   - T015 弱认证 → 拒绝启动（配置层）；
 *   - T016 单端口路由：Card / 后台 / A2A / 平台保留路径分流；
 *   - 就绪语义：真实商品可读 + 存储可写 + 策略已装载 → ready；探针 SKU 未配置 → not ready。
 *
 * 本文件是**本机故障注入验证**，不代替真实平台/真实制品的实机证据。
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapCloudRuntime, CloudStartupError } from "../src/cloud/bootstrap.js";
import { CloudConfigError } from "../src/cloud/config.js";

const dirs: string[] = [];
const servers: Server[] = [];
const envBackup: Record<string, string | undefined> = {};

function trackEnv(key: string, value: string | undefined): void {
  if (!(key in envBackup)) envBackup[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(async () => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete envBackup[k];
  }
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        }),
    ),
  );
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * 状态目录必须落在系统临时目录之外（配置层硬规则：临时目录重启即丢，
 * 云端拒绝）。测试用 HOME 下的短命目录，afterEach 清理。
 */
function tempDir(prefix: string): string {
  const root = path.join(homedir(), ".kiwi-cloud-test");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, `${prefix}${process.pid}-`));
  dirs.push(dir);
  return dir;
}

/** 假 shopping-cli：只提供 /products/{sku} 公开读（就绪检查与报价共用）。 */
async function startFakeCommerce(sku: string): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === `/products/${sku}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          product: {
            sku,
            merchant_id: "merchant-001",
            title: "M1 测试商品",
            description: "",
            category: "",
            tags: [],
            price: 100,
            currency: "CNY",
            stock: 10,
            delivery_attributes: [],
            paused: false,
          },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

const TEST_SKU = "test-sku-m1";

function writeCloudProfile(
  dataDir: string,
  commerceUrl: string,
  options: { demoPriceFallback?: boolean } = {},
): string {
  const profilePath = path.join(dataDir, "merchant.yaml");
  writeFileSync(
    profilePath,
    [
      "runtime_version: 0.6.0",
      "protocol_version: shopping.negotiation/0.1",
      "agent_id: merchant-agent:merchant-001",
      "role: merchant",
      "owner_id: merchant-001",
      "commerce:",
      `  base_url: ${commerceUrl}`,
      "  token_env: KIWI_TEST_COMMERCE_TOKEN",
      "  backend: local_marketplace",
      // 云端生产禁演示价回退：profile 打开时启动必须失败（T018 的前置约束）。
      `  allow_demo_price_fallback: ${options.demoPriceFallback === true ? "true" : "false"}`, 
      "model:",
      "  provider: fake",
      "  model: fake-merchant-model",
      "runtime:",
      "  mode: once",
      "  poll_interval_seconds: 5",
      "  turn_timeout_seconds: 90",
      "  max_model_steps: 4",
      "  max_retries: 2",
      "merchant_policy:",
      "  min_unit_price_private: 80.00",
      "  max_auto_discount_percent: 10",
      "  inventory_source: marketplace",
      "  quote_ttl_seconds: 300",
      "  auto_negotiate: true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return profilePath;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  const address = s.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

function cloudEnv(options: {
  port: number;
  dataDir: string;
  profilePath: string;
  auth?: string;
  sku?: string;
}): Record<string, string | undefined> {
  return {
    PORT: String(options.port),
    KIWI_CLOUD_PUBLIC_ORIGIN: "https://m1-runtime.example.app.workbuddy.host",
    KIWI_CLOUD_DATA_DIR: options.dataDir,
    KIWI_CLOUD_PROFILE: options.profilePath,
    KIWI_CLOUD_A2A_AUTH: options.auth ?? "bearer:KIWI_TEST_A2A_TOKEN",
    KIWI_TEST_A2A_TOKEN: "test-bearer-token",
    ...(options.sku !== undefined ? { KIWI_CLOUD_READINESS_SKU: options.sku } : {}),
  };
}

describe("云端单实例启动（T013/T014/T015/T016）", () => {
  it("单端口同时提供 Card / 商家面 / 探针，平台保留路径不被接管", async () => {
    const commerce = await startFakeCommerce(TEST_SKU);
    const dataDir = tempDir("kiwi-cloud-ok-");
    const profilePath = writeCloudProfile(dataDir, commerce);
    trackEnv("KIWI_COMMERCE_URL", commerce);
    const port = await freePort();
    const instance = await bootstrapCloudRuntime({
      env: cloudEnv({ port, dataDir, profilePath, sku: TEST_SKU }),
      artifactRoot: "/workspace",
      log: () => {},
    });
    try {
      const base = `http://127.0.0.1:${port}`;

      // A2A 面：公开 Card（真实能力来自实际配置的端点与路径）。
      const card = await fetch(`${base}/.well-known/agent-card.json`);
      expect(card.status).toBe(200);
      const cardBody = (await card.json()) as { name?: string; url?: string };
      expect(cardBody.name).toBe("Kiwi A2A Merchant");

      // 商家面：/admin/login 可达（会话鉴权在 handler 内部，公开路径给人脸看）。
      const admin = await fetch(`${base}/admin/login`);
      expect(admin.status).toBe(200);
      expect(admin.headers.get("content-type")).toContain("text/html");

      // 探针：/livez 最小应答；/readyz 反映真实就绪（商品可读 + 存储可写 + 策略装载）。
      expect((await fetch(`${base}/livez`)).status).toBe(200);
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(200);
      const readyBody = (await ready.json()) as { ready: boolean; checks: Record<string, { ok: boolean }> };
      expect(readyBody.ready).toBe(true);
      expect(readyBody.checks.products?.ok).toBe(true);
      expect(readyBody.checks.storage?.ok).toBe(true);

      // 平台数据面路径：业务不接管。
      const reserved = await fetch(`${base}/.cloud/database/rest/items`);
      expect(reserved.status).toBe(404);
      expect((await reserved.json()) as { error: string }).toMatchObject({ error: "reserved_path" });

      // 绑定挑战（M2 已实装）：空 body / 结构不完整 → 400，绝不空实现。
      const challenge = await fetch(`${base}/control/challenge`, { method: "POST" });
      expect(challenge.status).toBe(400);
      expect((await challenge.json()) as { error?: string }).toMatchObject({ error: "invalid_challenge" });
    } finally {
      await instance.close();
    }
  });

  it("状态目录未配置探针 SKU 时 readyz 不冒充就绪（但进程仍存活）", async () => {
    const commerce = await startFakeCommerce(TEST_SKU);
    const dataDir = tempDir("kiwi-cloud-nosku-");
    const profilePath = writeCloudProfile(dataDir, commerce);
    trackEnv("KIWI_COMMERCE_URL", commerce);
    const port = await freePort();
    const instance = await bootstrapCloudRuntime({
      env: cloudEnv({ port, dataDir, profilePath }),
      artifactRoot: "/workspace",
      log: () => {},
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/livez`)).status).toBe(200);
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(503);
      const body = (await ready.json()) as { checks: Record<string, { code?: string }> };
      expect(body.checks.products?.code).toBe("PRODUCTS_PROBE_SKU_UNSET");
    } finally {
      await instance.close();
    }
  });

  it("端口被占用 → 启动失败且不换端口（T013）", async () => {
    const commerce = await startFakeCommerce(TEST_SKU);
    const dataDir = tempDir("kiwi-cloud-busy-");
    const profilePath = writeCloudProfile(dataDir, commerce);
    trackEnv("KIWI_COMMERCE_URL", commerce);
    const port = await freePort();
    const blocker = createServer((_req, res) => res.end());
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(port, "0.0.0.0", () => resolve()));

    await expect(
      bootstrapCloudRuntime({
        env: cloudEnv({ port, dataDir, profilePath, sku: TEST_SKU }),
        artifactRoot: "/workspace",
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: "PORT_IN_USE" });
  });

  it("弱认证配置在云端被拒绝（T015）", async () => {
    const dataDir = tempDir("kiwi-cloud-weakauth-");
    const profilePath = writeCloudProfile(dataDir, "http://127.0.0.1:1");
    const port = await freePort();
    await expect(
      bootstrapCloudRuntime({
        env: cloudEnv({ port, dataDir, profilePath, auth: "none" }),
        artifactRoot: "/workspace",
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(CloudConfigError);
  });

  it("状态目录含制品文件（被 deploy 覆盖）→ 拒绝启动（T014）", async () => {
    const dataDir = tempDir("kiwi-cloud-clobber-");
    const profilePath = writeCloudProfile(dataDir, "http://127.0.0.1:1");
    writeFileSync(path.join(dataDir, "package.json"), "{}");
    const port = await freePort();
    await expect(
      bootstrapCloudRuntime({
        env: cloudEnv({ port, dataDir, profilePath }),
        artifactRoot: "/workspace",
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(CloudStartupError);
  });

  it("T043：A2A 侧身份不得调用商家管理与策略接口（会话门 + 无任何私密数据）", async () => {
    const commerce = await startFakeCommerce(TEST_SKU);
    const dataDir = tempDir("kiwi-cloud-admin-");
    const profilePath = writeCloudProfile(dataDir, commerce);
    trackEnv("KIWI_COMMERCE_URL", commerce);
    const port = await freePort();
    const instance = await bootstrapCloudRuntime({
      env: cloudEnv({ port, dataDir, profilePath, sku: TEST_SKU }),
      artifactRoot: "/workspace",
      log: () => {},
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      // 管理面：未持会话一律被会话门挡住（303 → 登录页），不返回任何业务数据。
      for (const path of ["/admin/pending", "/merchant/api/policy", "/merchant/api/status", "/admin/rfq"]) {
        const res = await fetch(`${base}${path}`, { redirect: "manual" });
        expect([302, 303]).toContain(res.status);
        const body = await res.text();
        expect(body).not.toMatch(/price_floors|min_unit_price_private|amount_minor/);
      }
      // 提交审批同样需要会话（POST 亦被拒，不可能凭 A2A 身份批准任何写命令）。
      const decision = await fetch(`${base}/admin/decision`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "command_id=x&decision=approve&confirmation=y",
      });
      expect([302, 303]).toContain(decision.status);
      // A2A 面没有任何 approve 动作（KNP 词表内不存在审批动作）。
      const a2a = await fetch(`${base}/a2a`, {
        method: "POST",
        headers: { "content-type": "application/json", "A2A-Version": "1.0" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "t043",
          method: "SendMessage",
          params: {
            message: {
              role: "ROLE_USER",
              parts: [{ data: { knp_envelope: { action: "approve", capability: "x" } }, mediaType: "application/json" }],
              messageId: "msg_t043",
            },
          },
        }),
      });
      const a2aBody = await a2a.text();
      expect(a2aBody).not.toContain("agreement");
      expect(a2aBody).not.toMatch(/amount_minor/);
    } finally {
      await instance.close();
    }
  });

  it("演示价回退开启的 profile → 拒绝启动", async () => {
    const dataDir = tempDir("kiwi-cloud-demo-");
    const profilePath = writeCloudProfile(dataDir, "http://127.0.0.1:1", {
      demoPriceFallback: true,
    });
    const port = await freePort();
    await expect(
      bootstrapCloudRuntime({
        env: cloudEnv({ port, dataDir, profilePath }),
        artifactRoot: "/workspace",
        log: () => {},
      }),
    ).rejects.toMatchObject({ code: "DEMO_PRICE_FALLBACK_FORBIDDEN" });
  });
});
