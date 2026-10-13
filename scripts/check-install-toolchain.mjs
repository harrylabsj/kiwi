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
