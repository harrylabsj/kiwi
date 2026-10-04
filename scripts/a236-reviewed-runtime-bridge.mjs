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
 * A236 reviewed-runtime bridge（A192 derivative; source A192 file remains frozen）——**本地候选，未部署**。
 *
 *   node launcher/a192-merchant-launcher.mjs --pkg-dir <dir> --app-dir <dir> --cache-dir <dir>
 *        [--port <n>]
 *
 * 与 A145 launcher（b330d213…）的**关系与差异**（重要，不混淆）：
 *   A145 launcher 校验/解压官方 runtime 后 exec 的是 **探针健康脚本 p1-main.mjs**，
 *   证明的是"平台旧宿主能装起受支持 Node 并装载 Pi 闭包"。
 *   本 launcher 同样最小复用那套**已审 runtime 安装逻辑**，但 exec 的是
 *   **真实完整商家应用 app/cloud/main.js** —— 探针健康脚本**不是**商家启动桥，
 *   复制它不能证明商家能启动。本文件是**新派生** launcher，字节与 SHA 都不等于 b330d213…。
 *
 * 冻结物料只读：本文件不改 A145/A147 任何字节，也不动既有 build-cloud-artifact.mjs。
 * 原 A173 公开探针**不重开**；本文件从未被发布。
 *
 * 硬边界（fail-closed）：
 *   - 运行时长：平台旧宿主（可能 < 22.19）。低于支持线由**应用入口自己**硬拒（既有 A118），
 *     本 launcher 不改 engine、不谎报版本、不绕过守卫。
 *   - env/hooks/NODE_OPTIONS/flags/sessionID **原样透传**给子进程；只**追加** PORT。
 *   - 载荷按官方 SHA 校验；缺/多/坏一律拒绝，不静默降级。
 *   - 错误面 = 固定错误码单行 stderr；不回落路径、不回显 secret。
 *   - SIGINT/SIGTERM 精确转发给子进程；退出码如实传播。
 */

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const T0 = Date.now();
const SUPPORTED_RUNTIME_VERSION = "22.19.0";

class LauncherFailure extends Error {
  constructor(code, fixedText) { super(fixedText); this.code = code; this.fixedText = fixedText; }
}

