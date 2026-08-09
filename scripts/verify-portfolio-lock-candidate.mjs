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
//
// 组合锁候选预检（本地、无网络、无发布权限）。远程同步本地三仓提交前，先用
// 候选 portfolio.lock.json 验证候选组合是否可安全发布：
//
//   node scripts/verify-portfolio-lock-candidate.mjs \
//     --lock ./candidate-portfolio.lock.json \
//     --kiwi-catalog-dir <WORKSPACE>/kiwi-catalog \
//     --shopping-cli-dir ~/coding/shopping-cli
//
// 校验内容（全部 fail-closed，任一失败即退出码 1）：
//   - lock_version=1；repositories 只含 kiwi/kiwi-catalog/shopping-cli；
//     repository 名必须命中 allowlist；commit/source_commit 必须 40 位小写 SHA；
//     contract_bundle_sha256 必须 64 位小写 hex；
//   - kiwi contracts/manifest.json 的 bundle_sha256 与组合锁一致；
//   - kiwi 中央 contracts/kiwi-contracts.lock.json 的 source_commit/bundle_sha256
//     与组合锁一致；
//   - 两个 consumer checkout 的 `git rev-parse HEAD` 与 lock commit 精确一致；
//   - 两个 consumer 的 kiwi-contracts.lock.json 的 source_commit/bundle_sha256
//     与组合锁一致。
//
// 本脚本只做本地只读校验：不执行网络、checkout、push、registry 操作，不修改
// 当前 portfolio.lock.json 的历史远程 SHA。错误信息不泄露环境秘密。成功输出
// 固定、可读的摘要。

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PortfolioLockError, verifyPortfolioLockCandidate } from "./lib/portfolio-lock-verify.mjs";

const USAGE = `usage: node scripts/verify-portfolio-lock-candidate.mjs \\
  --lock <candidate-portfolio.lock.json> \\
  --kiwi-catalog-dir <kiwi-catalog checkout> \\
  --shopping-cli-dir <shopping-cli checkout>

Verify a candidate portfolio.lock.json combination before it is used to sync
the three local repos. Read-only and offline: only local JSON files and
\`git rev-parse HEAD\` are consulted. Never modifies the committed
portfolio.lock.json or the consumer checkouts.

options:
  --lock <path>                 candidate portfolio.lock.json to validate
  --kiwi-catalog-dir <path>     local kiwi-catalog checkout root
  --shopping-cli-dir <path>     local shopping-cli checkout root
  --help                        show this help and exit
`;

/**
 * 解析 CLI 参数。未知参数或缺失必填项抛 PortfolioLockError(USAGE)。
 *
 * @param {string[]} argv process.argv.slice(2)。
 */
function parseArgs(argv) {
  const args = { help: false, lock: null, kiwiCatalogDir: null, shoppingCliDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg !== "--lock" && arg !== "--kiwi-catalog-dir" && arg !== "--shopping-cli-dir") {
      throw new PortfolioLockError(`unknown argument: ${String(arg)}`, { code: "USAGE" });
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new PortfolioLockError(`missing value for ${String(arg)}`, { code: "USAGE" });
    }
    if (arg === "--lock") {
      args.lock = value;
    } else if (arg === "--kiwi-catalog-dir") {
      args.kiwiCatalogDir = value;
    } else {
      args.shoppingCliDir = value;
    }
    i += 1;
  }
  if (!args.help) {
    if (args.lock === null)
      throw new PortfolioLockError("missing required --lock <path>", { code: "USAGE" });
    if (args.kiwiCatalogDir === null) {
      throw new PortfolioLockError("missing required --kiwi-catalog-dir <path>", { code: "USAGE" });
    }
    if (args.shoppingCliDir === null) {
      throw new PortfolioLockError("missing required --shopping-cli-dir <path>", { code: "USAGE" });
    }
  }
  return args;
}

// kiwi 仓库根目录由脚本自身位置推导（scripts/..），不依赖 cwd。
const kiwiRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`error: ${err.message}`);
  console.error(USAGE);
  process.exit(2);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

try {
  const lines = await verifyPortfolioLockCandidate({
    lockPath: resolve(args.lock),
    kiwiCatalogDir: resolve(args.kiwiCatalogDir),
    shoppingCliDir: resolve(args.shoppingCliDir),
    kiwiRoot,
  });
  for (const line of lines) console.log(line);
} catch (err) {
  if (err instanceof PortfolioLockError) {
    console.error(`portfolio lock candidate verification failed: ${err.message}`);
    process.exitCode = 1;
  } else {
    console.error(`portfolio lock candidate verification failed: unexpected error`);
    process.exitCode = 1;
  }
}
