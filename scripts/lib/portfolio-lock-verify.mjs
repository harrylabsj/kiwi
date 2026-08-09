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
// 组合锁候选预检的纯校验/比对逻辑（无网络、无 checkout/push/registry）。
//
// portfolio.lock.json 是三仓组合的 immutable 边界：contract_bundle_sha256 /
// contract_source_commit 固定契约 bundle 来源，repositories.*.commit 固定三个
// 仓库的公开提交。远程同步本地三仓提交前，operator 用候选 lock 文件跑本模块：
//
//   1. 结构校验：lock_version、仓库 allowlist、repo 名、40 位小写 commit SHA、
//      64 位小写 bundle hex；
//   2. kiwi contracts/manifest.json 的 bundle_sha256 与 lock 的
//      contract_bundle_sha256 一致；
//   3. 两个 consumer checkout 的 `git rev-parse HEAD` 与 lock commit 精确一致；
//   4. 两个 consumer 的 kiwi-contracts.lock.json 的 source_commit /
//      bundle_sha256 与 portfolio lock 一致。
//
// 所有失败都以类型化 PortfolioLockError 抛出（fail-closed）。纯 helper 导出给
// Vitest 直接覆盖，不触碰网络；`git` 仅用于本地 `rev-parse HEAD`。

import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";

/** 组合内允许的仓库 key → 规范 repository 名（单一 allowlist）。 */
export const ALLOWED_REPOSITORIES = Object.freeze({
  kiwi: "harrylabsj/kiwi",
  "kiwi-catalog": "harrylabsj/kiwi-catalog",
  "shopping-cli": "harrylabsj/shopping-cli",
});

/** 组合锁必须包含且仅包含这三个仓库 key。 */
export const REPOSITORY_KEYS = Object.freeze(Object.keys(ALLOWED_REPOSITORIES));

/** 64 位小写 hex（SHA-256）。 */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** 40 位小写 commit SHA。 */
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/** consumer checkout 内固定的契约锁文件名。 */
export const LOCK_FILENAME = "kiwi-contracts.lock.json";

/**
 * 类型化校验错误。`code` 用于测试断言与 operator 定位，message 只含校验主体
 * 字段与值，绝不携带环境变量或文件全文（不泄露环境秘密）。
 */
export class PortfolioLockError extends Error {
  constructor(message, { code = "PORTFOLIO_LOCK_INVALID" } = {}) {
    super(message);
    this.name = "PortfolioLockError";
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new PortfolioLockError(message, { code });
};

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 结构校验组合锁。任何违规立即抛 PortfolioLockError。
 *
 * @param {unknown} lock 解析后的 candidate portfolio lock。
 */
export function validateLock(lock) {
  if (!isPlainObject(lock)) {
    fail("portfolio lock must be a JSON object", "LOCK_SHAPE");
  }
  if (lock.lock_version !== 1) {
    fail(`unsupported lock_version ${String(lock.lock_version)}`, "LOCK_VERSION");
  }
  if (!SHA256_HEX_RE.test(String(lock.contract_bundle_sha256 ?? ""))) {
    fail("contract_bundle_sha256 must be a 64-char lowercase hex", "BUNDLE_SHA");
  }
  if (!COMMIT_SHA_RE.test(String(lock.contract_source_commit ?? ""))) {
    fail("contract_source_commit must be a 40-char lowercase SHA", "SOURCE_COMMIT_SHA");
  }
  if (!isPlainObject(lock.repositories)) {
    fail("repositories must be an object", "REPOSITORIES_SHAPE");
  }
  for (const key of Object.keys(lock.repositories)) {
    if (!(key in ALLOWED_REPOSITORIES)) {
      fail(`repositories contains disallowed repo key: ${key}`, "REPOSITORY_KEY");
    }
  }
  for (const key of REPOSITORY_KEYS) {
    if (!(key in lock.repositories)) {
      fail(`repositories missing required repo: ${key}`, "REPOSITORY_MISSING");
    }
    const entry = lock.repositories[key];
    if (!isPlainObject(entry)) {
      fail(`repositories.${key} must be an object`, "REPOSITORY_ENTRY_SHAPE");
    }
    if (entry.repository !== ALLOWED_REPOSITORIES[key]) {
      fail(
        `repositories.${key}.repository must be ${ALLOWED_REPOSITORIES[key]}, got ${String(entry.repository)}`,
        "REPOSITORY_NAME",
      );
    }
    if (!COMMIT_SHA_RE.test(String(entry.commit ?? ""))) {
      fail(`repositories.${key}.commit must be a 40-char lowercase SHA`, "REPOSITORY_COMMIT_SHA");
    }
  }
}

/**
 * 校验 kiwi contracts/manifest.json 的 bundle_sha256 与组合锁一致。
 * `kiwiRoot` 由调用方解析（CLI 用脚本自身位置推导；测试用临时 fixture）。
 *
 * @param {string} kiwiRoot kiwi 仓库根目录。
 * @param {object} lock 已通过结构校验的组合锁。
 */
export async function verifyManifestBundle(kiwiRoot, lock) {
  const manifestPath = resolve(kiwiRoot, "contracts/manifest.json");
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    fail(`cannot read kiwi contracts manifest: ${err.code ?? "error"}`, "MANIFEST_READ");
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    fail("kiwi contracts/manifest.json is not valid JSON", "MANIFEST_PARSE");
  }
  if (!isPlainObject(manifest)) {
    fail("kiwi contracts/manifest.json must be an object", "MANIFEST_SHAPE");
  }
  if (manifest.manifest_version !== 1) {
    fail(`unsupported manifest_version ${String(manifest.manifest_version)}`, "MANIFEST_VERSION");
  }
  if (!SHA256_HEX_RE.test(String(manifest.bundle_sha256 ?? ""))) {
    fail(
      "kiwi contracts/manifest.json bundle_sha256 must be a 64-char lowercase hex",
      "MANIFEST_BUNDLE_SHA",
    );
  }
  if (manifest.bundle_sha256 !== lock.contract_bundle_sha256) {
    fail(
      `kiwi contracts/manifest.json bundle_sha256 ${manifest.bundle_sha256} does not match portfolio contract_bundle_sha256 ${lock.contract_bundle_sha256}`,
      "MANIFEST_BUNDLE_MISMATCH",
    );
  }
}

