#!/usr/bin/env node
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_URL = "https://catalog.kiwi.harrylabsj.com";
// --data-dir 缺省：/workspace 存在（WorkBuddy 云端宿主，cwd=/workspace）时沿用平台默认
// /workspace/.kiwi-runtime；本机（开发/冒烟宿主）没有 /workspace，缺省改用部署目录旁的
// 一次性临时目录，避免冷启动因创建不了平台路径而 ENOENT（WP17 报告 §3.3）。
// KIWI_CLOUD_PLATFORM_WORKSPACE 仅用于测试/特殊宿主覆盖该探测路径。
const PLATFORM_WORKSPACE_DIR = process.env.KIWI_CLOUD_PLATFORM_WORKSPACE ?? "/workspace";
// 样例商家名：与包内 app/cloud-sample 夹具、scripts/smoke-cloud-artifact.mjs 的 agent_card 断言一致；
// --sample 且未显式给 --merchant-name 时使用，使冒烟无需额外参数即可通过。
const SAMPLE_MERCHANT_NAME = "Kiwi A2A Merchant";

function defaultDataDir(outDir) {
  if (existsSync(PLATFORM_WORKSPACE_DIR)) return path.join(PLATFORM_WORKSPACE_DIR, ".kiwi-runtime");
  return mkdtempSync(path.join(path.dirname(outDir), ".kiwi-runtime-"));
}

function parseArgs(argv) {
  const options = { origin: undefined, out: undefined, dataDir: undefined, catalogUrl: DEFAULT_CATALOG_URL, allowInsecureCatalog: false, sample: false, merchantName: undefined, adminBootstrap: false, ownedMode: "off", ownedPolicyPath: undefined, skipInstall: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--origin") options.origin = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--data-dir") options.dataDir = argv[++i];
    else if (arg === "--catalog-url") options.catalogUrl = argv[++i];
    else if (arg === "--allow-insecure-catalog") options.allowInsecureCatalog = true;
    else if (arg === "--sample") options.sample = true;
    else if (arg === "--merchant-name") options.merchantName = argv[++i];
    else if (arg === "--admin-bootstrap") options.adminBootstrap = true;
    else if (arg === "--skip-install") options.skipInstall = true;
    else if (arg === "--owned-mode") options.ownedMode = argv[++i];
    else if (arg === "--owned-policy") options.ownedPolicyPath = argv[++i];
    else throw new Error(`未知参数 ${arg}`);
  }
  if (options.ownedMode !== "off" && options.ownedMode !== "require") {
    throw new Error("--owned-mode 只能是 off 或 require");
  }
  if (options.ownedMode === "require" && options.ownedPolicyPath === undefined) {
    throw new Error("--owned-mode require 必须同时提供 --owned-policy <json文件>");
  }
  if (options.ownedMode === "off" && options.ownedPolicyPath !== undefined) {
    throw new Error("--owned-mode off 不接受 --owned-policy（不默默启用）");
  }
  if (options.origin === undefined || options.out === undefined) {
    throw new Error("用法：node prepare.mjs --origin https://<host> --out <部署目录> [--catalog-url <https-url>] [--merchant-name <名称>] [--sample] [--allow-insecure-catalog] [--data-dir <绝对路径>] [--admin-bootstrap] [--owned-mode off|require] [--owned-policy <json文件>] [--skip-install]");
  }
  return options;
}


function validateOwnedPolicyFile(file) {
  let policy;
  try {
    policy = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`--owned-policy 不是合法 JSON：${error.message}`, { cause: error });
  }
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("--owned-policy 必须是对象");
  }
  const allowed = ["version", "policy_id", "window_id", "window_start_utc", "window_end_utc", "caps"];
  for (const key of Object.keys(policy)) {
    if (!allowed.includes(key)) throw new Error(`--owned-policy 含未知字段：${key}`);
  }
  for (const key of ["version", "policy_id", "window_id"]) {
    if (typeof policy[key] !== "string" || policy[key].trim() === "") {
      throw new Error(`--owned-policy.${key} 必须是非空字符串`);
    }
  }
  const start = Date.parse(policy.window_start_utc);
  const end = Date.parse(policy.window_end_utc);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("--owned-policy 窗口起止必须是可解析时间");
  }
  if (end <= start) throw new Error("--owned-policy window_end_utc 必须晚于 window_start_utc");
  if (end <= Date.now()) throw new Error("--owned-policy 窗口已过期，不能用于新部署");
  const caps = policy.caps;
  if (caps === null || typeof caps !== "object" || Array.isArray(caps)) {
    throw new Error("--owned-policy.caps 必须是对象");
  }
  const capKeys = ["business_requests", "mcp_calls", "core_starts"];
  for (const key of Object.keys(caps)) {
    if (!capKeys.includes(key)) throw new Error(`--owned-policy.caps 含未知字段：${key}`);
  }
  for (const key of capKeys) {
    if (!Number.isSafeInteger(caps[key]) || caps[key] <= 0) {
      throw new Error(`--owned-policy.caps.${key} 必须是正整数`);
    }
  }
  return policy;
}

