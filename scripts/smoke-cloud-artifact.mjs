#!/usr/bin/env node
/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 云端制品冷启动冒烟（M1 A4）：按平台形态启动制品并验证单端口面。
 *
 *   node scripts/smoke-cloud-artifact.mjs [--artifact <dir>] [--json]
 *   node scripts/smoke-cloud-artifact.mjs --deploy-dir <dir>   # 按平台方式预检部署包
 *
 * `--deploy-dir` 模式最贴近平台：cwd = 部署目录、**除 PORT 外不注入任何环境
 * 变量**（其余配置全部来自部署包内的 cloud.config.json），并额外做一次真实
 * A2A RFQ 报价断言（读取配置里的 readiness_sku 与商品表价格）。
 *
 * 形态尽量贴近平台：cwd = 制品目录（平台实测 cwd=/workspace）、只经环境变量
 * 注入配置、状态目录在制品之外、单端口。检查项：
 *   1. 进程能从制品目录冷启动并监听平台端口；
 *   2. /livez 存活；/readyz ready（真实商品可读、权威存储可写、策略已装载）；
 *   3. Agent Card 可读；商家面 /admin/login 可达；
 *   4. /.cloud/* 不被业务接管；/control/challenge 明确 501（M2 未实现）；
 *   5. 关闭进程后端口释放。
 *
 * 这是**本机冒烟**，不代替平台安装/冷启动证据（G01 子检查由实机回执关闭）。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_SKU = "smoke-sku-1";

function parseArgs(argv) {
  const options = {
    artifact: path.join(REPO_ROOT, "build", "cloud-artifact"),
    deployDir: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--artifact") options.artifact = path.resolve(argv[++i]);
    else if (argv[i] === "--deploy-dir") options.deployDir = path.resolve(argv[++i]);
    else if (argv[i] === "--json") options.json = true;
    else throw new Error(`未知参数 ${argv[i]}`);
  }
  if (options.deployDir !== undefined) options.artifact = options.deployDir;
  return options;
}

async function freePort() {
  const s = createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  const address = s.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => s.close(() => resolve()));
  return port;
}

async function startFakeCommerce() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === `/products/${TEST_SKU}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          product: {
            sku: TEST_SKU,
            merchant_id: "merchant-001",
            title: "冒烟测试商品",
            description: "",
            category: "",
            tags: [],
            price: 120,
            currency: "CNY",
            stock: 5,
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

function writeProfile(dir, commerceUrl) {
  const file = path.join(dir, "merchant.yaml");
  writeFileSync(
    file,
    [
      "runtime_version: 0.6.0",
      "protocol_version: shopping.negotiation/0.1",
      "agent_id: merchant-agent:merchant-001",
      "role: merchant",
      "owner_id: merchant-001",
      "commerce:",
      `  base_url: ${commerceUrl}`,
      "  token_env: SMOKE_COMMERCE_TOKEN",
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
  return file;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待超时：${label}${lastError ? `（最后错误：${String(lastError)}）` : ""}`);
}

/** 读部署包自述（deploy-dir 模式用于断言报价与探针 SKU）。 */
function readDeployDirFacts(deployDir) {
  const configPath = path.join(deployDir, "cloud.config.json");
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const productsPath = typeof config.products_file === "string" ? config.products_file : undefined;
  // 本地预检时部署包用本机路径（--remote-root <deployDir>），这里按包内相对路径读。
  const localProducts = productsPath === undefined ? undefined : path.join(deployDir, "pilot", "products.json");
  const products =
    localProducts !== undefined && existsSync(localProducts)
      ? JSON.parse(readFileSync(localProducts, "utf8"))
      : undefined;
  return {
    readinessSku: typeof config.readiness_sku === "string" ? config.readiness_sku : undefined,
    expectedAmountMinor:
      products?.products?.[0]?.price !== undefined ? Math.round(products.products[0].price * 100) : undefined,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const deployMode = options.deployDir !== undefined;
  const entry = path.join(options.artifact, "dist", "cloud", "main.js");
  if (!existsSync(entry)) throw new Error(`制品入口不存在：${entry}`);
  const deployFacts = deployMode ? readDeployDirFacts(options.artifact) : undefined;
  const buildManifestPath = path.join(options.artifact, "build-manifest.json");
  const buildManifest = existsSync(buildManifestPath)
    ? JSON.parse(readFileSync(buildManifestPath, "utf8"))
    : undefined;

  const stateRoot = path.join(homedir(), ".kiwi-cloud-smoke");
  mkdirSync(stateRoot, { recursive: true });
  const dataDir = deployMode ? undefined : mkdtempSync(path.join(stateRoot, "run-"));
  const commerce = deployMode ? undefined : await startFakeCommerce();
  const profilePath = deployMode ? undefined : writeProfile(dataDir, commerce.url);
  const port = await freePort();

  // deploy-dir 模式：**只**注入 PORT（其余配置来自部署包内的 cloud.config.json），
  // 这是平台实际形态；本地模式用环境变量注入全部配置。
  const childEnv = deployMode
    ? { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port) }
    : {
        ...process.env,
        PORT: String(port),
        KIWI_CLOUD_PUBLIC_ORIGIN: "https://smoke-runtime.example.app.workbuddy.host",
        KIWI_CLOUD_DATA_DIR: dataDir,
        KIWI_CLOUD_PROFILE: profilePath,
        KIWI_CLOUD_A2A_AUTH: "bearer:SMOKE_A2A_TOKEN",
        SMOKE_A2A_TOKEN: "smoke-token-not-a-secret",
        KIWI_CLOUD_READINESS_SKU: TEST_SKU,
        KIWI_COMMERCE_URL: commerce.url,
      };

  const child = spawn(process.execPath, ["dist/cloud/main.js"], {
    cwd: options.artifact, // 平台实测 cwd=/workspace（制品根）
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const base = `http://127.0.0.1:${port}`;
  const checks = [];
  const record = (name, ok, detail) => checks.push({ check: name, ok, detail });

  try {
    const bootedAt = Date.now();
    await waitFor(
      async () => {
        const res = await fetch(`${base}/livez`).catch(() => undefined);
        return res?.status === 200;
      },
      20_000,
      "冷启动 /livez",
    );
    record("cold_start", true, `listening after ${Date.now() - bootedAt} ms`);

    const ready = await fetch(`${base}/readyz`);
    const readyBody = await ready.json();
    record("readyz", ready.status === 200 && readyBody.ready === true, JSON.stringify(readyBody));

    const card = await fetch(`${base}/.well-known/agent-card.json`);
    const cardBody = await card.json().catch(() => ({}));
    record("agent_card", card.status === 200 && cardBody.name === "Kiwi A2A Merchant", cardBody.name ?? "");

    const admin = await fetch(`${base}/admin/login`);
    record("merchant_surface", admin.status === 200, `status=${admin.status}`);

    const reserved = await fetch(`${base}/.cloud/database/rest/items`);
    const reservedBody = await reserved.json().catch(() => ({}));
    record("cloud_reserved", reserved.status === 404 && reservedBody.error === "reserved_path", reservedBody.error ?? "");

    const challenge = await fetch(`${base}/control/challenge`, { method: "POST" });
    record("challenge_not_implemented", challenge.status === 501, `status=${challenge.status}`);

    const readyAfter = await fetch(`${base}/readyz`);
    record("readyz_stable", readyAfter.status === 200, `status=${readyAfter.status}`);

    if (deployMode && deployFacts?.readinessSku !== undefined) {
      // 真实 A2A RFQ：签名模式下匿名 T0 放行（设计 §13.1 的开放互操作），
      // 因此技术探针无需预共享令牌；扩展 URI 取自实例自己的 Agent Card。
      const extensionUri = cardBody.capabilities?.extensions?.[0]?.uri;
      const sku = deployFacts.readinessSku;
      // 信封必须带合法 digest（KNP schema 要求）：用制品自带的实现计算，
      // 不手写摘要——冒烟脚本不该自己发明协议字段。
      const { finalizeEnvelope } = await import(
        path.join(options.artifact, "dist", "negotiation", "domain", "envelope.js")
      );
      // 每次运行用唯一 id：状态目录跨运行保留，固定 id 会撞上 KNP 相位/幂等
      // （第二次冒烟会因 state_conflict 被 decline——冒烟必须可重复）。
      const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const envelope = finalizeEnvelope({
        capability: "com.harrylabsj.kiwi.shopping.negotiation",
        protocol_version: "1.0",
        negotiation_id: `neg_smoke_${runId}`,
        exchange_id: `ex_smoke_${runId}`,
        message_id: `msg_smoke_${runId}`,
        actor: "buyer",
        action: "rfq",
        created_at: new Date().toISOString(),
        payload: { type: "rfq", items: [{ sku, quantity: { value: 1, unit: "piece" } }] },
      });
      const rfq = await fetch(`${base}/a2a`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "A2A-Version": "1.0",
          ...(extensionUri !== undefined ? { "A2A-Extensions": extensionUri } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `smoke-rfq-${runId}`,
          method: "SendMessage",
          params: {
            message: {
              role: "ROLE_USER",
              parts: [{ data: { knp_envelope: envelope }, mediaType: "application/json" }],
              messageId: `msg_smoke_${runId}`,
            },
          },
        }),
      });
      const rfqBody = await rfq.json().catch(() => ({}));
      const serialized = JSON.stringify(rfqBody);
      const expected = deployFacts.expectedAmountMinor;
      record(
        "a2a_rfq_quote",
        rfq.status === 200 && (expected === undefined || serialized.includes(`"amount_minor":${expected}`)),
        expected === undefined ? `status=${rfq.status}` : `expected amount_minor=${expected}, status=${rfq.status}`,
      );
    }
  } catch (err) {
    record("smoke", false, err instanceof Error ? err.message : String(err));
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const portReleased = await fetch(`${base}/livez`).then(
      () => false,
      () => true,
    );
    record("port_released", portReleased, portReleased ? "closed" : "still serving");
    commerce?.server.close();
    commerce?.server.closeAllConnections();
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  const result = {
    smoke: "cloud-artifact",
    artifact: options.artifact,
    artifact_sha256: buildManifest?.artifact_sha256 ?? null,
    source_commit: buildManifest?.source_commit ?? null,
    node_version: process.versions.node,
    ran_at: new Date().toISOString(),
    checks,
    passed: failed.length === 0,
    stdout_tail: stdout.split("\n").slice(-6).join("\n"),
    stderr_tail: stderr.split("\n").slice(-6).join("\n"),
  };

  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const c of checks) process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.check}  ${c.detail}\n`);
    process.stdout.write(`\n${failed.length === 0 ? "冒烟通过" : `冒烟失败（${failed.length} 项）`}\n`);
  }
  if (failed.length > 0) process.exitCode = 1;
}

await main();