const assertReadableDirectory = (directory, code) => {
  let stat;
  try {
    stat = statSync(directory);
  } catch {
    fail(`directory does not exist: ${directory}`, code);
  }
  if (!stat.isDirectory()) {
    fail(`not a directory: ${directory}`, code);
  }
};

/**
 * 本地解析 checkout 的 HEAD commit（仅 `git rev-parse HEAD`，无网络/checkout）。
 *
 * @param {string} repoDir git checkout 目录。
 * @returns {string} 40 位小写 commit SHA。
 */
export function gitHeadCommit(repoDir) {
  const result = spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.error) {
    fail(`cannot run git rev-parse HEAD: ${result.error.code ?? "git error"}`, "GIT_HEAD");
  }
  if (result.status !== 0) {
    const firstLine = String(result.stderr ?? "")
      .trim()
      .split("\n")[0];
    fail(`git rev-parse HEAD failed: ${firstLine || "unknown error"}`, "GIT_HEAD");
  }
  const head = String(result.stdout ?? "").trim();
  if (!COMMIT_SHA_RE.test(head)) {
    fail("git rev-parse HEAD returned a non-SHA value", "GIT_HEAD");
  }
  return head;
}

/**
 * 校验 consumer checkout 的 HEAD 与 lock 的 repositories.<repoKey>.commit 精确一致。
 *
 * @param {string} consumerDir consumer 本地 checkout 根目录。
 * @param {object} lock 组合锁。
 * @param {string} repoKey 仓库 key（kiwi-catalog / shopping-cli）。
 * @returns {Promise<string>} 校验通过时的 HEAD commit。
 */
export async function verifyConsumerHead(consumerDir, lock, repoKey) {
  assertReadableDirectory(consumerDir, "CONSUMER_READ");
  const head = gitHeadCommit(consumerDir);
  const expected = lock.repositories[repoKey].commit;
  if (head !== expected) {
    fail(`${repoKey} HEAD ${head} does not match lock commit ${expected}`, "HEAD_MISMATCH");
  }
  return head;
}

// 递归扫描时需要跳过的目录（.git、依赖、构建产物、缓存），既为性能也避免
// 误读 vendored 副本。symlink 目录/文件不会被跟随（Dirent.isDirectory() /
// isFile() 对 symlink 为 false），因此不可能逃逸出 consumer 目录。
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".egg-info",
  ".ipynb_checkpoints",
  ".direnv",
]);

/**
 * 在 consumer checkout 内限定范围查找 kiwi-contracts.lock.json。
 * 只扫描普通目录/文件，不跟随 symlink，路径安全（不读 consumer 目录外）。
 *
 * @param {string} consumerDir consumer 本地 checkout 根目录。
 * @returns {Promise<string[]>} 找到的 lock 文件绝对路径。
 */
export async function findConsumerLockFiles(consumerDir) {
  assertReadableDirectory(consumerDir, "CONSUMER_READ");
  const found = [];
  const visit = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (err) {
      fail(`cannot read consumer directory: ${err.code ?? "error"}`, "CONSUMER_READ");
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await visit(join(directory, entry.name));
      } else if (entry.isFile() && entry.name === LOCK_FILENAME) {
        found.push(join(directory, entry.name));
      }
    }
  };
  await visit(consumerDir);
  return found;
}

/**
 * 读取并结构校验单个 consumer kiwi-contracts.lock.json。
 *
 * @param {string} file lock 文件绝对路径。
 * @returns {Promise<object>} 解析后的 consumer lock。
 */
