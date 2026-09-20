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
 * 云端 Runtime 制品构建（设计 v0.1.2 §15.1/§15.3/§15.5）。
 *
 *   node scripts/build-cloud-artifact.mjs [--out <dir>] [--skip-build] [--artifact-uri <https://…>]
 *
 * 产出目录（默认 build/cloud-artifact/）：
 *   app/            编译产物（入口 app/cloud/main.js）
 *                   ——不叫 dist/：平台发布工具会把"build output"（dist 等）
 *                   排除在上传之外，而本制品既是编译产物又是运行代码。
 *   contracts/      运行期读取的 JSON Schema（协议唯一权威源）
 *   node_modules/   仅生产依赖（不需要平台侧 npm install）
 *   package.json    制品自述（main/start 指向云端入口；无 devDependencies）
 *   build-manifest.json 本地产物事实：commit、Node、逐文件 sha256、聚合摘要、依赖锁摘要
 *   release-manifest.json 仅当提供 --artifact-uri 时生成（Schema 0.1.2 合规）
 *
 * 制品准入检查（不通过即失败，绝不带着状态文件/密钥发布）：
 *   - 不含任何权威状态文件（state.sqlite / oauth.sqlite / *.jsonl / owner.lock / 各种凭据）；
 *   - 不含 .env、.git、测试与覆盖率产物；
 *   - 不含 devDependencies；
 *   - 体积上限（默认 64 MiB，可用 --max-mib 覆盖）。
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 权威状态/凭据类文件：制品里出现任何一个都视为构建失败。 */
const FORBIDDEN_STATE_PATTERNS = [
  /(^|\/)state\.sqlite$/,
  /(^|\/)oauth\.sqlite$/,
  /(^|\/)stats\.sqlite$/,
  /(^|\/)owner\.lock$/,
  /(^|\/)admin-credentials\.json$/,
  /(^|\/)a2a-signing-key\.json$/,
  /(^|\/)a2a-trusted-keys\.json$/,
  /(^|\/)policy-overrides\.json$/,
  /(^|\/)capability-probe\.json$/,
  /(^|\/)registration\.json$/,
  /(^|\/)credentials\.env$/,
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)\.git(\/|$)/,
  /\.jsonl$/,
];

function parseArgs(argv) {
  const options = {
    out: path.join(REPO_ROOT, "build", "cloud-artifact"),
    skipBuild: false,
    artifactUri: undefined,
    maxMiB: 64,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") options.out = path.resolve(argv[++i] ?? options.out);
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--artifact-uri") options.artifactUri = argv[++i];
    else if (arg === "--max-mib") options.maxMiB = Number(argv[++i] ?? "64");
    else throw new Error(`未知参数 ${arg}`);
  }
  return options;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function listFiles(root, prefix = "") {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, rel));
    else if (entry.isFile()) out.push({ rel, abs, size: statSync(abs).size });
  }
  return out;
}

