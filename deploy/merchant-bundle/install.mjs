/**
 * deploy/merchant-bundle 安装器（V2 阶段一；BUG-09 修订：可运行的实例）。
 *
 * 配套实例：Kiwi Merchant + shopping-cli + 持久卷布局 + 服务托管单元。
 * fail-closed 原则：
 *   - 新实例必须显式 --confirm-new-instance；
 *   - 检测到已有安装/已有数据库（<prefix>/data 非空或 state.sqlite 存在）→
 *     拒绝安装，绝不新建空库替代已有安装（升级路径留阶段四，明确报错）；
 *   - shopping-cli 版本超出版本锁（versions.lock.json；与 src/product-compat.ts
 *     的漂移由 tests/deploy-merchant-bundle.test.ts 锁定）→ 拒绝；
 *   - BUG-09：安装 Kiwi 运行应用（dist + 生产依赖）到 <prefix>/app、安装
 *     merchant profile 到 <prefix>/config/profile.yaml、放置实例凭据引用
 *     （<prefix>/.kiwi/credentials.env，0600）、渲染含 --profile/--data-dir
 *     的服务单元（Kiwi + shopping-cli 及其依赖关系），并在宣告完成前跑
 *     preflight（真实执行 <prefix>/app/dist/cli.js --version 冒烟 + 渲染
 *     结果核对）——任一失败即安装失败，绝不产出"装完却起不来"的实例。
 *
 * 用法：
 *   node install.mjs --prefix /srv/kiwi-merchant --confirm-new-instance \
 *     --profile ./merchant.yaml [--app-dir /path/to/kiwi-build] \
 *     [--credentials-env ./credentials.env] [--shopping-bin /usr/local/bin/shopping] \
 *     [--shopping-args "serve --port 8765"] [--skip-credentials-check] [--dry-run]
 *
 * --app-dir 应是生产构建暂存目录（`npm ci --omit=dev && npm run build` 的
 * 产物：dist/ + package.json + node_modules/）；缺省用本仓库根（开发机形态）。
 */
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSIONS_LOCK = JSON.parse(readFileSync(path.join(here, "versions.lock.json"), "utf8"));