export async function readConsumerLockFile(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    fail(`cannot read consumer lock: ${err.code ?? "error"}`, "CONSUMER_LOCK_READ");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("consumer kiwi-contracts.lock.json is not valid JSON", "CONSUMER_LOCK_PARSE");
  }
  if (!isPlainObject(parsed)) {
    fail("consumer kiwi-contracts.lock.json must be an object", "CONSUMER_LOCK_SHAPE");
  }
  if (parsed.lock_version !== 1) {
    fail(
      `unsupported consumer lock_version ${String(parsed.lock_version)}`,
      "CONSUMER_LOCK_VERSION",
    );
  }
  if (!COMMIT_SHA_RE.test(String(parsed.source_commit ?? ""))) {
    fail(
      "consumer lock source_commit must be a 40-char lowercase SHA",
      "CONSUMER_SOURCE_COMMIT_SHA",
    );
  }
  if (!SHA256_HEX_RE.test(String(parsed.bundle_sha256 ?? ""))) {
    fail("consumer lock bundle_sha256 must be a 64-char lowercase hex", "CONSUMER_BUNDLE_SHA");
  }
  return parsed;
}

/**
 * 校验 consumer checkout 内所有 kiwi-contracts.lock.json 的 source_commit /
 * bundle_sha256 与组合锁一致（至少一个文件；每个文件都必须一致，fail-closed）。
 *
 * @param {string} consumerDir consumer 本地 checkout 根目录。
 * @param {object} lock 组合锁。
 * @returns {Promise<{ checked: number }>} 校验的 lock 文件数量。
 */
export async function verifyConsumerLock(consumerDir, lock) {
  assertReadableDirectory(consumerDir, "CONSUMER_READ");
  const files = await findConsumerLockFiles(consumerDir);
  if (files.length === 0) {
    fail(`no ${LOCK_FILENAME} found under consumer directory`, "CONSUMER_LOCK_MISSING");
  }
  for (const file of files) {
    const consumerLock = await readConsumerLockFile(file);
    if (consumerLock.source_commit !== lock.contract_source_commit) {
      fail(
        `consumer lock source_commit ${consumerLock.source_commit} does not match portfolio contract_source_commit ${lock.contract_source_commit}`,
        "CONSUMER_SOURCE_COMMIT_MISMATCH",
      );
    }
    if (consumerLock.bundle_sha256 !== lock.contract_bundle_sha256) {
      fail(
        `consumer lock bundle_sha256 ${consumerLock.bundle_sha256} does not match portfolio contract_bundle_sha256 ${lock.contract_bundle_sha256}`,
        "CONSUMER_BUNDLE_MISMATCH",
      );
    }
  }
  return { checked: files.length };
}

/**
 * 组合锁候选预检编排：结构 → manifest bundle → 两个 consumer HEAD →
 * 两个 consumer 契约锁，全部通过才返回固定摘要行。
 *
 * @param {object} options
 * @param {string} options.lockPath candidate portfolio lock 文件路径。
 * @param {string} options.kiwiCatalogDir kiwi-catalog 本地 checkout。
 * @param {string} options.shoppingCliDir shopping-cli 本地 checkout。
 * @param {string} options.kiwiRoot kiwi 仓库根目录（读取 contracts/manifest.json）。
 * @returns {Promise<string[]>} 固定、可读的成功摘要行。
 */
export async function verifyPortfolioLockCandidate({
  lockPath,
  kiwiCatalogDir,
  shoppingCliDir,
  kiwiRoot,
}) {
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    fail(`cannot read lock file: ${err.code ?? "error"}`, "LOCK_READ");
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    fail("lock file is not valid JSON", "LOCK_PARSE");
  }
  validateLock(lock);

  await verifyManifestBundle(kiwiRoot, lock);

  const catalogHead = await verifyConsumerHead(kiwiCatalogDir, lock, "kiwi-catalog");
  const shoppingHead = await verifyConsumerHead(shoppingCliDir, lock, "shopping-cli");

  const catalogLock = await verifyConsumerLock(kiwiCatalogDir, lock);
  const shoppingLock = await verifyConsumerLock(shoppingCliDir, lock);

  return [
    "portfolio lock candidate verified",
    `  lock_version: ${lock.lock_version}`,
    `  contract_source_commit: ${lock.contract_source_commit}`,
    `  contract_bundle_sha256: ${lock.contract_bundle_sha256}`,
    "  kiwi contracts/manifest.json bundle_sha256: match",
    `  kiwi-catalog HEAD: ${catalogHead} (matches lock repositories.kiwi-catalog.commit)`,
    `  shopping-cli HEAD: ${shoppingHead} (matches lock repositories.shopping-cli.commit)`,
    `  kiwi-catalog consumer lock: ${catalogLock.checked} file(s), source_commit + bundle_sha256 match`,
    `  shopping-cli consumer lock: ${shoppingLock.checked} file(s), source_commit + bundle_sha256 match`,
  ];
}