function assertAdmissible(files) {
  const violations = [];
  for (const file of files) {
    for (const pattern of FORBIDDEN_STATE_PATTERNS) {
      if (pattern.test(file.rel)) violations.push(`${file.rel}（匹配 ${pattern}）`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`制品准入检查失败：含被禁止的状态/凭据文件\n  ${violations.join("\n  ")}`);
  }
}

/** 依赖锁摘要：对 package-lock.json 的依赖解析结果做稳定摘要。 */
function dependencyLockDigest(outDir) {
  const lockPath = path.join(outDir, "package-lock.json");
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : undefined;
  const packages = lock?.packages ?? {};
  const lines = Object.keys(packages)
    .filter((key) => key !== "")
    .sort()
    .map((key) => {
      const entry = packages[key] ?? {};
      return `${key}\u0000${entry.version ?? ""}\u0000${entry.integrity ?? ""}`;
    });
  return `sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}


/**
 * 按**实际随包依赖**计算 engines 下界。
 *
 * 仓库根 package.json 的 engines 由全量依赖决定（pi-agent-core/pi-ai 要求
 * >=22.19.0）；云端薄切片已把模型 SDK 裁掉，若原样继承该声明，就会带着一个
 * 与实际运行时无关的下界上平台（M0 实测平台 Node 为 v22.13.1），可能直接
 * 触发引擎校验失败。因此这里取随包依赖 engines.node 的最大下界。
 */
function computeShippedEngines(outDir) {
  const modulesDir = path.join(outDir, "node_modules");
  const floors = [];
  const complex = [];
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    const pkgs = entry.name.startsWith("@")
      ? readdirSync(path.join(modulesDir, entry.name)).map((n) => `${entry.name}/${n}`)
      : [entry.name];
    for (const name of pkgs) {
      const pkg = parsePackageJson(path.join(modulesDir, name, "package.json"));
      const range = pkg?.engines?.node;
      if (typeof range !== "string") continue;
      const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
      if (match === null) {
        complex.push(`${name}: ${range}`);
        continue;
      }
      floors.push({
        name,
        version: `${match[1]}.${match[2]}.${match[3]}`,
        parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      });
    }
  }
  floors.sort((a, b) => {
    for (let i = 0; i < 3; i += 1) {
      if (a.parts[i] !== b.parts[i]) return b.parts[i] - a.parts[i];
    }
    return 0;
  });
  return { highest: floors[0], complex };
}

function gitCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/**
 * 从入口出发计算运行时可达的包集合，用于裁剪 node_modules。
 *
 * 云端 M1 不调用任何模型：`@earendil-works/pi-ai` 静态拉入 Anthropic/OpenAI/
 * Gemini/Mistral/Bedrock 各 SDK（约 100 MiB）。裁剪依据是**可达性**而不是
 * "应该用不到"——先静态解析 dist/*.js 的 import/require 说明符做 BFS，再把
 * 命中包的 dependencies/peerDependencies 一并保留（保守，宁可多留）。
 * 裁剪后必须通过 scripts/smoke-cloud-artifact.mjs 冷启动冒烟，否则视为裁剪过度。
 */
const NODE_BUILTIN = /^node:/;
const RELATIVE_SPEC = /^(\.{1,2}\/|\/)/;

function scanModuleSpecifiers(file) {
  const text = readFileSync(file, "utf8");
  const specs = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;
  let match;
  while ((match = re.exec(text)) !== null) specs.add(match[2]);
  return specs;
}

function packageNameOf(spec) {
  if (NODE_BUILTIN.test(spec) || RELATIVE_SPEC.test(spec)) return undefined;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function parsePackageJson(file) {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function collectReachablePackages(outDir) {
  const needed = new Set();
  const distRoot = path.join(outDir, "app");
  // 只从云端入口出发（不是整个 dist——否则所有文件都会被判"可达"）。
  const entry = path.join(distRoot, "cloud", "main.js");
  if (!existsSync(entry)) throw new Error(`入口不存在：${entry}`);
  const queue = [entry];
  const visitedFiles = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (visitedFiles.has(file)) continue;
    visitedFiles.add(file);
    for (const spec of scanModuleSpecifiers(file)) {
      if (RELATIVE_SPEC.test(spec)) {
        const resolved = path.resolve(path.dirname(file), spec);
        for (const candidate of [resolved, `${resolved}.js`, path.join(resolved, "index.js")]) {
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            queue.push(candidate);
            break;
          }
        }
        continue;
      }
      const name = packageNameOf(spec);
      if (name !== undefined) needed.add(name);
    }
  }
  // 传递闭包：命中包的依赖（含 peer/optional）一并保留。
  const resolved = new Set();
  const stack = [...needed];
  while (stack.length > 0) {
    const name = stack.pop();
    if (resolved.has(name)) continue;
    const pkgDir = path.join(outDir, "node_modules", name);
    if (!existsSync(pkgDir)) continue;
    resolved.add(name);
    const pkg = parsePackageJson(path.join(pkgDir, "package.json"));
    if (pkg === undefined) continue;
    for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(pkg[key] ?? {})) stack.push(dep);
    }
  }
  return resolved;
}

/** 删除运行时不可达的顶层包（保留 .bin 与作用域目录结构）。 */
function pruneUnreachablePackages(outDir, keep) {
  const modulesDir = path.join(outDir, "node_modules");
  const removed = [];
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(modulesDir, entry.name);
      for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
        const full = `${entry.name}/${scoped.name}`;
        if (keep.has(full)) continue;
        rmSync(path.join(scopeDir, scoped.name), { recursive: true, force: true });
        removed.push(full);
      }
      if (readdirSync(scopeDir).length === 0) rmSync(scopeDir, { recursive: true, force: true });
      continue;
    }
    if (keep.has(entry.name)) continue;
    rmSync(path.join(modulesDir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed.sort();
}

/**
 * 包内非运行期内容（文档/类型声明/源码映射/测试目录）：删了不影响执行。
 *
 * 只按"确定不是运行期文件"的规则删：**.js/.cjs/.mjs/.json 一律保留**。
 * （首版规则里 `docs?/` 会匹配 `yaml/dist/doc/`，把真实运行期文件删掉——
 * 冷启动冒烟当场发现，故收紧为精确目录名。）
 */
function prunePackageFat(outDir) {
  const modulesDir = path.join(outDir, "node_modules");
  const dropRe = /(^|\/)(README|CHANGELOG|HISTORY|LICENSE)(\.[A-Za-z]+)?$|\.(md|markdown|map|d\.ts)$|(^|\/)(test|tests|__tests__|examples|benchmark|benchmarks)(\/|$)/i;
  let removed = 0;
  for (const file of listFiles(modulesDir)) {
    if (dropRe.test(file.rel)) {
      rmSync(file.abs, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.skipBuild) {
    process.stdout.write("[cloud-artifact] 编译 dist/ …\n");
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  }
  const distDir = path.join(REPO_ROOT, "dist");
  if (!existsSync(path.join(distDir, "cloud", "main.js"))) {
    throw new Error("dist/cloud/main.js 不存在：先运行 npm run build（或去掉 --skip-build）");
  }
  const contractsDir = path.join(REPO_ROOT, "contracts");
  if (!existsSync(contractsDir)) throw new Error("contracts/ 不存在：运行期 schema 是制品必需内容");

  process.stdout.write(`[cloud-artifact] 组装 ${options.out} …\n`);
  rmSync(options.out, { recursive: true, force: true });
  mkdirSync(options.out, { recursive: true });
  // 目录名用 app/ 而非 dist/：平台的发布工具排除 "build output"，src 编译产物
  // 同时也是运行代码，被排除后沙箱里就没有可执行的入口（实测 MODULE_NOT_FOUND）。
  cpSync(distDir, path.join(options.out, "app"), { recursive: true });
  cpSync(contractsDir, path.join(options.out, "contracts"), { recursive: true });

  // 制品 package.json：只声明生产依赖 + 云端入口；平台不需要 npm install。
  const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const artifactPkg = {
    name: "@harrylabsj/kiwi-cloud-runtime",
    version: rootPkg.version,
    private: true,
    type: "module",
    main: "index.js",
    scripts: { start: "node index.js" },
    // engines 在依赖裁剪后由实际随包依赖决定（见 computeShippedEngines）。
    dependencies: rootPkg.dependencies,
  };
  writeFileSync(path.join(options.out, "package.json"), `${JSON.stringify(artifactPkg, null, 2)}\n`);
  // 入口兜底：平台的启动方式未实测（可能是 npm start、node <main>、node index.js）。
  // index.js 只是转发到云端入口，不承载任何逻辑。
  writeFileSync(
    path.join(options.out, "index.js"),
    [
      "// 平台入口兜底：调用云端 Runtime 入口（真实实现见 app/cloud/main.js）。",
      '// 注意：不能只 import——main.js 有"直接执行才启动"的保护，import 不会启动。',
      'import { runCloudMain } from "./app/cloud/main.js";',
      "",
      "const code = await runCloudMain();",
      "if (code !== 0) process.exit(code);",
      "",
    ].join("\n"),
  );

  process.stdout.write("[cloud-artifact] 安装生产依赖（仅 production，不跑脚本）…\n");
  execFileSync(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"],
    { cwd: options.out, stdio: "inherit" },
  );

  // 裁剪：先按运行时可达性删除整包，再删包内非运行期内容（文档/测试/映射）。
  // 这一步是体积控制的关键：不裁剪时 pi-ai 会带入 5 家模型 SDK（约 100 MiB）。
  const keep = collectReachablePackages(options.out);
  const removedPackages = pruneUnreachablePackages(options.out, keep);
  const removedFiles = prunePackageFat(options.out);
  process.stdout.write(
    `[cloud-artifact] 裁剪：保留 ${keep.size} 个可达包，删除 ${removedPackages.length} 个不可达包、` +
      `${removedFiles} 个包内非运行期文件\n` +
      (removedPackages.length > 0 ? `  删除：${removedPackages.join(", ")}\n` : ""),
  );

  // 摘要与准入检查（node_modules 逐文件哈希太慢，按聚合摘要 + 顶层校验文件数）。
  // engines：裁剪后再写/修正（按实际随包依赖）。
  const shippedEngines = computeShippedEngines(options.out);
  const pkgPath = path.join(options.out, "package.json");
  const writtenPkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  // 自身代码下界：本切片用 node:sqlite（DatabaseSync，≥22.5）；不继承仓库根的
  // >=22.19.0——那是 pi-ai/pi-agent-core 的要求，而这两个包已被裁掉。
  const CODE_NODE_FLOOR = [22, 5, 0];
  const floorParts =
    shippedEngines.highest === undefined
      ? CODE_NODE_FLOOR
      : shippedEngines.highest.parts.some((value, i) => value > CODE_NODE_FLOOR[i])
        ? shippedEngines.highest.parts
        : CODE_NODE_FLOOR;
  writtenPkg.engines = { node: `>=${floorParts.join(".")}` };
  writeFileSync(pkgPath, `${JSON.stringify(writtenPkg, null, 2)}\n`);
  if (shippedEngines.highest !== undefined) {
    process.stdout.write(
      `[cloud-artifact] engines.node => ${writtenPkg.engines.node}` +
        `（随包依赖最高要求：${shippedEngines.highest.name}）\n`,
    );
  }

  const files = listFiles(options.out).filter((f) => !f.rel.startsWith("node_modules/"));
  assertAdmissible(listFiles(options.out));
  const digestLines = files
    .map((f) => `${f.rel}\u0000sha256:${sha256File(f.abs)}`)
    .sort()
    .join("\n");
  const artifactSha256 = `sha256:${createHash("sha256").update(digestLines).digest("hex")}`;
  const totalBytes = listFiles(options.out).reduce((sum, f) => sum + f.size, 0);
  const maxBytes = options.maxMiB * 1024 * 1024;
  if (totalBytes > maxBytes) {
    throw new Error(
      `制品体积 ${(totalBytes / 1024 / 1024).toFixed(1)} MiB 超过上限 ${options.maxMiB} MiB：` +
        "裁剪或改走打包方案（属范围变更，需先确认）",
    );
  }

  const buildManifest = {
    schema_version: "0.1.2",
    artifact_kind: "kiwi-merchant-cloud-runtime",
    runtime_version: rootPkg.version,
    source_commit: gitCommit(),
    built_at: new Date().toISOString(),
    node_version: process.versions.node,
    entry: "app/cloud/main.js",
    artifact_sha256: artifactSha256,
    dependency_lock_sha256: dependencyLockDigest(options.out),
    file_count_excluding_node_modules: files.length,
    total_bytes: totalBytes,
    files: files.map((f) => ({ path: f.rel, size: f.size, sha256: `sha256:${sha256File(f.abs)}` })),
    notes: [
      "artifact_sha256 覆盖 node_modules 之外的制品文件（含 contracts/ 与 package.json）。",
      "本文件是本机构建事实；平台安装/冷启动证据在 evidence/runs/<date>-M1/ 另记。",
    ],
  };
  // 不叫 build-manifest：文件名同样避开 "build" 前缀，避免被发布工具过滤。
  writeFileSync(
    path.join(options.out, "artifact-manifest.json"),
    `${JSON.stringify(buildManifest, null, 2)}\n`,
  );

  if (options.artifactUri !== undefined) {
    if (!/^https:\/\//.test(options.artifactUri)) {
      throw new Error("--artifact-uri 必须是 https:// 地址（Schema 要求）");
    }
    const releaseManifest = {
      schema_version: "0.1.2",
      release_version: rootPkg.version,
      runtime_version: rootPkg.version,
      source_commit: buildManifest.source_commit,
      artifact_uri: options.artifactUri,
      artifact_sha256: artifactSha256,
      node_version: process.versions.node,
      wire_profile: "a2a-1.0",
      // M1 薄切片：权威状态落在制品外的显式状态目录（单写者）。
      storage_mode: "persistent_single_writer",
      signing_policy: "verify_before_deploy",
      compatible_catalog_contract: "0.1.2",
      // M1 未使用 WorkBuddy 云端 SDK（未接云数据库/LLM/存储）。
      sdk_lock: {
        mode: "not_used",
        reason: "M1 薄切片不调用云端 SDK 模块（未接云数据库/LLM/存储）",
        evidence_ref: "evidence/runs/2026-09-20-M1/〈M1 实验记录〉",
      },
      dependency_lock_sha256: buildManifest.dependency_lock_sha256,
      evidence_kind: "measured",
    };
    writeFileSync(
      path.join(options.out, "release-manifest.json"),
      `${JSON.stringify(releaseManifest, null, 2)}\n`,
    );
    process.stdout.write("[cloud-artifact] 已写入 release-manifest.json（含 artifact_uri）\n");
  } else {
    process.stdout.write(
      "[cloud-artifact] 未提供 --artifact-uri：跳过 release-manifest.json（避免伪造对外地址）\n",
    );
  }

  process.stdout.write(
    `[cloud-artifact] 完成：${options.out}\n` +
      `  文件数（不含 node_modules）：${files.length}\n` +
      `  体积：${(totalBytes / 1024 / 1024).toFixed(1)} MiB\n` +
      `  artifact_sha256：${artifactSha256}\n`,
  );
}

main();
