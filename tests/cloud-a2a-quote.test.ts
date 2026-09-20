/**
 * T018（M1）：关闭模型，用真实（测试）商品走 A2A 1.0 Wire Profile 发 RFQ，
 * 由**确定性策略**返回协议有效报价。
 *
 * 断言重点：
 *   - 请求/响应是 A2A 1.0 形状（SendMessage + 大写 TaskState），不是 legacy 帧；
 *   - 报价金额来自商品源的 list 价，且**永不低于商家私有底价**（无 LLM 参与）；
 *   - 商品源不可得时明确 decline，不用演示价兜底。
 *
 * 本文件是本地验证；平台侧 T018 仍需在真实制品与真实账号上复验。
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapCloudRuntime } from "../src/cloud/bootstrap.js";
import { finalizeEnvelope } from "../src/negotiation/domain/envelope.js";
import { CAPABILITY } from "./negotiation-helpers.js";

const servers: Server[] = [];
const dirs: string[] = [];
const envBackup: Record<string, string | undefined> = {};
const instances: Array<{ close: () => Promise<void> }> = [];

function trackEnv(key: string, value: string | undefined): void {
  if (!(key in envBackup)) envBackup[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close().catch(() => undefined);
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

function tempDir(prefix: string): string {
  const root = path.join(homedir(), ".kiwi-cloud-test");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, `${prefix}${process.pid}-`));
  dirs.push(dir);
  return dir;
}

const SKU = "sku-quote-001";
const BEARER = "t018-bearer-token";

/** 假商品源：list 价 unitPriceMajor 元（major），无库存缺口。 */
async function startFakeCommerce(priceMajor: number, available = true): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (available && req.method === "GET" && url.pathname === `/products/${SKU}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          product: {
            sku: SKU,
            merchant_id: "merchant-001",
            title: "T018 授权测试商品",
            description: "",
            category: "",
            tags: [],
            price: priceMajor,
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

function writeProfile(dataDir: string, commerceUrl: string, floorMajor = 80.0): string {
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
      `  min_unit_price_private: ${floorMajor.toFixed(2)}`,
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

async function startInstance(priceMajor: number, floorMajor = 80.0, available = true) {
  const commerce = await startFakeCommerce(priceMajor, available);
  const dataDir = tempDir("kiwi-t018-");
  const profilePath = writeProfile(dataDir, commerce, floorMajor);
  trackEnv("KIWI_COMMERCE_URL", commerce);
  const port = await freePort();
  const instance = await bootstrapCloudRuntime({
    env: {
      PORT: String(port),
      KIWI_CLOUD_PUBLIC_ORIGIN: "https://t018-runtime.example.app.workbuddy.host",
      KIWI_CLOUD_DATA_DIR: dataDir,
      KIWI_CLOUD_PROFILE: profilePath,
      KIWI_CLOUD_A2A_AUTH: `bearer:KIWI_T018_TOKEN`,
      KIWI_T018_TOKEN: BEARER,
      KIWI_CLOUD_READINESS_SKU: SKU,
    },
    artifactRoot: "/workspace",
    log: () => {},
  });
  instances.push(instance);
  return { base: `http://127.0.0.1:${port}`, dataDir };
}

function rfqEnvelope(messageId: string) {
  return finalizeEnvelope({
    capability: CAPABILITY,
    protocol_version: "1.0",
    negotiation_id: "neg_t018",
    exchange_id: "ex_t018",
    message_id: messageId,
    actor: "buyer",
    action: "rfq",
    created_at: new Date().toISOString(),
    payload: {
      type: "rfq",
      items: [{ sku: SKU, quantity: { value: 10, unit: "piece" } }],
    },
  });
}

