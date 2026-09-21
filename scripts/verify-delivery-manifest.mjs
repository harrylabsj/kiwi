#!/usr/bin/env node
// Copyright 2026 harrylabsj
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// 校验 connector-delivery-manifest.json（BD §16.1）：Schema（ajv）+ 语义复核
// （锁摘要与仓库一致、管理 API major 与源码一致、mcp_readonly 硬闸、回滚文档
// 存在）。只读、无网络；**不验证 detached 签名**（那是发布信任根的职责）。
//
// 用法：node scripts/verify-delivery-manifest.mjs <delivery/connector-delivery-manifest.json>

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = process.argv[2] ?? resolve(root, "delivery/connector-delivery-manifest.json");
const fail = (message) => {
  console.error(`delivery manifest verification failed: ${message}`);
  process.exitCode = 1;
};

const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
const require2 = createRequire(import.meta.url);
const Ajv2020 = require2(resolve(root, "node_modules/ajv/dist/2020.js")).default;
const schema = JSON.parse(
  readFileSync(resolve(root, "contracts/merchant-management/1.0/connector-delivery-manifest.schema.json"), "utf8"),
);
const validate = new Ajv2020({ strict: false }).compile(schema);
if (!validate(manifest)) {
  fail(`schema: ${JSON.stringify(validate.errors)}`);
  process.exit(process.exitCode ?? 1);
}

// 语义复核：锁摘要与仓库一致（清单描述的依赖解析必须就是本仓的锁）。
const lockActual = createHash("sha256").update(readFileSync(resolve(root, "package-lock.json"))).digest("hex");
if (manifest.lockfile_sha256 !== lockActual) fail("lockfile_sha256 与仓库 package-lock.json 不一致");

// 管理 API major 与源码常量一致。
const serviceSource = readFileSync(resolve(root, "src/merchant/application/service.ts"), "utf8");
const major = /export const MANAGEMENT_API_MAJOR = (\d+)/.exec(serviceSource)?.[1];
if (major === undefined || String(manifest.management_api_major) !== major) {
  fail("management_api_major 与 src/merchant/application/service.ts 不一致");
}

// 回滚策略文档必须真实存在。
if (!existsSync(resolve(root, manifest.rollback_policy_ref))) {
  fail(`rollback_policy_ref 文件不存在：${manifest.rollback_policy_ref}`);
}

// mcp_readonly 硬闸（BD §14/§16.1）：开启必须带环境声明（发布责任人确认）。
if (manifest.enabled_modes.mcp_readonly && process.env.KIWI_DELIVERY_ALLOW_MCP_READONLY !== "1") {
  fail("enabled_modes.mcp_readonly=true 需要 KIWI_DELIVERY_ALLOW_MCP_READONLY=1（B07+UC37–40 证据）");
}

// not_produced 清单只可用于自检，交付前必须 bound。
if (manifest.runtime_artifact.status !== "bound") {
  console.error("note: runtime_artifact=not_produced（自检清单，不得对外交付）");
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`delivery manifest verified: ${manifest.delivery_version} (${manifest.source_commit.slice(0, 8)})`);