function fail(message) {
  console.error(`安装失败：${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    confirmNewInstance: false,
    dryRun: false,
    skipCredentialsCheck: false,
    // 与 product-init 默认 shopping-cli base_url 8765 对齐。审查 P2：3.x 的
    // CLI 无顶层 serve（FastAPI 栈为 `shopping api serve`，需 [api] extra）；
    // 可用 --shopping-args 覆盖为实际发行版/版本的启动命令。
    shoppingArgs: "api serve --port 8765",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--prefix") args.prefix = argv[++i];
    else if (a === "--shopping-bin") args.shoppingBin = argv[++i];
    else if (a === "--shopping-args") args.shoppingArgs = argv[++i];
    else if (a === "--app-dir") args.appDir = argv[++i];
    else if (a === "--profile") args.profile = argv[++i];
    else if (a === "--credentials-env") args.credentialsEnv = argv[++i];
    else if (a === "--confirm-new-instance") args.confirmNewInstance = true;
    else if (a === "--skip-credentials-check") args.skipCredentialsCheck = true;
    else if (a === "--dry-run") args.dryRun = true;
    else fail(`未知参数 ${a}`);
  }
  assert(args.prefix, "缺 --prefix <安装目录>");
  assert(args.profile, "缺 --profile <merchant profile 文件>（BUG-09：实例必须带 profile 才可启动）");
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

function resolveExecutable(bin) {
  if (path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) return path.resolve(bin);
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, [bin], { encoding: "utf8", timeout: 5_000 });
  const resolved = String(result.stdout ?? "").trim().split(/\r?\n/)[0] ?? "";
  return result.status === 0 && resolved !== "" ? resolved : bin;
}

/** 已有安装检测：`<prefix>/data` 存在且非空、state.sqlite 或 config/install.json
 *  存在 → true（审查 P2：安装后未首启前 data/ 为空——install.json 缺失会让
 *  重跑安装器无确认覆盖 app/config/凭据）。 */
export function detectExistingInstall(prefix) {
  const dataDir = path.join(prefix, "data");
  if (existsSync(path.join(dataDir, "state.sqlite"))) return "已有状态库 state.sqlite";
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0)
    return `已有数据目录 ${dataDir}（非空）`;
  if (existsSync(path.join(prefix, "config", "install.json")))
    return "已有安装记录 config/install.json";
  return undefined;
}

/**
 * BUG-09：Kiwi 运行应用检查——dist/cli.js、package.json、node_modules 必须齐备
 * （缺 node_modules 的"裸 dist"跑不起来，绝不安装）。
 */
export function checkAppDir(appDir) {
  const distCli = path.join(appDir, "dist", "cli.js");
  if (!existsSync(distCli)) {
    return { ok: false, error: `应用包缺 ${distCli}（先 npm run build，或用 --app-dir 指向构建产物目录）` };
  }
  if (!existsSync(path.join(appDir, "package.json"))) {
    return { ok: false, error: `应用包缺 ${path.join(appDir, "package.json")}` };
  }
  const nodeModules = path.join(appDir, "node_modules");
  if (!existsSync(nodeModules) || readdirSync(nodeModules).length === 0) {
    return {
      ok: false,
      error: `应用包缺生产依赖 ${nodeModules}（先 npm ci --omit=dev；裸 dist 无法运行）`,
    };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
  } catch (error) {
    return { ok: false, error: `package.json 解析失败：${error.message}` };
  }
  return { ok: true, distCli, version: String(pkg.version ?? "unknown") };
}

/**
 * BUG-09：merchant profile 轻量校验（安装器无 YAML 依赖，做关键事实检查；
 * 完整 schema 校验由 cli 启动时 requireProfileOrDefault 执行——双保险）。
 */
export function checkProfile(profilePath) {
  if (!existsSync(profilePath)) return { ok: false, error: `profile 不存在：${profilePath}` };
  const text = readFileSync(profilePath, "utf8");
  if (text.trim().length === 0) return { ok: false, error: `profile 为空：${profilePath}` };
  if (!/^\s*role:\s*merchant\s*$/m.test(text)) {
    return { ok: false, error: "profile 不是 merchant（缺 `role: merchant`）——商家实例拒绝非 merchant profile" };
  }
  if (!/^\s*agent_id:/m.test(text)) {
    return { ok: false, error: "profile 缺 `agent_id`（实例身份）" };
  }
  return { ok: true };
}

/**
 * BUG-09：实例凭据引用检查。凭据值永不读取/记录——只确认
 * KIWI_MERCHANT_TOKEN 引用存在（cli 侧 loadMerchantCredentials 消费）。
 */
export function checkCredentialsEnv(credentialsPath) {
  if (!existsSync(credentialsPath)) {
    return { ok: false, error: `凭据引用不存在：${credentialsPath}（--credentials-env 放置或 --skip-credentials-check 跳过）` };
  }
  const text = readFileSync(credentialsPath, "utf8");
  if (!/^KIWI_MERCHANT_TOKEN=/m.test(text)) {
    return { ok: false, error: `${credentialsPath} 缺 KIWI_MERCHANT_TOKEN 引用` };
  }
  return { ok: true };
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
  if (args.shoppingArgs.trim() === "") {
    fail("缺 --shopping-args <serve 参数>；必须明确 shopping-cli 的 API 启动命令、端口和数据目录，拒绝生成不可运行的 service");
  }

  // BUG-09：安装前校验应用包 / profile / 凭据引用（全部 fail-closed）。
  const appDir = path.resolve(args.appDir ?? path.join(here, "..", ".."));
  const app = checkAppDir(appDir);
  if (!app.ok) fail(app.error);
  const profileSrc = path.resolve(args.profile);
  const profile = checkProfile(profileSrc);
  if (!profile.ok) fail(profile.error);
  const credentialsTarget = path.join(prefix, ".kiwi", "credentials.env");
  let credentials;
  if (args.credentialsEnv !== undefined) {
    credentials = { source: path.resolve(args.credentialsEnv) };
  } else {
    // 未提供 --credentials-env：回退检查操作者默认凭据（~/.kiwi/credentials.env）。
    credentials = { source: path.join(homedir(), ".kiwi", "credentials.env"), default: true };
  }
  let credentialsOk = true;
  if (!args.skipCredentialsCheck) {
    const c = checkCredentialsEnv(credentials.source);
    credentialsOk = c.ok;
    if (!c.ok) fail(c.error);
    // 审查 P2：入站 token 之外，profile 的 commerce.token_env（数据引擎凭据）
    // 缺失时装得上、起不来（所有 shopping-cli 调用 fail-closed）——违背
    // BUG-09 目标。同样只查存在性，不读不记值。
    const profileText = readFileSync(profileSrc, "utf8");
    const envText = readFileSync(credentials.source, "utf8");
    for (const m of profileText.matchAll(/^\s*token_env:\s*([A-Z_][A-Z0-9_]*)\s*$/gm)) {
      const name = m[1];
      if (!new RegExp(`^${name}=`, "m").test(envText)) {
        fail(`${credentials.source} 缺 ${name} 引用（profile commerce.token_env 指向的数据引擎凭据）`);
      }
    }
  }

  const layout = {
    prefix,
    app: path.join(prefix, "app"),
    data: path.join(prefix, "data"),
    config: path.join(prefix, "config"),
    run: path.join(prefix, "run"),
    logs: path.join(prefix, "logs"),
    backups: path.join(prefix, "backups"),
  };
  const profileTarget = path.join(layout.config, "profile.yaml");

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          layout,
          app: { source: appDir, version: app.version },
          profile: { source: profileSrc, target: profileTarget },
          credentials: { source: credentials.source, target: credentialsTarget, checked: !args.skipCredentialsCheck },
          services: ["kiwi-shopping.service", "kiwi-merchant.service"],
          versions: VERSIONS_LOCK,
        },
        null,
        2,
      ),
    );
    return;
  }

  for (const dir of Object.values(layout)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  mkdirSync(path.join(prefix, ".kiwi"), { recursive: true, mode: 0o700 });

  // BUG-09：安装 Kiwi 运行应用（dist + package.json + lock + 生产依赖）。
  cpSync(path.join(appDir, "dist"), path.join(layout.app, "dist"), { recursive: true });
  cpSync(path.join(appDir, "package.json"), path.join(layout.app, "package.json"));
  if (existsSync(path.join(appDir, "package-lock.json"))) {
    cpSync(path.join(appDir, "package-lock.json"), path.join(layout.app, "package-lock.json"));
  }
  cpSync(path.join(appDir, "node_modules"), path.join(layout.app, "node_modules"), {
    recursive: true,
  });

  // BUG-09：merchant profile + 实例凭据引用（0600；值不读不记）。
  cpSync(profileSrc, profileTarget);
  if (existsSync(credentials.source) && path.resolve(credentials.source) !== credentialsTarget) {
    writeFileSync(credentialsTarget, readFileSync(credentials.source), { mode: 0o600 });
  }

  // 服务单元：Kiwi（--profile + --data-dir）+ shopping-cli（独立托管单元；
  // systemd 由 Wants/After 表达依赖；launchd 无依赖排序，由 KeepAlive 兜底）。
  const unitVars = {
    PREFIX: prefix,
    SHOPPING_BIN: resolveExecutable(args.shoppingBin ?? "shopping"),
    SHOPPING_ARGS: args.shoppingArgs,
  };
  writeFileSync(
    path.join(layout.config, "kiwi-shopping.service"),
    renderTemplate(path.join("systemd", "kiwi-shopping.service.template"), unitVars),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(layout.config, "kiwi-merchant.service"),
    renderTemplate(path.join("systemd", "kiwi-merchant.service.template"), unitVars),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(layout.config, "com.kiwi.shopping.plist"),
    renderTemplate(path.join("launchd", "com.kiwi.shopping.plist.template"), unitVars),
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(layout.config, "com.kiwi.merchant.plist"),
    renderTemplate(path.join("launchd", "com.kiwi.merchant.plist.template"), unitVars),
    { mode: 0o600 },
  );

  // BUG-09：preflight（宣告完成前，fail-closed）。
  const preflight = [];
  const smoke = spawnSync(process.execPath, [path.join(layout.app, "dist", "cli.js"), "--version"], {
    encoding: "utf-8",
    timeout: 15_000,
  });
  const smokeOut = String(smoke.stdout ?? "");
  preflight.push({
    check: "app_cli_smoke",
    ok: smoke.status === 0 && /kiwi/i.test(smokeOut),
    detail: smoke.status === 0 ? smokeOut.trim() : `exit ${smoke.status ?? smoke.error?.message}`,
  });
  const unitText = readFileSync(path.join(layout.config, "kiwi-merchant.service"), "utf8");
  preflight.push({
    check: "unit_carries_profile_and_datadir",
    ok: unitText.includes(`--profile ${profileTarget}`) && unitText.includes(`--data-dir ${layout.data}`),
    detail: "--profile/--data-dir 渲染核对",
  });
  preflight.push({
    check: "profile_installed",
    ok: existsSync(profileTarget),
    detail: profileTarget,
  });
  preflight.push({
    check: "credentials_reference",
    ok: credentialsOk,
    detail: args.skipCredentialsCheck ? "已跳过（--skip-credentials-check）" : credentials.source,
  });
  const failed = preflight.filter((p) => !p.ok);
  if (failed.length > 0) {
    fail(`preflight 未通过：${JSON.stringify(failed)}`);
  }

  writeFileSync(
    path.join(layout.config, "install.json"),
    `${JSON.stringify(
      {
        installed_at: new Date().toISOString(),
        prefix,
        versions: { ...VERSIONS_LOCK, kiwi: app.version },
        shopping_cli_detected: shopping.version,
        app: { source: appDir, version: app.version },
        profile: { source: profileSrc, target: profileTarget },
        credentials: { target: credentialsTarget, checked: !args.skipCredentialsCheck },
        services: ["kiwi-shopping.service", "kiwi-merchant.service"],
        preflight,
        layout,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.log(
    `安装完成：${prefix}（kiwi ${app.version}；shopping-cli ${shopping.version.major}.${shopping.version.minor}.${shopping.version.patch}；` +
      "preflight 通过；服务单元在 config/ 下：kiwi-shopping + kiwi-merchant）",
  );
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main();
}