const emit = (event) =>
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), elapsed_ms: Date.now() - T0, ...event })}\n`);

const sha256Buf = (b) => createHash("sha256").update(b).digest("hex");
const sha256File = (f) => sha256Buf(readFileSync(f));

function parseArgs(argv) {
  const o = { pkgDir: undefined, appDir: undefined, cacheDir: undefined, port: process.env.PORT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--pkg-dir") o.pkgDir = argv[++i];
    else if (argv[i] === "--app-dir") o.appDir = argv[++i];
    else if (argv[i] === "--cache-dir") o.cacheDir = argv[++i];
    else if (argv[i] === "--port") o.port = argv[++i];
  }
  const missing = [];
  if (!o.pkgDir) missing.push("--pkg-dir");
  if (!o.appDir) missing.push("--app-dir");
  if (!o.cacheDir) missing.push("--cache-dir");
  if (missing.length > 0) {
    throw new LauncherFailure("A192_USAGE", `launcher: 缺少参数 ${missing.join(", ")}`);
  }
  if (o.port === undefined || o.port === "") {
    throw new LauncherFailure("A192_PORT_REQUIRED", "launcher: 需要 --port 或环境变量 $PORT");
  }
  // 相对参数按进程初始 cwd 解析为绝对：后续子进程 cwd 切换不影响。
  const base = process.cwd();
  o.pkgDir = path.resolve(base, o.pkgDir);
  o.appDir = path.resolve(base, o.appDir);
  o.cacheDir = path.resolve(base, o.cacheDir);
  return o;
}

/**
 * 载入并校验 runtime manifest。
 * **精确文件集合**：期望的 payload 清单来自 manifest 自身声明（node + npm），
 * 少一个、多一个、或 SHA 不符，都拒绝——不因"只找到一个可用"而放行。
 */
function loadManifest(pkgDir, hostPlatform, hostArch) {
  const name = `runtime-manifest.${hostPlatform}-${hostArch}.json`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(pkgDir, name), "utf8"));
  } catch {
    throw new LauncherFailure("A192_MANIFEST_INVALID", "launcher: runtime manifest 不可读或平台/arch 不匹配");
  }
  const s = (v) => typeof v === "string" && v.length > 0;
  const n = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (manifest.package_format !== 1
    || !s(manifest.node_version) || !s(manifest.platform) || !s(manifest.arch) || !s(manifest.payload_file)
    || !s(manifest.bin_node_sha256) || !n(manifest.bin_node_bytes)
    || !s(manifest.bin_node_gzip_sha256) || !n(manifest.bin_node_gzip_bytes)) {
    throw new LauncherFailure("A192_MANIFEST_SCHEMA_INVALID", "launcher: runtime manifest 字段/schema 非法");
  }
  if (manifest.platform !== hostPlatform || manifest.arch !== hostArch) {
    throw new LauncherFailure("A192_PLATFORM_MISMATCH", "launcher: 载荷平台/arch 与宿主不符，拒绝执行");
  }
  if (manifest.node_version !== SUPPORTED_RUNTIME_VERSION) {
    throw new LauncherFailure("A192_RUNTIME_VERSION_UNEXPECTED", "launcher: runtime 版本与预定不符");
  }
  // 期望 payload 精确集合（非空！空集合必须拒绝，不能当成"无需校验"）
  const expected = new Set();
  const nodePayload = path.basename(String(manifest.payload_file));
  expected.add(nodePayload);
  if (manifest.npm_payload !== undefined) {
    const m = manifest.npm_payload;
    if (!s(m.payload_file) || !s(m.sha256) || !n(m.bytes)) {
      throw new LauncherFailure("A192_MANIFEST_SCHEMA_INVALID", "launcher: npm 载荷 manifest 字段非法");
    }
    expected.add(path.basename(String(m.payload_file)));
  }
  if (expected.size === 0) {
    throw new LauncherFailure("A192_PAYLOAD_SET_EMPTY", "launcher: 期望载荷集合为空，拒绝执行");
  }
  // 实际磁盘集合：必须与期望**完全相等**（缺/多都拒）
  const payloadDir = path.join(pkgDir, "payloads");
  if (!existsSync(payloadDir)) {
    throw new LauncherFailure("A192_PAYLOAD_DIR_MISSING", "launcher: 载荷目录缺失");
  }
  const actual = new Set(readdirSync(payloadDir).filter((f) => !f.startsWith(".")));
  const missing = [...expected].filter((f) => !actual.has(f));
  const extra = [...actual].filter((f) => !expected.has(f));
  if (missing.length > 0) {
    throw new LauncherFailure("A192_PAYLOAD_MISSING", `launcher: 载荷缺失 ${missing.length} 项，拒绝执行`);
  }
  if (extra.length > 0) {
    throw new LauncherFailure("A192_PAYLOAD_UNEXPECTED", `launcher: 载荷多余 ${extra.length} 项，拒绝执行`);
  }
  return { manifest, expected, payloadDir };
}

/** 校验并原子解压官方 runtime 到**自有 cache**；已存在且校验通过则复用。 */
function installRuntime(manifest, payloadDir, cacheDir) {
  const gzPath = path.join(payloadDir, path.basename(String(manifest.payload_file)));
  if (!existsSync(gzPath)) throw new LauncherFailure("A192_PAYLOAD_MISSING", "launcher: 载荷缺失");
  if (sha256File(gzPath) !== manifest.bin_node_gzip_sha256) {
    throw new LauncherFailure("A192_PAYLOAD_HASH_MISMATCH", "launcher: 载荷 hash 不匹配，拒绝执行");
  }
  let plain;
  try {
    plain = gunzipSync(readFileSync(gzPath));
  } catch {
    throw new LauncherFailure("A192_DECOMPRESS_FAILED", "launcher: 载荷解压失败");
  }
  if (plain.length !== manifest.bin_node_bytes) {
    throw new LauncherFailure("A192_EXTRACT_INCOMPLETE", "launcher: 解压不完整，拒绝执行");
  }
  if (sha256Buf(plain) !== manifest.bin_node_sha256) {
    throw new LauncherFailure("A192_RUNTIME_HASH_MISMATCH", "launcher: runtime 二进制 hash 不匹配，拒绝执行");
  }
  mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `node-v${manifest.node_version}`);
  if (existsSync(target)) {
    if (statSync(target).size === manifest.bin_node_bytes && sha256File(target) === manifest.bin_node_sha256) {
      emit({ event: "runtime_cache_reused", node_version: manifest.node_version });
      return target;
    }
    throw new LauncherFailure("A192_CACHE_HASH_MISMATCH", "launcher: cache 内既有文件校验失败，拒绝覆盖");
  }
  const tmp = path.join(cacheDir, `.tmp-node-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, plain);
    chmodSync(tmp, 0o755);
    renameSync(tmp, target);
  } catch {
    throw new LauncherFailure("A192_CACHE_WRITE_FAILED", "launcher: cache 目录不可写");
  }
  if (statSync(target).size !== manifest.bin_node_bytes || sha256File(target) !== manifest.bin_node_sha256) {
    throw new LauncherFailure("A192_CACHE_VERIFY_FAILED", "launcher: 落盘复验失败，拒绝执行");
  }
  emit({
    event: "runtime_installed",
    node_version: manifest.node_version,
    disk_bytes_written: manifest.bin_node_bytes,
    payload_gzip_bytes: manifest.bin_node_gzip_bytes,
  });
  return target;
}

