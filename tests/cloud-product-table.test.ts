/**
 * 文件式商品源（设计 §10.1「商家上传商品表」路径）+ 与云端入口的集成。
 *
 * 覆盖：
 *   - 严格解析（结构/类型/状态/价格），任何问题即拒绝整表；
 *   - 租户边界（表 merchant_id 必须等于运行实例的商家）；
 *   - 过期 / 暂停 / 查无此 SKU → 不可报价（fail-closed），不产生任何价格；
 *   - mtime 热加载：商家改表即生效；
 *   - 集成：`cloud.config.json` + 商品表 → 单端口实例里真实 RFQ 得到确定性报价。
 *
 * 本文件是本地验证；平台侧仍需在真实制品上复验。
 */
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapCloudRuntime } from "../src/cloud/bootstrap.js";
import { createFileProductSource, parseProductTable, ProductTableError } from "../src/cloud/product-source.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { CAPABILITY } from "./negotiation-helpers.js";

const dirs: string[] = [];
const servers: Server[] = [];
const instances: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close().catch(() => undefined);
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

function tempDir(prefix: string): string {
  const root = path.join(homedir(), ".kiwi-cloud-test");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, `${prefix}${process.pid}-`));
  dirs.push(dir);
  return dir;
}

const SKU = "table-sku-1";
const MERCHANT = "merchant-001";

function productTable(overrides: Partial<Record<string, unknown>> = {}): string {
  const now = Date.now();
  return JSON.stringify({
    schema_version: "0.1.2",
    merchant_id: MERCHANT,
    source: "test_fixture",
    generated_at: new Date(now).toISOString(),
    products: [
      {
        sku: SKU,
        title: "商品表测试商品",
        currency: "CNY",
        unit: "piece",
        price: 128.5,
        moq: 2,
        supply_note: "现货",
        updated_at: new Date(now - 60_000).toISOString(),
        valid_until: new Date(now + 3_600_000).toISOString(),
        status: "active",
        stock: 20,
        test: true,
        ...overrides,
      },
    ],
  });
}