/** 在任意深度的响应里取回 KNP envelope（1.0 任务把结果放在 artifact/status.message）。 */
function findEnvelope(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEnvelope(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const knp = record["knp_envelope"];
  if (knp !== null && typeof knp === "object") return knp as Record<string, unknown>;
  for (const item of Object.values(record)) {
    const found = findEnvelope(item);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 协商扩展 URI **取自运行中实例的 Agent Card**（不是硬编码本地地址）：
 * 云端广告地址是公网 origin，扩展声明也随之在公网地址上；硬编码会让服务端
 * 按 fail-closed 拒绝（unsupported A2A extension）。
 */
async function declaredExtensionUri(base: string): Promise<string> {
  const card = (await (await fetch(`${base}/.well-known/agent-card.json`)).json()) as {
    capabilities?: { extensions?: { uri?: string }[] };
  };
  const uri = card.capabilities?.extensions?.[0]?.uri;
  if (uri === undefined) throw new Error("Agent Card 未声明协商扩展 URI");
  return uri;
}

async function sendRfq(base: string, messageId: string, token = BEARER) {
  const extensionUri = await declaredExtensionUri(base);
  const res = await fetch(`${base}/a2a`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "A2A-Version": "1.0",
      "A2A-Extensions": extensionUri,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `t018-${messageId}`,
      method: "SendMessage",
      params: {
        message: {
          role: "ROLE_USER",
          parts: [{ data: { knp_envelope: rfqEnvelope(messageId) }, mediaType: "application/json" }],
          messageId,
        },
      },
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

interface OfferTerms {
  items?: { sku?: string; unit_price?: { amount_minor?: number; currency?: string } }[];
  valid_until?: string;
}

describe("T018：无 LLM 的真实商品确定性报价（A2A 1.0）", () => {
  it("RFQ → 确定性 offer：价格取商品源 list 价，协议形状为 1.0 任务", async () => {
    const { base } = await startInstance(100.0, 80.0);
    const { status, body } = await sendRfq(base, "msg_t018_list");
    expect(status).toBe(200);

    const task = (body["result"] as Record<string, unknown> | undefined)?.["task"] as
      | { status?: { state?: string } }
      | undefined;
    // KNP 相位、A2A 任务状态、商家审批状态是三套状态（设计 §13.2）：发出去的
    // offer 在等买家回应，A2A 任务停在非终态是正常语义，这里只排除失败。
    expect(task?.status?.state).toBeDefined();
    expect(task?.status?.state).not.toBe("TASK_STATE_FAILED");

    const envelope = findEnvelope(body["result"]);
    expect(envelope).toBeDefined();
    expect(envelope?.["action"]).toBe("offer");
    const payload = envelope?.["payload"] as { type?: string; terms?: OfferTerms } | undefined;
    expect(payload?.type).toBe("offer");
    expect(payload?.terms?.items?.[0]?.sku).toBe(SKU);
    // list 100.00 元 → offer 10000 minor（确定性：等于商品源价，未做模型折扣）
    expect(payload?.terms?.items?.[0]?.unit_price).toEqual({
      currency: "CNY",
      amount_minor: 10_000,
    });
    expect(payload?.terms?.valid_until).toBeDefined();
  });

  it("商品 list 价低于私有底价 → offer 抬到底价（绝不低于底价，且不泄露底价本身）", async () => {
    const { base } = await startInstance(50.0, 80.0);
    const { body } = await sendRfq(base, "msg_t018_floor");
    const envelope = findEnvelope(body["result"]);
    const payload = envelope?.["payload"] as { terms?: OfferTerms } | undefined;
    expect(envelope?.["action"]).toBe("offer");
    // floor 80.00 元 = 8000 minor：offer 必须 ≥ floor（此处等于 floor）
    expect(payload?.terms?.items?.[0]?.unit_price?.amount_minor).toBe(8_000);
    // 响应里不得出现底价以外的策略信息（public_message 只允许商品 note）
    expect(JSON.stringify(body)).not.toContain("min_unit_price_private");
  });

  it("商品源无此 SKU → 明确 decline，不回退演示价", async () => {
    const { base } = await startInstance(100.0, 80.0, false);
    const { body } = await sendRfq(base, "msg_t018_missing");
    const serialized = JSON.stringify(body);
    // 1.0 wire：decline 以结构化标记 + reason_code 回复，不带任何报价。
    expect(serialized).toContain('"decline":true');
    expect(serialized).toContain("temporarily_unavailable");
    expect(serialized).not.toMatch(/amount_minor/);
  });

  it("未认证请求被拒（T016 鉴权分离的 A2A 侧）", async () => {
    const { base } = await startInstance(100.0, 80.0);
    const { status } = await sendRfq(base, "msg_t018_noauth", "");
    expect([401, 403]).toContain(status);
  });
});
