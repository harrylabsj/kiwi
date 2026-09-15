/**
 * deploy/merchant-bundle 安装器（V2 阶段一）。
 *
 * 配套实例：Kiwi Merchant + shopping-cli + 持久卷布局 + 服务托管单元。
 * fail-closed 原则：
 *   - 新实例必须显式 --confirm-new-instance；
 *   - 检测到已有安装/已有数据库（<prefix>/data 非空或 state.sqlite 存在）→
 *     拒绝安装，绝不新建空库替代已有安装（升级路径留阶段四，明确报错）；
 *   - shopping-cli 版本超出版本锁（versions.lock.json；与 src/product-compat.ts
 *     的漂移由 tests/deploy-merchant-bundle.test.ts 锁定）→ 拒绝。
 *
 * 用法：
 *   node deploy/merchant-bundle/install.mjs --prefix /srv/kiwi-merchant --confirm-new-instance \
 *     [--shopping-bin /usr/local/bin/shopping] [--dry-run]
 */
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSIONS_LOCK = JSON.parse(readFileSync(path.join(here, "versions.lock.json"), "utf8"));

function fail(message) {
  console.error(`安装失败：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { confirmNewInstance: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--prefix") args.prefix = argv[++i];
    else if (a === "--shopping-bin") args.shoppingBin = argv[++i];
    else if (a === "--confirm-new-instance") args.confirmNewInstance = true;
    else if (a === "--dry-run") args.dryRun = true;
    else fail(`未知参数 ${a}`);
  }
  assert(args.prefix, "缺 --prefix <安装目录>");
  return args;
}

/** 解析 ">= a.b.c < x.y.z" 范围文本（versions.lock.json 的 shopping_cli 字段）。 */
function parseRange(text) {
  const match = /^>= (\d+\.\d+\.\d+)(?: < (\d+\.\d+\.\d+))?$/.exec(text.trim());
  assert(match !== null, `versions.lock.json shopping_cli 范围非法：${text}`);
  return { min: match[1], maxExclusive: match[2] };
}

function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function cmp(a, b) {
  for (const k of ["major", "minor", "patch"]) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return 0;
}

/** 版本是否在版本锁范围内（fail-closed：不可判定 → false）。 */
export function versionLocked(versionText, rangeText = VERSIONS_LOCK.shopping_cli) {
  const v = parseVersion(versionText);
  const { min, maxExclusive } = parseRange(rangeText);
  const minV = parseVersion(min);
  const maxV = maxExclusive !== undefined ? parseVersion(maxExclusive) : null;
  if (v === null || minV === null) return false;
  if (cmp(v, minV) < 0) return false;
  if (maxV !== null && cmp(v, maxV) >= 0) return false;
  return true;
}

/** shopping-cli 版本检查（fail-closed：不可用或超范围都拒绝）。 */
export function checkShoppingCli(shoppingBin) {
  const result = spawnSync(shoppingBin, ["--version"], { encoding: "utf-8", timeout: 5_000 });
  if (result.status !== 0) {
    return {
      ok: false,
      error: `shopping --version 失败（${result.status ?? result.error?.message}）`,
    };
  }
  const text = String(result.stdout ?? "").trim();
  if (!versionLocked(text)) {
    return {
      ok: false,
      error: `shopping-cli 版本 ${text || "不可判定"} 不在版本锁范围 ${VERSIONS_LOCK.shopping_cli}`,
    };
  }
  return { ok: true, version: parseVersion(text) };
}

/** 已有安装检测：<prefix>/data 存在且非空，或 state.sqlite 存在 → true。 */
export function detectExistingInstall(prefix) {
  const dataDir = path.join(prefix, "data");
  if (existsSync(path.join(dataDir, "state.sqlite"))) return "已有状态库 state.sqlite";
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0)
    return `已有数据目录 ${dataDir}（非空）`;
  return undefined;
}

function renderTemplate(name, vars) {
  const template = readFileSync(path.join(here, name), "utf8");
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`__${k}__`, v), template);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const prefix = path.resolve(args.prefix);

  const existing = detectExistingInstall(prefix);
  if (existing !== undefined) {
    fail(
      `检测到已有安装（${existing}）。不新建空库替代已有安装；` +
        "升级路径在阶段四提供，请先备份并人工核对。",
    );
  }
  if (!args.confirmNewInstance) {
    fail("新实例安装必须显式加 --confirm-new-instance（确认创建全新商家实例）。");
  }

  const shopping = checkShoppingCli(args.shoppingBin ?? "shopping");
  if (!shopping.ok) fail(shopping.error);

  const layout = {
    prefix,
    data: path.join(prefix, "data"),
    config: path.join(prefix, "config"),
    run: path.join(prefix, "run"),
    logs: path.join(prefix, "logs"),
    backups: path.join(prefix, "backups"),
  };

  if (args.dryRun) {
    console.log(JSON.stringify({ dry_run: true, layout, versions: VERSIONS_LOCK }, null, 2));
    return;
  }

  for (const dir of Object.values(layout)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    path.join(layout.config, "kiwi-merchant.service"),
    renderTemplate(path.join("systemd", "kiwi-merchant.service.template"), { PREFIX: prefix }),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(layout.config, "com.kiwi.merchant.plist"),
    renderTemplate(path.join("launchd", "com.kiwi.merchant.plist.template"), { PREFIX: prefix }),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(layout.config, "install.json"),
    `${JSON.stringify(
      {
        installed_at: new Date().toISOString(),
        prefix,
        versions: VERSIONS_LOCK,
        shopping_cli_detected: shopping.version,
        layout,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.log(
    `安装完成：${prefix}（shopping-cli ${shopping.version.major}.${shopping.version.minor}.${shopping.version.patch}；服务单元在 config/ 下）`,
  );
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
