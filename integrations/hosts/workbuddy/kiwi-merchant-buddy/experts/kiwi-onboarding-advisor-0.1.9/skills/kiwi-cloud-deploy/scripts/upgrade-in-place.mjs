#!/usr/bin/env node
/**
 * 原地升级的文件手术脚本（供 kiwi-cloud-deploy 技能在升级流程第 4 步调用）。
 *
 * 只做一件事：把一个已校验过的新版本部署目录里的**程序文件**替换进既有发布目录，
 * 并逐字节保留 cloud.config.json 与 pilot/merchant.yaml；替换前整目录备份。
 *
 * 它不做：不解析 latest、不下载、不校验 tarball、不调用平台发布工具、不改配置、
 * 不碰云端数据目录、不读任何口令或 token。发布动作仍由当前会话真实提供的工具完成。
 *
 * 用法：
 *   node upgrade-in-place.mjs --publish-dir <绝对路径> --staged <新版本包目录绝对路径> [--dry-run]
 *
 * 退出码：0 成功（含 --dry-run），1 前置条件/校验失败。
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

// 允许替换的程序文件/目录；其余（cloud.config.json、pilot/、node_modules/ 等）一律不动。
const REPLACED = ["app", "contracts", "scripts", "index.js", "package.json", "build-manifest.json"];
const KEPT = ["cloud.config.json", path.join("pilot", "merchant.yaml")];

function fail(message) {
  process.stderr.write(`[upgrade-in-place] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { publishDir: undefined, staged: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--publish-dir") options.publishDir = argv[++i];
    else if (arg === "--staged") options.staged = argv[++i];
    else if (arg === "--dry-run") options.dryRun = true;
    else fail(`未知参数 ${arg}`);
  }
  if (options.publishDir === undefined || options.staged === undefined) {
    fail("用法：node upgrade-in-place.mjs --publish-dir <绝对路径> --staged <新版本包目录绝对路径> [--dry-run]");
  }
  if (!path.isAbsolute(options.publishDir) || !path.isAbsolute(options.staged)) fail("两个路径都必须是绝对路径");
  return options;
}

function sha256(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function countFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    total += entry.isDirectory() ? countFiles(full) : 1;
  }
  return total;
}

function singleLine(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) fail(`${label} 缺失或含换行`);
  return value;
}

const options = parseArgs(process.argv.slice(2));
const publishDir = path.resolve(options.publishDir);
const stagedDir = path.resolve(options.staged);

if (!existsSync(publishDir) || !lstatSync(publishDir).isDirectory()) fail(`发布目录不存在或不是目录：${publishDir}`);
if (!existsSync(stagedDir) || !lstatSync(stagedDir).isDirectory()) fail(`新版本目录不存在或不是目录：${stagedDir}`);
if (publishDir === stagedDir || publishDir.startsWith(`${stagedDir}${path.sep}`) || stagedDir.startsWith(`${publishDir}${path.sep}`)) {
  fail("发布目录与新版本目录不能互相包含");
}

// 前置：保留文件必须已在发布目录里，新版本目录必须带齐程序文件与部署锁。
for (const rel of KEPT) {
  if (!existsSync(path.join(publishDir, rel))) fail(`发布目录缺少必须保留的 ${rel}；拒绝在不明状态下替换`);
}
for (const rel of ["app", "index.js", "package.json", "build-manifest.json"]) {
  if (!existsSync(path.join(stagedDir, rel))) fail(`新版本目录缺少 ${rel}`);
}
const stagedLock = path.join(stagedDir, "deployment-lock.json");
const stagedExistingLock = path.join(stagedDir, "package-lock.json");
const lockSource = existsSync(stagedLock) ? stagedLock : existsSync(stagedExistingLock) ? stagedExistingLock : undefined;
if (lockSource === undefined) fail("新版本目录既没有 deployment-lock.json 也没有 package-lock.json");

const configPath = path.join(publishDir, "cloud.config.json");
let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  fail("cloud.config.json 不是合法 JSON");
}
const before = {
  version: singleLine(JSON.parse(readFileSync(path.join(publishDir, "package.json"), "utf8")).version, "发布目录 package.json version"),
  config_sha256: sha256(configPath),
  profile_sha256: sha256(path.join(publishDir, KEPT[1])),
};
const nextVersion = singleLine(JSON.parse(readFileSync(path.join(stagedDir, "package.json"), "utf8")).version, "新版本 package.json version");
const nextConfig = existsSync(path.join(stagedDir, "cloud.config.json"))
  ? JSON.parse(readFileSync(path.join(stagedDir, "cloud.config.json"), "utf8"))
  : undefined;

// 新版本自带的配置若与现网不一致，只报告、不采用（采用会换 data_dir/origin/身份）。
const configDiffs = [];
if (nextConfig !== undefined) {
  for (const key of ["public_origin", "data_dir", "profile", "products_file"]) {
    if (JSON.stringify(nextConfig[key]) !== JSON.stringify(config[key])) {
      configDiffs.push({ field: key, staged: nextConfig[key] ?? null, kept: config[key] ?? null });
    }
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = `${publishDir}-${stamp}-backup`;
if (existsSync(backupDir)) fail(`备份目录已存在：${backupDir}`);

const receipt = {
  schema: "kiwi.cloud.upgrade-in-place/1",
  publish_dir: publishDir,
  staged_dir: stagedDir,
  version: { from: before.version, to: nextVersion },
  backup_dir: options.dryRun ? null : backupDir,
  kept: { config_sha256: before.config_sha256, profile_sha256: before.profile_sha256 },
  config: { public_origin: config.public_origin ?? null, data_dir: config.data_dir ?? null, profile: config.profile ?? null, products_file: config.products_file ?? null },
  staged_config_differences_not_adopted: configDiffs,
  dry_run: options.dryRun,
};

if (options.dryRun) {
  receipt.planned = REPLACED;
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.exit(0);
}

// 1) 备份整个发布目录（逐字节）。
cpSync(publishDir, backupDir, { recursive: true, preserveTimestamps: true });

// 2) 只替换程序文件。
for (const rel of REPLACED) {
  const target = path.join(publishDir, rel);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  const source = path.join(stagedDir, rel);
  if (!existsSync(source)) continue; // contracts/scripts 在新版本里可能不存在
  if (lstatSync(source).isDirectory()) mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, preserveTimestamps: true });
}
cpSync(lockSource, path.join(publishDir, "package-lock.json"));

// 3) 复核保留文件未被改动。
const after = {
  config_sha256: sha256(configPath),
  profile_sha256: sha256(path.join(publishDir, KEPT[1])),
};
if (after.config_sha256 !== before.config_sha256 || after.profile_sha256 !== before.profile_sha256) {
  fail(`保留文件在替换过程中被改动（config ${after.config_sha256} / profile ${after.profile_sha256}）；备份在 ${backupDir}`);
}
const afterVersion = JSON.parse(readFileSync(path.join(publishDir, "package.json"), "utf8")).version;
if (afterVersion !== nextVersion) fail(`替换后版本 ${afterVersion} != ${nextVersion}`);

receipt.files_after = countFiles(publishDir);
receipt.files_backup = countFiles(backupDir);
receipt.verified = { config_unchanged: true, profile_unchanged: true, version: afterVersion };
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