/** 自检：新 runtime 自报版本必须等于 manifest 声明。 */
function selfTest(cachedNode, manifest) {
  let version;
  try {
    version = spawnSync(cachedNode, [...process.execArgv, "--version"], { encoding: "utf8", timeout: 20_000 }).stdout.trim();
  } catch {
    throw new LauncherFailure("A192_RUNTIME_SELFTEST_FAILED", "launcher: 缓存 runtime 自检失败");
  }
  if (version !== `v${manifest.node_version}`) {
    throw new LauncherFailure("A192_RUNTIME_VERSION_MISMATCH", "launcher: 缓存 runtime 版本不符");
  }
  return version;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { manifest, payloadDir } = loadManifest(options.pkgDir, process.platform, process.arch);
  emit({
    event: "manifest_verified",
    platform: manifest.platform,
    arch: manifest.arch,
    node_version: manifest.node_version,
    host_node: process.versions.node,
  });

  const cachedNode = installRuntime(manifest, payloadDir, options.cacheDir);
  const runtimeVersion = selfTest(cachedNode, manifest);
  emit({ event: "runtime_ready", runtime_version: runtimeVersion });

  // exec 目标 = **真实完整商家入口**（不是探针健康脚本）
  const merchantEntry = path.join(options.appDir, "app", "cloud", "main.js");
  if (!existsSync(merchantEntry)) {
    throw new LauncherFailure("A192_MERCHANT_ENTRY_MISSING", "launcher: 商家入口 app/cloud/main.js 缺失");
  }

  // env 原样继承（不 unset 任何原有变量），只**追加** PORT。
  const childEnv = { ...process.env, PORT: String(options.port) };
  const child = spawn(cachedNode, [...process.execArgv, merchantEntry], {
    cwd: options.appDir,          // 平台实测 cwd = 制品根
    env: childEnv,                // 原样透传 env/hooks/NODE_OPTIONS/flags/sessionID
    stdio: ["ignore", "inherit", "inherit"],
  });
  emit({ event: "merchant_child_started", pid: child.pid, runtime: runtimeVersion });

  let ended = false;
  const forward = (signal) => { if (!ended && child.pid !== undefined) child.kill(signal); };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  child.on("exit", (code, signal) => {
    ended = true;
    emit({ event: "merchant_child_exit", code: code === null ? null : code, signal: signal === null ? null : signal });
    if (code !== null) process.exitCode = code;
    else process.exitCode = 1;
  });
  child.on("error", () => {
    emit({ event: "merchant_child_error", code: "A192_CHILD_SPAWN_FAILED" });
    process.exitCode = 1;
  });
}

try {
  main();
} catch (err) {
  if (err instanceof LauncherFailure) {
    process.stderr.write(`${err.code} ${err.fixedText}\n`);
    process.exit(1);
  }
  process.stderr.write("A192_INTERNAL_ERROR launcher: 内部错误，拒绝执行\n");
  process.exit(1);
}
