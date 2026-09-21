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

// 生成 connector-delivery-manifest.json（BD 设计 §16.1；Schema 见
// contracts/merchant-management/1.0/connector-delivery-manifest.schema.json）。
//
// 用法：
//   node scripts/build-delivery-manifest.mjs \
//     [--out delivery/connector-delivery-manifest.json] \
//     [--runtime-artifact <制品路径>] \
//     [--parent-release-manifest <D1 release-manifest 路径>] \
//     [--delivery-version 2026-09-21.1] [--compatible-buddy ">=1.0"]
//
// 边界：只读本地文件 + git rev-parse，无网络；**不做签名**——detached 签名/
// 证明由发布流程对产物另行签发（§16.1：文件内自带 hash 不构成可信）。

import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`missing value for ${name}`);
  return value;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error("git rev-parse HEAD 返回异常");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// 管理 API major 的权威来源是源码常量（正则解析，防止与契约漂移）。
const serviceSource = readFileSync(
  resolve(root, "src/merchant/application/service.ts"),
  "utf8",
);
const majorMatch = /export const MANAGEMENT_API_MAJOR = (\d+)/.exec(serviceSource);
if (majorMatch === null) throw new Error("无法从 service.ts 解析 MANAGEMENT_API_MAJOR");

const lockfileSha = sha256(readFileSync(resolve(root, "package-lock.json")));

// 制品：未提供 → not_produced（如实记录，不得对外交付该清单）。
const artifactPath = argValue("--runtime-artifact");
const runtimeArtifact = { status: "not_produced" };
if (artifactPath !== undefined) {
  const artifact = resolve(artifactPath);
  if (!existsSync(artifact)) throw new Error(`runtime artifact 不存在：${artifact}`);
  runtimeArtifact.status = "bound";
  runtimeArtifact.sha256 = sha256(readFileSync(artifact));
  runtimeArtifact.path = artifactPath;
  runtimeArtifact.bytes = statSync(artifact).size;
}

// D1 总发布清单：可挂接摘要；缺省 null + ref 说明（不得据此声称通过总设计门槛）。
const parentPath = argValue("--parent-release-manifest");
const parentReleaseManifest = {
  sha256: parentPath !== undefined ? sha256(readFileSync(resolve(parentPath))) : null,
  ref:
    parentPath !== undefined
      ? parentPath
      : "docs/kiwi_merchant_cloud_v0.1.2/contracts/release-manifest.schema.json（本轮未绑定实例清单）",
};

// 对话只读工具（BD-06）的硬闸：除非显式环境声明（B07 实测 + UC37–40 通过后
// 由发布负责人开启），一律 false。
const mcpReadonly =
  args.includes("--enable-mcp-readonly") && process.env.KIWI_DELIVERY_ALLOW_MCP_READONLY === "1";
if (args.includes("--enable-mcp-readonly") && !mcpReadonly) {
  throw new Error(
    "--enable-mcp-readonly 需要环境 KIWI_DELIVERY_ALLOW_MCP_READONLY=1（B07 实测与 UC37–40 证据齐备后由发布负责人开启）",
  );
}

const compatibleRaw = argValue("--compatible-buddy");
const compatibleBuddyVersions =
  compatibleRaw === undefined
    ? []
    : compatibleRaw.split(",").map((item) => item.trim()).filter((item) => item !== "");

const rollbackPolicyRef = "docs/merchant-buddy/merchant-connector-deployment.md";
if (!existsSync(resolve(root, rollbackPolicyRef))) {
  throw new Error(`rollback_policy_ref 文件不存在：${rollbackPolicyRef}`);
}

const manifest = {
  schema_version: "1.0",
  delivery_version: argValue("--delivery-version") ?? new Date().toISOString().slice(0, 10) + ".1",
  source_commit: sourceCommit,
  runtime_version: pkg.version,
  runtime_artifact: runtimeArtifact,
  lockfile_sha256: lockfileSha,
  build_environment_ref: `node@${process.versions.node}/${process.platform}-${process.arch}`,
  management_api_major: Number(majorMatch[1]),
  compatible_buddy_versions: compatibleBuddyVersions,
  enabled_modes: { page: true, mcp_readonly: mcpReadonly },
  migration_version: 1,
  rollback_policy_ref: rollbackPolicyRef,
  parent_release_manifest: parentReleaseManifest,
  notes:
    runtimeArtifact.status === "not_produced"
      ? ["runtime_artifact=not_produced：本清单为构建自检产物，不得用于对外交付。"]
      : [],
};

const text = `${JSON.stringify(manifest, null, 2)}\n`;
const out = argValue("--out");
if (out !== undefined) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), text, { mode: 0o600 });
  console.log(`delivery manifest written: ${out}`);
} else {
  process.stdout.write(text);
}
