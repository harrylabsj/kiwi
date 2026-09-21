/**
 * M4 / T012：服务降级时**停止新的询价**，行为经真实 HTTP 面验证。
 *
 * 两种错法都很糟：
 *   - 只做界面提示、A2A 照收：商家以为停了，实际还在接单；
 *   - 一律拒绝：把正在谈的会话也掐死，等于把故障扩大成"得罪所有在谈客户"。
 *
 * 因此这里验的是「组件降级 → 新询价被拒且错误码可辨认」，同时用
 * `TaskRegistry.findByContextId` 的用例证明"既有会话"这条路径的判定依据存在。
 */
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bootstrapCloudRuntime } from "../src/cloud/bootstrap.js";
import { TaskRegistry } from "../src/a2a/server/task-registry.js";
import { JSONRPC_CODES } from "../src/a2a/server/errors.js";
import { KNP_EXTENSION_PATH } from "../src/a2a/v1/headers.js";

const SKU = "sku-avail-1";
const BEARER = "avail-bearer-token";
const dirs: string[] = [];
const servers: Server[] = [];
const instances: Array<{ close: () => Promise<void> }> = [];

/**
 * 状态目录**不能**放系统临时目录：云端启动会以 DATA_DIR_EPHEMERAL 拒绝
 * （重启即丢的状态目录是配置错误，不是测试细节）。与其它云端用例同口径。
 */
function tmp(): string {
  const root = path.join(homedir(), ".kiwi-cloud-test");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, `kiwi-avail-${process.pid}-`));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.close().catch(() => undefined);
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

/** 极小的商品源：可用时返回一个有效商品；被关掉后连接失败 → 就绪降级。 */
async function startCommerce(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url?.includes(SKU)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          sku: SKU,
          title: "Availability Test Product",
          unit_price: { amount_minor: 12850, currency: "CNY" },
          inventory: 50,
          available: true,
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function writeProfile(dataDir: string, commerceUrl: string): string {
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

async function sendInquiry(origin: string, messageId: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}/a2a`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${BEARER}`,
      "a2a-version": "1.0",
      "a2a-extensions": `https://t012-runtime.example.app.workbuddy.host${KNP_EXTENSION_PATH}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: messageId,
      method: "SendMessage",
      params: {
        message: {
          role: "user",
          messageId,
          parts: [{ kind: "text", text: "请问库存和价格？" }],
        },
      },
    }),
  });
  return { status: response.status, body: await response.json() };
}

describe("T012：显式暂停 → 停止新询价（真实 HTTP 面）", () => {
  it("声明为 PAUSED 时，新询价被拒且错误可辨认、不泄漏私密信息", async () => {
    const commerce = await startCommerce();
    const dataDir = tmp();
    const profilePath = writeProfile(dataDir, commerce.url);
    const port = await freePort();
    const instance = await bootstrapCloudRuntime({
      env: {
        PORT: String(port),
        KIWI_CLOUD_PUBLIC_ORIGIN: "https://t012-runtime.example.app.workbuddy.host",
        KIWI_CLOUD_DATA_DIR: dataDir,
        KIWI_CLOUD_PROFILE: profilePath,
        KIWI_CLOUD_A2A_AUTH: "bearer:KIWI_T012_TOKEN",
        KIWI_T012_TOKEN: BEARER,
        // 操作者显式声明服务状态（M4 §5.4/T012）——缺省不设闸门
        KIWI_CLOUD_SERVICE_STATE: "PAUSED",
      },
      artifactRoot: "/workspace",
      log: () => {},
    });
    instances.push(instance);
    const origin = `http://127.0.0.1:${port}`;

    const refused = await sendInquiry(origin, "msg-avail-paused");
    expect(JSON.stringify(refused.body)).toContain("not accepting new inquiries");
    const error = (refused.body as { error?: { code: number; data?: unknown; message: string } })
      .error;
    // 对端必须能把这个错误与"参数错/方法不存在"区分开：它应当重试或换通道，而不是改请求
    expect(error?.code).toBe(JSONRPC_CODES.UNAVAILABLE);
    expect(error?.message).toContain("PAUSED");
    // 只暴露状态与失败组件名，不泄漏商家私密信息
    expect(error?.message).not.toContain("unit_price");
    expect(error?.message).not.toContain("min_unit_price_private");
    expect(JSON.stringify(error?.data ?? {})).not.toMatch(/\d{3,}/);
  }, 30_000);
});

describe("既有会话的判定依据", () => {
  it("TaskRegistry 能按 contextId 找回既有任务（新询价 vs 续聊的分界线）", () => {
    const registry = new TaskRegistry();
    registry.set(
      "task-existing",
      { id: "task-existing", status: { state: "working" }, contextId: "ctx-1" },
      { identity: "buyer-1", identityVerified: true },
    );
    expect(registry.findByContextId("ctx-1")?.id).toBe("task-existing");
    expect(registry.findByContextId("ctx-unknown")).toBeUndefined();
    expect(registry.findByContextId("")).toBeUndefined();
  });
});
