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
 * M1 平台部署包组装（pilot overlay）。
 *
 *   node scripts/prepare-m1-pilot.mjs --app-origin https://<app>.app.workbuddy.host \
 *        [--artifact build/cloud-artifact] [--out build/m1-pilot] [--remote-root /workspace] \
 *        [--sku sku-pilot-1] [--price 128.50] [--floor 100.00] [--merchant merchant-pilot-001]
 *
 * 为什么需要 overlay：平台只注入 PORT，其余配置得随部署包提供；而**制品不得
 * 携带商家数据/密钥**（设计 §15.1）。因此部署包 = 制品 + 一层明确标记的
 * pilot 覆盖：
 *   cloud.config.json   非敏感配置（公网 origin、状态目录、pilot 文件路径）
 *   pilot/merchant.yaml 测试商家 profile（**仅测试用**，生产由 M4 向导落地）
 *   pilot/products.json 测试商品表（设计 §10.1「商家上传商品表」路径）
 *   pilot-manifest.json 覆盖层清单 + 哈希 + 警告（哪些不是制品的一部分）
 *
 * 认证用 signature：Runtime 自持 Ed25519 密钥对（存状态目录、不进包），
 * 公钥随 Agent Card 公开——部署包内不需要任何令牌。
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    artifact: path.join(REPO_ROOT, "build", "cloud-artifact"),
    out: path.join(REPO_ROOT, "build", "m1-pilot"),
    appOrigin: undefined,
    remoteRoot: "/workspace",
    sku: "sku-pilot-1",
    price: 128.5,
    floor: 100.0,
    merchant: "merchant-pilot-001",
    validDays: 30,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--artifact") options.artifact = path.resolve(next());
    else if (arg === "--out") options.out = path.resolve(next());
    else if (arg === "--app-origin") options.appOrigin = next();
    else if (arg === "--remote-root") options.remoteRoot = next();
    else if (arg === "--sku") options.sku = next();
    else if (arg === "--price") options.price = Number(next());
    else if (arg === "--floor") options.floor = Number(next());
    else if (arg === "--merchant") options.merchant = next();
    else if (arg === "--valid-days") options.validDays = Number(next());
    else throw new Error(`未知参数 ${arg}`);
  }
  if (options.appOrigin === undefined) {
    throw new Error("必须提供 --app-origin（平台 activate 后拿到的公网 origin，https://…）");
  }
  if (!/^https:\/\/[^/]+$/.test(options.appOrigin)) {
    throw new Error("--app-origin 必须是 https origin（不含路径）");
  }
  return options;
}