describe("商品表解析与查询（fail-closed）", () => {
  it("合法商品表可解析，且保留测试商品标记", () => {
    const table = parseProductTable(JSON.parse(productTable()), "inline");
    expect(table.merchant_id).toBe(MERCHANT);
    expect(table.source).toBe("test_fixture");
    expect(table.products[0]?.test).toBe(true);
    expect(table.products[0]?.price).toBe(128.5);
  });

  it("结构问题一律拒绝整表（不部分解析）", () => {
    for (const bad of [
      { products: [] },
      { products: [{ sku: SKU }] },
      {
        schema_version: "0.1.2",
        merchant_id: MERCHANT,
        generated_at: new Date().toISOString(),
        products: [{ ...JSON.parse(productTable()).products[0], status: "unknown" }],
      },
      {
        schema_version: "0.1.2",
        merchant_id: MERCHANT,
        generated_at: new Date().toISOString(),
        products: [{ ...JSON.parse(productTable()).products[0], price: -1 }],
      },
      {
        schema_version: "0.1.2",
        merchant_id: MERCHANT,
        generated_at: new Date().toISOString(),
        products: [{ ...JSON.parse(productTable()).products[0], valid_until: "not-a-date" }],
      },
    ]) {
      expect(() => parseProductTable(bad, "inline")).toThrow(ProductTableError);
    }
  });

  it("租户不一致拒绝加载；过期/暂停/查无 SKU 都不可报价", () => {
    const dir = tempDir("kiwi-table-");
    const file = path.join(dir, "products.json");
    writeFileSync(file, productTable());

    const handle = createFileProductSource({ file, merchantId: MERCHANT });
    expect(handle.describeSku(SKU)).toEqual({ available: true });

    const otherTenant = createFileProductSource({ file, merchantId: "merchant-999" });
    expect(otherTenant.describeSku(SKU).code).toBe("PRODUCT_TABLE_TENANT_MISMATCH");

    // 过期
    writeFileSync(
      file,
      productTable({ valid_until: new Date(Date.now() - 1000).toISOString() }),
    );
    utimesSync(file, new Date(), new Date());
    expect(createFileProductSource({ file, merchantId: MERCHANT }).describeSku(SKU).code).toBe(
      "PRODUCT_EXPIRED",
    );

    // 暂停
    writeFileSync(file, productTable({ status: "paused" }));
    utimesSync(file, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    expect(createFileProductSource({ file, merchantId: MERCHANT }).describeSku(SKU).code).toBe(
      "PRODUCT_PAUSED",
    );

    // 查无此 SKU
    expect(handle.describeSku("no-such-sku").code).toBe("PRODUCT_NOT_IN_TABLE");
  });

  it("表不可读 → 明确错误码（不是空结果）", async () => {
    const dir = tempDir("kiwi-table-missing-");
    const handle = createFileProductSource({
      file: path.join(dir, "nope.json"),
      merchantId: MERCHANT,
    });
    expect(handle.describeSku(SKU).code).toBe("PRODUCT_TABLE_UNREADABLE");
    await expect(handle.source.getProduct(SKU)).rejects.toBeInstanceOf(ProductTableError);
  });

  it("过期商品查询抛错（报价路径 fail-closed）", async () => {
    const dir = tempDir("kiwi-table-expired-");
    const file = path.join(dir, "products.json");
    writeFileSync(file, productTable({ valid_until: new Date(Date.now() - 1000).toISOString() }));
    const handle = createFileProductSource({ file, merchantId: MERCHANT });
    await expect(handle.source.getProduct(SKU)).rejects.toMatchObject({ code: "PRODUCT_EXPIRED" });
  });
});

// ---------------------------------------------------------------------------
// 集成：配置文件 + 商品表 → 单端口实例 → 真实 RFQ 确定性报价
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  const address = s.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

function writePilotFiles(dataDir: string, options: { validUntil?: string } = {}) {
  const profilePath = path.join(dataDir, "merchant.yaml");
  writeFileSync(
    profilePath,
    [
      "runtime_version: 0.6.0",
      "protocol_version: shopping.negotiation/0.1",
      `agent_id: merchant-agent:${MERCHANT}`,
      "role: merchant",
      `owner_id: ${MERCHANT}`,
      "commerce:",
      "  base_url: http://127.0.0.1:1",
      "  token_env: KIWI_TEST_COMMERCE_TOKEN",
      "  backend: local_marketplace",
      "  allow_demo_price_fallback: false",
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
      "  min_unit_price_private: 100.00",
      "  max_auto_discount_percent: 10",
      "  inventory_source: marketplace",
      "  quote_ttl_seconds: 300",
      "  auto_negotiate: true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const productsFile = path.join(dataDir, "products.json");
  writeFileSync(
    productsFile,
    productTable(
      options.validUntil !== undefined ? { valid_until: options.validUntil } : {},
    ),
  );
  return { profilePath, productsFile };
}

function writeConfigFile(artifactDir: string, values: Record<string, unknown>): string {
  const file = path.join(artifactDir, "cloud.config.json");
  writeFileSync(file, `${JSON.stringify(values, null, 2)}\n`);
  return file;
}

async function sendRfq(base: string, messageId: string) {
  const card = (await (await fetch(`${base}/.well-known/agent-card.json`)).json()) as {
    capabilities?: { extensions?: { uri?: string }[] };
  };
  const extensionUri = card.capabilities?.extensions?.[0]?.uri;
  const res = await fetch(`${base}/a2a`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "A2A-Version": "1.0",
      ...(extensionUri !== undefined ? { "A2A-Extensions": extensionUri } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: messageId,
      method: "SendMessage",
      params: {
        message: {
          role: "ROLE_USER",
          parts: [
            {
              data: {
                knp_envelope: finalizeEnvelope({
                  capability: CAPABILITY,
                  protocol_version: "1.0",
                  negotiation_id: "neg_table",
                  exchange_id: "ex_table",
                  message_id: messageId,
                  actor: "buyer",
                  action: "rfq",
                  created_at: new Date().toISOString(),
                  payload: {
                    type: "rfq",
                    items: [{ sku: SKU, quantity: { value: 5, unit: "piece" } }],
                  },
                }),
              },
              mediaType: "application/json",
            },
          ],
          messageId,
        },
      },
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("集成：配置文件 + 商品表驱动的云端实例", () => {
  it("配置全部来自 cloud.config.json（仅 PORT 来自环境）：ready 且报价取表内价格", async () => {
    const artifactDir = tempDir("kiwi-pilot-artifact-");
    const dataDir = tempDir("kiwi-pilot-data-");
    const { profilePath, productsFile } = writePilotFiles(dataDir);
    const port = await freePort();
    writeConfigFile(artifactDir, {
      public_origin: "https://pilot-runtime.example.app.workbuddy.host",
      data_dir: dataDir,
      profile: profilePath,
      products_file: productsFile,
      readiness_sku: SKU,
      a2a_auth: { mode: "signature" },
    });

    const instance = await bootstrapCloudRuntime({
      env: { PORT: String(port) }, // 平台只注入 PORT
      artifactRoot: artifactDir,
      log: () => {},
    });
    instances.push(instance);

    const base = `http://127.0.0.1:${port}`;
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);

    const { status, body } = await sendRfq(base, "msg_table_quote");
    expect(status).toBe(200);
    const serialized = JSON.stringify(body);
    // 表内价 128.50 元 → 12850 minor（确定性：等于表内价，未被模型或折扣改写）
    expect(serialized).toContain('"amount_minor":12850');
    expect(serialized).toContain('"currency":"CNY"');
  });

  it("商品过期：readyz 未就绪且 RFQ 明确 decline（无任何价格）", async () => {
    const artifactDir = tempDir("kiwi-pilot-expired-");
    const dataDir = tempDir("kiwi-pilot-expired-data-");
    const { profilePath, productsFile } = writePilotFiles(dataDir, {
      validUntil: new Date(Date.now() - 1000).toISOString(),
    });
    const port = await freePort();
    writeConfigFile(artifactDir, {
      public_origin: "https://pilot-runtime.example.app.workbuddy.host",
      data_dir: dataDir,
      profile: profilePath,
      products_file: productsFile,
      readiness_sku: SKU,
      a2a_auth: { mode: "signature" },
    });

    const instance = await bootstrapCloudRuntime({
      env: { PORT: String(port) },
      artifactRoot: artifactDir,
      log: () => {},
    });
    instances.push(instance);

    const base = `http://127.0.0.1:${port}`;
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    const readyBody = (await ready.json()) as { checks: Record<string, { code?: string }> };
    expect(readyBody.checks.products?.code).toBe("PRODUCT_EXPIRED");

    const { body } = await sendRfq(base, "msg_table_expired");
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("temporarily_unavailable");
    expect(serialized).not.toMatch(/amount_minor/);
  });

  it("配置文件里声明 bearer（需要令牌）→ 拒绝：密钥不进部署包", async () => {
    const artifactDir = tempDir("kiwi-pilot-bearer-");
    const dataDir = tempDir("kiwi-pilot-bearer-data-");
    const { profilePath, productsFile } = writePilotFiles(dataDir);
    const port = await freePort();
    writeConfigFile(artifactDir, {
      public_origin: "https://pilot-runtime.example.app.workbuddy.host",
      data_dir: dataDir,
      profile: profilePath,
      products_file: productsFile,
      a2a_auth: { mode: "bearer" },
    });
    await expect(
      bootstrapCloudRuntime({ env: { PORT: String(port) }, artifactRoot: artifactDir, log: () => {} }),
    ).rejects.toMatchObject({ code: "CONFIG_FILE_AUTH_UNSUPPORTED" });
  });
});