function validateCatalogUrl(raw, options) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("--catalog-url 必须是合法 URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--catalog-url 只接受地址 origin，不得带凭据、路径、查询或片段");
  }
  if (url.protocol !== "https:") {
    if (!(options.allowInsecureCatalog && loopback && url.protocol === "http:")) {
      throw new Error("--catalog-url 必须使用 https；loopback http 需显式加 --allow-insecure-catalog");
    }
  }
  if (options.allowInsecureCatalog && !(loopback && url.protocol === "http:")) {
    throw new Error("--allow-insecure-catalog 只适用于 loopback http Catalog");
  }
  if (options.sample && !loopback) throw new Error("--sample 只允许连接 loopback Catalog，拒绝连接生产 Catalog");
  return url.origin;
}

function yamlString(value) {
  return JSON.stringify(value);
}

function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function writeMerchantProfile(file, identity, merchantName) {
  writeFileSync(file, [
    "# 商家云端 profile：身份由 prepare 生成；商品由商家在工作台导入。",
    "runtime_version: 0.6.0",
    "protocol_version: shopping.negotiation/0.1",
    `agent_id: ${identity.agent_id}`,
    `name: ${yamlString(merchantName)}`,
    "role: merchant",
    `owner_id: ${identity.owner_id}`,
    "commerce:",
    "  base_url: http://127.0.0.1:1",
    "  token_env: KIWI_CLOUD_COMMERCE_TOKEN",
    "  backend: local_marketplace",
    "  allow_demo_price_fallback: false",
    "model:",
    "  provider: fake",
    "  model: fake-merchant-model",
    "runtime:",
    "  mode: once",
    "  poll_interval_seconds: 5",
    "  turn_timeout_seconds: 90",
    "  max_model_steps: 4",
    "  max_retries: 2",
    "merchant_policy:",
    "  min_unit_price_private: 0.01",
    "  max_auto_discount_percent: 0",
    "  inventory_source: marketplace",
    "  quote_ttl_seconds: 300",
    "  auto_negotiate: true",
    "",
  ].join("\n"), { mode: 0o600 });
}