function sha256(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(path.join(options.artifact, "app", "cloud", "main.js"))) {
    throw new Error(`制品不存在：${options.artifact}（先跑 scripts/build-cloud-artifact.mjs）`);
  }
  const remote = (relative) => `${options.remoteRoot.replace(/\/+$/, "")}/${relative}`;
  const dataDir = remote(".kiwi-runtime");

  process.stdout.write(`[m1-pilot] 复制制品 → ${options.out}\n`);
  rmSync(options.out, { recursive: true, force: true });
  mkdirSync(options.out, { recursive: true });
  cpSync(options.artifact, options.out, { recursive: true, force: true });

  const pilotDir = path.join(options.out, "pilot");
  mkdirSync(pilotDir, { recursive: true });

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // 测试商家 profile：底价在私密策略区，**不进商品表**（设计 §10.1）。
  const profilePath = path.join(pilotDir, "merchant.yaml");
  writeFileSync(
    profilePath,
    [
      "# M1 pilot 测试商家 profile —— 仅用于平台技术验证，不是生产配置。",
      "# 生产商家配置由 M4 开通向导落地；此文件随部署包发布，不得承载真实商家数据。",
      "runtime_version: 0.6.0",
      "protocol_version: shopping.negotiation/0.1",
      `agent_id: merchant-agent:${options.merchant}`,
      "role: merchant",
      `owner_id: ${options.merchant}`,
      "commerce:",
      "  base_url: http://127.0.0.1:1   # 商品源走 pilot/products.json（见 cloud.config.json）",
      "  token_env: KIWI_PILOT_COMMERCE_TOKEN",
      "  backend: local_marketplace",
      "  allow_demo_price_fallback: false   # 云端生产禁演示价回退",
      "model:",
      "  provider: fake     # M1 关闭模型：报价完全由确定性策略产生",
      "  model: fake-merchant-model",
      "runtime:",
      "  mode: once",
      "  poll_interval_seconds: 5",
      "  turn_timeout_seconds: 90",
      "  max_model_steps: 4",
      "  max_retries: 2",
      "merchant_policy:",
      `  min_unit_price_private: ${options.floor.toFixed(2)}`,
      "  max_auto_discount_percent: 10",
      "  inventory_source: marketplace",
      "  quote_ttl_seconds: 300",
      "  auto_negotiate: true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const productsPath = path.join(pilotDir, "products.json");
  writeFileSync(
    productsPath,
    `${JSON.stringify(
      {
        schema_version: "0.1.2",
        merchant_id: options.merchant,
        source: "test_fixture",
        generated_at: nowIso,
        products: [
          {
            sku: options.sku,
            title: "M1 pilot 测试商品（非真实商品）",
            currency: "CNY",
            unit: "piece",
            price: options.price,
            moq: 1,
            supply_note: "pilot 测试商品",
            updated_at: nowIso,
            valid_until: new Date(now + options.validDays * 86_400_000).toISOString(),
            status: "active",
            stock: 50,
            test: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const configPath = path.join(options.out, "cloud.config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        public_origin: options.appOrigin,
        data_dir: dataDir,
        profile: remote("pilot/merchant.yaml"),
        products_file: remote("pilot/products.json"),
        readiness_sku: options.sku,
        // signature：Runtime 自持密钥（存状态目录），部署包内不含任何令牌。
        a2a_auth: { mode: "signature" },
      },
      null,
      2,
    )}\n`,
  );

  const artifacts = [
    { path: "cloud.config.json", local: configPath },
    { path: "pilot/merchant.yaml", local: profilePath },
    { path: "pilot/products.json", local: productsPath },
  ];
  const buildManifestPath = path.join(options.out, "artifact-manifest.json");
  const buildManifest = existsSync(buildManifestPath)
    ? JSON.parse(readFileSync(buildManifestPath, "utf8"))
    : undefined;

  const pilotManifest = {
    schema_version: "0.1.2",
    kind: "m1-pilot-deployment",
    prepared_at: nowIso,
    app_origin: options.appOrigin,
    remote_root: options.remoteRoot,
    data_dir: dataDir,
    artifact_sha256: buildManifest?.artifact_sha256 ?? null,
    source_commit: buildManifest?.source_commit ?? null,
    overlay_files: artifacts.map((entry) => ({
      path: entry.path,
      sha256: sha256(entry.local),
      note: "pilot 覆盖层：不是发布制品的一部分",
    })),
    warnings: [
      "本包含测试商家 profile 与测试商品表（test_fixture）：仅用于平台技术验证。",
      "部署包内不含任何令牌或私钥；Runtime 签名密钥在首次启动时生成并写入状态目录。",
      "生产部署不得复用本覆盖层；商家配置与商品表由 M4 向导落地。",
    ],
  };
  writeFileSync(
    path.join(pilotDir, "pilot-manifest.json"),
    `${JSON.stringify(pilotManifest, null, 2)}\n`,
  );

  process.stdout.write(
    [
      `[m1-pilot] 完成：${options.out}`,
      `  制品摘要：${pilotManifest.artifact_sha256}`,
      `  公网 origin：${options.appOrigin}`,
      `  状态目录：${dataDir}（制品之外，deploy 不覆盖）`,
      `  探针 SKU：${options.sku}（测试商品，价格 ${options.price.toFixed(2)} CNY）`,
      `  底价：${options.floor.toFixed(2)} CNY（仅存在于 merchant.yaml 私密策略区）`,
      "",
      "部署时把本目录整体上传为应用的在线服务；除平台注入的 PORT 外无需任何环境变量。",
      "",
    ].join("\n"),
  );
}

main();
