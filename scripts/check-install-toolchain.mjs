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
 * A106 安装工具契约守卫（preinstall，fail-closed）— 0.12.5 起。
 *
 * 不变量：本包的安装产物中不得存在已知脆弱的嵌套依赖副本。
 * 背景（A92/A94/A97/A100 实证链）：pi-coding-agent ≤1.0.2 的 npm-shrinkwrap
 *   曾钉嵌套 brace-expansion 5.0.9（GHSA-q2hr-2g5m-vwhr / GHSA-qhr7-859c-m2p7 /
 *   GHSA-6j4f-fj2g-mc7p），旧 npm 无法用 override 穿透，故 0.12.4 曾按
 *   npm >=12.0.2 <13 fail-closed。上游 1.2.0 已移除 shrinkwrap、原始树即干净
 *   （实测 brace-expansion 仅 5.0.12），本守卫转为直接校验树内容，任何
 *   安装器版本均可安装；若脆弱副本再次出现，无论 npm 版本一律拒绝。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const VULNERABLE = [
  { name: "brace-expansion", version: "5.0.9", ghsa: "GHSA-q2hr-2g5m-vwhr" },
];

/** 深度优先收集 <dir> 树内 name 包的全部安装副本（含任意嵌套 node_modules 与 @scope）。 */
function collectCopies(dir, name, out, depth = 0) {
  if (depth > 24 || out.length > 5000) return;
  const nm = path.join(dir, "node_modules");
  let entries = [];
  try {
    entries = readdirSync(nm, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (e.name.startsWith("@")) {
      let scoped = [];
      try {
        scoped = readdirSync(path.join(nm, e.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of scoped) {
        if (!s.isDirectory() || s.name.startsWith(".")) continue;
        recordIfVulnerable(path.join(nm, e.name, s.name), name, out);
        collectCopies(path.join(nm, e.name, s.name), name, out, depth + 1);
      }
    } else {
      recordIfVulnerable(path.join(nm, e.name), name, out);
      collectCopies(path.join(nm, e.name), name, out, depth + 1);
    }
  }
}

function recordIfVulnerable(pkgDir, name, out) {
  if (path.basename(pkgDir) !== name) return;
  if (!existsSync(pkgDir) || !statSync(pkgDir).isDirectory()) return;
  try {
    const v = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
    const vuln = VULNERABLE.find((x) => x.name === name && x.version === v);
    if (vuln) out.push(`${name}@${v} at ${pkgDir} (${vuln.ghsa})`);
  } catch {
    /* unreadable package.json: skip */
  }
}

const root = process.env.npm_config_local_prefix || process.cwd();

// Node 下界守卫：随包依赖（undici 8.10.2、@earendil-works/pi-* 1.2.0）声明
// engines.node >=22.19.0。低版本 npm 默认只报 EBADENGINE 警告后继续安装，故障
// 会推迟到运行时（undici 8 需要 22.19+ 的运行时行为）。这里按**被安装包自己的**
// engines 显式 fail-closed，并给出固定错误码，便于平台/排障直接定位。
let enginesNode = "";
try {
  enginesNode = String(
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).engines?.node ?? "",
  ).trim();
} catch {
  /* 没有可读的 package.json 时不额外约束（保持原有行为）。 */
}
if (enginesNode !== "") {
  // 只支持单一下界 ">=X.Y" / ">=X.Y.Z"（后者语义更严，必须逐位比较 patch）。
  // 复合范围（">=22.19.0 <23"、向上/波浪号、|| 等）不做近似解释，直接 fail-closed：
  // 静默跳过或只比 major/minor 都会错误放行更低 patch。
  const nodeFloor = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(enginesNode);
  if (nodeFloor === null) {
    console.error(
      `[a106] NODE_ENGINE_UNSUPPORTED: engines.node=${JSON.stringify(enginesNode)}; ` +
        'only a single lower bound ">=X.Y[.Z]" is supported. Rewrite the package engines ' +
        "to that form instead of skipping the Node check.",
    );
    process.exit(1);
  }
  const need = [Number(nodeFloor[1]), Number(nodeFloor[2]), Number(nodeFloor[3] ?? "0")];
  const current = process.versions.node.split(".").map(Number);
  const atLeast = (a, b) =>
    a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
  if (!atLeast(current, need)) {
    console.error(
      `[a106] NODE_VERSION_UNSUPPORTED: package requires node ${enginesNode}, ` +
        `current ${process.versions.node}; deploy on Node >=${need[0]}.${need[1]}.${need[2]} ` +
        "(e.g. 22.19.0) instead of an older sandbox runtime.",
    );
    process.exit(1);
  }
}

const offenders = [];
for (const vuln of VULNERABLE) {
  collectCopies(root, vuln.name, offenders);
}

if (offenders.length > 0) {
  console.error(
    "[a106] vulnerable nested dependency copy detected — refusing to install (fail-closed):\n  " +
      offenders.join("\n  "),
  );
  process.exit(1);
}
console.log("[a106] dependency tree invariant OK");