function validateOrigin(raw) {
  if (!/^https:\/\/[^/?#]+\/?$/.test(raw)) throw new Error("--origin 只接受 https://host[:port]，不得带路径、查询、片段或凭据");
  let url;
  try { url = new URL(raw); } catch { throw new Error("--origin 必须是合法的 https origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname || raw.includes("\\")) {
    throw new Error("--origin 只接受 https://host[:port]，不得带路径、查询、片段或凭据");
  }
  return url.origin;
}

function sha256(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function isWithin(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isValidNpmBinLink(file, binDir) {
  let stat;
  try { stat = lstatSync(file); } catch { return false; }
  if (!stat.isSymbolicLink()) return false;
  const linkName = path.basename(file);
  let target;
  try { target = readlinkSync(file); } catch { return false; }
  if (path.isAbsolute(target) || target.includes("\\")) return false;
  const nodeModules = path.dirname(binDir);
  const targetFile = path.resolve(binDir, target);
  if (!isWithin(nodeModules, targetFile) || !existsSync(targetFile)) return false;
  let targetStat;
  try { targetStat = lstatSync(targetFile); } catch { return false; }
  const mode = targetStat.mode & 0o777;
  if (!targetStat.isFile() || (mode & 0o400) === 0 || (mode & 0o100) === 0 || (mode & 0o022) !== 0) return false;
  let packageDir = path.dirname(targetFile);
  while (isWithin(nodeModules, packageDir)) {
    const packageFile = path.join(packageDir, "package.json");
    if (existsSync(packageFile)) {
      let pkg;
      try { pkg = JSON.parse(readFileSync(packageFile, "utf8")); } catch { return false; }
      const declared = pkg.bin;
      const packageName = typeof pkg.name === "string" ? pkg.name.split("/").at(-1) : "";
      const binPath = typeof declared === "string"
        ? (linkName === packageName ? declared : undefined)
        : declared !== null && typeof declared === "object" && typeof declared[linkName] === "string"
          ? declared[linkName]
          : undefined;
      if (typeof binPath !== "string" || binPath.includes("\\") || path.isAbsolute(binPath)) return false;
      return path.resolve(packageDir, binPath) === targetFile;
    }
    packageDir = path.dirname(packageDir);
  }
  return false;
}

function listPackageFiles(dir, prefix = "") {
  const paths = [];
  for (const name of readdirSync(dir)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (relative === "build-manifest.json" || relative === "admin-bootstrap.json" || relative.endsWith(".tgz") || relative === "node_modules/.package-lock.json" || relative.endsWith("/node_modules/.package-lock.json")) continue;
    const file = path.join(dir, name);
    if (relative === "node_modules/.bin" || relative.endsWith("/node_modules/.bin")) {
      for (const binName of readdirSync(file)) {
        const binFile = path.join(file, binName);
        if (!isValidNpmBinLink(binFile, file)) paths.push(`${relative}/${binName}`);
      }
      continue;
    }
    if (statSync(file).isDirectory()) paths.push(...listPackageFiles(file, relative));
    else paths.push(relative);
  }
  return paths.sort();
}

function verifyManifest() {
  const manifestPath = path.join(PACKAGE_ROOT, "build-manifest.json");
  if (!existsSync(manifestPath)) throw new Error("包内缺少 build-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.files) || typeof manifest.artifact_sha256 !== "string") throw new Error("build-manifest.json 格式无效");
  const expectedPaths = manifest.files.map((item) => item.path).sort();
  const actualPaths = listPackageFiles(PACKAGE_ROOT);
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) throw new Error("包内文件集合与 build-manifest.json 不一致");
  for (const item of manifest.files) {
    const file = path.resolve(PACKAGE_ROOT, item.path);
    if (!file.startsWith(`${PACKAGE_ROOT}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) throw new Error(`制品文件缺失或路径越界：${item.path}`);
    if (statSync(file).size !== item.size || sha256(file) !== item.sha256) throw new Error(`制品摘要不一致：${item.path}`);
  }
  const digestLines = manifest.files.map((item) => `${item.path}\0${item.sha256}`).sort().join("\n");
  const aggregate = `sha256:${createHash("sha256").update(digestLines).digest("hex")}`;
  if (aggregate !== manifest.artifact_sha256) throw new Error("build-manifest.json 聚合摘要不一致");
  return manifest;
}

/** 轻量包安装：按 package-lock.json 在部署目录执行 npm ci，并逐包核对锁定版本。 */
function verifyInstalledLock(out) {
  const lockPath = path.join(out, "package-lock.json");
  if (!existsSync(lockPath)) throw new Error("部署产物缺少 package-lock.json：轻量发布包必须按锁定版本安装依赖");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (!Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 3) {
    throw new Error("package-lock.json lockfileVersion 必须 >= 3");
  }
  const missing = [];
  const mismatched = [];
  for (const [relative, row] of Object.entries(lock.packages ?? {})) {
    if (relative === "" || row.dev === true || row.link === true) continue;
    const packageFile = path.join(out, relative, "package.json");
    if (!existsSync(packageFile)) {
      if (row.optional === true) continue;
      missing.push(relative);
      continue;
    }
    let installed;
    try { installed = JSON.parse(readFileSync(packageFile, "utf8")); } catch { missing.push(relative); continue; }
    if (installed.version !== row.version) mismatched.push(`${relative}: ${installed.version} != ${row.version}`);
  }
  if (missing.length > 0 || mismatched.length > 0) {
    throw new Error(
      "依赖安装与 package-lock.json 不一致：" +
        (missing.length > 0 ? `缺失 ${missing.slice(0, 5).join(", ")}` : "") +
        (mismatched.length > 0 ? `${missing.length > 0 ? "；" : ""}版本不符 ${mismatched.slice(0, 5).join(", ")}` : ""),
    );
  }
}

function installDependencies(out) {
  if (!existsSync(path.join(out, "package-lock.json")))
    throw new Error("部署产物缺少 package-lock.json：轻量发布包必须按锁定版本安装依赖");
  const toolchain = path.join(out, "scripts", "check-install-toolchain.mjs");
  if (!existsSync(toolchain)) throw new Error("部署产物缺少 scripts/check-install-toolchain.mjs，无法校验安装运行时");
  // preinstall 在 npm ci --ignore-scripts 下不会自动执行：安装前跑一次 Node 下界守卫，
  // 安装后再跑一次依赖树不变量检查（脆弱嵌套依赖 fail-closed）。
  execFileSync(process.execPath, [toolchain], { cwd: out, stdio: "inherit" });
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: out, stdio: "inherit" });
  execFileSync(process.execPath, [toolchain], { cwd: out, stdio: "inherit" });
  verifyInstalledLock(out);
}

function makeAdminBootstrap(identity) {
  const password = randomBytes(32).toString("base64url");
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 32, { N: 16384 }).toString("base64url");
  const credentials = { principal_id: identity.agent_id, merchant_id: identity.owner_id, password_hash: `scrypt$16384$${salt}$${hash}`, created_at: new Date().toISOString() };
  writeFileSync(path.join(PACKAGE_ROOT, "admin-bootstrap.json"), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  return password;
}

// 失败回滚钩子：只在本次运行创建了临时输出时才非空（见 main 内的 outExisted）。
let rollbackOnFailure = null;

function main() {
  const options = parseArgs(process.argv.slice(2));
  const publicOrigin = validateOrigin(options.origin);
  const catalogUrl = validateCatalogUrl(options.catalogUrl, options);
  const merchantName = options.merchantName?.trim() || (options.sample ? SAMPLE_MERCHANT_NAME : "待设置商家名称");
  if (merchantName.length > 80 || hasControlCharacters(merchantName)) throw new Error("--merchant-name 最长 80 个字符且不得包含控制字符");
  const manifest = verifyManifest();
  const out = path.resolve(options.out);
  if (out === PACKAGE_ROOT || out.startsWith(`${PACKAGE_ROOT}${path.sep}`)) throw new Error("部署目录必须在包目录之外");
  // 先校验 out（已存在且非空即拒绝），再创建任何临时目录：拒绝路径不得泄漏 mkdtemp。
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error("部署目录已存在且非空；请提供新的空目录");
  // 只有"未显式 --data-dir 且平台 /workspace 不存在"时才会 mkdtemp 出临时目录，
  // 失败回滚只回收这种本次新建的目录。
  const autoDataDir = options.dataDir === undefined && !existsSync(PLATFORM_WORKSPACE_DIR);
  const dataDirRaw = options.dataDir ?? defaultDataDir(out);
  if (!path.isAbsolute(dataDirRaw)) throw new Error("--data-dir 必须是部署目录外的绝对路径");
  const dataDir = path.resolve(dataDirRaw);
  if (dataDir === out || dataDir.startsWith(`${out}${path.sep}`)) {
    // 临时目录此时已创建：立即回收（仅限自动 mkdtemp 的那个；显式 --data-dir 不动）。
    if (autoDataDir) rmSync(dataDir, { recursive: true, force: true });
    throw new Error("--data-dir 必须是部署目录外的绝对路径");
  }
  rmSync(path.join(PACKAGE_ROOT, "admin-bootstrap.json"), { force: true });
  // 安全清理：只回收本次新建的临时输出，不删除用户既有目录或数据。
  // - out 在本次运行前不存在：删除整个 out（它是我们刚创建的）；
  // - out 是用户既有的空目录：只删除本次写入的顶层条目，目录本身保留；
  // - 仅自动 mkdtemp 出来的 data dir 会被回收；显式 --data-dir 与平台 /workspace 永不删除。
  const outExisted = existsSync(out);
  const createdNames = [];
  rollbackOnFailure = () => {
    rmSync(path.join(PACKAGE_ROOT, "admin-bootstrap.json"), { force: true });
    if (!outExisted) rmSync(out, { recursive: true, force: true });
    else for (const name of createdNames) rmSync(path.join(out, name), { recursive: true, force: true });
    if (autoDataDir) rmSync(dataDir, { recursive: true, force: true });
  };
  mkdirSync(out, { recursive: true });
  // scripts/ 必须一起复制：部署产物的 package.json 保留 preinstall
  // （node scripts/check-install-toolchain.mjs，A106 依赖树守卫），漏复制会让
  // 平台安装以 SITES_INSTALL_FAILED 失败（0.12.21 实测根因）。
  for (const name of ["app", "contracts", "node_modules", "index.js", "package.json", "package-lock.json", "build-manifest.json", "scripts"]) {
    const source = path.join(PACKAGE_ROOT, name);
    if (!existsSync(source)) continue;
    createdNames.push(name);
    cpSync(source, path.join(out, name), { recursive: true });
  }
  // 产物自洽：npm 生命周期钩子（preinstall/install/postinstall/prepare）若以
  // `node <相对文件>` 引用脚本，其目标必须已在部署目录内，否则在这里 fail-closed，
  // 而不是把 MODULE_NOT_FOUND 留给平台安装阶段（0.12.21 的 SITES_INSTALL_FAILED）。
  // 自定义脚本（如 prepare-cloud）只在开发时使用，不要求随部署产物分发。
  const LIFECYCLE_HOOKS = new Set(["preinstall", "install", "postinstall", "prepare"]);
  const deployedPkg = JSON.parse(readFileSync(path.join(out, "package.json"), "utf8"));
  for (const [hook, command] of Object.entries(deployedPkg.scripts ?? {})) {
    if (!LIFECYCLE_HOOKS.has(hook)) continue;
    const target = /^node\s+(\S+)/.exec(String(command))?.[1];
    if (target !== undefined && !target.startsWith("/") && !existsSync(path.join(out, target))) {
      throw new Error(
        `部署产物缺少 ${hook} 引用的文件 ${target}；prepare 的复制清单必须与 package.json 的生命周期脚本保持一致`,
      );
    }
  }
  // 轻量发布包不带 node_modules：按 package-lock.json 在部署目录安装第三方依赖。
  // 兼容旧式随包依赖（包内已有 node_modules）时只做锁定版本核对，不联网。
  const bundled = createdNames.includes("node_modules");
  if (!options.skipInstall) {
    if (bundled) {
      if (existsSync(path.join(out, "package-lock.json"))) verifyInstalledLock(out);
    } else {
      createdNames.push("node_modules");
      installDependencies(out);
    }
  }
  const identity = { owner_id: `merchant-${randomBytes(16).toString("hex")}` };
  identity.agent_id = `merchant-agent:${identity.owner_id}`;
  const pilotDir = path.join(out, "pilot");
  createdNames.push("pilot");
  mkdirSync(pilotDir, { recursive: true });
  if (options.sample) {
    const sampleSource = path.join(PACKAGE_ROOT, "app", "cloud-sample", "products.json");
    const sampleTable = JSON.parse(readFileSync(sampleSource, "utf8"));
    sampleTable.merchant_id = identity.owner_id;
    sampleTable.runtime_owner_id = identity.owner_id;
    writeFileSync(path.join(pilotDir, "products.json"), `${JSON.stringify(sampleTable, null, 2)}\n`, { mode: 0o600 });
  } else {
    rmSync(path.join(out, "app", "cloud-sample"), { recursive: true, force: true });
  }
  writeMerchantProfile(path.join(pilotDir, "merchant.yaml"), identity, merchantName);
  const config = {
    public_origin: publicOrigin,
    data_dir: dataDir,
    profile: "pilot/merchant.yaml",
    products_file: options.sample ? "pilot/products.json" : path.join(dataDir, "products.json"),
    ...(options.sample ? { readiness_sku: "smoke-sku-1", sample: true } : {}),
    catalog_url: catalogUrl,
    merchant_name_needs_update: !options.merchantName?.trim(),
    ...(options.allowInsecureCatalog ? { allow_insecure_catalog: true } : {}),
    a2a_auth: "signature",
    ...(options.ownedMode === "require"
      ? { owned_runtime: "require", owned_policy: validateOwnedPolicyFile(options.ownedPolicyPath) }
      : {}),
  };
  createdNames.push("cloud.config.json");
  writeFileSync(path.join(out, "cloud.config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  let password;
  if (options.adminBootstrap) {
    password = makeAdminBootstrap(identity);
    createdNames.push("admin-bootstrap.json");
    cpSync(path.join(PACKAGE_ROOT, "admin-bootstrap.json"), path.join(out, "admin-bootstrap.json"));
    rmSync(path.join(PACKAGE_ROOT, "admin-bootstrap.json"), { force: true });
  }
  process.stdout.write(`${JSON.stringify({ deployment_dir: out, artifact_sha256: manifest.artifact_sha256, version: manifest.runtime_version, agent_id: identity.agent_id, catalog_url: catalogUrl, sample: options.sample, allow_insecure_catalog: options.allowInsecureCatalog })}\n`);
  if (password !== undefined) process.stdout.write(`一次性管理员口令（请立即保存）：${password}\n`);
  rollbackOnFailure = null;
}

try { main(); } catch (error) {
  if (rollbackOnFailure !== null) {
    try { rollbackOnFailure(); } catch { /* best-effort：清理失败不掩盖原始错误 */ }
    rollbackOnFailure = null;
  }
  process.stderr.write(`[prepare] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
